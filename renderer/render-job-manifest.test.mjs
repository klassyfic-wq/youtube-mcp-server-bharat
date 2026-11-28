import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeRenderManifest,
  encodeRenderManifest,
  MAX_INLINE_RENDER_MANIFEST_BYTES
} from "./render-job-manifest.mjs";

test("render manifest survives Cloud Run execution override encoding", () => {
  const manifest = {
    jobId: "3420e979-160f-4dba-8c26-fd38a7eb0aba",
    aspectRatio: "16:9",
    voiceoverTracks: [{ sceneNumber: 1, imageUrl: "https://storage.example/image.png", audioUrl: "https://storage.example/audio.mp3" }],
    subtitles: { content: "" }
  };
  assert.deepEqual(decodeRenderManifest(encodeRenderManifest(manifest)), manifest);
});

test("oversized render manifests fall back to shared-volume loading", () => {
  const manifest = { payload: "x".repeat(MAX_INLINE_RENDER_MANIFEST_BYTES) };
  assert.equal(encodeRenderManifest(manifest), null);
});

test("invalid inline manifest values are ignored safely", () => {
  assert.equal(decodeRenderManifest(undefined), null);
  assert.equal(decodeRenderManifest("not-base64"), null);
  assert.equal(decodeRenderManifest(Buffer.from("[]").toString("base64")), null);
});
