import test from "node:test";
import assert from "node:assert/strict";
import { registerVideoMediaManifestTools } from "../src/youtube-media-manifest-tools.ts";

function fakeServer() {
  const handlers = new Map();
  return { handlers, registerTool(name, _config, handler) { handlers.set(name, handler); } };
}
function fakeKv() {
  const values = new Map();
  return { values, async get(key) { return values.get(key) ?? null; }, async put(key, value) { values.set(key, value); } };
}
function parse(result) { return JSON.parse(result.content[0].text); }

test("media manifest creates timed Marathi subtitles and voiceover/visual requests", async () => {
  const kv = fakeKv();
  const server = fakeServer();
  const jobId = "123e4567-e89b-42d3-a456-426614174000";
  const userId = "manifest-user";
  kv.values.set(`youtube:video-job:${userId}:${jobId}`, JSON.stringify({
    jobId, userId, brief: { language: "Marathi", durationMinutes: 1, aspectRatio: "16:9" },
    stage: "script", artifacts: {}, updatedAt: new Date().toISOString(),
  }));
  kv.values.set(`youtube:video-script:${userId}:${jobId}`, JSON.stringify({
    title: "AI भारतात", narration: "मराठी निवेदन", description: "", tags: [],
  }));
  kv.values.set(`youtube:video-scenes:${userId}:${jobId}`, JSON.stringify({
    scenes: [{
      sceneNumber: 1, durationSeconds: 60, narration: "नमस्कार मित्रांनो आज आपण AI बद्दल जाणून घेऊ",
      visualPrompt: "A detailed cinematic view of an Indian technology classroom",
      onScreenText: "AI भारतात", transition: "fade",
    }],
    totalDurationSeconds: 60,
  }));
  registerVideoMediaManifestTools(server, { userId, name: "Test", email: "test@example.com", accessToken: "" }, { OAUTH_KV: kv });

  const result = parse(await server.handlers.get("prepare_video_media_manifest")({ jobId }));
  assert.equal(result.stage, "assets");
  assert.equal(result.sceneCount, 1);
  assert.ok(result.subtitleCueCount > 0);
  const manifest = JSON.parse(kv.values.get(`youtube:video-media-manifest:${userId}:${jobId}`));
  assert.equal(manifest.voiceoverTracks[0].ttsRequest.language, "Marathi");
  assert.equal(manifest.voiceoverTracks[0].ttsRequest.provider, "unselected");
  assert.match(manifest.subtitles.content, /00:00:00,000 -->/);
  assert.equal(JSON.parse(kv.values.get(`youtube:video-job:${userId}:${jobId}`)).stage, "assets");
});

test("media manifest rejects cross-user or missing scene data", async () => {
  const kv = fakeKv();
  const server = fakeServer();
  const jobId = "123e4567-e89b-42d3-a456-426614174001";
  kv.values.set(`youtube:video-job:owner:${jobId}`, JSON.stringify({
    jobId, userId: "owner", brief: { language: "Marathi", durationMinutes: 1, aspectRatio: "16:9" },
    stage: "script", artifacts: {},
  }));
  registerVideoMediaManifestTools(server, { userId: "other-user", name: "Test", email: "test@example.com", accessToken: "" }, { OAUTH_KV: kv });
  const result = await server.handlers.get("prepare_video_media_manifest")({ jobId });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not found|does not belong/);
});
