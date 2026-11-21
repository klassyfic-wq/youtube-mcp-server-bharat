import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Props } from "./utils.ts";
import { decryptToken, encryptToken, getValidGoogleAccessToken } from "./utils.ts";

type UploadEnv = Env;

const CHUNK_BYTES = 256 * 1024;
const MAX_VIDEO_BYTES = 256 * 1024 * 1024 * 1024;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const MIME_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;

type UploadSession = {
  userId: string;
  sessionUriEncrypted: string;
  totalBytes: number;
  contentType: (typeof MIME_TYPES)[number];
  nextOffset: number;
  createdAt: string;
  completedVideo?: { id: string; title: string | null; privacyStatus: string | null };
};

async function getToken(userId: string | undefined, env: UploadEnv) {
  if (!userId) throw new Error("Authentication required. Connect your YouTube account first.");
  return getValidGoogleAccessToken(userId, env);
}

function sessionKey(userId: string, uploadId: string) {
  return `youtube:upload:${userId}:${uploadId}`;
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown) {
  console.error("YouTube upload operation failed:", error);
  return {
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : "YouTube upload operation failed." }],
    isError: true,
  };
}

export function decodeChunk(encoded: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error("chunkBase64 must be valid standard Base64.");
  }
  if (encoded.length > Math.ceil(CHUNK_BYTES / 3) * 4) {
    throw new Error("Each chunk must be no larger than 256 KiB.");
  }
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  if (bytes.length === 0 || bytes.length > CHUNK_BYTES) {
    throw new Error("Each chunk must contain between 1 byte and 256 KiB.");
  }
  return bytes;
}

export function nextOffsetFromRange(range: string | null, totalBytes: number): number {
  if (!range) return 0;
  const match = /^bytes=0-(\d+)$/.exec(range);
  if (!match) throw new Error("YouTube returned an invalid resumable upload range.");
  const offset = Number(match[1]) + 1;
  if (!Number.isSafeInteger(offset) || offset > totalBytes) {
    throw new Error("YouTube returned an upload offset outside the declared file size.");
  }
  return offset;
}

async function reconcileUploadAfterFailure(
  session: UploadSession,
  token: string,
  env: UploadEnv,
): Promise<{ nextOffset: number; video?: { id: string; title: string | null; privacyStatus: string | null } }> {
  const response = await fetch(await decryptToken(session.sessionUriEncrypted, env.TOKEN_ENCRYPTION_KEY), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Length": "0",
      "Content-Range": `bytes */${session.totalBytes}`,
    },
  });
  if (response.status === 308) {
    return { nextOffset: nextOffsetFromRange(response.headers.get("Range"), session.totalBytes) };
  }
  if (response.status === 200 || response.status === 201) {
    const video = await response.json() as { id?: string; status?: { privacyStatus?: string }; snippet?: { title?: string } };
    if (!video.id) throw new Error("YouTube reports completion but returned no video ID.");
    return {
      nextOffset: session.totalBytes,
      video: { id: video.id, title: video.snippet?.title ?? null, privacyStatus: video.status?.privacyStatus ?? null },
    };
  }
  if (response.status === 404 || response.status === 410) {
    throw new Error("YouTube upload session expired. Start a new upload.");
  }
  throw new Error(`Could not reconcile interrupted upload (HTTP ${response.status}).`);
}

async function loadSession(env: UploadEnv, userId: string, uploadId: string): Promise<UploadSession> {
  if (!/^[0-9a-f-]{36}$/i.test(uploadId)) throw new Error("Invalid uploadId.");
  const raw = await env.OAUTH_KV.get(sessionKey(userId, uploadId));
  if (!raw) throw new Error("Upload session not found or expired. Start a new upload.");
  const session = JSON.parse(raw) as UploadSession;
  if (session.userId !== userId) throw new Error("Upload session does not belong to this account.");
  return session;
}

export function registerYoutubeUploadTools(
  server: McpServer,
  authProps: Props | undefined,
  env: UploadEnv,
) {
  server.registerTool(
    "start_video_upload",
    {
      description: "Start a private-by-default YouTube resumable video upload. Returns an opaque uploadId; send the video in sequential Base64 chunks of at most 256 KiB using upload_video_chunk. Never expose or share upload session URLs.",
      inputSchema: {
        title: z.string().trim().min(1).max(100),
        description: z.string().max(5000).optional(),
        tags: z.array(z.string().trim().min(1).max(100)).max(500).optional(),
        categoryId: z.string().regex(/^\d{1,3}$/).optional(),
        privacyStatus: z.enum(["private", "unlisted"]).default("private"),
        contentType: z.enum(MIME_TYPES),
        totalBytes: z.number().int().positive().max(MAX_VIDEO_BYTES),
      },
    },
    async ({ title, description, tags, categoryId, privacyStatus, contentType, totalBytes }) => {
      try {
        const userId = authProps?.userId;
        const token = await getToken(userId, env);
        const metadata = {
          snippet: {
            title,
            ...(description !== undefined ? { description } : {}),
            ...(tags?.length ? { tags } : {}),
            ...(categoryId ? { categoryId } : {}),
          },
          status: { privacyStatus },
        };
        const response = await fetch(
          "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json; charset=UTF-8",
              "X-Upload-Content-Type": contentType,
              "X-Upload-Content-Length": String(totalBytes),
            },
            body: JSON.stringify(metadata),
          },
        );
        if (!response.ok) {
          console.error("YouTube resumable session creation failed:", response.status);
          throw new Error(`YouTube could not start the upload (HTTP ${response.status}). Check channel permissions, quota, and metadata.`);
        }
        const sessionUri = response.headers.get("Location");
        if (!sessionUri || !sessionUri.startsWith("https://www.googleapis.com/upload/youtube/")) {
          throw new Error("YouTube did not return a valid resumable upload session.");
        }
        const uploadId = crypto.randomUUID();
        const session: UploadSession = {
          userId: userId!,
          sessionUriEncrypted: await encryptToken(sessionUri, env.TOKEN_ENCRYPTION_KEY),
          totalBytes,
          contentType,
          nextOffset: 0,
          createdAt: new Date().toISOString(),
        };
        await env.OAUTH_KV.put(sessionKey(userId!, uploadId), JSON.stringify(session), {
          expirationTtl: SESSION_TTL_SECONDS,
        });
        return result({
          uploadId,
          chunkSizeBytes: CHUNK_BYTES,
          totalBytes,
          nextOffset: 0,
          privacyStatus,
          instructions: "Send chunks sequentially from offset 0. Use exactly 256 KiB for every non-final chunk; the final chunk may be smaller.",
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "upload_video_chunk",
    {
      description: "Upload the next sequential Base64 chunk to an existing YouTube resumable upload. Use 256 KiB chunks except for the final chunk. Calls for one upload must be sequential; use nextOffset returned by this tool.",
      inputSchema: {
        uploadId: z.string().uuid(),
        offset: z.number().int().nonnegative(),
        chunkBase64: z.string().min(4).max(350000),
      },
    },
    async ({ uploadId, offset, chunkBase64 }) => {
      try {
        const userId = authProps?.userId;
        const token = await getToken(userId, env);
        const session = await loadSession(env, userId!, uploadId);
        if (session.completedVideo) throw new Error("This upload is already complete.");
        if (offset !== session.nextOffset) {
          throw new Error(`Unexpected chunk offset. YouTube upload expects byte ${session.nextOffset}; resume from that offset.`);
        }
        if (offset >= session.totalBytes) throw new Error("All video bytes have already been uploaded.");
        const bytes = decodeChunk(chunkBase64);
        const end = offset + bytes.length - 1;
        if (end >= session.totalBytes) throw new Error("Chunk exceeds the declared totalBytes.");
        const isFinal = end + 1 === session.totalBytes;
        if (!isFinal && bytes.length !== CHUNK_BYTES) {
          throw new Error("Non-final chunks must be exactly 256 KiB.");
        }

        let response: Response | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            response = await fetch(await decryptToken(session.sessionUriEncrypted, env.TOKEN_ENCRYPTION_KEY), {
              method: "PUT",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": session.contentType,
                "Content-Length": String(bytes.length),
                "Content-Range": `bytes ${offset}-${end}/${session.totalBytes}`,
              },
              body: bytes,
            });
          } catch (networkError) {
            console.warn("Transient YouTube upload network error; reconciling resumable session.");
            response = undefined;
          }

          if (response && ![500, 502, 503, 504].includes(response.status)) break;

          const remote = await reconcileUploadAfterFailure(session, token, env);
          if (remote.video) {
            session.completedVideo = remote.video;
            session.nextOffset = session.totalBytes;
            await env.OAUTH_KV.put(sessionKey(userId!, uploadId), JSON.stringify(session), { expirationTtl: SESSION_TTL_SECONDS });
            return result({ uploadId, complete: true, videoId: remote.video.id, title: remote.video.title, privacyStatus: remote.video.privacyStatus, videoUrl: `https://www.youtube.com/watch?v=${remote.video.id}` });
          }
          session.nextOffset = remote.nextOffset;
          await env.OAUTH_KV.put(sessionKey(userId!, uploadId), JSON.stringify(session), { expirationTtl: SESSION_TTL_SECONDS });
          if (remote.nextOffset === end + 1) {
            return result({ uploadId, complete: false, nextOffset: remote.nextOffset, totalBytes: session.totalBytes, percentComplete: Number(((remote.nextOffset / session.totalBytes) * 100).toFixed(2)), recoveredAfterTransientFailure: true });
          }
          if (remote.nextOffset !== offset) {
            throw new Error(`Upload state reconciled at byte ${remote.nextOffset}; resend from this exact offset.`);
          }
          if (attempt === 2) throw new Error("YouTube upload retry limit reached. Upload remains resumable; call get_video_upload_status before continuing.");
          const retryAfter = response?.headers.get("Retry-After");
          const delayMs = retryAfter && /^\\d+$/.test(retryAfter)
            ? Math.min(Number(retryAfter) * 1000, 8000)
            : Math.min(1000 * (2 ** attempt), 4000);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        if (!response) throw new Error("Upload request was interrupted; check upload status and resume from the confirmed offset.");

        if (response.status === 308) {
          const nextOffset = nextOffsetFromRange(response.headers.get("Range"), session.totalBytes);
          session.nextOffset = nextOffset;
          await env.OAUTH_KV.put(sessionKey(userId!, uploadId), JSON.stringify(session), {
            expirationTtl: SESSION_TTL_SECONDS,
          });
          return result({
            uploadId,
            complete: false,
            nextOffset,
            totalBytes: session.totalBytes,
            percentComplete: Number(((nextOffset / session.totalBytes) * 100).toFixed(2)),
          });
        }

        if (response.status === 200 || response.status === 201) {
          const video = await response.json() as { id?: string; status?: { privacyStatus?: string }; snippet?: { title?: string } };
          if (!video.id) throw new Error("YouTube completed the upload but did not return a video ID.");
          session.completedVideo = {
            id: video.id,
            title: video.snippet?.title ?? null,
            privacyStatus: video.status?.privacyStatus ?? null,
          };
          await env.OAUTH_KV.put(sessionKey(userId!, uploadId), JSON.stringify(session), {
            expirationTtl: SESSION_TTL_SECONDS,
          });
          return result({
            uploadId,
            complete: true,
            videoId: video.id,
            title: video.snippet?.title ?? null,
            privacyStatus: video.status?.privacyStatus ?? null,
            videoUrl: `https://www.youtube.com/watch?v=${video.id}`,
          });
        }

        if (response.status === 404 || response.status === 410) {
          await env.OAUTH_KV.delete(sessionKey(userId!, uploadId));
          throw new Error("YouTube upload session expired. Start a new upload.");
        }
        console.error("YouTube chunk upload failed:", response.status);
        throw new Error(`YouTube rejected the video chunk (HTTP ${response.status}). Check upload status before retrying.`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_video_upload_status",
    {
      description: "Query YouTube for the confirmed byte offset of a resumable upload after a timeout or interrupted chunk. Does not expose the private session URL.",
      inputSchema: { uploadId: z.string().uuid() },
    },
    async ({ uploadId }) => {
      try {
        const userId = authProps?.userId;
        const token = await getToken(userId, env);
        const session = await loadSession(env, userId!, uploadId);
        if (session.completedVideo) {
          return result({
            uploadId,
            complete: true,
            videoId: session.completedVideo.id,
            title: session.completedVideo.title,
            privacyStatus: session.completedVideo.privacyStatus,
            videoUrl: `https://www.youtube.com/watch?v=${session.completedVideo.id}`,
          });
        }
        const response = await fetch(await decryptToken(session.sessionUriEncrypted, env.TOKEN_ENCRYPTION_KEY), {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Length": "0",
            "Content-Range": `bytes */${session.totalBytes}`,
          },
        });
        if (response.status === 308) {
          const nextOffset = nextOffsetFromRange(response.headers.get("Range"), session.totalBytes);
          session.nextOffset = nextOffset;
          await env.OAUTH_KV.put(sessionKey(userId!, uploadId), JSON.stringify(session), {
            expirationTtl: SESSION_TTL_SECONDS,
          });
          return result({
            uploadId,
            complete: false,
            nextOffset,
            totalBytes: session.totalBytes,
            percentComplete: Number(((nextOffset / session.totalBytes) * 100).toFixed(2)),
          });
        }
        if (response.status === 200 || response.status === 201) {
          const video = await response.json() as { id?: string; status?: { privacyStatus?: string }; snippet?: { title?: string } };
          if (video.id) {
            session.completedVideo = {
              id: video.id,
              title: video.snippet?.title ?? null,
              privacyStatus: video.status?.privacyStatus ?? null,
            };
            await env.OAUTH_KV.put(sessionKey(userId!, uploadId), JSON.stringify(session), {
              expirationTtl: SESSION_TTL_SECONDS,
            });
          }
          return result({
            uploadId,
            complete: true,
            videoId: video.id ?? null,
            title: video.snippet?.title ?? null,
            privacyStatus: video.status?.privacyStatus ?? null,
            videoUrl: video.id ? `https://www.youtube.com/watch?v=${video.id}` : null,
          });
        }
        if (response.status === 404 || response.status === 410) {
          await env.OAUTH_KV.delete(sessionKey(userId!, uploadId));
          throw new Error("YouTube upload session expired. Start a new upload.");
        }
        console.error("YouTube upload status query failed:", response.status);
        throw new Error(`Could not confirm YouTube upload status (HTTP ${response.status}).`);
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    "upload_video_thumbnail",
    {
      description: "Set a custom JPEG or PNG thumbnail for a video on the authenticated channel. For MCP transport reliability, provide an image no larger than 2 MiB as Base64.",
      inputSchema: {
        videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
        contentType: z.enum(["image/jpeg", "image/png"]),
        imageBase64: z.string().min(4).max(2_800_000),
      },
    },
    async ({ videoId, contentType, imageBase64 }) => {
      try {
        const userId = authProps?.userId;
        const token = await getToken(userId, env);
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(imageBase64)) {
          throw new Error("imageBase64 must be valid standard Base64.");
        }
        const binary = atob(imageBase64);
        if (binary.length === 0 || binary.length > 2 * 1024 * 1024) {
          throw new Error("Thumbnail must be between 1 byte and 2 MiB for this MCP upload path.");
        }
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
        const isPng = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
        if ((contentType === "image/jpeg" && !isJpeg) || (contentType === "image/png" && !isPng)) {
          throw new Error("Thumbnail bytes do not match the declared image content type.");
        }
        const response = await fetch(
          `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": contentType,
              "Content-Length": String(bytes.length),
            },
            body: bytes,
          },
        );
        if (!response.ok) {
          console.error("YouTube thumbnail upload failed:", response.status);
          throw new Error(`YouTube rejected the thumbnail (HTTP ${response.status}). Verify video ownership and custom-thumbnail eligibility.`);
        }
        const data = await response.json() as { items?: Array<Record<string, unknown>> };
        return result({ videoId, uploaded: true, thumbnails: data.items ?? [] });
      } catch (error) {
        return failure(error);
      }
    },
  );

}
