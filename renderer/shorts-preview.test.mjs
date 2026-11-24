import test from "node:test";
import assert from "node:assert/strict";
import { buildShortsFfmpegArgs, createShortsPreview, validateShortsPreviewRequest } from "./shorts-preview.mjs";

const hosts = new Set(["storage.googleapis.com"]);

test("validates HTTPS allowlisted source and clips no longer than 180 seconds", () => {
  const value = validateShortsPreviewRequest({ sourceVideoUrl: "https://storage.googleapis.com/bucket/video.mp4", startSeconds: 2, endSeconds: 62, subtitlesSrt: "" }, hosts);
  assert.equal(value.endSeconds - value.startSeconds, 60);
  assert.equal(value.source.hostname, "storage.googleapis.com");
  assert.throws(() => validateShortsPreviewRequest({ sourceVideoUrl: "https://evil.example/video.mp4", startSeconds: 0, endSeconds: 10 }, hosts), /ASSET_HOST_ALLOWLIST/);
  assert.throws(() => validateShortsPreviewRequest({ sourceVideoUrl: "http://storage.googleapis.com/video.mp4", startSeconds: 0, endSeconds: 10 }, hosts), /HTTPS/);
  assert.throws(() => validateShortsPreviewRequest({ sourceVideoUrl: "https://storage.googleapis.com/video.mp4", startSeconds: 0, endSeconds: 181 }, hosts), /180 seconds/);
});

test("builds vertical 9:16 FFmpeg crop and optional subtitle overlay while retaining audio", () => {
  const args = buildShortsFfmpegArgs({ sourcePath: "/tmp/source.mp4", outputPath: "/tmp/preview.mp4", startSeconds: 5, endSeconds: 35, subtitlesPath: "/tmp/captions.srt" });
  assert.ok(args.includes("scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,subtitles=/tmp/captions.srt"));
  assert.ok(args.includes("160k"));
  assert.ok(args.includes("30"));
});


test("rejects an oversized source before buffering or writing it", async () => {
  const originalFetch = globalThis.fetch;
  let fetchOptions;
  globalThis.fetch = async (_url, options) => {
    fetchOptions = options;
    return new Response("oversized", {
      status: 200,
      headers: {
        "content-type": "video/mp4",
        "content-length": String(500 * 1024 * 1024 + 1),
      },
    });
  };
  try {
    await assert.rejects(createShortsPreview({
      payload: {
        sourceVideoUrl: "https://storage.googleapis.com/bucket/large.mp4",
        startSeconds: 0,
        endSeconds: 30,
      },
      allowedHosts: hosts,
      dataDir: "/tmp/shorts-preview-size-test",
    }), /500 MB size limit/);
    assert.equal(fetchOptions.redirect, "error");
  } finally { globalThis.fetch = originalFetch; }
});
