import test from "node:test";
import assert from "node:assert/strict";
import { buildSceneVideoFilter } from "./video-effects.mjs";

test("builds a vertical scene filter with subtle push-in motion", () => {
  const filter = buildSceneVideoFilter({ width: 1080, height: 1920, durationSeconds: 30, sceneNumber: 1 });
  assert.ok(filter.includes("scale=1080:1920"));
  assert.ok(filter.includes("zoompan=z='min(1.0+0.08*on/900,1.08)'"));
  assert.ok(filter.includes("d=1:s=1080x1920:fps=30"));
});

test("alternates to a subtle pull-back on even-numbered scenes", () => {
  const filter = buildSceneVideoFilter({ width: 1920, height: 1080, durationSeconds: 10, sceneNumber: 2 });
  assert.ok(filter.includes("max(1.08-0.08*on/300,1.0)"));
});

test("renders Marathi overlay text separately from generated imagery", () => {
  const filter = buildSceneVideoFilter({ width: 1080, height: 1920, durationSeconds: 12, sceneNumber: 3, overlayFile: "/tmp/yt-render-test/scene-1.overlay.txt" });
  assert.ok(filter.includes("drawtext="));
  assert.ok(filter.includes("NotoSansDevanagari-Regular.ttf"));
  assert.ok(filter.includes("textfile=/tmp/yt-render-test/scene-1.overlay.txt"));
});

test("rejects invalid dimensions, duration and scene numbers", () => {
  assert.throws(() => buildSceneVideoFilter({ width: 0, height: 1920, durationSeconds: 5 }), /dimensions/);
  assert.throws(() => buildSceneVideoFilter({ width: 1080, height: 1920, durationSeconds: 3601 }), /duration/);
  assert.throws(() => buildSceneVideoFilter({ width: 1080, height: 1920, durationSeconds: 5, sceneNumber: 0 }), /Scene number/);
});
