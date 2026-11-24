#!/usr/bin/env bash
set -euo pipefail

: "${PROJECT_ID:?PROJECT_ID is required}"
: "${REGION:?REGION is required}"
: "${MEDIA_BUCKET:?MEDIA_BUCKET is required}"
: "${RENDERER_URL:?RENDERER_URL is required}"
: "${SIGNER_SERVICE_ACCOUNT:?SIGNER_SERVICE_ACCOUNT is required}"

OUT_DIR="${RUNNER_TEMP:-/tmp}/production-e2e"
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"
RUN_PREFIX="e2e-test/${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}"
JOB_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
SHORTS_ID=""
printf 'E2E_PREFIX=%s\nE2E_JOB_ID=%s\n' "$RUN_PREFIX" "$JOB_ID" >> "$GITHUB_ENV"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
umask 077
gcloud secrets versions access latest \
  --secret=klassyfic-renderer-shared-secret \
  --project="$PROJECT_ID" > "$TMP_DIR/renderer-secret"
printf 'header = "Authorization: Bearer %s"\n' "$(cat "$TMP_DIR/renderer-secret")" > "$TMP_DIR/curl.conf"
chmod 600 "$TMP_DIR/curl.conf"

IMAGE_SOURCE="vertex-ai"
if [[ "${E2E_USE_SYNTHETIC_IMAGES:-false}" == "true" ]]; then
  IMAGE_SOURCE="synthetic-fallback"
  echo "::warning::Using deterministic synthetic PNG test frames because Vertex AI image access is blocked by account eligibility."
  python3 - "$TMP_DIR" <<'PY'
import math, pathlib, struct, sys, zlib
base = pathlib.Path(sys.argv[1])
W, H = 1280, 720

def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)

def make_png(path, variant):
    rows = []
    for y in range(H):
        row = bytearray([0])
        for x in range(W):
            sky = y < 455
            if variant == 1:
                top, bottom, land = (20, 55, 105), (250, 165, 95), (42, 125, 78)
            else:
                top, bottom, land = (34, 32, 100), (100, 190, 210), (35, 112, 112)
            t = min(1.0, y / 455)
            if sky:
                rgb = tuple(int(top[i] * (1-t) + bottom[i] * t) for i in range(3))
                sun_x, sun_y = (1010, 175) if variant == 1 else (260, 190)
                if (x-sun_x)**2 + (y-sun_y)**2 < 78**2:
                    rgb = (255, 225, 145) if variant == 1 else (245, 235, 170)
            else:
                hill = 470 + int(55 * math.sin(x / 155 + variant)) + int(22 * math.sin(x / 61))
                rgb = land if y > hill else tuple(min(255, c + 35) for c in land)
                if y > 610 and ((x // 42 + variant) % 5 == 0):
                    rgb = tuple(max(0, c - 18) for c in rgb)
            row.extend(rgb)
        rows.append(bytes(row))
    raw = b"".join(rows)
    data = b"\x89PNG\r\n\x1a\n"
    data += chunk(b"IHDR", struct.pack(">2I5B", W, H, 8, 2, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(raw, 6))
    data += chunk(b"IEND", b"")
    path.write_bytes(data)

for n in (1, 2):
    path = base / f"scene-{n}.png"
    make_png(path, n)
    assert path.stat().st_size > 1000
    print(f"Synthetic E2E scene {n}: PASS ({path.stat().st_size} bytes)")
PY
else
  # Generate two original AI scene images through the production Vertex endpoint.
  curl --config "$TMP_DIR/curl.conf" --fail-with-body --silent --show-error \
    -H 'Content-Type: application/json' \
    -d '{"model":"gemini-2.5-flash-image","prompt":"Cinematic 16:9 illustration of a warm sunrise over a peaceful Indian village, lush green landscape, vibrant natural colors, professional animation background, no words, no lettering, no logos","n":1,"size":"1024x1024","response_format":"b64_json"}' \
    "$RENDERER_URL/v1/images/generations" -o "$TMP_DIR/scene-1-image.json"
  curl --config "$TMP_DIR/curl.conf" --fail-with-body --silent --show-error \
    -H 'Content-Type: application/json' \
    -d '{"model":"gemini-2.5-flash-image","prompt":"Cinematic 16:9 illustration of a curious child exploring a colorful science garden with simple glowing experiments, friendly educational animation style, rich details, no words, no lettering, no logos","n":1,"size":"1024x1024","response_format":"b64_json"}' \
    "$RENDERER_URL/v1/images/generations" -o "$TMP_DIR/scene-2-image.json"
  python3 - "$TMP_DIR" <<'PY'
import base64, json, pathlib, sys
base = pathlib.Path(sys.argv[1])
for index in (1, 2):
    payload = json.loads((base / f"scene-{index}-image.json").read_text(encoding="utf-8"))
    encoded = payload.get("data", [{}])[0].get("b64_json")
    assert isinstance(encoded, str) and encoded, f"Vertex returned no image for scene {index}"
    image = base64.b64decode(encoded, validate=True)
    assert 1000 < len(image) <= 6 * 1024 * 1024, f"Scene {index} image size outside bounds: {len(image)}"
    assert image.startswith(bytes.fromhex("89504e470d0a1a0a")) or image.startswith(bytes.fromhex("ffd8ff")), f"Scene {index} image signature invalid"
    (base / f"scene-{index}.png").write_bytes(image)
    print(f"Vertex AI scene {index}: PASS ({len(image)} bytes)")
PY
fi

curl --config "$TMP_DIR/curl.conf" --fail-with-body --silent --show-error \
  -H 'Content-Type: application/json' \
  -d '{"input":"नमस्कार! आपल्या चॅनेलमध्ये स्वागत आहे.","voice":"mr-IN-Chirp3-HD-Achird","response_format":"mp3"}' \
  "$RENDERER_URL/v1/audio/speech" -o "$TMP_DIR/scene-1.mp3"
curl --config "$TMP_DIR/curl.conf" --fail-with-body --silent --show-error \
  -H 'Content-Type: application/json' \
  -d '{"input":"चला, आज काहीतरी नवीन शिकूया!","voice":"mr-IN-Chirp3-HD-Achird","response_format":"mp3"}' \
  "$RENDERER_URL/v1/audio/speech" -o "$TMP_DIR/scene-2.mp3"

for asset in scene-1.png scene-2.png scene-1.mp3 scene-2.mp3; do
  gcloud storage cp "$TMP_DIR/$asset" "gs://$MEDIA_BUCKET/$RUN_PREFIX/$asset" --quiet
done

sign_url() {
  local object="$1"
  gcloud storage sign-url "gs://$MEDIA_BUCKET/$object" \
    --duration=20m \
    --impersonate-service-account="$SIGNER_SERVICE_ACCOUNT" \
    --format='value(signed_url)'
}
IMAGE_1_URL="$(sign_url "$RUN_PREFIX/scene-1.png")"
IMAGE_2_URL="$(sign_url "$RUN_PREFIX/scene-2.png")"
AUDIO_1_URL="$(sign_url "$RUN_PREFIX/scene-1.mp3")"
AUDIO_2_URL="$(sign_url "$RUN_PREFIX/scene-2.mp3")"
export JOB_ID IMAGE_1_URL IMAGE_2_URL AUDIO_1_URL AUDIO_2_URL TMP_DIR
python3 <<'PY'
import json, os, subprocess
def duration(path):
    value = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", path
    ], text=True).strip()
    return float(value)
base = os.environ["TMP_DIR"]
tracks = []
cursor = 0.0
for i, (image, audio, narration, overlay, transition) in enumerate([
    (os.environ["IMAGE_1_URL"], os.path.join(base, "scene-1.mp3"),
     "नमस्कार! आपल्या चॅनेलमध्ये स्वागत आहे.", "नमस्कार! स्वागत आहे", "cut"),
    (os.environ["IMAGE_2_URL"], os.path.join(base, "scene-2.mp3"),
     "चला, आज काहीतरी नवीन शिकूया!", "चला, शिकूया!", "dissolve"),
], start=1):
    d = duration(audio)
    tracks.append({
        "sceneNumber": i, "startSeconds": round(cursor, 3), "durationSeconds": round(d, 3),
        "imageUrl": image,
        "audioUrl": os.environ["AUDIO_1_URL"] if i == 1 else os.environ["AUDIO_2_URL"],
        "narrationText": narration, "onScreenText": overlay, "transition": transition
    })
    cursor += d
manifest = {
    "jobId": os.environ["JOB_ID"], "aspectRatio": "16:9",
    "voiceoverTracks": tracks, "subtitles": {"content": ""}
}
with open(os.path.join(base, "manifest.json"), "w", encoding="utf-8") as f:
    json.dump({"jobId": os.environ["JOB_ID"], "manifest": manifest}, f, ensure_ascii=False)
PY

curl --config "$TMP_DIR/curl.conf" --fail-with-body --silent --show-error \
  -H 'Content-Type: application/json' --data-binary @"$TMP_DIR/manifest.json" \
  "$RENDERER_URL/render" -o "$TMP_DIR/render-queued.json"
python3 - "$TMP_DIR/render-queued.json" "$JOB_ID" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
assert data.get("jobId") == sys.argv[2], data
assert data.get("executionMode") == "cloud-run-jobs", data
assert data.get("dispatchOutcomeUnknown") is not True, data
print("Production Cloud Run render dispatch: PASS")
PY

ready=0
for attempt in $(seq 1 90); do
  curl --config "$TMP_DIR/curl.conf" --fail-with-body --silent --show-error \
    "$RENDERER_URL/jobs/$JOB_ID" -o "$TMP_DIR/render-status.json"
  STATUS="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("status",""))' "$TMP_DIR/render-status.json")"
  if [[ "$STATUS" == "preview_ready" ]]; then ready=1; break; fi
  if [[ "$STATUS" == "failed" || "$STATUS" == "dispatch_unknown" ]]; then
    cat "$TMP_DIR/render-status.json"
    echo "::error::Production render ended with status $STATUS"
    exit 1
  fi
  sleep 5
done
if [[ "$ready" != "1" ]]; then
  cat "$TMP_DIR/render-status.json"
  echo "::error::Timed out waiting for production synthetic render."
  exit 1
fi

curl --config "$TMP_DIR/curl.conf" --fail-with-body --silent --show-error \
  "$RENDERER_URL/preview/$JOB_ID" -o "$OUT_DIR/production-render.mp4"
ffprobe -v error -show_entries stream=codec_type,width,height,duration -show_entries format=duration \
  -of json "$OUT_DIR/production-render.mp4" > "$OUT_DIR/render-probe.json"
ffmpeg -hide_banner -v error -i "$OUT_DIR/production-render.mp4" -f null -
python3 - "$OUT_DIR/render-probe.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
streams = data.get("streams", [])
video = next((s for s in streams if s.get("codec_type") == "video"), None)
audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
assert video and (video.get("width"), video.get("height")) == (1920, 1080), video
assert audio, "Rendered MP4 has no audio stream"
assert abs(float(video["duration"]) - float(audio["duration"])) < 0.75, (video, audio)
assert float(data["format"]["duration"]) > 2, data
print("Production MP4 playback/decode, 1920x1080 video and audio: PASS")
PY

# Reuse the synthetic rendered MP4 as the authorized test source for the Shorts route.
gcloud storage cp "$OUT_DIR/production-render.mp4" "gs://$MEDIA_BUCKET/$RUN_PREFIX/shorts-source.mp4" --quiet
SOURCE_URL="$(sign_url "$RUN_PREFIX/shorts-source.mp4")"
export SOURCE_URL
SHORTS_END="$(python3 -c 'import json,sys; print(min(4.0, float(json.load(open(sys.argv[1]))["format"]["duration"])-0.1))' "$OUT_DIR/render-probe.json")"
python3 - "$TMP_DIR/shorts-request.json" "$SOURCE_URL" "$SHORTS_END" <<'PY'
import json, sys
end = float(sys.argv[3])
assert end > 1.0, f"Synthetic render is too short for a Shorts preview: {end}"
total_ms = int(round(end * 1000))
seconds, millis = divmod(total_ms, 1000)
payload = {
    "sourceVideoUrl": sys.argv[2], "startSeconds": 0, "endSeconds": end,
    "subtitlesSrt": f"1\\n00:00:00,000 --> 00:00:{seconds:02d},{millis:03d}\\nनमस्कार! चला, शिकूया!\\n"
}
json.dump(payload, open(sys.argv[1], "w", encoding="utf-8"), ensure_ascii=False)
PY
curl --config "$TMP_DIR/curl.conf" --fail-with-body --silent --show-error \
  -H 'Content-Type: application/json' --data-binary @"$TMP_DIR/shorts-request.json" \
  "$RENDERER_URL/v1/shorts/preview" -o "$TMP_DIR/shorts-response.json"
SHORTS_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["previewId"])' "$TMP_DIR/shorts-response.json")"
printf 'E2E_SHORTS_ID=%s\n' "$SHORTS_ID" >> "$GITHUB_ENV"
curl --config "$TMP_DIR/curl.conf" --fail-with-body --silent --show-error \
  "$RENDERER_URL/shorts-preview/$SHORTS_ID" -o "$OUT_DIR/production-shorts.mp4"
ffprobe -v error -show_entries stream=codec_type,width,height,duration -show_entries format=duration \
  -of json "$OUT_DIR/production-shorts.mp4" > "$OUT_DIR/shorts-probe.json"
ffmpeg -hide_banner -v error -i "$OUT_DIR/production-shorts.mp4" -f null -
python3 - "$OUT_DIR/shorts-probe.json" "$TMP_DIR/shorts-response.json" <<'PY'
import json, sys
probe = json.load(open(sys.argv[1], encoding="utf-8"))
result = json.load(open(sys.argv[2], encoding="utf-8"))
streams = probe.get("streams", [])
video = next((s for s in streams if s.get("codec_type") == "video"), None)
audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
assert video and (video.get("width"), video.get("height")) == (1080, 1920), video
assert audio, "Shorts preview has no retained source audio"
assert abs(float(video["duration"]) - float(audio["duration"])) < 0.75, (video, audio)
assert result.get("status") == "preview_ready" and result.get("aspectRatio") == "9:16", result
assert result.get("published") is False, result
print("Production Shorts preview 1080x1920, retained audio, subtitle render and playback: PASS")
PY

cp "$TMP_DIR/render-status.json" "$OUT_DIR/render-status.json"
cp "$TMP_DIR/shorts-response.json" "$OUT_DIR/shorts-response.json"
cat > "$OUT_DIR/README.txt" <<EOF
Production synthetic E2E run: ${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}
Render job ID: $JOB_ID
Shorts preview ID: $SHORTS_ID
Both videos were generated only from original Vertex AI scenes and Marathi TTS.
No third-party or YouTube source media was used. Nothing was uploaded or published to YouTube.
EOF
printf 'Production renderer E2E passed. Render job=%s Shorts preview=%s\n' "$JOB_ID" "$SHORTS_ID"
