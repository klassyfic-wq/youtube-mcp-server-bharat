import test from "node:test";
import assert from "node:assert/strict";
import { handleAudioArtifactRequest, registerAudioDeliveryTools } from "../src/youtube-audio-delivery.ts";

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
    async delete(key) { values.delete(key); },
  };
}
const userId = "audio-user";
const jobId = "123e4567-e89b-42d3-a456-426614174000";
const auth = { userId, name: "Test", email: "test@example.com", accessToken: "" };
const baseUrl = "https://worker.example.test";
function seed(kv) {
  kv.values.set(`youtube:video-job:${userId}:${jobId}`, JSON.stringify({ jobId, userId }));
  kv.values.set(`youtube:video-audio:${userId}:${jobId}:1`, JSON.stringify({
    schemaVersion: 1, jobId, sceneNumber: 1, format: "mp3", contentType: "audio/mpeg",
    byteLength: 6, audioBase64: "SUQzAQID",
  }));
}

test("creates a short-lived opaque URL and streams binary audio with private headers", async () => {
  const kv = fakeKv();
  seed(kv);
  const server = fakeServer();
  registerAudioDeliveryTools(server, auth, { OAUTH_KV: kv, MEDIA_BASE_URL: baseUrl });
  const result = await server.handlers.get("create_video_audio_download_link")({ jobId, sceneNumber: 1 });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.expiresInSeconds, 600);
  assert.match(payload.downloadUrl, /^https:\/\/worker\.example\.test\/media\/audio\/[a-f0-9]{64}$/);
  const response = await handleAudioArtifactRequest(new Request(payload.downloadUrl), { OAUTH_KV: kv });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0x49, 0x44, 0x33, 1, 2, 3]);
});

test("rejects expired or unknown bearer tokens and non-GET requests", async () => {
  const kv = fakeKv();
  const url = `${baseUrl}/media/audio/${"a".repeat(64)}`;
  assert.equal((await handleAudioArtifactRequest(new Request(url), { OAUTH_KV: kv })).status, 404);
  assert.equal((await handleAudioArtifactRequest(new Request(url, { method: "POST" }), { OAUTH_KV: kv })).status, 405);
});

test("does not issue a link for another user's job or without a public HTTPS base URL", async () => {
  const kv = fakeKv();
  seed(kv);
  const server = fakeServer();
  registerAudioDeliveryTools(server, { ...auth, userId: "other-user" }, { OAUTH_KV: kv, MEDIA_BASE_URL: baseUrl });
  const denied = await server.handlers.get("create_video_audio_download_link")({ jobId, sceneNumber: 1 });
  assert.equal(denied.isError, true);
  registerAudioDeliveryTools(server, auth, { OAUTH_KV: kv });
  const unconfigured = await server.handlers.get("create_video_audio_download_link")({ jobId, sceneNumber: 1 });
  assert.equal(unconfigured.isError, true);
  assert.match(unconfigured.content[0].text, /MEDIA_BASE_URL/);
});
