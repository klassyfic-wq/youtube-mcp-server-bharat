import test from "node:test";
import assert from "node:assert/strict";
import { registerVideoVoiceTools } from "../src/youtube-video-voice-tools.ts";

function fakeServer() {
  const handlers = new Map();
  return { handlers, registerTool(name, _config, handler) { handlers.set(name, handler); } };
}
function fakeKv() {
  const values = new Map();
  return {
    values,
    async get(key) { return values.get(key) ?? null; },
    async put(key, value) { values.set(key, value); },
  };
}
function parse(result) { return JSON.parse(result.content[0].text); }
const userId = "voice-user";
const jobId = "6a7e8d3f-3a12-4b7d-8f41-5e4a2d9c0b11";
const auth = { userId, name: "Test", email: "test@example.com", accessToken: "" };
function seed(kv) {
  kv.values.set(`youtube:video-job:${userId}:${jobId}`, JSON.stringify({
    jobId, userId, stage: "assets", artifacts: {}, updatedAt: new Date().toISOString(),
  }));
  kv.values.set(`youtube:video-media-manifest:${userId}:${jobId}`, JSON.stringify({
    jobId,
    voiceoverTracks: [{
      sceneNumber: 1,
      narrationText: "नमस्कार, आज आपण कृत्रिम बुद्धिमत्तेबद्दल जाणून घेणार आहोत.",
      ttsRequest: {
        text: "नमस्कार, आज आपण कृत्रिम बुद्धिमत्तेबद्दल जाणून घेणार आहोत.",
        language: "Marathi",
        outputFormat: "mp3",
        sampleRateHz: 48000,
        voiceId: null,
        provider: "unselected",
      },
    }],
    providerStatus: { textToSpeech: "not_configured" },
  }));
}

test("TTS generates and stores a validated scene audio artifact", async () => {
  const originalFetch = globalThis.fetch;
  const kv = fakeKv();
  seed(kv);
  const env = {
    OAUTH_KV: kv,
    TTS_API_URL: "https://tts.example.test/v1/audio/speech",
    TTS_API_KEY: "test-secret",
    TTS_MODEL: "test-tts",
    TTS_VOICE: "marathi-neutral",
  };
  const server = fakeServer();
  registerVideoVoiceTools(server, auth, env);
  let requestBody;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), env.TTS_API_URL);
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-secret");
    requestBody = JSON.parse(init.body);
    return new Response(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    });
  };
  try {
    const result = parse(await server.handlers.get("generate_video_voiceover")({ jobId, sceneNumber: 1 }));
    assert.equal(result.status, "generated");
    assert.equal(result.byteLength, 6);
    assert.match(result.artifactRef, /^kv:\/\//);
    assert.equal(requestBody.model, "test-tts");
    assert.equal(requestBody.voice, "marathi-neutral");
    assert.equal(requestBody.response_format, "mp3");
    const stored = JSON.parse(kv.values.get(`youtube:video-audio:${userId}:${jobId}:1`));
    assert.equal(stored.audioBase64, "SUQzAQID");
    const manifest = JSON.parse(kv.values.get(`youtube:video-media-manifest:${userId}:${jobId}`));
    assert.equal(manifest.voiceoverTracks[0].audioStatus, "generated");
    assert.equal(manifest.voiceoverTracks[0].audioArtifactRef, result.artifactRef);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TTS refuses to call a provider when configuration is missing", async () => {
  const kv = fakeKv();
  seed(kv);
  const server = fakeServer();
  registerVideoVoiceTools(server, auth, { OAUTH_KV: kv });
  const result = await server.handlers.get("generate_video_voiceover")({ jobId, sceneNumber: 1 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /TTS provider is not configured/);
  assert.equal(kv.values.has(`youtube:video-audio:${userId}:${jobId}:1`), false);
});

test("TTS rejects unexpected content types without saving audio", async () => {
  const originalFetch = globalThis.fetch;
  const kv = fakeKv();
  seed(kv);
  const server = fakeServer();
  registerVideoVoiceTools(server, auth, {
    OAUTH_KV: kv,
    TTS_API_URL: "https://tts.example.test/v1/audio/speech",
    TTS_API_KEY: "test-secret",
    TTS_MODEL: "test-tts",
    TTS_VOICE: "marathi-neutral",
  });
  globalThis.fetch = async () => new Response("not audio", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
  try {
    const result = await server.handlers.get("generate_video_voiceover")({ jobId, sceneNumber: 1 });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /unsupported content type/);
    assert.equal(kv.values.has(`youtube:video-audio:${userId}:${jobId}:1`), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TTS enforces account ownership and job stage", async () => {
  const kv = fakeKv();
  seed(kv);
  const server = fakeServer();
  registerVideoVoiceTools(server, { ...auth, userId: "another-user" }, {
    OAUTH_KV: kv,
    TTS_API_URL: "https://tts.example.test/v1/audio/speech",
    TTS_API_KEY: "test-secret",
    TTS_MODEL: "test-tts",
    TTS_VOICE: "marathi-neutral",
  });
  const result = await server.handlers.get("generate_video_voiceover")({ jobId, sceneNumber: 1 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not found or expired/);
});
