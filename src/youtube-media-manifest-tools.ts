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
const audioKey = (userId: string, jobId: string, sceneNumber: number) => `youtube:video-audio:${userId}:${jobId}:${sceneNumber}`;
const imageKey = (userId: string, jobId: string, sceneNumber: number) => `youtube:video-image:${userId}:${jobId}:${sceneNumber}`;

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
    "save_approved_video_plan",
    {
      description: "Validate and persist a manually approved structured script and scene plan into the dedicated KV records consumed by prepare_video_media_manifest. This does not call AI/media providers or render anything.",
      inputSchema: {
        jobId: z.string().uuid(),
        script: ScriptSchema,
        scenePlan: ScenePlanSchema,
      },
    },
    async ({ jobId, script: inputScript, scenePlan: inputScenePlan }) => {
      try {
        const userId = authProps?.userId;
        if (!userId) throw new Error("Authentication required.");
        const key = jobKey(userId, jobId);
        const rawJob = await env.OAUTH_KV.get(key);
        if (!rawJob) throw new Error("Video job not found or expired.");
        const job = JSON.parse(rawJob) as StoredJob;
        if (job.userId !== userId) throw new Error("Video job does not belong to this account.");
        if (job.stage !== "script") throw new Error("Approved plans can only be saved while the job is at script stage.");

        const script = ScriptSchema.parse(inputScript);
        const scenePlan = ScenePlanSchema.parse(inputScenePlan);
        const summedDuration = scenePlan.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0);
        if (Math.abs(summedDuration - scenePlan.totalDurationSeconds) > 1) {
          throw new Error("Scene durations must match scenePlan.totalDurationSeconds.");
        }
        const targetSeconds = Math.round(job.brief.durationMinutes * 60);
        if (Math.abs(summedDuration - targetSeconds) > targetSeconds * 0.1) {
          throw new Error(`Scene plan duration (${summedDuration}s) is outside the allowed 10% range for the ${targetSeconds}s target.`);
        }
        if (scenePlan.scenes.some((scene, index) => scene.sceneNumber !== index + 1)) {
          throw new Error("Scene numbers must be sequential starting at 1.");
        }

        const storedScriptKey = scriptKey(userId, jobId);
        const storedScenesKey = scenesKey(userId, jobId);
        await env.OAUTH_KV.put(storedScriptKey, JSON.stringify(script), { expirationTtl: TTL_SECONDS });
        await env.OAUTH_KV.put(storedScenesKey, JSON.stringify(scenePlan), { expirationTtl: TTL_SECONDS });

        job.artifacts = {
          ...job.artifacts,
          script: `kv://${storedScriptKey}`,
          scenePlan: `kv://${storedScenesKey}`,
        };
        job.updatedAt = new Date().toISOString();
        await env.OAUTH_KV.put(key, JSON.stringify(job), { expirationTtl: TTL_SECONDS });

        return response({
          jobId,
          stage: job.stage,
          status: "approved_plan_saved",
          artifacts: {
            script: `kv://${storedScriptKey}`,
            scenePlan: `kv://${storedScenesKey}`,
          },
          sceneCount: scenePlan.scenes.length,
          totalDurationSeconds: summedDuration,
          nextAction: "Call prepare_video_media_manifest with this jobId. No AI or media provider is needed for that step.",
          note: "Structured approved plan saved to the exact KV keys consumed by the manifest tool. No provider calls or media generation occurred.",
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

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

        const previousManifestRaw = await env.OAUTH_KV.get(manifestKey(userId, jobId));
        const previousManifest = previousManifestRaw ? JSON.parse(previousManifestRaw) as { voiceoverTracks?: Array<{ sceneNumber: number; audioArtifactRef?: string; imageArtifactRef?: string }> } : undefined;

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
        const tracksWithArtifacts = await Promise.all(voiceoverTracks.map(async (track) => {
          const previous = previousManifest?.voiceoverTracks?.find((item) => item.sceneNumber === track.sceneNumber);
          const audioArtifactRef = job.artifacts?.[`voiceoverScene${track.sceneNumber}`] ?? previous?.audioArtifactRef;
          const imageArtifactRef = job.artifacts?.[`sceneImage${track.sceneNumber}`] ?? previous?.imageArtifactRef;
          const [audioExists, imageExists] = await Promise.all([
            env.OAUTH_KV.get(audioKey(userId, jobId, track.sceneNumber)),
            env.OAUTH_KV.get(imageKey(userId, jobId, track.sceneNumber)),
          ]);
          return {
            ...track,
            ...(audioExists && audioArtifactRef ? { audioArtifactRef, audioStatus: "generated" } : {}),
            ...(imageExists && imageArtifactRef ? { imageArtifactRef, imageStatus: "generated" } : {}),
          };
        }));
        const srt = cues.map((cue) => `${cueNumber++}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}\n`).join("\n");
        const manifest = {
          schemaVersion: 1,
          jobId,
          language: job.brief.language,
          title: script.title,
          targetDurationSeconds: totalSeconds,
          aspectRatio: job.brief.aspectRatio,
          voiceoverTracks: tracksWithArtifacts,
          subtitles: { format: "srt", content: srt },
          renderer: { engine: "ffmpeg", status: "not_started", requiredInputs: ["voiceover audio files", "visual assets", "subtitle.srt"] },
          providerStatus: {
            textToSpeech: tracksWithArtifacts.some((track) => track.audioStatus === "generated") ? "partially_or_fully_generated" : "not_configured",
            imageGeneration: tracksWithArtifacts.some((track) => track.imageStatus === "generated") ? "partially_or_fully_generated" : "not_configured",
            rendering: "external_worker_required",
          },
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

  server.registerTool(
    "get_video_media_manifest",
    {
      description: "Read the saved media manifest and SRT subtitles for an authenticated user's video job. Includes read-only integrity diagnostics; never regenerates or modifies artifacts.",
      inputSchema: { jobId: z.string().uuid() },
    },
    async ({ jobId }) => {
      try {
        const userId = authProps?.userId;
        if (!userId) throw new Error("Authentication required.");
        const rawJob = await env.OAUTH_KV.get(jobKey(userId, jobId));
        if (!rawJob) throw new Error("Video job not found or expired.");
        const job = JSON.parse(rawJob) as StoredJob;
        if (job.userId !== userId) throw new Error("Video job does not belong to this account.");

        const expectedManifestRef = `kv://${manifestKey(userId, jobId)}`;
        if (job.artifacts?.mediaManifest !== expectedManifestRef) throw new Error("The job does not contain a valid media manifest reference.");
        if (job.artifacts?.subtitles !== `${expectedManifestRef}#subtitles`) throw new Error("The job does not contain a valid subtitles reference.");

        const rawManifest = await env.OAUTH_KV.get(manifestKey(userId, jobId));
        if (!rawManifest) throw new Error("Saved media manifest not found or expired.");
        const manifest = JSON.parse(rawManifest) as {
          jobId?: string; targetDurationSeconds?: number;
          voiceoverTracks?: Array<{ sceneNumber?: number; startSeconds?: number; durationSeconds?: number; narrationText?: string; visualRequest?: { prompt?: string }; onScreenText?: string }>;
          subtitles?: { format?: string; content?: string }; providerStatus?: Record<string, string>;
        };
        if (manifest.jobId !== jobId) throw new Error("Stored manifest job ID does not match the requested job.");
        const tracks = Array.isArray(manifest.voiceoverTracks) ? manifest.voiceoverTracks : [];
        const subtitleText = manifest.subtitles?.content;
        if (manifest.subtitles?.format !== "srt" || typeof subtitleText !== "string" || !subtitleText.trim()) {
          throw new Error("SRT subtitles are missing from the saved manifest.");
        }

        const issues: string[] = [];
        let expectedStart = 0;
        for (let index = 0; index < tracks.length; index++) {
          const track = tracks[index];
          if (track.sceneNumber !== index + 1) issues.push(`Scene numbering is not sequential at scene ${index + 1}.`);
          if (typeof track.startSeconds !== "number" || typeof track.durationSeconds !== "number") {
            issues.push(`Scene ${index + 1} has invalid timing metadata.`); continue;
          }
          if (Math.abs(track.startSeconds - expectedStart) > 0.001) issues.push(`Scene ${index + 1} has a gap or overlap.`);
          expectedStart = track.startSeconds + track.durationSeconds;
          if (!track.narrationText?.trim()) issues.push(`Scene ${index + 1} has no narration.`);
          if (!track.visualRequest?.prompt?.trim()) issues.push(`Scene ${index + 1} has no visual prompt.`);
        }
        if (!tracks.length) issues.push("Manifest contains no scene tracks.");
        if (typeof manifest.targetDurationSeconds === "number" && Math.abs(expectedStart - manifest.targetDurationSeconds) > 0.001) issues.push("Scene track duration does not match manifest target duration.");

        const cueMatches = [...subtitleText.matchAll(/(?:^|\n)(\d+)\n(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})\n([^\n]+)(?=\n|$)/g)];
        const toSeconds = (stamp: string) => {
          const match = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(stamp);
          if (!match) return NaN;
          return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
        };
        let previousCueEnd = 0;
        const cues = cueMatches.map((match, index) => {
          const start = toSeconds(match[2]); const end = toSeconds(match[3]);
          if (Number(match[1]) !== index + 1) issues.push("Subtitle cue numbering is not sequential.");
          if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) issues.push(`Subtitle cue ${index + 1} has invalid timing.`);
          if (Math.abs(start - previousCueEnd) > 0.001) issues.push(`Subtitle cue ${index + 1} has a gap or overlap.`);
          previousCueEnd = end;
          return { number: Number(match[1]), startSeconds: start, endSeconds: end, text: match[4] };
        });
        if (!cues.length) issues.push("No valid SRT cues could be parsed.");
        if (typeof manifest.targetDurationSeconds === "number" && Math.abs(previousCueEnd - manifest.targetDurationSeconds) > 0.001) issues.push("Subtitle timeline does not end at the manifest target duration.");
        const sceneNarration = tracks.map((track) => track.narrationText ?? "").join(" ");
        const subtitleNarration = cues.map((cue) => cue.text).join(" ");
        const normalized = (value: string) => value.replace(/\s+/g, " ").trim();
        const narrationMatches = normalized(sceneNarration) === normalized(subtitleNarration);
        if (!narrationMatches) issues.push("Subtitle cue text does not exactly reconstruct the scene narration.");

        return response({
          jobId, stage: job.stage, readOnly: true,
          validation: { sceneCount: tracks.length, sceneDurationSeconds: expectedStart, subtitleCueCount: cues.length, subtitleDurationSeconds: previousCueEnd, narrationMatchesSubtitles: narrationMatches, hasTimingOrContentIssues: issues.length > 0, issues },
          manifest, subtitlesSrt: subtitleText, parsedSubtitleCues: cues, providerStatus: manifest.providerStatus ?? {},
          note: "Read-only retrieval. No KV records or job state were modified.",
        });
      } catch (error) { return failure(error); }
    },
  );

}
