import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Props } from "./utils.ts";

type DeliveryEnv = Env & { MEDIA_BASE_URL?: string };
type DownloadGrant = { audioKey: string; userId: string; jobId: string; sceneNumber: number; expiresAt: number };
type AudioArtifact = { schemaVersion: number; jobId: string; sceneNumber: number; format: "mp3" | "wav" | "opus"; contentType: string; byteLength: number; audioBase64: string };

const GRANT_TTL_SECONDS = 10 * 60;
const grantKey = (token: string) => `youtube:audio-download-grant:${token}`;
const audioKey = (userId: string, jobId: string, sceneNumber: number) =>
  `youtube:video-audio:${userId}:${jobId}:${sceneNumber}`;

function errorResponse(status: number, message: string) {
  return new Response(message, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function handleAudioArtifactRequest(request: Request, env: DeliveryEnv): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/media\/audio\/([a-f0-9]{64})$/);
  if (!match) return errorResponse(404, "Not found");
  const token = match[1];
  try {
    const grantRaw = await env.OAUTH_KV.get(grantKey(token));
    if (!grantRaw) return errorResponse(404, "Download link is invalid or expired.");
    const grant = JSON.parse(grantRaw) as DownloadGrant;
    if (!grant.userId || !grant.jobId || !Number.isInteger(grant.sceneNumber) ||
        grant.audioKey !== audioKey(grant.userId, grant.jobId, grant.sceneNumber) ||
        grant.expiresAt <= Date.now()) {
      await env.OAUTH_KV.delete(grantKey(token));
      return errorResponse(404, "Download link is invalid or expired.");
    }
    const artifactRaw = await env.OAUTH_KV.get(grant.audioKey);
    if (!artifactRaw) return errorResponse(404, "Audio artifact not found or expired.");
    const artifact = JSON.parse(artifactRaw) as AudioArtifact;
    const allowedTypes: Record<string, string> = {
      mp3: "audio/mpeg",
      wav: "audio/wav",
      opus: "audio/ogg",
    };
    if (artifact.schemaVersion !== 1 || artifact.jobId !== grant.jobId ||
        artifact.sceneNumber !== grant.sceneNumber || !allowedTypes[artifact.format] ||
        artifact.contentType !== allowedTypes[artifact.format] && !(artifact.format === "mp3" && artifact.contentType === "audio/mp3") ||
        typeof artifact.audioBase64 !== "string") {
      return errorResponse(500, "Stored audio artifact failed validation.");
    }
    const bytes = decodeBase64(artifact.audioBase64);
    if (bytes.byteLength !== artifact.byteLength || bytes.byteLength === 0 || bytes.byteLength > 18 * 1024 * 1024) {
      return errorResponse(500, "Stored audio artifact failed integrity validation.");
    }
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": allowedTypes[artifact.format],
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename="scene-${grant.sceneNumber}.${artifact.format}"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (error) {
    console.error("Audio artifact delivery failed:", error instanceof Error ? error.message : "unknown error");
    return errorResponse(500, "Unable to deliver audio artifact.");
  }
}

export function registerAudioDeliveryTools(server: McpServer, authProps: Props | undefined, env: DeliveryEnv) {
  server.registerTool(
    "create_video_audio_download_link",
    {
      description: "Create a short-lived (10-minute), opaque bearer URL for a generated scene audio artifact so an external FFmpeg renderer can download the binary audio without sending it through MCP. Treat the returned URL as a secret. Does not publish or upload anything.",
      inputSchema: { jobId: z.string().uuid(), sceneNumber: z.number().int().min(1) },
    },
    async ({ jobId, sceneNumber }) => {
      try {
        const userId = authProps?.userId;
        if (!userId) throw new Error("Authentication required.");
        if (!env.MEDIA_BASE_URL) throw new Error("MEDIA_BASE_URL must be configured as the HTTPS base URL of this Worker before issuing renderer download links.");
        const base = new URL(env.MEDIA_BASE_URL);
        if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
          throw new Error("MEDIA_BASE_URL must be an HTTPS base URL without credentials, query, or fragment.");
        }
        const jobRaw = await env.OAUTH_KV.get(`youtube:video-job:${userId}:${jobId}`);
        if (!jobRaw) throw new Error("Video job not found or expired.");
        const job = JSON.parse(jobRaw) as { userId?: string };
        if (job.userId !== userId) throw new Error("Video job does not belong to this account.");
        const key = audioKey(userId, jobId, sceneNumber);
        const artifactRaw = await env.OAUTH_KV.get(key);
        if (!artifactRaw) throw new Error("Generated audio artifact not found for this scene.");
        const artifact = JSON.parse(artifactRaw) as AudioArtifact;
        if (artifact.jobId !== jobId || artifact.sceneNumber !== sceneNumber || !artifact.audioBase64) {
          throw new Error("Stored audio artifact failed validation.");
        }
        const random = new Uint8Array(32);
        crypto.getRandomValues(random);
        const token = Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("");
        const grant: DownloadGrant = {
          audioKey: key, userId, jobId, sceneNumber, expiresAt: Date.now() + GRANT_TTL_SECONDS * 1000,
        };
        await env.OAUTH_KV.put(grantKey(token), JSON.stringify(grant), { expirationTtl: GRANT_TTL_SECONDS });
        const root = base.toString().replace(/\/$/, "");
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            jobId, sceneNumber, expiresInSeconds: GRANT_TTL_SECONDS,
            downloadUrl: `${root}/media/audio/${token}`,
            note: "This URL is a bearer secret. Do not log, share, or expose it to browsers; pass it directly to the trusted renderer and request a fresh link after expiry.",
          }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Could not create audio download link." }],
          isError: true,
        };
      }
    },
  );
}
