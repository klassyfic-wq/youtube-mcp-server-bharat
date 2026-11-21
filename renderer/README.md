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
- `POST /render` with `{ "jobId": "...", "manifest": { ... } }`
- `GET /preview/:jobId` returns the MP4.
- `POST /preview/:jobId` accepts `{ "edits": { "subtitleSrt": "..." } }` and re-renders from the original manifest.

Each manifest scene must include sequential `startSeconds`/`durationSeconds`, `imageUrl`, and `audioUrl`. The URLs must be HTTPS and their hostname must be explicitly listed in `ASSET_HOST_ALLOWLIST`; redirects are rejected. Audio is padded/trimmed to the scene's declared duration, scene clips are concatenated, and SRT subtitles are burned into the preview.

## Important limits

- This is a first external renderer adapter, not a managed/free hosting deployment.
- The in-memory job index is lost on restart; the MP4 itself is persisted under `/data/:jobId/preview.mp4`. Production needs durable job metadata and object storage.
- Scene transitions currently render as hard cuts; transition-specific xfade support remains future work.
- Only subtitle SRT edits are accepted in this initial preview revision. Do not expose the renderer publicly without TLS, rate limiting, a strong secret, and a persistent volume.
