# External FFmpeg renderer

This is a separate container runtime. Cloudflare Workers remain the MCP/control plane; they should not perform long-running FFmpeg jobs.

## Run

```sh
docker build -t klassyfic-video-renderer ./renderer
docker run --rm -p 8787:8787 \
  -e RENDERER_SHARED_SECRET='replace-with-a-long-random-secret' \
  -e ASSET_HOST_ALLOWLIST='youtube-mcp-server-bharat.klassyfic.workers.dev' \
  -v renderer-data:/data klassyfic-video-renderer
```

The runtime requires persistent storage mounted at `/data`. It is not deployed by this repository change.

## API

All endpoints require `Authorization: Bearer <RENDERER_SHARED_SECRET>`.

- `GET /health`
- `POST /render` with `{ "jobId": "...", "manifest": { ... } }` returns HTTP 202 immediately.
- `GET /jobs/:jobId` polls queued/rendering/preview_ready/failed status.
- `GET /preview/:jobId` returns the MP4 once ready.
- `POST /preview/:jobId` accepts `{ "edits": { "subtitleSrt": "..." } }` and queues a revision from the original manifest.

Each manifest scene must include sequential `startSeconds`/`durationSeconds`, `imageUrl`, and `audioUrl`. The URLs must be HTTPS and their hostname must be explicitly listed in `ASSET_HOST_ALLOWLIST`; redirects are rejected. FFprobe measures each generated voiceover. Each scene lasts at least its planned duration and is extended if speech is longer; audio is padded to that scene duration, visuals remain on screen for the same interval, and captions are re-timed proportionally to narration word count. Scene clips are concatenated and SRT subtitles are burned into the preview. This is scene-level synchronization, not phoneme-level forced alignment.

## Important limits

- This is a first external renderer adapter, not a managed/free hosting deployment.
- The in-memory job index is lost on restart; the MP4 itself is persisted under `/data/:jobId/preview.mp4`. Production needs durable job metadata and object storage.
- Scene transitions currently render as hard cuts; transition-specific xfade support remains future work.
- Only subtitle SRT edits are accepted in this initial preview revision. Scene transitions currently render as hard cuts. Do not expose the renderer publicly without TLS, rate limiting, a strong secret, and a persistent volume.
