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

The runtime requires persistent storage mounted at `/data`. On Cloud Run, mount a Cloud Storage bucket at this path; see [Cloud Run notes](./cloud-run/README.md). This repository change does not deploy GCP resources.

## API

All endpoints require `Authorization: Bearer <RENDERER_SHARED_SECRET>`.

- `GET /health`
- `POST /render` with `{ "jobId": "...", "manifest": { ... } }` returns HTTP 202 immediately.
- `GET /jobs/:jobId` polls queued/rendering/preview_ready/failed status.
- `GET /preview/:jobId` returns the MP4 once ready.
- `POST /preview/:jobId` accepts `{ "edits": { "subtitleSrt": "..." } }` and queues a revision from the original manifest.

Each manifest scene must include sequential `startSeconds`/`durationSeconds`, `imageUrl`, and `audioUrl`. The URLs must be HTTPS and their hostname must be explicitly listed in `ASSET_HOST_ALLOWLIST`; redirects are rejected. FFprobe measures each generated voiceover. Each scene lasts at least its planned duration and is extended if speech is longer; audio is padded to that scene duration, visuals remain on screen for the same interval, and captions are re-timed proportionally to narration word count. Scene clips are concatenated and SRT subtitles are burned into the preview. This is scene-level synchronization, not phoneme-level forced alignment.

## Google Cloud media generation

Cloud Run provides Vertex AI Gemini image generation and Marathi Cloud Text-to-Speech. See [Cloud Run deployment and Terraform](./cloud-run/README.md).

## Cloud Run Jobs mode

For Cloud Run, set `RENDER_EXECUTION_MODE=cloud-run-jobs` and configure `CLOUD_RUN_PROJECT`, `CLOUD_RUN_LOCATION`, and `CLOUD_RUN_JOB` on the private HTTP dispatcher. It persists the manifest to `/data`, then invokes the Cloud Run Jobs v2 API using the attached runtime identity. Run the same image as a Cloud Run Job with `RENDER_JOB_ID` supplied as an execution environment override; that process renders synchronously to completion and exits. The dispatcher service and Job must mount the same persistent Cloud Storage bucket at `/data`. See [Cloud Run deployment notes](./cloud-run/README.md) for IAM and deployment requirements.

## Important limits

- This is a renderer adapter, not a managed/free hosting deployment.
- Job metadata is persisted under `/data/jobs/:jobId.json`; MP4 previews are persisted under `/data/:jobId/preview.mp4`. Both require the same persistent volume to be mounted in the dispatcher and worker.
- Local mode still renders asynchronously after HTTP 202 and is intended for local development only. Cloud Run Jobs mode dispatches a separate one-shot worker.
- Worker termination before writing a terminal status can leave a record in `rendering`; Cloud Run execution reconciliation marks terminal executions without a persisted preview as failed when status is polled.
- Submissions, edits, and worker execution are serialized with an in-process per-job mutex. This is not a distributed lock: it does not coordinate separate dispatcher instances or separate Cloud Run Job executions. Use a single dispatcher instance and prevent duplicate Job dispatches operationally until a storage-backed lease/atomic conditional-write coordinator is implemented and integration-tested.
- Scene transitions currently render as hard cuts; transition-specific xfade support remains future work.
- Only subtitle SRT edits are accepted in this initial preview revision. Scene transitions currently render as hard cuts. Do not expose the renderer publicly without TLS, rate limiting, a strong secret, and a persistent volume.
