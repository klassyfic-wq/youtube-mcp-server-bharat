import test from "node:test";
import assert from "node:assert/strict";
import { registerVideoWorkflowTools } from "../src/youtube-video-workflow-tools.ts";
import { registerAiVideoPlanningTools } from "../src/youtube-ai-planning-tools.ts";

function fakeServer() {
  const handlers = new Map();
  return {
    handlers,
    registerTool(name, _config, handler) { handlers.set(name, handler); },
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

function parse(result) {
  return JSON.parse(result.content[0].text);
}

async function createJob(server) {
  return parse(await server.handlers.get("create_video_job")({
    topic: "AI in India",
    title: "AI in India",
    language: "Marathi",
    durationMinutes: 5,
    audience: "General audience",
    aspectRatio: "16:9",
    tone: "Educational",
  }));
}

test("AI script and scene planner persist validated artifacts and advance the job", async () => {
  const originalFetch = globalThis.fetch;
  const kv = fakeKv();
  const server = fakeServer();
  const env = {
    OAUTH_KV: kv,
    AI_API_URL: "https://ai.example.test/v1/chat/completions",
    AI_API_KEY: "test-key",
    AI_MODEL: "test-model",
  };
  registerVideoWorkflowTools(server, { userId: "planner-user", name: "Test", email: "test@example.com", accessToken: "" }, env);
  registerAiVideoPlanningTools(server, { userId: "planner-user", name: "Test", email: "test@example.com", accessToken: "" }, env);
  const job = await createJob(server);
  const script = {
    title: "भारतामधील AI",
    hook: "AI भारताचं भविष्य कसं बदलू शकते?",
    outline: ["परिचय", "उद्योगातील वापर", "आव्हाने"],
    narration: "ही मराठी निवेदनाची चाचणी आहे. ".repeat(12),
    description: "AI बद्दल मराठी माहितीपूर्ण व्हिडिओ.",
    tags: ["AI", "India", "Marathi"],
    factCheckNotes: ["आकडेवारी प्रकाशित करण्यापूर्वी पडताळा."],
  };
  const scenes = {
    scenes: [
      { sceneNumber: 1, durationSeconds: 100, narration: "प्रस्तावना", visualPrompt: "Modern Indian city with subtle technology motifs", onScreenText: "AI आणि भारत", transition: "fade" },
      { sceneNumber: 2, durationSeconds: 100, narration: "उद्योग", visualPrompt: "Indian manufacturing and healthcare technology montage", onScreenText: "उद्योगातील बदल", transition: "cut" },
      { sceneNumber: 3, durationSeconds: 100, narration: "आव्हाने", visualPrompt: "People learning digital skills in a classroom", onScreenText: "कौशल्ये आणि संधी", transition: "dissolve" },
    ],
  };
  let call = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), env.AI_API_URL);
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-key");
    call++;
    return Response.json({ choices: [{ message: { content: JSON.stringify(call === 1 ? script : scenes) } }] });
  };

  try {
    const generated = parse(await server.handlers.get("generate_video_script")({ jobId: job.jobId }));
    assert.equal(generated.stage, "script");
    assert.equal(generated.script.title, script.title);
    assert.ok(kv.values.has(`youtube:video-script:planner-user:${job.jobId}`));

    const planned = parse(await server.handlers.get("plan_video_scenes")({ jobId: job.jobId }));
    assert.equal(planned.sceneCount, 3);
    assert.equal(planned.totalDurationSeconds, 300);
    assert.ok(kv.values.has(`youtube:video-scenes:planner-user:${job.jobId}`));

    const storedJob = JSON.parse(kv.values.get(`youtube:video-job:planner-user:${job.jobId}`));
    assert.equal(storedJob.stage, "script");
    assert.match(storedJob.artifacts.script, /^kv:\/\//);
    assert.match(storedJob.artifacts.scenes, /^kv:\/\//);
    assert.equal(call, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AI planning fails clearly when no provider is configured and does not mutate job", async () => {
  const kv = fakeKv();
  const server = fakeServer();
  const auth = { userId: "no-provider-user", name: "Test", email: "test@example.com", accessToken: "" };
  registerVideoWorkflowTools(server, auth, { OAUTH_KV: kv });
  registerAiVideoPlanningTools(server, auth, { OAUTH_KV: kv });
  const job = await createJob(server);
  const result = await server.handlers.get("generate_video_script")({ jobId: job.jobId });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /AI provider is not configured/);
  const storedJob = JSON.parse(kv.values.get(`youtube:video-job:no-provider-user:${job.jobId}`));
  assert.equal(storedJob.stage, "brief");
  assert.equal(kv.values.has(`youtube:video-script:no-provider-user:${job.jobId}`), false);
});

test("scene planner rejects a duration mismatch without persisting scenes", async () => {
  const originalFetch = globalThis.fetch;
  const kv = fakeKv();
  const server = fakeServer();
  const env = {
    OAUTH_KV: kv,
    AI_API_URL: "https://ai.example.test/v1/chat/completions",
    AI_API_KEY: "test-key",
    AI_MODEL: "test-model",
  };
  const auth = { userId: "duration-user", name: "Test", email: "test@example.com", accessToken: "" };
  registerVideoWorkflowTools(server, auth, env);
  registerAiVideoPlanningTools(server, auth, env);
  const job = await createJob(server);
  const script = {
    title: "Test", hook: "Test hook", outline: ["A", "B", "C"],
    narration: "A sufficiently long narration. ".repeat(10),
    description: "Test description", tags: [], factCheckNotes: [],
  };
  kv.values.set(`youtube:video-script:duration-user:${job.jobId}`, JSON.stringify(script));
  const storedJob = JSON.parse(kv.values.get(`youtube:video-job:duration-user:${job.jobId}`));
  storedJob.stage = "script";
  await kv.put(`youtube:video-job:duration-user:${job.jobId}`, JSON.stringify(storedJob));
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify({
    scenes: [
      { sceneNumber: 1, durationSeconds: 30, narration: "A", visualPrompt: "A detailed visual scene prompt", onScreenText: "A" },
      { sceneNumber: 2, durationSeconds: 30, narration: "B", visualPrompt: "A second detailed visual scene prompt", onScreenText: "B" },
      { sceneNumber: 3, durationSeconds: 30, narration: "C", visualPrompt: "A third detailed visual scene prompt", onScreenText: "C" },
    ],
  }) } }] });
  try {
    const result = await server.handlers.get("plan_video_scenes")({ jobId: job.jobId });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /outside the allowed 10% range/);
    assert.equal(kv.values.has(`youtube:video-scenes:duration-user:${job.jobId}`), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
