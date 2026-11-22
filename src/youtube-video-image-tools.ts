import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Props } from "./utils.ts";

type ImageEnv = Env & { IMAGE_API_URL?: string; IMAGE_API_KEY?: string; IMAGE_MODEL?: string; MEDIA_BASE_URL?: string; TTS_API_URL?: string; TTS_API_KEY?: string };
type StoredJob = { jobId: string; userId: string; stage: string; artifacts: Record<string, string>; updatedAt: string };
type VisualTrack = { sceneNumber: number; visualRequest: { prompt: string; aspectRatio: string }; imageArtifactRef?: string; imageStatus?: string };
type Manifest = { jobId: string; voiceoverTracks: VisualTrack[]; providerStatus?: Record<string, string> };
type ImageArtifact = { schemaVersion: 1; jobId: string; sceneNumber: number; format: "png" | "jpeg"; contentType: string; byteLength: number; imageBase64: string; createdAt: string };

const TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const jobKey = (userId: string, jobId: string) => `youtube:video-job:${userId}:${jobId}`;
const manifestKey = (userId: string, jobId: string) => `youtube:video-media-manifest:${userId}:${jobId}`;
const imageKey = (userId: string, jobId: string, sceneNumber: number) => `youtube:video-image:${userId}:${jobId}:${sceneNumber}`;
const grantKey = (token: string) => `youtube:image-download-grant:${token}`;

function response(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] }; }
function failure(error: unknown) {
  console.error("Video image generation failed:", error instanceof Error ? error.message : "unknown error");
  return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Video image generation failed." }], isError: true };
}
function configuredEndpoint(env: ImageEnv): URL {
  const imageApiUrl = env.IMAGE_API_URL ?? env.TTS_API_URL?.replace(/\/v1\/audio\/speech\/?$/, "/v1/images/generations");
  const imageApiKey = env.IMAGE_API_KEY ?? env.TTS_API_KEY;
  const imageModel = env.IMAGE_MODEL ?? "gemini-2.5-flash-image";
  if (!imageApiUrl || !imageApiKey || !imageModel) {
    throw new Error("Image provider is not configured. Set IMAGE_API_URL/IMAGE_API_KEY/IMAGE_MODEL or configure the shared renderer TTS endpoint and key. No provider has been called.");
  }
  let endpoint: URL;
  try { endpoint = new URL(imageApiUrl); } catch { throw new Error("IMAGE_API_URL must be a valid HTTPS endpoint."); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error("IMAGE_API_URL must use HTTPS and must not contain embedded credentials or a fragment.");
  }
  return endpoint;
}
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  return btoa(binary);
}
function decodeBase64(value: string): Uint8Array {
  const binary = atob(value); const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function detectImage(bytes: Uint8Array): { format: "png" | "jpeg"; contentType: string } {
  const png = bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v);
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (png) return { format: "png", contentType: "image/png" };
  if (jpeg) return { format: "jpeg", contentType: "image/jpeg" };
  throw new Error("Image provider returned data that is not a PNG or JPEG. No image was saved.");
}

export async function handleImageArtifactRequest(request: Request, env: Env): Promise<Response> {
  const headers = { "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET" } });
  const match = new URL(request.url).pathname.match(/^\/media\/image\/([a-f0-9]{64})$/);
  if (!match) return new Response("Not found", { status: 404, headers });
  try {
    const token = match[1];
    const grantRaw = await env.OAUTH_KV.get(grantKey(token));
    if (!grantRaw) return new Response("Download link is invalid or expired.", { status: 404, headers });
    const grant = JSON.parse(grantRaw) as { imageKey: string; userId: string; jobId: string; sceneNumber: number; expiresAt: number };
    if (grant.expiresAt <= Date.now() || grant.imageKey !== imageKey(grant.userId, grant.jobId, grant.sceneNumber)) return new Response("Download link is invalid or expired.", { status: 404, headers });
    const raw = await env.OAUTH_KV.get(grant.imageKey);
    if (!raw) return new Response("Image artifact not found or expired.", { status: 404, headers });
    const artifact = JSON.parse(raw) as ImageArtifact;
    if (artifact.schemaVersion !== 1 || artifact.jobId !== grant.jobId || artifact.sceneNumber !== grant.sceneNumber ||
        (artifact.format !== "png" && artifact.format !== "jpeg") || artifact.contentType !== (artifact.format === "png" ? "image/png" : "image/jpeg")) {
      return new Response("Stored image artifact failed validation.", { status: 500, headers });
    }
    const bytes = decodeBase64(artifact.imageBase64);
    if (!bytes.length || bytes.length !== artifact.byteLength || bytes.length > MAX_IMAGE_BYTES) return new Response("Stored image artifact failed integrity validation.", { status: 500, headers });
    const signature = detectImage(bytes);
    if (signature.format !== artifact.format) return new Response("Stored image signature mismatch.", { status: 500, headers });
    return new Response(bytes, { status: 200, headers: { ...headers, "Content-Type": artifact.contentType, "Content-Length": String(bytes.length), "Content-Disposition": `attachment; filename="scene-${grant.sceneNumber}.${artifact.format}"` } });
  } catch (error) {
    console.error("Image artifact delivery failed:", error instanceof Error ? error.message : "unknown error");
    return new Response("Unable to deliver image artifact.", { status: 500, headers });
  }
}

export function registerVideoImageTools(server: McpServer, authProps: Props | undefined, env: ImageEnv) {
  server.registerTool("generate_video_scene_image", {
    description: "Generate one scene image using a configured OpenAI-compatible image generation endpoint. Only provider-returned base64 PNG/JPEG is accepted; remote URLs are never fetched. Image is stored privately and is not returned inline.",
    inputSchema: { jobId: z.string().uuid(), sceneNumber: z.number().int().min(1), promptOverride: z.string().min(1).max(4000).optional() },
  }, async ({ jobId, sceneNumber, promptOverride }) => {
    try {
      const userId = authProps?.userId;
      if (!userId) throw new Error("Authentication required.");
      const rawJob = await env.OAUTH_KV.get(jobKey(userId, jobId));
      if (!rawJob) throw new Error("Video job not found or expired.");
      const job = JSON.parse(rawJob) as StoredJob;
      if (job.userId !== userId) throw new Error("Video job does not belong to this account.");
      if (job.stage !== "assets") throw new Error("Image generation requires a job at assets stage.");
      const rawManifest = await env.OAUTH_KV.get(manifestKey(userId, jobId));
      if (!rawManifest) throw new Error("Media manifest not found. Run prepare_video_media_manifest first.");
      const manifest = JSON.parse(rawManifest) as Manifest;
      if (manifest.jobId !== jobId || !Array.isArray(manifest.voiceoverTracks)) throw new Error("Media manifest failed validation.");
      const track = manifest.voiceoverTracks.find(item => item.sceneNumber === sceneNumber);
      if (!track?.visualRequest?.prompt) throw new Error("Scene visual request does not exist in the media manifest.");
      const endpoint = configuredEndpoint(env);
      const providerResponse = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.IMAGE_API_KEY ?? env.TTS_API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ model: env.IMAGE_MODEL ?? "gemini-2.5-flash-image", prompt: promptOverride ?? track.visualRequest.prompt, n: 1, size: track.visualRequest.aspectRatio === "9:16" ? "1024x1792" : track.visualRequest.aspectRatio === "1:1" ? "1024x1024" : "1792x1024", response_format: "b64_json" }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!providerResponse.ok) throw new Error(`Configured image provider returned HTTP ${providerResponse.status}. Check provider configuration and quota.`);
      const payload = await providerResponse.json() as { data?: Array<{ b64_json?: string }> };
      const encoded = payload.data?.[0]?.b64_json;
      if (typeof encoded !== "string" || !encoded || encoded.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8) throw new Error("Image provider must return one bounded data[0].b64_json image. URL responses are not fetched.");
      let bytes: Uint8Array;
      try { bytes = decodeBase64(encoded); } catch { throw new Error("Image provider returned invalid Base64 image data."); }
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error(`Generated image exceeds the ${MAX_IMAGE_BYTES} byte per-scene storage limit.`);
      const detected = detectImage(bytes);
      const key = imageKey(userId, jobId, sceneNumber);
      const artifact: ImageArtifact = { schemaVersion: 1, jobId, sceneNumber, ...detected, byteLength: bytes.length, imageBase64: encodeBase64(bytes), createdAt: new Date().toISOString() };
      await env.OAUTH_KV.put(key, JSON.stringify(artifact), { expirationTtl: TTL_SECONDS });
      const artifactRef = `kv://${key}`;
      const nextManifest = { ...manifest, voiceoverTracks: manifest.voiceoverTracks.map(item => item.sceneNumber === sceneNumber ? { ...item, imageArtifactRef: artifactRef, imageStatus: "generated" } : item), providerStatus: { ...(manifest.providerStatus ?? {}), imageGeneration: "partially_or_fully_generated" } };
      await env.OAUTH_KV.put(manifestKey(userId, jobId), JSON.stringify(nextManifest), { expirationTtl: TTL_SECONDS });
      job.artifacts = { ...job.artifacts, [`sceneImage${sceneNumber}`]: artifactRef };
      job.updatedAt = new Date().toISOString();
      await env.OAUTH_KV.put(jobKey(userId, jobId), JSON.stringify(job), { expirationTtl: TTL_SECONDS });
      return response({ jobId, sceneNumber, status: "generated", format: detected.format, contentType: detected.contentType, byteLength: bytes.length, artifactRef, note: "Image stored privately. Use create_video_image_download_link to issue a short-lived renderer URL." });
    } catch (error) { return failure(error); }
  });

  server.registerTool("create_video_image_download_link", {
    description: "Create a short-lived (10-minute) opaque bearer URL for a generated scene image so a trusted external renderer can download the binary asset.",
    inputSchema: { jobId: z.string().uuid(), sceneNumber: z.number().int().min(1) },
  }, async ({ jobId, sceneNumber }) => {
    try {
      const userId = authProps?.userId;
      if (!userId) throw new Error("Authentication required.");
      const rawJob = await env.OAUTH_KV.get(jobKey(userId, jobId));
      if (!rawJob) throw new Error("Video job not found or expired.");
      const rawImage = await env.OAUTH_KV.get(imageKey(userId, jobId, sceneNumber));
      if (!rawImage) throw new Error("Generated scene image not found or expired.");
      const base = (env as ImageEnv).MEDIA_BASE_URL;
      if (!base) throw new Error("MEDIA_BASE_URL is not configured. Set it to the HTTPS Worker origin before issuing renderer links.");
      const baseUrl = new URL(base);
      if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new Error("MEDIA_BASE_URL must be a clean HTTPS base URL.");
      const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
      const token = Array.from(tokenBytes, b => b.toString(16).padStart(2, "0")).join("");
      const expiresAt = Date.now() + 10 * 60 * 1000;
      const key = imageKey(userId, jobId, sceneNumber);
      await env.OAUTH_KV.put(grantKey(token), JSON.stringify({ imageKey: key, userId, jobId, sceneNumber, expiresAt }), { expirationTtl: 600 });
      return response({ jobId, sceneNumber, url: `${baseUrl.origin}/media/image/${token}`, expiresAt: new Date(expiresAt).toISOString(), expiresInSeconds: 600, note: "Treat this bearer URL as a secret and pass it only to the trusted renderer." });
    } catch (error) { return failure(error); }
  });
}
