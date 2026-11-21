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


test("saves structured approved plan under the exact KV keys read by manifest tool", async () => {
  const kv = fakeKv();
  const server = fakeServer();
  const jobId = "861d38bc-7501-40a2-89af-d43ff0c1b370";
  const userId = "manifest-user";
  const script = {
    title: "Welcome to Klassyfic Videos",
    narration: "नमस्कार! स्वागत आहे Klassyfic Videos मध्ये! इथे मिळतील तुम्हाला नवनवीन माहिती, मनोरंजक गोष्टी आणि उपयोगी व्हिडिओ. चला, शिकूया काहीतरी नवीन!",
    description: "Klassyfic Videos channel introduction.",
    tags: ["Klassyfic Videos", "Introduction"],
  };
  const scenePlan = {
    totalDurationSeconds: 15,
    scenes: [
      { sceneNumber: 1, durationSeconds: 4, narration: "नमस्कार! स्वागत आहे Klassyfic Videos मध्ये!", visualPrompt: "Klassyfic Videos logo reveal with energetic motion graphics", onScreenText: "Welcome to Klassyfic Videos", transition: "fade" },
      { sceneNumber: 2, durationSeconds: 5, narration: "इथे मिळतील तुम्हाला नवनवीन माहिती, मनोरंजक गोष्टी", visualPrompt: "Fast montage of knowledge, technology and interesting topics", onScreenText: "नवीन माहिती", transition: "cut" },
      { sceneNumber: 3, durationSeconds: 6, narration: "आणि उपयोगी व्हिडिओ. चला, शिकूया काहीतरी नवीन!", visualPrompt: "Channel name with the tagline revealed on a clean branded background", onScreenText: "नवीन माहिती, नवा अनुभव!", transition: "fade" },
    ],
  };
  kv.values.set(`youtube:video-job:${userId}:${jobId}`, JSON.stringify({
    jobId, userId, brief: { language: "Marathi", durationMinutes: 0.25, aspectRatio: "16:9" },
    stage: "script", artifacts: { script: "manual:script", scenePlan: "manual:scenePlan" },
    updatedAt: "2026-11-21T19:27:39.965Z",
  }));
  registerVideoMediaManifestTools(server, { userId }, { OAUTH_KV: kv });

  const saved = parse(await server.handlers.get("save_approved_video_plan")({ jobId, script, scenePlan }));
  assert.equal(saved.stage, "script");
  assert.equal(saved.sceneCount, 3);
  assert.equal(saved.totalDurationSeconds, 15);
  assert.ok(kv.values.has(`youtube:video-script:${userId}:${jobId}`));
  assert.ok(kv.values.has(`youtube:video-scenes:${userId}:${jobId}`));

  const manifestResult = parse(await server.handlers.get("prepare_video_media_manifest")({ jobId }));
  assert.equal(manifestResult.stage, "assets");
  assert.equal(manifestResult.sceneCount, 3);
  assert.equal(manifestResult.totalDurationSeconds, 15);
  assert.equal(manifestResult.providerStatus.textToSpeech, "not_configured");
  const manifest = JSON.parse(kv.values.get(`youtube:video-media-manifest:${userId}:${jobId}`));
  assert.match(manifest.subtitles.content, /नमस्कार/);
  assert.equal(manifest.voiceoverTracks.length, 3);
  assert.equal(manifest.renderer.status, "not_started");
});

test("rejects invalid approved plan without writing dedicated artifacts or advancing stage", async () => {
  const kv = fakeKv();
  const server = fakeServer();
  const jobId = "861d38bc-7501-40a2-89af-d43ff0c1b370";
  const userId = "manifest-user";
  const script = { title: "Welcome", narration: "नमस्कार!", description: "Intro", tags: [] };
  const scenePlan = {
    totalDurationSeconds: 20,
    scenes: [{ sceneNumber: 1, durationSeconds: 15, narration: "नमस्कार!", visualPrompt: "A welcoming channel logo reveal", onScreenText: "Welcome", transition: "fade" }],
  };
  kv.values.set(`youtube:video-job:${userId}:${jobId}`, JSON.stringify({
    jobId, userId, brief: { language: "Marathi", durationMinutes: 0.25, aspectRatio: "16:9" },
    stage: "script", artifacts: {}, updatedAt: new Date().toISOString(),
  }));
  registerVideoMediaManifestTools(server, { userId }, { OAUTH_KV: kv });
  const result = await server.handlers.get("save_approved_video_plan")({ jobId, script, scenePlan });
  assert.equal(result.isError, true);
  assert.equal(kv.values.has(`youtube:video-script:${userId}:${jobId}`), false);
  assert.equal(kv.values.has(`youtube:video-scenes:${userId}:${jobId}`), false);
  assert.equal(JSON.parse(kv.values.get(`youtube:video-job:${userId}:${jobId}`)).stage, "script");
});

test("does not overwrite plans after the job has advanced beyond script stage", async () => {
  const kv = fakeKv();
  const server = fakeServer();
  const jobId = "861d38bc-7501-40a2-89af-d43ff0c1b370";
  const userId = "manifest-user";
  kv.values.set(`youtube:video-job:${userId}:${jobId}`, JSON.stringify({
    jobId, userId, brief: { language: "Marathi", durationMinutes: 0.25, aspectRatio: "16:9" },
    stage: "assets", artifacts: {}, updatedAt: new Date().toISOString(),
  }));
  registerVideoMediaManifestTools(server, { userId }, { OAUTH_KV: kv });
  const result = await server.handlers.get("save_approved_video_plan")({
    jobId,
    script: { title: "Welcome", narration: "नमस्कार!", description: "Intro", tags: [] },
    scenePlan: { totalDurationSeconds: 15, scenes: [{ sceneNumber: 1, durationSeconds: 15, narration: "नमस्कार!", visualPrompt: "A welcoming logo reveal", onScreenText: "Welcome", transition: "fade" }] },
  });
  assert.equal(result.isError, true);
  assert.equal(kv.values.has(`youtube:video-script:${userId}:${jobId}`), false);
});


test("get_video_media_manifest returns full manifest, SRT, and integrity diagnostics without writes", async () => {
  const kv = fakeKv(), server = fakeServer();
  const jobId = "861d38bc-7501-40a2-89af-d43ff0c1b370", userId = "manifest-reader";
  const key = `youtube:video-job:${userId}:${jobId}`, manifestKey = `youtube:video-media-manifest:${userId}:${jobId}`;
  const manifest = { jobId, targetDurationSeconds: 4, voiceoverTracks: [{ sceneNumber: 1, startSeconds: 0, durationSeconds: 4, narrationText: "नमस्कार!", visualRequest: { prompt: "Logo reveal" }, onScreenText: "Klassyfic Videos" }], subtitles: { format: "srt", content: "1\n00:00:00,000 --> 00:00:04,000\nनमस्कार!\n" }, providerStatus: { textToSpeech: "not_configured" } };
  kv.values.set(key, JSON.stringify({ jobId, userId, stage: "assets", artifacts: { mediaManifest: `kv://${manifestKey}`, subtitles: `kv://${manifestKey}#subtitles` } }));
  kv.values.set(manifestKey, JSON.stringify(manifest));
  registerVideoMediaManifestTools(server, { userId }, { OAUTH_KV: kv });
  const before = [...kv.values.entries()];
  const result = parse(await server.handlers.get("get_video_media_manifest")({ jobId }));
  assert.equal(result.readOnly, true); assert.equal(result.manifest.jobId, jobId);
  assert.equal(result.subtitlesSrt, manifest.subtitles.content); assert.equal(result.validation.sceneCount, 1);
  assert.equal(result.validation.subtitleCueCount, 1); assert.equal(result.validation.narrationMatchesSubtitles, true);
  assert.deepEqual([...kv.values.entries()], before);
});

test("get_video_media_manifest rejects unauthenticated and cross-account access", async () => {
  const kv = fakeKv(), server = fakeServer(), jobId = "861d38bc-7501-40a2-89af-d43ff0c1b370";
  kv.values.set(`youtube:video-job:owner:${jobId}`, JSON.stringify({ jobId, userId: "owner", artifacts: {} }));
  registerVideoMediaManifestTools(server, undefined, { OAUTH_KV: kv });
  const unauth = await server.handlers.get("get_video_media_manifest")({ jobId });
  assert.equal(unauth.isError, true); assert.match(unauth.content[0].text, /Authentication required/);
  registerVideoMediaManifestTools(server, { userId: "other" }, { OAUTH_KV: kv });
  const cross = await server.handlers.get("get_video_media_manifest")({ jobId });
  assert.equal(cross.isError, true); assert.match(cross.content[0].text, /not found|does not belong/);
});

test("get_video_media_manifest rejects missing or mismatched artifact references", async () => {
  const kv = fakeKv(), server = fakeServer(), jobId = "861d38bc-7501-40a2-89af-d43ff0c1b370", userId = "reader";
  kv.values.set(`youtube:video-job:${userId}:${jobId}`, JSON.stringify({ jobId, userId, artifacts: { mediaManifest: "kv://wrong", subtitles: "kv://wrong#subtitles" } }));
  registerVideoMediaManifestTools(server, { userId }, { OAUTH_KV: kv });
  const result = await server.handlers.get("get_video_media_manifest")({ jobId });
  assert.equal(result.isError, true); assert.match(result.content[0].text, /valid media manifest reference/);
});

test("get_video_media_manifest diagnoses bad SRT timing and subtitle text", async () => {
  const kv = fakeKv(), server = fakeServer(), jobId = "861d38bc-7501-40a2-89af-d43ff0c1b370", userId = "reader";
  const key = `youtube:video-job:${userId}:${jobId}`, mk = `youtube:video-media-manifest:${userId}:${jobId}`;
  kv.values.set(key, JSON.stringify({ jobId, userId, artifacts: { mediaManifest: `kv://${mk}`, subtitles: `kv://${mk}#subtitles` } }));
  kv.values.set(mk, JSON.stringify({ jobId, targetDurationSeconds: 2, voiceoverTracks: [{ sceneNumber: 1, startSeconds: 0, durationSeconds: 2, narrationText: "Hello", visualRequest: { prompt: "Visual" } }], subtitles: { format: "srt", content: "1\n00:00:00,500 --> 00:00:01,000\nWrong text\n" } }));
  registerVideoMediaManifestTools(server, { userId }, { OAUTH_KV: kv });
  const result = parse(await server.handlers.get("get_video_media_manifest")({ jobId }));
  assert.equal(result.validation.narrationMatchesSubtitles, false); assert.equal(result.validation.hasTimingOrContentIssues, true);
  assert.ok(result.validation.issues.some((x) => x.includes("gap or overlap")));
  assert.ok(result.validation.issues.some((x) => x.includes("does not exactly reconstruct")));
  kv.values.set(mk, JSON.stringify({ jobId, targetDurationSeconds: 2, voiceoverTracks: [], subtitles: { format: "srt", content: "" } }));
  const missing = await server.handlers.get("get_video_media_manifest")({ jobId });
  assert.equal(missing.isError, true); assert.match(missing.content[0].text, /SRT subtitles are missing/);
});

test("get_video_media_manifest handles missing job and manifest records", async () => {
  const kv = fakeKv(), server = fakeServer(), jobId = "861d38bc-7501-40a2-89af-d43ff0c1b370", userId = "reader";
  registerVideoMediaManifestTools(server, { userId }, { OAUTH_KV: kv });
  const noJob = await server.handlers.get("get_video_media_manifest")({ jobId });
  assert.equal(noJob.isError, true); assert.match(noJob.content[0].text, /Video job not found/);
  const mk = `youtube:video-media-manifest:${userId}:${jobId}`;
  kv.values.set(`youtube:video-job:${userId}:${jobId}`, JSON.stringify({ jobId, userId, artifacts: { mediaManifest: `kv://${mk}`, subtitles: `kv://${mk}#subtitles` } }));
  const noManifest = await server.handlers.get("get_video_media_manifest")({ jobId });
  assert.equal(noManifest.isError, true); assert.match(noManifest.content[0].text, /Saved media manifest not found/);
});
