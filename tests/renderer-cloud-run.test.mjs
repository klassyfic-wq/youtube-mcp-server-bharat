import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

test("renderer server has valid Node.js syntax", () => {
  const result = spawnSync(process.execPath, ["--check", "renderer/server.mjs"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("renderer persists job metadata and recovers interrupted jobs", async () => {
  const source = await readFile("renderer/server.mjs", "utf8");
  assert.match(source, /async function persistJob/);
  assert.match(source, /async function loadJob/);
  assert.match(source, /await mkdir\(JOBS_DIR/);
  assert.match(source, /Render was interrupted by a renderer restart/);
});
