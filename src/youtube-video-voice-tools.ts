import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Props } from "./utils.ts";

type TtsEnv = Env & {
  TTS_API_URL?: string;
  TTS_API_KEY?: string;
  TTS_MODEL?: string;
  TTS_VOICE?: string;
};

type StoredJob = {
  jobId: string;
  userId: string;
  stage: "brief" | "script" | "assets" | "render" | "review" | "upload" | "completed";
  artifacts: Record<string, string>;
  updatedAt: string;
};

const TTL_SECONDS = 30 * 24 * 60 * 60;
// Base64 expands binary data by ~4/3; keep the JSON value below KV's 25 MiB value limit.
const MAX_AUDIO_BYTES = 18 * 1024 * 1024;
const jobKey = (userId: string, jobId: string) => `youtube:video-job:${userId}:${jobId}`;
const manifestKey = (userId: string, jobId: string) => `youtube:video-media-manifest:${userId}:${jobId}`;
const audioKey = (userId: string, jobId: string, sceneNumber: number) =>
  `youtube:video-audio:${userId}:${jobId}:${sceneNumber}`;

const ManifestSchema = z.object({
  jobId: z.string().uuid(),
  voiceoverTracks: z.array(z.object({
    sceneNumber: z.number().int().positive(),
    narrationText: z.string().min(1),
    ttsRequest: z.object({
      text: z.string().min(1),
      language: z.string().min(1),
      outputFormat: z.enum(["mp3", "wav", "opus"]).default("mp3"),
      sampleRateHz: z.number().int().positive().optional(),
      voiceId: z.string().nullable().optional(),
      provider: z.string().optional(),
    }),
  })).min(1),
  providerStatus: z.record(z.string(), z.string()).optional(),
});

function response(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown) {
  console.error("Video voice generation failed:", error instanceof Error ? error.message : "unknown error");
  return {
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Video voice generation failed." }],
    isError: true,
  };
}

function configuredEndpoint(env: TtsEnv): URL {
  if (!env.TTS_API_URL || !env.TTS_API_KEY || !env.TTS_MODEL || !env.TTS_VOICE) {
    throw new Error("TTS provider is not configured. Set TTS_API_URL, TTS_API_KEY, TTS_MODEL, and TTS_VOICE as Worker variables/secrets. No provider has been called.");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(env.TTS_API_URL);
  } catch {
    throw new Error("TTS_API_URL must be a valid HTTPS endpoint.");
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error("TTS_API_URL must use HTTPS and must not contain embedded credentials or a fragment.");
  }
  return endpoint;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

export function registerVideoVoiceTools(server: McpServer, authProps: Props | undefined, env: TtsEnv) {
  server.registerTool(
    "generate_video_voiceover",
    {
      description: "Generate and privately store one scene's narration audio using the configured OpenAI-compatible TTS speech endpoint. Requires a prepared media manifest and explicit TTS configuration. Does not upload or publish anything.",
      inputSchema: {
        jobId: z.string().uuid(),
        sceneNumber: z.number().int().min(1),
      },
    },
    async ({ jobId, sceneNumber }) => {
      try {
        const userId = authProps?.userId;
        if (!userId) throw new Error("Authentication required.");
        if (!z.string().uuid().safeParse(jobId).success) throw new Error("Invalid jobId.");
        const jobRaw = await env.OAUTH_KV.get(jobKey(userId, jobId));
        if (!jobRaw) throw new Error("Video job not found or expired.");
        const job = JSON.parse(jobRaw) as StoredJob;
        if (job.userId !== userId) throw new Error("Video job does not belong to this account.");
        if (job.stage !== "assets") throw new Error("Voice generation requires a job at assets stage.");

        const manifestRaw = await env.OAUTH_KV.get(manifestKey(userId, jobId));
        if (!manifestRaw) throw new Error("Media manifest not found. Run prepare_video_media_manifest first.");
        const manifest = ManifestSchema.parse(JSON.parse(manifestRaw));
        if (manifest.jobId !== jobId) throw new Error("Media manifest job ID mismatch.");
        const track = manifest.voiceoverTracks.find((item) => item.sceneNumber === sceneNumber);
        if (!track) throw new Error("Scene number does not exist in the media manifest.");

        const endpoint = configuredEndpoint(env);
        const format = track.ttsRequest.outputFormat;
        const requestId = crypto.randomUUID();
        const ttsResponse = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.TTS_API_KEY}`,
            "Content-Type": "application/json",
            "x-request-id": requestId,
            Accept: format === "mp3" ? "audio/mpeg" : format === "wav" ? "audio/wav" : "audio/ogg",
          },
          body: JSON.stringify({
            model: env.TTS_MODEL,
            voice: track.ttsRequest.voiceId ?? env.TTS_VOICE,
            input: track.ttsRequest.text,
            response_format: format,
            ...(track.ttsRequest.sampleRateHz ? { sample_rate: track.ttsRequest.sampleRateHz } : {}),
          }),
          signal: AbortSignal.timeout(120_000),
        });
        if (!ttsResponse.ok) {
          const errorBody = await ttsResponse.json().catch(() => ({})) as {
            error?: unknown;
            authDiagnostics?: {
              secretConfigured?: boolean;
              authorizationHeaderPresent?: boolean;
              bearerPrefixPresent?: boolean;
              tokenMatchesConfiguredSecret?: boolean;
            };
          };
          const rendererError = typeof errorBody.error === "string" ? errorBody.error.slice(0, 120) : "non-JSON error response";
          const authDiagnostics = errorBody.authDiagnostics;
          console.error(JSON.stringify({ event: "tts_upstream_rejected", requestId, status: ttsResponse.status, rendererError, authDiagnostics }));
          throw new Error(`Renderer returned HTTP ${ttsResponse.status}: ${rendererError}. authDiagnostics=${JSON.stringify(authDiagnostics ?? null)}. requestId=${requestId}`);
        }
        const contentType = (ttsResponse.headers.get("content-type") ?? "").toLowerCase();
        const allowedTypes = format === "mp3"
          ? ["audio/mpeg", "audio/mp3"]
          : format === "wav" ? ["audio/wav", "audio/x-wav"] : ["audio/ogg", "audio/opus"];
        if (!allowedTypes.some((type) => contentType.includes(type))) {
          throw new Error(`TTS provider returned an unsupported content type (${contentType || "missing"}); expected audio/${format}. No audio was saved.`);
        }
        const audio = new Uint8Array(await ttsResponse.arrayBuffer());
        if (!audio.length) throw new Error("TTS provider returned an empty audio file. No audio was saved.");
        if (audio.length > MAX_AUDIO_BYTES) {
          throw new Error(`Generated audio exceeds the ${MAX_AUDIO_BYTES} byte per-scene storage limit. No audio was saved.`);
        }

        const key = audioKey(userId, jobId, sceneNumber);
        const artifact = {
          schemaVersion: 1,
          jobId,
          sceneNumber,
          format,
          contentType,
          byteLength: audio.length,
          audioBase64: base64(audio),
          createdAt: new Date().toISOString(),
        };
        await env.OAUTH_KV.put(key, JSON.stringify(artifact), { expirationTtl: TTL_SECONDS });
        const artifactRef = `kv://${key}`;
        const nextManifest = {
          ...manifest,
          voiceoverTracks: manifest.voiceoverTracks.map((item) => item.sceneNumber === sceneNumber
            ? { ...item, audioArtifactRef: artifactRef, audioStatus: "generated" }
            : item),
          providerStatus: { ...(manifest.providerStatus ?? {}), textToSpeech: "partially_or_fully_generated" },
        };
        await env.OAUTH_KV.put(manifestKey(userId, jobId), JSON.stringify(nextManifest), { expirationTtl: TTL_SECONDS });
        job.artifacts = { ...job.artifacts, [`voiceoverScene${sceneNumber}`]: artifactRef };
        job.updatedAt = new Date().toISOString();
        await env.OAUTH_KV.put(jobKey(userId, jobId), JSON.stringify(job), { expirationTtl: TTL_SECONDS });

        return response({
          jobId,
          sceneNumber,
          status: "generated",
          format,
          contentType,
          byteLength: audio.length,
          artifactRef,
          note: "Audio is stored privately in KV. A secure renderer-facing audio retrieval/streaming endpoint is still required before FFmpeg can consume it.",
        });
      } catch (error) {
        return failure(error);
      }
    },
  );
}
