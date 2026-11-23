import test from "node:test";
import assert from "node:assert/strict";
import { buildSceneJoinArgs, buildSceneVideoFilter } from "./video-effects.mjs";

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

test("builds sequential xfade and audio crossfade transitions from the scene plan", () => {
  const args = buildSceneJoinArgs({ clipPaths: ["/tmp/a.mp4", "/tmp/b.mp4", "/tmp/c.mp4", "/tmp/d.mp4"], durations: [5, 6, 7, 8], transitions: ["fade", "cut", "dissolve", "slide"], outputPath: "/tmp/joined.mp4" });
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.match(graph, /xfade=transition=fade:duration=0\.010:offset=4\.990/);
  assert.match(graph, /xfade=transition=dissolve:duration=0\.350:offset=10\.640/);
  assert.match(graph, /xfade=transition=slideleft/);
  assert.match(graph, /acrossfade/);
});

test("copies a single scene without applying a transition", () => {
  const args = buildSceneJoinArgs({ clipPaths: ["/tmp/a.mp4"], durations: [5], outputPath: "/tmp/joined.mp4" });
  assert.deepEqual(args, ["-y", "-i", "/tmp/a.mp4", "-c", "copy", "/tmp/joined.mp4"]);
});
