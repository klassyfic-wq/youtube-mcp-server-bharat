import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Props } from "./utils";
import { decryptToken, encryptToken, getValidGoogleAccessToken } from "./utils";

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

function decodeChunk(encoded: string): Uint8Array {
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

function nextOffsetFromRange(range: string | null, totalBytes: number): number {
  if (!range) return 0;
  const match = /^bytes=0-(\d+)$/.exec(range);
  if (!match) throw new Error("YouTube returned an invalid resumable upload range.");
  const offset = Number(match[1]) + 1;
  if (!Number.isSafeInteger(offset) || offset > totalBytes) {
    throw new Error("YouTube returned an upload offset outside the declared file size.");
  }
  return offset;
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

        const response = await fetch(await decryptToken(session.sessionUriEncrypted, env.TOKEN_ENCRYPTION_KEY), {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": session.contentType,
            "Content-Length": String(bytes.length),
            "Content-Range": `bytes ${offset}-${end}/${session.totalBytes}`,
          },
          body: bytes,
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
}
