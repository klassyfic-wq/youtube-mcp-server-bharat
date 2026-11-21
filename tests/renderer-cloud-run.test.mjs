import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

test("renderer server has valid Node.js syntax", () => {
  const result = spawnSync(process.execPath, ["--check", "renderer/server.mjs"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("renderer persists job metadata and recovers interrupted service jobs", async () => {
  const source = await readFile("renderer/server.mjs", "utf8");
  assert.match(source, /async function persistJob/);
  assert.match(source, /async function loadJob/);
  assert.match(source, /await mkdir\(JOBS_DIR/);
  assert.match(source, /Render was interrupted by a renderer restart/);
});

test("Cloud Run Jobs mode dispatches durable jobs and uses a one-shot worker", async () => {
  const source = await readFile("renderer/server.mjs", "utf8");
  assert.match(source, /RENDER_EXECUTION_MODE === "cloud-run-jobs"/);
  assert.match(source, /async function dispatchCloudRunJob/);
  assert.match(source, /run\.googleapis\.com\/v2\/projects/);
  assert.match(source, /containerOverrides/);
  assert.match(source, /async function runRenderWorker/);
  assert.match(source, /process\.env\.RENDER_JOB_ID/);
  assert.match(source, /await render\(jobId, record\.manifest/);
  assert.match(source, /shared persistent volume/);
  assert.match(source, /executionMode: CLOUD_RUN_JOBS_MODE/);
});

test("Cloud Run dispatcher restart does not fail independent Job executions", async () => {
  const source = await readFile("renderer/server.mjs", "utf8");
  assert.match(source, /!CLOUD_RUN_JOBS_MODE && \(record\.status === "queued" \|\| record\.status === "rendering"\)/);
});

test("dispatch response merges execution metadata without overwriting worker progress", async () => {
  const source = await readFile("renderer/server.mjs", "utf8");
  assert.match(source, /const latest = await loadJob\(jobId\) \|\| record/);
  assert.match(source, /\{ \.\.\.latest, executionName, updatedAt:/);
});
