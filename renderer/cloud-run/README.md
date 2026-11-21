# Cloud Run deployment notes

The renderer container is compatible with the Cloud Run container contract: it listens on `0.0.0.0:$PORT` and uses `/data` for durable output and job metadata.

## Persistent data

Mount a dedicated Cloud Storage bucket at `/data` using a Cloud Run Cloud Storage volume. Grant the Cloud Run runtime service account the minimum object permissions required to read and write that bucket. The renderer stores:

- MP4 previews under `/data/<jobId>/preview.mp4`
- Job state and the original manifest under `/data/jobs/<jobId>.json`

On startup, the renderer reloads job records. Jobs left in `queued` or `rendering` state by a prior instance are marked failed with an explicit restart message instead of silently disappearing.

## Important execution-model blocker

**Do not deploy this asynchronous HTTP renderer to Cloud Run as a production-ready service yet.** The current `POST /render` handler returns HTTP 202 and continues FFmpeg work in the background. Cloud Run request-based CPU allocation and instance lifecycle do not guarantee that background work will continue after the response is sent, especially when the service scales down.

Before a live demo render, the execution model must be changed to one of:

1. A Cloud Run Jobs worker that performs one render execution to completion, with the Cloud Run service acting only as a dispatcher/status API; or
2. A request-held synchronous render design with a verified end-to-end request timeout budget.

The Cloud Run Jobs approach is preferred for FFmpeg workloads. It requires a separate implementation and IAM setup; this repository change does not create or execute a Cloud Run Job.

## Deployment safety

- Do not create a service or bucket until the user approves the exact resources and confirms the expected billing impact.
- Set CPU and memory limits, request timeout, concurrency, and maximum instances explicitly.
- Use Secret Manager for `RENDERER_SHARED_SECRET`; never commit secrets.
- Restrict `ASSET_HOST_ALLOWLIST` to the Cloudflare Worker media hostname.
- Keep the Cloud Run service private where possible; require authenticated invocation.
- A budget alert is notification-only and is not a hard spending cap.
