import test from "node:test";
import assert from "node:assert/strict";
import { registerYoutubeUploadTools } from "../src/youtube-upload-tools.ts";
import { registerVideoWorkflowTools } from "../src/youtube-video-workflow-tools.ts";
import { encryptToken } from "../src/utils.ts";

function fakeServer() {
  const handlers = new Map();
  return {
    handlers,
    registerTool(name, _config, handler) {
      handlers.set(name, handler);
    },
  };
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

function parseToolResult(result) {
  return JSON.parse(result.content[0].text);
}

test("resumable video upload and thumbnail upload work through mocked YouTube API", async () => {
  const originalFetch = globalThis.fetch;
  const kv = fakeKv();
  const secret = "unit-test-encryption-secret";
  kv.values.set("google:refresh:test-user", await encryptToken("refresh-token", secret));
  const env = {
    OAUTH_KV: kv,
    TOKEN_ENCRYPTION_KEY: secret,
    GOOGLE_CLIENT_ID: "test-client",
    GOOGLE_CLIENT_SECRET: "test-secret",
  };
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? "GET", headers: init.headers });
    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "test-access-token" });
    }
    if (url.includes("uploadType=resumable")) {
      return new Response(null, {
        status: 200,
        headers: { Location: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=test-session" },
      });
    }
    if (url.includes("upload_id=test-session")) {
      assert.equal(init.method, "PUT");
      assert.equal(new Headers(init.headers).get("Content-Range"), "bytes 0-2/3");
      return Response.json({
        id: "abcdefghijk",
        snippet: { title: "Test upload" },
        status: { privacyStatus: "private" },
      }, { status: 201 });
    }
    if (url.includes("/thumbnails/set?videoId=abcdefghijk")) {
      assert.equal(init.method, "POST");
      assert.equal(new Headers(init.headers).get("Content-Type"), "image/jpeg");
      return Response.json({ items: [{ default: { url: "https://img.youtube.test/thumb.jpg" } }] });
    }
    throw new Error("Unexpected mocked request: " + url);
  };

  try {
    const server = fakeServer();
    registerYoutubeUploadTools(server, { userId: "test-user", name: "Test", email: "test@example.com", accessToken: "" }, env);

    const started = parseToolResult(await server.handlers.get("start_video_upload")({
      title: "Test upload",
      privacyStatus: "private",
      contentType: "video/mp4",
      totalBytes: 3,
    }));
    assert.ok(started.uploadId);
    assert.equal(started.nextOffset, 0);

    const completed = parseToolResult(await server.handlers.get("upload_video_chunk")({
      uploadId: started.uploadId,
      offset: 0,
      chunkBase64: Buffer.from([0, 1, 2]).toString("base64"),
    }));
    assert.equal(completed.complete, true);
    assert.equal(completed.videoId, "abcdefghijk");
    assert.equal(completed.privacyStatus, "private");

    const thumbnail = parseToolResult(await server.handlers.get("upload_video_thumbnail")({
      videoId: "abcdefghijk",
      contentType: "image/jpeg",
      imageBase64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"),
    }));
    assert.equal(thumbnail.uploaded, true);
    assert.equal(calls.filter(call => call.url.includes("upload_id=test-session")).length, 1);
    assert.equal(calls.filter(call => call.url.includes("/thumbnails/set")).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("video production workflow enforces review before publish approval", async () => {
  const kv = fakeKv();
  const server = fakeServer();
  registerVideoWorkflowTools(server, { userId: "workflow-user", name: "Test", email: "test@example.com", accessToken: "" }, { OAUTH_KV: kv });

  const created = parseToolResult(await server.handlers.get("create_video_job")({
    topic: "AI in India",
    title: "AI in India",
    language: "Marathi",
    durationMinutes: 5,
    audience: "General audience",
    aspectRatio: "16:9",
    tone: "Educational",
  }));
  assert.equal(created.stage, "brief");

  const prematureApproval = await server.handlers.get("approve_video_publish")({
    jobId: created.jobId,
    confirmation: "APPROVE_PUBLIC_PUBLISH",
  });
  assert.equal(prematureApproval.isError, true);

  const reviewed = parseToolResult(await server.handlers.get("update_video_job")({
    jobId: created.jobId,
    stage: "review",
    status: "ready_for_review",
    artifacts: { preview: "private://preview.mp4", script: "private://script.md" },
  }));
  assert.equal(reviewed.status, "ready_for_review");

  const approved = parseToolResult(await server.handlers.get("approve_video_publish")({
    jobId: created.jobId,
    confirmation: "APPROVE_PUBLIC_PUBLISH",
  }));
  assert.ok(approved.publishApprovedAt);
  assert.match(approved.note, /does not change YouTube visibility/);
});


test("resumable upload reconciles a transient 503 and retries from confirmed offset", async () => {
  const originalFetch = globalThis.fetch;
  const kv = fakeKv();
  const secret = "retry-test-encryption-secret";
  kv.values.set("google:refresh:retry-user", await encryptToken("refresh-token", secret));
  const env = {
    OAUTH_KV: kv,
    TOKEN_ENCRYPTION_KEY: secret,
    GOOGLE_CLIENT_ID: "test-client",
    GOOGLE_CLIENT_SECRET: "test-secret",
  };
  let chunkAttempts = 0;
  let statusChecks = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "test-access-token" });
    if (url.includes("uploadType=resumable")) {
      return new Response(null, { status: 200, headers: { Location: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=retry-session" } });
    }
    if (url.includes("upload_id=retry-session") && init.method === "PUT" && new Headers(init.headers).get("Content-Range") === "bytes */3") {
      statusChecks++;
      return new Response(null, { status: 308 });
    }
    if (url.includes("upload_id=retry-session") && init.method === "PUT") {
      chunkAttempts++;
      if (chunkAttempts === 1) return new Response(null, { status: 503, headers: { "Retry-After": "0" } });
      return Response.json({ id: "abcdefghijk", snippet: { title: "Retry test" }, status: { privacyStatus: "private" } }, { status: 201 });
    }
    throw new Error("Unexpected mocked request: " + url);
  };

  try {
    const server = fakeServer();
    registerYoutubeUploadTools(server, { userId: "retry-user", name: "Test", email: "test@example.com", accessToken: "" }, env);
    const started = parseToolResult(await server.handlers.get("start_video_upload")({
      title: "Retry test",
      privacyStatus: "private",
      contentType: "video/mp4",
      totalBytes: 3,
    }));
    const completed = parseToolResult(await server.handlers.get("upload_video_chunk")({
      uploadId: started.uploadId,
      offset: 0,
      chunkBase64: Buffer.from([3, 4, 5]).toString("base64"),
    }));
    assert.equal(completed.complete, true);
    assert.equal(chunkAttempts, 2);
    assert.equal(statusChecks, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
