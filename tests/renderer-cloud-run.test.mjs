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

test("Cloud Run status polling reconciles terminal executions missing a worker result", async () => {
  const source = await readFile("renderer/server.mjs", "utf8");
  assert.match(source, /async function reconcileCloudRunExecution/);
  assert.match(source, /execution\.completionTime/);
  assert.match(source, /no preview result was persisted/);
  assert.match(source, /reconcileCloudRunExecution\(statusMatch\[1\], record\)/);
});

test("Cloud Run reconciliation uses v2 Completed condition terminal states", async () => {
  const source = await readFile("renderer/server.mjs", "utf8");
  assert.match(source, /CONDITION_SUCCEEDED/);
  assert.match(source, /CONDITION_FAILED/);
  assert.match(source, /condition\.type === "Completed"/);
});

test("job reads refresh from shared storage instead of trusting a process cache", async () => {
  const source = await readFile("renderer/server.mjs", "utf8");
  const loadBlock = source.slice(source.indexOf("async function loadJob"), source.indexOf("\nfunction send"));
  assert.doesNotMatch(loadBlock, /if \(jobs\.has\(jobId\)\) return jobs\.get\(jobId\)/);
  assert.match(loadBlock, /readFile\(path\.join\(JOBS_DIR/);
});


test("render submission and revision edits are serialized per job in one renderer process", async () => {
  const source = await readFile("renderer/server.mjs", "utf8");
  assert.match(source, /const jobLocks = new Map\(\)/);
  assert.match(source, /async function withJobLock\(jobId, operation\)/);
  assert.match(source, /return withJobLock\(jobId, \(\) => queueRenderUnlocked/);
  assert.match(source, /return withJobLock\(jobId, \(\) => runRenderWorkerUnlocked/);
  assert.match(source, /already active; wait for it to finish before editing/);
  assert.match(source, /A render job with this jobId already exists/);
  assert.match(source, /revision = \(existing\.revision \|\| 0\) \+ 1/);
});

test("edit requests derive their manifest and revision from the latest persisted job", async () => {
  const source = await readFile("renderer/server.mjs", "utf8");
  assert.match(source, /if \(isEdit\)[\s\S]*?manifest = existing\.manifest;[\s\S]*?revision = \(existing\.revision \|\| 0\) \+ 1/);
  assert.match(source, /queueRender\(match\[1\], record\.manifest, payload\.edits \|\| \{\}, 0, true\)/);
});
