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
      { id: "abcdefghijk", snippet: { title: "Lower views", channelTitle: "Creator A", license: "creativeCommon" }, statistics: { viewCount: "500", likeCount: "10" }, contentDetails: { duration: "PT2M" }, status: { privacyStatus: "public", embeddable: true } },
      { id: "lmnopqrstuv", snippet: { title: "Higher views", channelTitle: "Creator B", license: "creativeCommon" }, statistics: { viewCount: "9000", likeCount: "100" }, contentDetails: { duration: "PT5M" }, status: { privacyStatus: "public", embeddable: true } },
      { id: "standard1234", snippet: { title: "Standard licence must be excluded", channelTitle: "Creator C", license: "youtube" }, statistics: { viewCount: "99000", likeCount: "500" }, contentDetails: { duration: "PT1M" }, status: { privacyStatus: "public", embeddable: true } },
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
    transcript: "A timestamped transcript with enough content to analyze. ".repeat(4),
  });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /AI provider is not configured/);
});
