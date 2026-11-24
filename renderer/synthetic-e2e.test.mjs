import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const available = ["ffmpeg", "ffprobe", "openssl"].every(command =>
  spawnSync(command, ["-version"], { stdio: "ignore" }).status === 0
);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], ...options });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); if (stderr.length > 5000) stderr = stderr.slice(-5000); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr}`)));
  });
}

async function freePort() {
  const server = createNetServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test("synthetic HTTP-to-FFmpeg render produces a playable MP4 with synchronized audio", {
  skip: !available && "Requires ffmpeg, ffprobe and openssl (installed in CI integration job).",
  timeout: 90000
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "renderer-e2e-"));
  const assetPort = await freePort();
  const rendererPort = await freePort();
  const secret = "synthetic-e2e-test-secret";
  let renderer;
  let assets;

  t.after(async () => {
    if (renderer && !renderer.killed) renderer.kill("SIGTERM");
    if (assets?.listening) await new Promise(resolve => assets.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const keyPath = path.join(root, "localhost.key");
  const certPath = path.join(root, "localhost.crt");
  await run("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"
  ]);

  const imagePath = path.join(root, "synthetic.png");
  const audioPath = path.join(root, "synthetic.mp3");
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:duration=2", "-frames:v", "1", imagePath]);
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-q:a", "7", audioPath]);
  const sourceVideoPath = path.join(root, "authorized-synthetic-source.mp4");
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", "30", "-i", imagePath, "-f", "lavfi", "-i", "sine=frequency=660:duration=4", "-t", "4", "-vf", "scale=1280:720", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sourceVideoPath]);
  const [image, audio, sourceVideo, key, cert] = await Promise.all([
    readFile(imagePath), readFile(audioPath), readFile(sourceVideoPath), readFile(keyPath), readFile(certPath)
  ]);

  assets = createHttpsServer({ key, cert }, (req, res) => {
    if (req.url === "/synthetic.png") {
      res.writeHead(200, { "content-type": "image/png", "content-length": image.length });
      return res.end(image);
    }
    if (req.url === "/synthetic.mp3") {
      res.writeHead(200, { "content-type": "audio/mpeg", "content-length": audio.length });
      return res.end(audio);
    }
    if (req.url === "/authorized-synthetic-source.mp4") {
      res.writeHead(200, { "content-type": "video/mp4", "content-length": sourceVideo.length });
      return res.end(sourceVideo);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(resolve => assets.listen(assetPort, "127.0.0.1", resolve));

  renderer = spawn(process.execPath, ["renderer/server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(rendererPort),
      RENDERER_SHARED_SECRET: secret,
      RENDERER_DATA_DIR: path.join(root, "data"),
      ASSET_HOST_ALLOWLIST: "127.0.0.1",
      NODE_TLS_REJECT_UNAUTHORIZED: "0"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let rendererError = "";
  renderer.stderr.on("data", chunk => { rendererError += chunk.toString(); if (rendererError.length > 6000) rendererError = rendererError.slice(-6000); });

  const base = `http://127.0.0.1:${rendererPort}`;
  const headers = { authorization: `Bearer ${secret}`, "content-type": "application/json" };
  let healthy = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (renderer.exitCode !== null) throw new Error(`Renderer exited before health check: ${rendererError}`);
    try {
      const response = await fetch(`${base}/health`, { headers });
      if (response.ok) { healthy = true; break; }
    } catch { /* Wait for the child server to bind its port. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(healthy, true, `Renderer did not become healthy: ${rendererError}`);

  const jobId = randomUUID();
  const manifest = {
    jobId,
    aspectRatio: "16:9",
    voiceoverTracks: [{
      sceneNumber: 1,
      startSeconds: 0,
      durationSeconds: 2,
      narrationText: "नमस्कार! स्वागत आहे",
      onScreenText: "नमस्कार! स्वागत आहे",
      transition: "cut",
      imageUrl: "https://127.0.0.1:" + assetPort + "/synthetic.png",
      audioUrl: "https://127.0.0.1:" + assetPort + "/synthetic.mp3"
    }, {
      sceneNumber: 2,
      startSeconds: 2,
      durationSeconds: 2,
      narrationText: "आज आपण नवीन गोष्ट शिकूया",
      onScreenText: "आज आपण शिकूया",
      transition: "dissolve",
      imageUrl: "https://127.0.0.1:" + assetPort + "/synthetic.png",
      audioUrl: "https://127.0.0.1:" + assetPort + "/synthetic.mp3"
    }],
    subtitles: { format: "srt", content: "" }
  };

  const queuedResponse = await fetch(`${base}/render`, {
    method: "POST", headers, body: JSON.stringify({ jobId, manifest })
  });
  assert.equal(queuedResponse.status, 202, await queuedResponse.text());

  let status;
  for (let attempt = 0; attempt < 240; attempt++) {
    const response = await fetch(`${base}/jobs/${jobId}`, { headers });
    const responseBody = await response.text();
    assert.equal(response.status, 200, responseBody);
    status = JSON.parse(responseBody);
    if (status.status === "preview_ready" || status.status === "failed") break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(status?.status, "preview_ready", JSON.stringify(status));
  assert.ok(status.byteLength > 5000);
  assert.equal(status.sceneCount, 2);

  const previewResponse = await fetch(`${base}/preview/${jobId}`, { headers });
  assert.equal(previewResponse.status, 200);
  assert.match(previewResponse.headers.get("content-type") || "", /video\/mp4/);
  const previewPath = path.join(root, "preview.mp4");
  await writeFile(previewPath, Buffer.from(await previewResponse.arrayBuffer()));

  const probe = spawnSync("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type,width,height,duration",
    "-show_entries", "format=duration", "-of", "json", previewPath
  ], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  const metadata = JSON.parse(probe.stdout);
  const video = metadata.streams.find(stream => stream.codec_type === "video");
  const sound = metadata.streams.find(stream => stream.codec_type === "audio");
  assert.ok(video, "Rendered preview must contain a video stream.");
  assert.ok(sound, "Rendered preview must retain the source narration audio.");
  assert.equal(video.width, 1920);
  assert.equal(video.height, 1080);
  assert.ok(Number.isFinite(Number(video.duration)));
  assert.ok(Number.isFinite(Number(sound.duration)));
  assert.ok(Math.abs(Number(video.duration) - Number(sound.duration)) <= 0.2, "Narration audio and video must remain synchronized.");
  assert.ok(Number(metadata.format.duration) >= 3.5);
  assert.ok(Number(metadata.format.duration) <= 5.0);

  const decode = spawnSync("ffmpeg", ["-v", "error", "-i", previewPath, "-f", "null", "-"], { encoding: "utf8" });
  assert.equal(decode.status, 0, "Rendered MP4 must fully decode for playback: " + decode.stderr);

  const motion = spawnSync("ffmpeg", [
    "-v", "error", "-i", previewPath, "-vf", "select='eq(n,0)+eq(n,30)'",
    "-vsync", "0", "-f", "framemd5", "-"
  ], { encoding: "utf8" });
  assert.equal(motion.status, 0, motion.stderr);
  const frameHashes = motion.stdout.split("\n").filter(line => line && !line.startsWith("#")).map(line => line.trim().split(",").at(-1).trim());
  assert.ok(frameHashes.length >= 2, "Motion check must sample at least two frames.");
  assert.notEqual(frameHashes[0], frameHashes[1], "Static generated imagery must have visible Ken Burns motion.");

  const shortsResponse = await fetch(base + "/v1/shorts/preview", {
    method: "POST",
    headers,
    body: JSON.stringify({
      sourceVideoUrl: "https://127.0.0.1:" + assetPort + "/authorized-synthetic-source.mp4",
      startSeconds: 0.5,
      endSeconds: 2.5,
      subtitlesSrt: "1\n00:00:00,000 --> 00:00:02,000\nनमस्कार! हा अधिकृत synthetic Shorts test आहे\n"
    })
  });
  assert.equal(shortsResponse.status, 200, await shortsResponse.clone().text());
  const shorts = await shortsResponse.json();
  assert.equal(shorts.status, "preview_ready");
  assert.equal(shorts.aspectRatio, "9:16");
  assert.equal(shorts.published, false);
  const shortsPlayback = await fetch(base + "/shorts-preview/" + shorts.previewId, { headers });
  assert.equal(shortsPlayback.status, 200);
  const shortsPath = path.join(root, "shorts-preview.mp4");
  await writeFile(shortsPath, Buffer.from(await shortsPlayback.arrayBuffer()));
  const shortsProbe = spawnSync("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type,width,height",
    "-show_entries", "format=duration", "-of", "json", shortsPath
  ], { encoding: "utf8" });
  assert.equal(shortsProbe.status, 0, shortsProbe.stderr);
  const shortsMetadata = JSON.parse(shortsProbe.stdout);
  const shortsVideo = shortsMetadata.streams.find(stream => stream.codec_type === "video");
  assert.equal(shortsVideo.width, 1080);
  assert.equal(shortsVideo.height, 1920);
  assert.ok(shortsMetadata.streams.some(stream => stream.codec_type === "audio"));
  assert.ok(Number(shortsMetadata.format.duration) >= 1.8);
  assert.ok(Number(shortsMetadata.format.duration) <= 2.3);
  const shortsDecode = spawnSync("ffmpeg", ["-v", "error", "-i", shortsPath, "-f", "null", "-"], { encoding: "utf8" });
  assert.equal(shortsDecode.status, 0, "Shorts MP4 must fully decode for playback: " + shortsDecode.stderr);
});
