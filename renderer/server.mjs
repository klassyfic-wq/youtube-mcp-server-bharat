import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 8787);
const SECRET = process.env.RENDERER_SHARED_SECRET;
const DATA_DIR = process.env.RENDERER_DATA_DIR || "/data";
const ALLOWED_HOSTS = new Set((process.env.ASSET_HOST_ALLOWLIST || "").split(",").map(v => v.trim().toLowerCase()).filter(Boolean));
const jobs = new Map();
const JOBS_DIR = path.join(DATA_DIR, "jobs");
const CLOUD_RUN_PROJECT = process.env.CLOUD_RUN_PROJECT;
const CLOUD_RUN_LOCATION = process.env.CLOUD_RUN_LOCATION;
const CLOUD_RUN_JOB = process.env.CLOUD_RUN_JOB;
const CLOUD_RUN_JOBS_MODE = process.env.RENDER_EXECUTION_MODE === "cloud-run-jobs";

async function googleAccessToken() {
  const response = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
    headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`Google metadata token request failed: HTTP ${response.status}`);
  const data = await response.json();
  if (typeof data.access_token !== "string") throw new Error("Google metadata did not return an access token.");
  return data.access_token;
}
async function dispatchCloudRunJob(jobId) {
  if (!CLOUD_RUN_PROJECT || !CLOUD_RUN_LOCATION || !CLOUD_RUN_JOB) throw new Error("Cloud Run Jobs mode requires CLOUD_RUN_PROJECT, CLOUD_RUN_LOCATION, and CLOUD_RUN_JOB.");
  const token = await googleAccessToken();
  const endpoint = `https://run.googleapis.com/v2/projects/${encodeURIComponent(CLOUD_RUN_PROJECT)}/locations/${encodeURIComponent(CLOUD_RUN_LOCATION)}/jobs/${encodeURIComponent(CLOUD_RUN_JOB)}:run`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ overrides: { containerOverrides: [{ env: [{ name: "RENDER_JOB_ID", value: jobId }] }] } }),
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Cloud Run Job dispatch failed: HTTP ${response.status}`);
  return data.name || null;
}
async function reconcileCloudRunExecution(jobId, record) {
  if (!CLOUD_RUN_JOBS_MODE || !record.executionName || !["queued", "rendering"].includes(record.status)) return record;
  const token = await googleAccessToken();
  const endpoint = `https://run.googleapis.com/v2/${record.executionName.split("/").map(encodeURIComponent).join("/")}`;
  const response = await fetch(endpoint, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Cloud Run execution lookup failed: HTTP ${response.status}`);
  const execution = await response.json();
  const conditions = Array.isArray(execution.conditions) ? execution.conditions : [];
  const completedCondition = conditions.find(condition => condition.type === "Completed");
  const terminal = Boolean(execution.completionTime) ||
    ["CONDITION_SUCCEEDED", "CONDITION_FAILED"].includes(completedCondition?.state);
  if (!terminal) return record;
  const succeeded = completedCondition?.state === "CONDITION_SUCCEEDED";
  const next = {
    ...record,
    status: "failed",
    error: succeeded
      ? "Cloud Run execution succeeded but no preview result was persisted; verify shared-volume consistency."
      : "Cloud Run execution failed or was cancelled before a preview result was persisted.",
    executionState: succeeded ? "succeeded" : "failed",
    updatedAt: new Date().toISOString()
  };
  await persistJob(jobId, next);
  return next;
}
async function queueRender(jobId, manifest, edits = {}, revision = 0) {
  const record = { status: CLOUD_RUN_JOBS_MODE ? "queued" : "rendering", manifest, edits, revision, updatedAt: new Date().toISOString() };
  await persistJob(jobId, record);
  if (CLOUD_RUN_JOBS_MODE) {
    try {
      const executionName = await dispatchCloudRunJob(jobId);
      // The worker may start (or even finish) before :run returns. Merge the
      // execution name into the latest persisted record rather than overwriting
      // a worker's rendering/terminal state with the stale queued snapshot.
      const latest = await loadJob(jobId) || record;
      await persistJob(jobId, { ...latest, executionName, updatedAt: new Date().toISOString() });
    } catch (error) {
      await persistJob(jobId, { ...record, status: "failed", error: error instanceof Error ? error.message : "Cloud Run Job dispatch failed", updatedAt: new Date().toISOString() });
      throw error;
    }
    return;
  }
  void render(jobId, manifest, edits).then(result => persistJob(jobId, { ...result, status: "preview_ready", manifest, revision: result.revision, updatedAt: new Date().toISOString() })).catch(error => persistJob(jobId, { ...record, status: "failed", error: error instanceof Error ? error.message : "Render failed", updatedAt: new Date().toISOString() }));
}
async function runRenderWorker(jobId) {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error("RENDER_JOB_ID is invalid.");
  const record = await loadJob(jobId);
  if (!record?.manifest) throw new Error("Render job manifest was not found on the shared persistent volume.");
  await persistJob(jobId, { ...record, status: "rendering", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  try {
    const result = await render(jobId, record.manifest, record.edits || {});
    await persistJob(jobId, { ...result, status: "preview_ready", manifest: record.manifest, revision: result.revision, executionName: process.env.CLOUD_RUN_EXECUTION || null, updatedAt: new Date().toISOString() });
  } catch (error) {
    await persistJob(jobId, { ...record, status: "failed", error: error instanceof Error ? error.message : "Render failed", updatedAt: new Date().toISOString() });
    throw error;
  }
}
async function persistJob(jobId, record) {
  await writeFile(path.join(JOBS_DIR, `${jobId}.json`), JSON.stringify(record), "utf8");
  jobs.set(jobId, record);
  return record;
}
async function loadJob(jobId) {
  // Always read the shared volume first: another Cloud Run instance / Job
  // execution may have updated this record since this process cached it.
  try {
    const record = JSON.parse(await readFile(path.join(JOBS_DIR, `${jobId}.json`), "utf8"));
    jobs.set(jobId, record);
    return record;
  } catch (error) {
    if (error?.code === "ENOENT") return jobs.get(jobId) || null;
    throw error;
  }
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}
function auth(req) {
  if (!SECRET) return false;
  return req.headers.authorization === `Bearer ${SECRET}`;
}
async function body(req, max = 2 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new Error("Request body too large."); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function safeAssetUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())) throw new Error("Asset URL host is not allowlisted or URL is not safe HTTPS.");
  return url;
}
async function download(url, target, maxBytes) {
  const response = await fetch(safeAssetUrl(url), { signal: AbortSignal.timeout(60_000), redirect: "error" });
  if (!response.ok) throw new Error(`Asset download failed with HTTP ${response.status}.`);
  const type = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
  if (!(type.startsWith("image/") || type.startsWith("audio/"))) throw new Error("Asset server returned an unexpected content type.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > maxBytes) throw new Error("Downloaded asset is empty or exceeds its size limit.");
  await writeFile(target, bytes);
}
function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); if (stderr.length > 4000) stderr = stderr.slice(-4000); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${command} exited ${code}: ${stderr}`)));
  });
}
async function probeDuration(file) {
  const value = await capture("ffprobe", ["-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",file]);
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) throw new Error("Unable to determine a valid voiceover audio duration.");
  return duration;
}
function srtTimestamp(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000), milli = ms % 1000;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")},${String(milli).padStart(3,"0")}`;
}
function buildTimedSubtitles(tracks, durations) {
  let cursor = 0, index = 1; const cues = [];
  tracks.forEach((track, sceneIndex) => {
    const words = String(track.narrationText || "").trim().split(/\s+/).filter(Boolean);
    if (!words.length) { cursor += durations[sceneIndex]; return; }
    const chunks = [];
    for (let i=0;i<words.length;i+=8) chunks.push(words.slice(i,i+8).join(" "));
    const weights = chunks.map(chunk => Math.max(1,chunk.split(/\s+/).length));
    const total = weights.reduce((a,b)=>a+b,0);
    let local = cursor;
    chunks.forEach((chunk,i) => {
      const end = i===chunks.length-1 ? cursor+durations[sceneIndex] : local+durations[sceneIndex]*(weights[i]/total);
      cues.push(`${index++}\n${srtTimestamp(local)} --> ${srtTimestamp(end)}\n${chunk}\n`);
      local=end;
    });
    cursor += durations[sceneIndex];
  });
  return cues.join("\n");
}
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk.toString(); if (stderr.length > 12000) stderr = stderr.slice(-12000); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-4000)}`)));
  });
}
function validateManifest(m) {
  if (!m || typeof m.jobId !== "string" || !Array.isArray(m.voiceoverTracks) || !m.voiceoverTracks.length || !m.subtitles || typeof m.subtitles.content !== "string") throw new Error("Invalid render manifest.");
  const tracks = [...m.voiceoverTracks].sort((a,b) => a.sceneNumber-b.sceneNumber);
  let cursor = 0;
  for (const t of tracks) {
    if (!Number.isInteger(t.sceneNumber) || !Number.isFinite(t.startSeconds) || !Number.isFinite(t.durationSeconds) || t.startSeconds < 0 || t.durationSeconds <= 0 || Math.abs(t.startSeconds-cursor) > 0.05 || typeof t.imageUrl !== "string" || typeof t.audioUrl !== "string") throw new Error("Each scene needs sequential timing plus imageUrl and audioUrl.");
    cursor += t.durationSeconds;
  }
  if (cursor > 3600) throw new Error("Render duration exceeds the one-hour safety limit.");
  return { tracks, duration: cursor };
}
async function render(jobId, manifest, edits = {}) {
  const { tracks, duration } = validateManifest(manifest);
  const work = await mkdtemp(path.join(tmpdir(), "yt-render-"));
  const finalDir = path.resolve(DATA_DIR, jobId);
  try {
    await mkdir(finalDir, { recursive: true });
    const clips = []; const actualDurations = [];
    const width = manifest.aspectRatio === "9:16" ? 1080 : manifest.aspectRatio === "1:1" ? 1080 : 1920;
    const height = manifest.aspectRatio === "9:16" ? 1920 : manifest.aspectRatio === "1:1" ? 1080 : 1080;
    for (const [index, track] of tracks.entries()) {
      const image = path.join(work, `scene-${index}.img`);
      const audio = path.join(work, `scene-${index}.audio`);
      const clip = path.join(work, `clip-${index}.mp4`);
      await Promise.all([download(track.imageUrl, image, 8*1024*1024), download(track.audioUrl, audio, 20*1024*1024)]);
      const audioDuration = await probeDuration(audio);
      const durationForScene = Number(Math.max(track.durationSeconds, audioDuration).toFixed(3));
      actualDurations.push(durationForScene);
      await run("ffmpeg", ["-y","-loop","1","-framerate","30","-i",image,"-i",audio,"-t",String(durationForScene),"-vf",`scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=30`,"-af",`apad,atrim=duration=${durationForScene}`,"-c:v","libx264","-preset","veryfast","-pix_fmt","yuv420p","-c:a","aac","-b:a","192k","-ar","48000","-movflags","+faststart","-shortest",clip]);
      clips.push(clip);
    }
    const list = path.join(work, "concat.txt");
    await writeFile(list, clips.map(p => `file '${p.replaceAll("'","'\\''")}'`).join("\n"));
    const rawVideo = path.join(work, "joined.mp4");
    await run("ffmpeg", ["-y","-f","concat","-safe","0","-i",list,"-c","copy",rawVideo]);
    const subtitle = path.join(work, "subtitles.srt");
    await writeFile(subtitle, edits.subtitleSrt ?? buildTimedSubtitles(tracks, actualDurations), "utf8");
    const output = path.join(finalDir, "preview.mp4");
    await run("ffmpeg", ["-y","-i",rawVideo,"-vf",`subtitles=${subtitle.replaceAll("\\","/").replaceAll(":","\\:")}`,"-c:v","libx264","-preset","veryfast","-pix_fmt","yuv420p","-c:a","copy","-movflags","+faststart",output]);
    const info = await stat(output);
    return { jobId, status: "preview_ready", previewPath: output, byteLength: info.size, durationSeconds: actualDurations.reduce((a,b)=>a+b,0), sceneCount: tracks.length, revision: (jobs.get(jobId)?.revision || 0) + 1 };
  } finally { await rm(work, { recursive: true, force: true }); }
}
const app = http.createServer(async (req,res) => {
  try {
    if (!auth(req)) return send(res, 401, { error: "Unauthorized" });
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { status: "ok", ffmpeg: "required-at-runtime" });
    if (req.method === "POST" && url.pathname === "/render") {
      const payload = await body(req);
      const jobId = payload.jobId;
      if (typeof jobId !== "string" || !/^[0-9a-f-]{36}$/i.test(jobId)) return send(res,400,{error:"Invalid jobId"});
      validateManifest(payload.manifest);
      await queueRender(jobId, payload.manifest, payload.edits || {}, 0);
      return send(res, 202, { jobId, status: "queued", executionMode: CLOUD_RUN_JOBS_MODE ? "cloud-run-jobs" : "local" });
    }
    const statusMatch = url.pathname.match(new RegExp("^/jobs/([0-9a-f-]{36})$", "i"));
    if (req.method === "GET" && statusMatch) {
      let record = await loadJob(statusMatch[1]);
      if (!record) return send(res,404,{error:"Render job not found"});
      if (CLOUD_RUN_JOBS_MODE && record.executionName) {
        try { record = await reconcileCloudRunExecution(statusMatch[1], record); }
        catch (error) { process.stderr.write(`execution reconciliation failed for ${statusMatch[1]}: ${error instanceof Error ? error.message : "unknown error"}\\n`); }
      }
      const { manifest: _manifest, previewPath: _path, ...publicRecord } = record;
      return send(res,200,publicRecord);
    }
    const match = url.pathname.match(new RegExp("^/preview/([0-9a-f-]{36})$", "i"));
    if (req.method === "GET" && match) {
      const jobId = match[1]; const record = await loadJob(jobId);
      if (!record || record.status !== "preview_ready" || !record.previewPath) return send(res,404,{error:"Preview not found"});
      const bytes = await readFile(record.previewPath);
      res.writeHead(200, { "content-type":"video/mp4", "content-length":bytes.length, "cache-control":"private, no-store", "x-content-type-options":"nosniff", "content-disposition":`inline; filename="${jobId}-preview.mp4"` });
      return res.end(bytes);
    }
    if (req.method === "POST" && match) {
      const payload = await body(req);
      const record = await loadJob(match[1]);
      if (!record?.manifest) return send(res,404,{error:"Original render manifest is unavailable"});
      await queueRender(match[1], record.manifest, payload.edits || {}, (record.revision || 0) + 1);
      return send(res,202,{jobId:match[1],status:"queued",executionMode:CLOUD_RUN_JOBS_MODE ? "cloud-run-jobs" : "local"});
    }
    return send(res,404,{error:"Not found"});
  } catch (error) { return send(res,400,{error:error instanceof Error ? error.message : "Render failed"}); }
});
await mkdir(DATA_DIR, { recursive: true });
await mkdir(JOBS_DIR, { recursive: true });
if (process.env.RENDER_JOB_ID) {
  try { await runRenderWorker(process.env.RENDER_JOB_ID); }
  catch (error) { process.stderr.write(`render worker failed: ${error instanceof Error ? error.message : "unknown error"}\n`); process.exitCode = 1; }
} else {
  if (CLOUD_RUN_JOBS_MODE && (!CLOUD_RUN_PROJECT || !CLOUD_RUN_LOCATION || !CLOUD_RUN_JOB)) throw new Error("Cloud Run Jobs mode requires CLOUD_RUN_PROJECT, CLOUD_RUN_LOCATION, and CLOUD_RUN_JOB.");
  for (const filename of await readdir(JOBS_DIR)) {
    if (!filename.endsWith(".json")) continue;
    try {
      const jobId = filename.slice(0, -5);
      const record = JSON.parse(await readFile(path.join(JOBS_DIR, filename), "utf8"));
      // Cloud Run Job executions are independent of dispatcher instances.
      // Never mark their shared records failed merely because this HTTP service
      // restarted; the worker owns the terminal state in Jobs mode.
      if (!CLOUD_RUN_JOBS_MODE && (record.status === "queued" || record.status === "rendering")) {
        record.status = "failed";
        record.error = "Render was interrupted by a renderer restart; submit the render again.";
        record.updatedAt = new Date().toISOString();
        await writeFile(path.join(JOBS_DIR, filename), JSON.stringify(record), "utf8");
      }
      jobs.set(jobId, record);
    } catch { /* Ignore an invalid job index entry; other jobs remain available. */ }
  }
  app.listen(PORT, "0.0.0.0", () => process.stdout.write(`renderer listening on ${PORT}\n`));
}
