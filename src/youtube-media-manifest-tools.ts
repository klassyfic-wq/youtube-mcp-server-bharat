import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Props } from "./utils.ts";

type MediaEnv = Env;
type StoredJob = {
  jobId: string;
  userId: string;
  brief: { language: string; durationMinutes: number; aspectRatio: "16:9" | "9:16" | "1:1" };
  stage: "brief" | "script" | "assets" | "render" | "review" | "upload" | "completed";
  artifacts: Record<string, string>;
  updatedAt: string;
};

const TTL_SECONDS = 30 * 24 * 60 * 60;
const jobKey = (userId: string, jobId: string) => `youtube:video-job:${userId}:${jobId}`;
const scriptKey = (userId: string, jobId: string) => `youtube:video-script:${userId}:${jobId}`;
const scenesKey = (userId: string, jobId: string) => `youtube:video-scenes:${userId}:${jobId}`;
const manifestKey = (userId: string, jobId: string) => `youtube:video-media-manifest:${userId}:${jobId}`;

const ScriptSchema = z.object({
  title: z.string().min(1),
  narration: z.string().min(1),
  description: z.string(),
  tags: z.array(z.string()),
});
const ScenePlanSchema = z.object({
  scenes: z.array(z.object({
    sceneNumber: z.number().int().positive(),
    durationSeconds: z.number().int().positive(),
    narration: z.string().min(1),
    visualPrompt: z.string().min(1),
    onScreenText: z.string(),
    transition: z.enum(["cut", "fade", "dissolve", "slide"]),
  })).min(1),
  totalDurationSeconds: z.number().positive(),
});

function response(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}
function failure(error: unknown) {
  console.error("Media manifest preparation failed:", error instanceof Error ? error.message : "unknown error");
  return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Media manifest preparation failed." }], isError: true };
}
function srtTime(seconds: number) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(milli).padStart(3, "0")}`;
}
function splitCaption(text: string, maxWords = 8) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += maxWords) chunks.push(words.slice(i, i + maxWords).join(" "));
  return chunks.length ? chunks : [text.trim()];
}

export function registerVideoMediaManifestTools(server: McpServer, authProps: Props | undefined, env: MediaEnv) {
  server.registerTool(
    "prepare_video_media_manifest",
    {
      description: "Prepare a deterministic production manifest from the approved script and scene plan. Includes scene visual prompts, per-scene voiceover requests, and timed SRT subtitles. It does not call a TTS/image provider or render media.",
      inputSchema: { jobId: z.string().uuid() },
    },
    async ({ jobId }) => {
      try {
        const userId = authProps?.userId;
        if (!userId) throw new Error("Authentication required.");
        const key = jobKey(userId, jobId);
        const rawJob = await env.OAUTH_KV.get(key);
        if (!rawJob) throw new Error("Video job not found or expired.");
        const job = JSON.parse(rawJob) as StoredJob;
        if (job.userId !== userId) throw new Error("Video job does not belong to this account.");
        if (job.stage !== "script" && job.stage !== "assets") throw new Error("Generate the script and scene plan first; job must be at script or assets stage.");

        const [rawScript, rawScenes] = await Promise.all([
          env.OAUTH_KV.get(scriptKey(userId, jobId)),
          env.OAUTH_KV.get(scenesKey(userId, jobId)),
        ]);
        if (!rawScript || !rawScenes) throw new Error("Saved script and scene plan are both required.");
        const script = ScriptSchema.parse(JSON.parse(rawScript));
        const scenePlan = ScenePlanSchema.parse(JSON.parse(rawScenes));
        const totalSeconds = scenePlan.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0);
        if (Math.abs(totalSeconds - scenePlan.totalDurationSeconds) > 1) throw new Error("Stored scene duration metadata is inconsistent.");

        let cursor = 0;
        let cueNumber = 1;
        const cues: Array<{ start: number; end: number; text: string }> = [];
        const voiceoverTracks = scenePlan.scenes.map((scene) => {
          const start = cursor;
          const end = start + scene.durationSeconds;
          const captions = splitCaption(scene.narration);
          const weights = captions.map((caption) => Math.max(1, caption.split(/\s+/).length));
          const weightTotal = weights.reduce((a, b) => a + b, 0);
          let local = start;
          captions.forEach((caption, index) => {
            const cueDuration = index === captions.length - 1
              ? end - local
              : scene.durationSeconds * (weights[index] / weightTotal);
            cues.push({ start: local, end: local + cueDuration, text: caption });
            local += cueDuration;
          });
          cursor = end;
          return {
            sceneNumber: scene.sceneNumber,
            startSeconds: start,
            durationSeconds: scene.durationSeconds,
            narrationText: scene.narration,
            ttsRequest: {
              text: scene.narration,
              language: job.brief.language,
              outputFormat: "mp3",
              sampleRateHz: 48000,
              voiceId: null,
              provider: "unselected",
            },
            visualRequest: { prompt: scene.visualPrompt, aspectRatio: job.brief.aspectRatio },
            transition: scene.transition,
            onScreenText: scene.onScreenText,
          };
        });
        const srt = cues.map((cue) => `${cueNumber++}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}\n`).join("\n");
        const manifest = {
          schemaVersion: 1,
          jobId,
          language: job.brief.language,
          title: script.title,
          targetDurationSeconds: totalSeconds,
          aspectRatio: job.brief.aspectRatio,
          voiceoverTracks,
          subtitles: { format: "srt", content: srt },
          renderer: { engine: "ffmpeg", status: "not_started", requiredInputs: ["voiceover audio files", "visual assets", "subtitle.srt"] },
          providerStatus: { textToSpeech: "not_configured", imageGeneration: "not_configured", rendering: "external_worker_required" },
          createdAt: new Date().toISOString(),
        };
        const artifact = manifestKey(userId, jobId);
        await env.OAUTH_KV.put(artifact, JSON.stringify(manifest), { expirationTtl: TTL_SECONDS });
        job.stage = "assets";
        job.artifacts = { ...job.artifacts, mediaManifest: `kv://${artifact}`, subtitles: `kv://${artifact}#subtitles` };
        job.updatedAt = new Date().toISOString();
        await env.OAUTH_KV.put(key, JSON.stringify(job), { expirationTtl: TTL_SECONDS });
        return response({
          jobId,
          stage: job.stage,
          artifactRef: `kv://${artifact}`,
          sceneCount: voiceoverTracks.length,
          subtitleCueCount: cues.length,
          totalDurationSeconds: totalSeconds,
          providerStatus: manifest.providerStatus,
          note: "This is a validated production manifest only. No audio, images, or video were generated; provider adapters and an external FFmpeg worker are still required.",
        });
      } catch (error) {
        return failure(error);
      }
    },
  );
}
