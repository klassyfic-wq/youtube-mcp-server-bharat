import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 8787);
const SECRET = process.env.RENDERER_SHARED_SECRET;
const DATA_DIR = process.env.RENDERER_DATA_DIR || "/data";
const ALLOWED_HOSTS = new Set((process.env.ASSET_HOST_ALLOWLIST || "").split(",").map(v => v.trim().toLowerCase()).filter(Boolean));
const jobs = new Map();

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
    const clips = [];
    const width = manifest.aspectRatio === "9:16" ? 1080 : manifest.aspectRatio === "1:1" ? 1080 : 1920;
    const height = manifest.aspectRatio === "9:16" ? 1920 : manifest.aspectRatio === "1:1" ? 1080 : 1080;
    for (const [index, track] of tracks.entries()) {
      const image = path.join(work, `scene-${index}.img`);
      const audio = path.join(work, `scene-${index}.audio`);
      const clip = path.join(work, `clip-${index}.mp4`);
      await Promise.all([download(track.imageUrl, image, 8*1024*1024), download(track.audioUrl, audio, 20*1024*1024)]);
      const durationForScene = Number(track.durationSeconds.toFixed(3));
      await run("ffmpeg", ["-y","-loop","1","-framerate","30","-i",image,"-i",audio,"-t",String(durationForScene),"-vf",`scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=30`,"-af",`apad,atrim=duration=${durationForScene}`,"-c:v","libx264","-preset","veryfast","-pix_fmt","yuv420p","-c:a","aac","-b:a","192k","-ar","48000","-movflags","+faststart","-shortest",clip]);
      clips.push(clip);
    }
    const list = path.join(work, "concat.txt");
    await writeFile(list, clips.map(p => `file '${p.replaceAll("'","'\\''")}'`).join("\n"));
    const rawVideo = path.join(work, "joined.mp4");
    await run("ffmpeg", ["-y","-f","concat","-safe","0","-i",list,"-c","copy",rawVideo]);
    const subtitle = path.join(work, "subtitles.srt");
    await writeFile(subtitle, edits.subtitleSrt ?? manifest.subtitles.content, "utf8");
    const output = path.join(finalDir, "preview.mp4");
    await run("ffmpeg", ["-y","-i",rawVideo,"-vf",`subtitles=${subtitle.replaceAll("\\","/").replaceAll(":","\\:")}`,"-c:v","libx264","-preset","veryfast","-pix_fmt","yuv420p","-c:a","copy","-movflags","+faststart",output]);
    const info = await stat(output);
    return { jobId, status: "preview_ready", previewPath: output, byteLength: info.size, durationSeconds: duration, sceneCount: tracks.length, revision: (jobs.get(jobId)?.revision || 0) + 1 };
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
      const result = await render(jobId, payload.manifest, payload.edits || {});
      jobs.set(jobId, { ...result, manifest, revision: result.revision });
      return send(res, 200, result);
    }
    const match = url.pathname.match(/^\/preview\/([0-9a-f-]{36})$/i);
    if (req.method === "GET" && match) {
      const jobId = match[1]; const record = jobs.get(jobId);
      if (!record) return send(res,404,{error:"Preview not found"});
      const bytes = await readFile(record.previewPath);
      res.writeHead(200, { "content-type":"video/mp4", "content-length":bytes.length, "cache-control":"private, no-store", "x-content-type-options":"nosniff", "content-disposition":`inline; filename="${jobId}-preview.mp4"` });
      return res.end(bytes);
    }
    if (req.method === "POST" && match) {
      const payload = await body(req);
      const record = jobs.get(match[1]);
      if (!record?.manifest) return send(res,404,{error:"Original render manifest is unavailable"});
      const result = await render(match[1], record.manifest, payload.edits || {});
      jobs.set(match[1], { ...result, manifest: record.manifest });
      return send(res,200,result);
    }
    return send(res,404,{error:"Not found"});
  } catch (error) { return send(res,400,{error:error instanceof Error ? error.message : "Render failed"}); }
});
await mkdir(DATA_DIR, { recursive: true });
app.listen(PORT, "0.0.0.0", () => process.stdout.write(`renderer listening on ${PORT}\n`));
