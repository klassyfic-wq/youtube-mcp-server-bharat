import test from "node:test";
import assert from "node:assert/strict";
import { registerVideoImageTools, handleImageArtifactRequest } from "../src/youtube-video-image-tools.ts";

function fakeServer() {
  const handlers = new Map();
  return { handlers, registerTool(name, _config, handler) { handlers.set(name, handler); } };
}
function fakeKv() {
  const values = new Map();
  return { values, async get(key) { return values.get(key) ?? null; }, async put(key, value) { values.set(key, value); }, async delete(key) { values.delete(key); } };
}
function parse(result) { return JSON.parse(result.content[0].text); }
const userId = "image-user";
const jobId = "6a7e8d3f-3a12-4b7d-8f41-5e4a2d9c0b11";
function seed(kv) {
  kv.values.set(`youtube:video-job:${userId}:${jobId}`, JSON.stringify({ jobId, userId, stage: "assets", artifacts: {}, updatedAt: new Date().toISOString() }));
  kv.values.set(`youtube:video-media-manifest:${userId}:${jobId}`, JSON.stringify({
    jobId, voiceoverTracks: [{ sceneNumber: 1, visualRequest: { prompt: "A cinematic Indian technology scene", aspectRatio: "16:9" } }],
    providerStatus: { imageGeneration: "not_configured" },
  }));
}
const auth = { userId, name: "Test", email: "test@example.com", accessToken: "" };
const png = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
const pngBase64 = btoa(String.fromCharCode(...png));

test("image adapter generates, validates and privately stores a scene image", async () => {
  const originalFetch = globalThis.fetch;
  const kv = fakeKv(); seed(kv);
  const env = { OAUTH_KV: kv, IMAGE_API_URL: "https://images.example.test/v1/images/generations", IMAGE_API_KEY: "test-secret", IMAGE_MODEL: "test-image", MEDIA_BASE_URL: "https://worker.example.test" };
  const server = fakeServer(); registerVideoImageTools(server, auth, env);
  let requestBody;
  globalThis.fetch = async (_url, init) => {
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-secret");
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ data: [{ b64_json: pngBase64 }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const generated = parse(await server.handlers.get("generate_video_scene_image")({ jobId, sceneNumber: 1 }));
    assert.equal(generated.status, "generated");
    assert.equal(generated.format, "png");
    assert.equal(requestBody.model, "test-image");
    const manifest = JSON.parse(kv.values.get(`youtube:video-media-manifest:${userId}:${jobId}`));
    assert.equal(manifest.voiceoverTracks[0].imageStatus, "generated");
    const link = parse(await server.handlers.get("create_video_image_download_link")({ jobId, sceneNumber: 1 }));
    const token = new URL(link.url).pathname.split("/").pop();
    const download = await handleImageArtifactRequest(new Request(link.url), env);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "image/png");
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), png);
    assert.match(token, /^[a-f0-9]{64}$/);
  } finally { globalThis.fetch = originalFetch; }
});

test("image adapter refuses provider calls without configuration", async () => {
  const kv = fakeKv(); seed(kv); const server = fakeServer();
  registerVideoImageTools(server, auth, { OAUTH_KV: kv });
  const result = await server.handlers.get("generate_video_scene_image")({ jobId, sceneNumber: 1 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Image provider is not configured/);
  assert.equal(kv.values.has(`youtube:video-image:${userId}:${jobId}:1`), false);
});

test("image adapter rejects non-image payloads and cross-user jobs", async () => {
  const originalFetch = globalThis.fetch;
  const kv = fakeKv(); seed(kv); const server = fakeServer();
  registerVideoImageTools(server, auth, { OAUTH_KV: kv, IMAGE_API_URL: "https://images.example.test/generate", IMAGE_API_KEY: "secret", IMAGE_MODEL: "model" });
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ b64_json: btoa("not an image") }] }), { status: 200 });
  try {
    const invalid = await server.handlers.get("generate_video_scene_image")({ jobId, sceneNumber: 1 });
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0].text, /not a PNG or JPEG/);
  } finally { globalThis.fetch = originalFetch; }
  const other = fakeServer();
  registerVideoImageTools(other, { ...auth, userId: "other-user" }, { OAUTH_KV: kv });
  const denied = await other.handlers.get("generate_video_scene_image")({ jobId, sceneNumber: 1 });
  assert.equal(denied.isError, true);
});

test("shared renderer ignores a stale dedicated image key and surfaces safe auth diagnostics", async () => {
  const originalFetch = globalThis.fetch;
  const kv = fakeKv(); seed(kv); const server = fakeServer();
  registerVideoImageTools(server, auth, {
    OAUTH_KV: kv,
    TTS_API_URL: "https://renderer.example.test/v1/audio/speech",
    TTS_API_KEY: "current-renderer-secret",
    IMAGE_API_KEY: "stale-image-secret",
  });
  let authorization;
  globalThis.fetch = async (_url, init) => {
    authorization = new Headers(init.headers).get("Authorization");
    return new Response(JSON.stringify({
      error: "Unauthorized",
      requestId: "safe-request-id",
      authDiagnostics: {
        secretConfigured: true,
        authorizationHeaderPresent: true,
        bearerPrefixPresent: true,
        tokenMatchesConfiguredSecret: false,
      },
    }), { status: 401, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await server.handlers.get("generate_video_scene_image")({ jobId, sceneNumber: 1 });
    assert.equal(authorization, "Bearer current-renderer-secret");
    assert.match(result.content[0].text, /tokenMatchesConfiguredSecret=false/);
    assert.match(result.content[0].text, /requestId=safe-request-id/);
    assert.equal(kv.values.has(`youtube:video-image:${userId}:${jobId}:1`), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("image adapter surfaces sanitized provider 400 details", async () => {
  const originalFetch = globalThis.fetch;
  const kv = fakeKv(); seed(kv); const server = fakeServer();
  registerVideoImageTools(server, auth, { OAUTH_KV: kv, TTS_API_URL: "https://renderer.example.test/v1/audio/speech", TTS_API_KEY: "shared-test-secret" });
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "Vertex AI image generation returned HTTP 400 (INVALID_ARGUMENT: Invalid imageConfig aspectRatio).", requestId: "provider-400-id" }), { status: 400 });
  try {
    const result = await server.handlers.get("generate_video_scene_image")({ jobId, sceneNumber: 1 });
    assert.match(result.content[0].text, /HTTP 400/);
    assert.match(result.content[0].text, /INVALID_ARGUMENT/);
    assert.match(result.content[0].text, /requestId=provider-400-id/);
    assert.equal(kv.values.has(`youtube:video-image:${userId}:${jobId}:1`), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("image adapter reuses the configured shared renderer endpoint and TTS secret", async () => {
  const originalFetch = globalThis.fetch;
  const kv = fakeKv(); seed(kv); const server = fakeServer();
  registerVideoImageTools(server, auth, { OAUTH_KV: kv, TTS_API_URL: "https://renderer.example.test/v1/audio/speech", TTS_API_KEY: "shared-test-secret" });
  let requestedUrl, requestedBody;
  globalThis.fetch = async (url, init) => {
    requestedUrl = String(url);
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer shared-test-secret");
    requestedBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ data: [{ b64_json: pngBase64 }] }), { status: 200 });
  };
  try {
    const result = parse(await server.handlers.get("generate_video_scene_image")({ jobId, sceneNumber: 1 }));
    assert.equal(result.status, "generated");
    assert.equal(requestedUrl, "https://renderer.example.test/v1/images/generations");
    assert.equal(requestedBody.model, "gemini-2.5-flash-image");
  } finally { globalThis.fetch = originalFetch; }
});
