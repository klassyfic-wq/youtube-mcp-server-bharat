const FPS = 30;
const MAX_DIMENSION = 4096;

export function buildSceneVideoFilter({ width, height, durationSeconds, sceneNumber = 1, overlayFile }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error("Video dimensions must be integers between 2 and 4096.");
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 3600) {
    throw new Error("Scene duration must be greater than 0 and no more than 3600 seconds.");
  }
  if (!Number.isInteger(sceneNumber) || sceneNumber < 1) throw new Error("Scene number must be a positive integer.");
  const frameCount = Math.max(1, Math.round(durationSeconds * FPS));
  const zoom = sceneNumber % 2 === 0
    ? "max(1.08-0.08*on/" + frameCount + ",1.0)"
    : "min(1.0+0.08*on/" + frameCount + ",1.08)";
  let filter = [
    "scale=" + width + ":" + height + ":force_original_aspect_ratio=increase",
    "crop=" + width + ":" + height,
    "zoompan=z='" + zoom + "':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=" + width + "x" + height + ":fps=" + FPS,
    "setsar=1",
  ].join(",");
  if (overlayFile) {
    const safePath = String(overlayFile).replaceAll("\\", "/").replaceAll(":", "\\:");
    filter += ",drawtext=fontfile=/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf:textfile=" + safePath + ":fontcolor=white:fontsize=56:box=1:boxcolor=black@0.55:boxborderw=20:x=(w-text_w)/2:y=h-text_h-90";
  }
  return filter;
}

export function buildSceneJoinArgs({ clipPaths, durations, transitions = [], outputPath, transitionDurationSeconds = 0.35 }) {
  if (!Array.isArray(clipPaths) || !clipPaths.length || clipPaths.length > 60 ||
      !Array.isArray(durations) || durations.length !== clipPaths.length ||
      !clipPaths.every(path => typeof path === "string" && path.length > 0) ||
      !durations.every(value => Number.isFinite(value) && value > 0) ||
      typeof outputPath !== "string" || !outputPath) {
    throw new Error("Scene join requires matching non-empty clip paths and positive durations.");
  }
  if (!Number.isFinite(transitionDurationSeconds) || transitionDurationSeconds <= 0 || transitionDurationSeconds > 1) {
    throw new Error("Transition duration must be greater than 0 and no more than 1 second.");
  }
  if (clipPaths.length === 1) return ["-y", "-i", clipPaths[0], "-c", "copy", outputPath];
  const args = ["-y"];
  for (const clipPath of clipPaths) args.push("-i", clipPath);
  const graph = [];
  let videoLabel = "0:v";
  let audioLabel = "0:a";
  let outputDuration = durations[0];
  let priorOverlap = 0;
  for (let index = 1; index < clipPaths.length; index++) {
    const requested = transitions[index] ?? "cut";
    const transition = requested === "dissolve" ? "dissolve" : requested === "slide" ? "slideleft" : "fade";
    const overlap = requested === "cut" ? 0.01 : transitionDurationSeconds;
    const offset = Math.max(0, outputDuration - overlap);
    const nextVideo = `v${index}`;
    const nextAudio = `a${index}`;
    graph.push(`[${videoLabel}][${index}:v]xfade=transition=${transition}:duration=${overlap.toFixed(3)}:offset=${offset.toFixed(3)}[${nextVideo}]`);
    graph.push(`[${audioLabel}][${index}:a]acrossfade=d=${overlap.toFixed(3)}:c1=tri:c2=tri[${nextAudio}]`);
    videoLabel = nextVideo;
    audioLabel = nextAudio;
    outputDuration += durations[index] - overlap;
    priorOverlap += overlap;
  }
  args.push("-filter_complex", graph.join(";"), "-map", `[${videoLabel}]`, "-map", `[${audioLabel}]`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", outputPath);
  return args;
}
