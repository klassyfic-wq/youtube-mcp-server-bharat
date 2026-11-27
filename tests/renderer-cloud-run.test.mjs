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

test("ambiguous Cloud Run dispatch does not overwrite worker progress or trigger unsafe retry", async () => {
  const source = await readFile("renderer/server.mjs", "utf8");
  assert.match(source, /dispatch_unknown/);
  assert.match(source, /dispatchOutcomeUnknown: true/);
  assert.match(source, /Never overwrite worker progress or automatically retry an ambiguous dispatch/);
  assert.match(source, /\["rendering", "preview_ready", "failed"\]\.includes\(latest\.status\)/);
});

test("missing persisted job does not fall back to a stale process cache", async () => {
  const source = await readFile("renderer/server.mjs", "utf8");
  const loadBlock = source.slice(source.indexOf("async function loadJob"), source.indexOf("\nfunction send"));
  assert.match(loadBlock, /if \(error\?\.code === "ENOENT"\) return null/);
  assert.doesNotMatch(loadBlock, /jobs\.get\(jobId\) \|\| null/);
});

test("completed Cloud Run render is not repeated by a retried worker", async () => {
  const source = await readFile("renderer/server.mjs", "utf8");
  assert.match(source, /record\.status === "preview_ready" && record\.previewPath/);
  assert.match(source, /event: "render_already_complete"/);
});

test("Cloud Run jobs.run stores the Execution resource name, not the long-running Operation name", async () => {
  const source = await readFile("renderer/server.mjs", "utf8");
  assert.match(source, /data\.metadata\?\.name \|\| data\.response\?\.name/);
  assert.match(source, /executionName\.includes\("\/executions\/"\)/);
  assert.match(source, /data\.name is the Operation name, not an Execution/);
});

test("renderer overlays scene on-screen text using a Devanagari-capable font", async () => {
  const source = await readFile("renderer/server.mjs", "utf8");
  const docker = await readFile("renderer/Dockerfile", "utf8");
  assert.match(source, /track\.onScreenText/);
  assert.match(source, /drawtext=fontfile=\/usr\/share\/fonts\/truetype\/noto\/NotoSansDevanagari-Regular\.ttf/);
  assert.match(source, /scene-\$\{index\}\.overlay\.txt/);
  assert.match(docker, /fonts-noto-core/);
});

test("Cloud Run dispatcher service avoids platform-reserved environment variables", async () => {
  const terraform = await readFile("infra/gcp/main.tf", "utf8");
  const service = terraform.slice(terraform.indexOf('resource "google_cloud_run_v2_service" "renderer"'), terraform.indexOf('resource "google_cloud_run_v2_service_iam_member"'));
  assert.doesNotMatch(service, /name\s*=\s*"PORT"/);
  assert.doesNotMatch(service, /name\s*=\s*"CLOUD_RUN_JOB"/);
  assert.match(service, /name\s*=\s*"RENDERER_JOB_NAME"/);
});


test("renderer logs secret-safe authentication diagnostics for rejected requests", async () => {
  const source = await readFile("renderer/server.mjs", "utf8");
  assert.match(source, /function authDiagnostic\(req\)/);
  assert.match(source, /secretConfigured: Boolean\(SECRET\)/);
  assert.match(source, /authorizationHeaderPresent:/);
  assert.match(source, /bearerPrefixPresent:/);
  assert.match(source, /tokenMatchesConfiguredSecret:/);
  assert.match(source, /console\.error\(JSON\.stringify\(\{ \.\.\.authDiagnostic\(req\), requestId \}\)\)/);
  assert.doesNotMatch(source, /authorization:\s*authorization/);
});
