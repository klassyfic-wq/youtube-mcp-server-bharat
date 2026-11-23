import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_SOURCE_BYTES = 500 * 1024 * 1024;
const MAX_CLIP_SECONDS = 180;

export function validateShortsPreviewRequest(payload, allowedHosts) {
  if (!payload || typeof payload !== "object") throw new Error("A Shorts preview request is required.");
  let source;
  try { source = new URL(payload.sourceVideoUrl); } catch { throw new Error("sourceVideoUrl must be a valid HTTPS URL."); }
  if (source.protocol !== "https:" || source.username || source.password || source.hash || !allowedHosts.has(source.hostname.toLowerCase())) {
    throw new Error("Source video URL must use HTTPS and a host in ASSET_HOST_ALLOWLIST.");
  }
  const startSeconds = payload.startSeconds;
  const endSeconds = payload.endSeconds;
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds || endSeconds - startSeconds > MAX_CLIP_SECONDS) {
    throw new Error("Clip timestamps must define a positive segment no longer than 180 seconds.");
  }
  const subtitlesSrt = payload.subtitlesSrt === undefined ? "" : payload.subtitlesSrt;
  if (typeof subtitlesSrt !== "string" || subtitlesSrt.length > 200000) throw new Error("subtitlesSrt must be text no longer than 200000 characters.");
  return { source, startSeconds, endSeconds, subtitlesSrt };
}

export function buildShortsFfmpegArgs({ sourcePath, outputPath, startSeconds, endSeconds, subtitlesPath }) {
  const duration = endSeconds - startSeconds;
  const filters = ["scale=1080:1920:force_original_aspect_ratio=increase", "crop=1080:1920", "setsar=1"];
  if (subtitlesPath) {
    const safePath = subtitlesPath.replaceAll("\\", "/").replaceAll(":", "\\:");
    filters.push("subtitles=" + safePath);
  }
  return ["-y", "-ss", String(startSeconds), "-i", sourcePath, "-t", String(duration), "-vf", filters.join(","), "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart", outputPath];
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString(); if (stdout.length > 4000) stdout = stdout.slice(-4000); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${command} exited ${code}: ${stderr.slice(-2500)}`)));
  });
}

export async function createShortsPreview({ payload, allowedHosts, dataDir }) {
  const { source, startSeconds, endSeconds, subtitlesSrt } = validateShortsPreviewRequest(payload, allowedHosts);
  const response = await fetch(source, { redirect: "error", signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Source video fetch failed with HTTP ${response.status}.`);
  const contentType = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
  if (!["video/mp4", "video/webm", "video/quicktime", "application/octet-stream"].includes(contentType)) throw new Error("Source URL did not return an accepted video content type.");
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_SOURCE_BYTES) throw new Error("Source video exceeds the 500 MB size limit.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_SOURCE_BYTES) throw new Error("Source video is empty or exceeds the 500 MB size limit.");
  const previewId = randomUUID();
  const outputDir = path.resolve(dataDir, "shorts", previewId);
  await mkdir(outputDir, { recursive: true });
  const sourcePath = path.join(outputDir, "source-video");
  const outputPath = path.join(outputDir, "preview.mp4");
  const subtitlesPath = subtitlesSrt ? path.join(outputDir, "captions.srt") : undefined;
  await writeFile(sourcePath, bytes);
  if (subtitlesPath) await writeFile(subtitlesPath, subtitlesSrt, "utf8");
  const mediaDuration = Number(await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", sourcePath]));
  if (!Number.isFinite(mediaDuration) || endSeconds > mediaDuration + 0.05) throw new Error("Requested clip end is beyond the source video's duration.");
  await run("ffmpeg", buildShortsFfmpegArgs({ sourcePath, outputPath, startSeconds, endSeconds, subtitlesPath }));
  const info = await stat(outputPath);
  return { previewId, status: "preview_ready", durationSeconds: Number((endSeconds - startSeconds).toFixed(3)), byteLength: info.size, aspectRatio: "9:16", audio: "source audio retained; caller must confirm audio rights", published: false };
}

export async function readShortsPreview({ previewId, dataDir }) {
  if (!/^[0-9a-f-]{36}$/i.test(previewId)) throw new Error("Invalid Shorts preview ID.");
  const filePath = path.resolve(dataDir, "shorts", previewId, "preview.mp4");
  const info = await stat(filePath);
  return { filePath, byteLength: info.size, bytes: await readFile(filePath) };
}
