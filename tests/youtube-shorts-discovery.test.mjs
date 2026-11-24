import test from "node:test";
import assert from "node:assert/strict";
import { registerYoutubeShortsDiscoveryTools } from "../src/youtube-shorts-discovery-tools.ts";

function fakeServer() {
  const handlers = new Map();
  return { handlers, registerTool(name, _config, handler) { handlers.set(name, handler); } };
}

test("public video search sorts by views and reports licence metadata without granting reuse permission", async () => {
  const originalFetch = globalThis.fetch;
  const server = fakeServer();
  registerYoutubeShortsDiscoveryTools(server, { YOUTUBE_API_KEY: "test-key" });
  const requests = [];
  globalThis.fetch = async url => {
    const parsed = new URL(url);
    requests.push(parsed);
    if (parsed.pathname.endsWith("/search")) {
      assert.equal(parsed.searchParams.get("order"), "viewCount");
      assert.equal(parsed.searchParams.get("videoLicense"), "creativeCommon");
      return Response.json({ items: [
        { id: { videoId: "abcdefghijk" } },
        { id: { videoId: "lmnopqrstuv" } },
        { id: { videoId: "standard1234" } },
      ] });
    }
    return Response.json({ items: [
      { id: "abcdefghijk", snippet: { title: "Lower views", channelTitle: "Creator A" }, statistics: { viewCount: "500", likeCount: "10" }, contentDetails: { duration: "PT2M" }, status: { privacyStatus: "public", license: "creativeCommon", embeddable: true } },
      { id: "lmnopqrstuv", snippet: { title: "Higher views", channelTitle: "Creator B" }, statistics: { viewCount: "9000", likeCount: "100" }, contentDetails: { duration: "PT5M" }, status: { privacyStatus: "public", license: "creativeCommon", embeddable: true } },
      { id: "standard1234", snippet: { title: "Standard licence must be excluded", channelTitle: "Creator C" }, statistics: { viewCount: "99000", likeCount: "500" }, contentDetails: { duration: "PT1M" }, status: { privacyStatus: "public", license: "youtube", embeddable: true } },
    ] });
  };
  try {
    const response = await server.handlers.get("search_public_youtube_videos")({ topic: "Marathi science", maxResults: 10, license: "creativeCommon" });
    const data = JSON.parse(response.content[0].text);
    assert.equal(data.videos[0].title, "Higher views");
    assert.equal(data.videos[0].viewCount, 9000);
    assert.equal(data.videos[0].rightsReview.startsWith("Creative Commons licence metadata found"), true);
    assert.equal(data.videos.length, 2);
    assert.equal(data.videos.some(video => video.videoId === "standard1234"), false);
    assert.equal(data.videos.every(video => video.licenseMetadata === "creativeCommon"), true);
    assert.equal(requests.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public video search fails clearly without an API key and does not call network", async () => {
  const server = fakeServer();
  registerYoutubeShortsDiscoveryTools(server, {});
  const response = await server.handlers.get("search_public_youtube_videos")({ topic: "science", maxResults: 5, license: "creativeCommon" });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /YOUTUBE_API_KEY/);
});

test("transcript analyzer validates returned clip bounds and requires an AI provider", async () => {
  const server = fakeServer();
  registerYoutubeShortsDiscoveryTools(server, {});
  const missing = await server.handlers.get("analyze_transcript_for_shorts")({
    videoTitle: "Test video",
    videoDurationSeconds: 300,
    transcript: "[00:00:05] A timestamped transcript with enough content to analyze. ".repeat(2) + "[00:00:20] The next sentence provides another valid timestamp and enough context.",
  });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /AI provider is not configured/);
});

 
test("transcript analysis returns validated best moments and timing metadata", async () => {
  const server = fakeServer();
  registerYoutubeShortsDiscoveryTools(server, {
    AI_API_URL: "https://ai.example.test/v1/chat/completions",
    AI_API_KEY: "test-ai-key",
    AI_MODEL: "test-model",
  });
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init };
    return Response.json({
      choices: [{ message: { content: JSON.stringify({ clips: [{
        startSeconds: 5,
        endSeconds: 38,
        hook: "हा क्षण महत्त्वाचा आहे",
        title: "महत्त्वाचा क्षण",
        reason: "पूर्ण संदर्भासह समजणारा भाग",
      }] }) } }],
    });
  };
  try {
    const transcript = "[00:00:05] सुरुवातीचा मुद्दा स्पष्ट करतो.\n[00:00:20] पुढे महत्त्वाचे उदाहरण समजावतो.\n[00:00:38] निष्कर्ष सांगतो.";
    const response = await server.handlers.get("analyze_transcript_for_shorts")({
      videoTitle: "मराठी विज्ञान",
      videoDurationSeconds: 90,
      transcript,
    });
    assert.equal(response.isError, undefined);
    const data = JSON.parse(response.content[0].text);
    assert.equal(data.clipCount, 1);
    assert.equal(data.clips[0].startSeconds, 5);
    assert.equal(data.clips[0].endSeconds, 38);
    assert.equal(data.transcriptTiming.timestampCount, 3);
    assert.equal(data.transcriptTiming.lastTimestampSeconds, 38);
    assert.equal(data.rightsStatus, "not_assessed");
    assert.match(data.note, /nothing was published/);
    assert.equal(request.url, "https://ai.example.test/v1/chat/completions");
    assert.equal(new Headers(request.init.headers).get("Authorization"), "Bearer test-ai-key");
  } finally { globalThis.fetch = originalFetch; }
});

test("transcript analysis rejects missing, unordered, and out-of-range timestamps before AI call", async () => {
  const server = fakeServer();
  registerYoutubeShortsDiscoveryTools(server, {
    AI_API_URL: "https://ai.example.test/v1/chat/completions",
    AI_API_KEY: "test-ai-key",
    AI_MODEL: "test-model",
  });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({}); };
  try {
    const base = { videoTitle: "Test", videoDurationSeconds: 60 };
    const missing = await server.handlers.get("analyze_transcript_for_shorts")({
      ...base, transcript: "No timestamp appears here, only enough text to exceed the one hundred character minimum. ".repeat(2),
    });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /at least two bracketed timestamps/);
    const unordered = await server.handlers.get("analyze_transcript_for_shorts")({
      ...base, transcript: "[00:00:30] Later.\n[00:00:10] Earlier. " + "more transcript words ".repeat(8),
    });
    assert.equal(unordered.isError, true);
    assert.match(unordered.content[0].text, /chronological order/);
    const beyond = await server.handlers.get("analyze_transcript_for_shorts")({
      ...base, transcript: "[00:00:10] Start.\n[00:01:30] Beyond video. " + "more transcript words ".repeat(8),
    });
    assert.equal(beyond.isError, true);
    assert.match(beyond.content[0].text, /beyond the supplied video duration/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("transcript analyzer rejects AI-selected clips outside source duration", async () => {
  const server = fakeServer();
  registerYoutubeShortsDiscoveryTools(server, {
    AI_API_URL: "https://ai.example.test/v1/chat/completions",
    AI_API_KEY: "test-ai-key",
    AI_MODEL: "test-model",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    choices: [{ message: { content: JSON.stringify({ clips: [{
      startSeconds: 50, endSeconds: 75, hook: "Hook", title: "Title", reason: "Reason",
    }] }) } }],
  });
  try {
    const response = await server.handlers.get("analyze_transcript_for_shorts")({
      videoTitle: "Test",
      videoDurationSeconds: 60,
      transcript: "[00:00:05] Start.\n[00:00:55] End. " + "context ".repeat(15),
    });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /beyond the supplied video duration/);
  } finally { globalThis.fetch = originalFetch; }
});
