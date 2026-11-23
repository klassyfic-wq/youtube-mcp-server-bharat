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
