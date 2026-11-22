# Cloud Run deployment and execution model

The renderer supports two explicit modes:

- **Local mode** (default): the HTTP process renders asynchronously for local development only.
- **Cloud Run Jobs mode**: set `RENDER_EXECUTION_MODE=cloud-run-jobs` on the private dispatcher service. The service writes the manifest and edit request to the shared `/data/jobs/<jobId>.json` volume, then calls the Cloud Run Jobs v2 `:run` API. The response is a long-running Operation; the dispatcher persists the Execution resource name from the Operation metadata (not the Operation name) for subsequent status polling. The same image is used by the Job; set `RENDER_JOB_ID` as a Job execution override and the container runs exactly one render to completion, then exits.

## Required shared storage

Mount the same dedicated Cloud Storage bucket at `/data` in **both** the dispatcher service and the Cloud Run Job. The worker reads the persisted manifest and writes the MP4 and final job record to this shared volume. Do not use instance-local writable storage for job metadata or output. Validate Cloud Storage FUSE consistency and write behavior with a real integration test before production use; this repository does not provision the bucket.

## Dispatcher service configuration

Set these non-secret environment variables:

- `RENDER_EXECUTION_MODE=cloud-run-jobs`
- `CLOUD_RUN_PROJECT=<project-id>`
- `CLOUD_RUN_LOCATION=<job-region>`
- `RENDERER_JOB_NAME=<job-name>`
- `RENDERER_DATA_DIR=/data`
- `RENDERER_SHARED_SECRET` from Secret Manager
- `ASSET_HOST_ALLOWLIST` restricted to the Worker media hostname

The service runtime identity obtains its short-lived access token from the Cloud Run metadata server and calls the Cloud Run Jobs v2 API. Grant it `run.jobs.run` and `run.jobs.runWithOverrides` on the specific Job because the request supplies a container environment override (typically via a narrowly scoped custom role or a supported predefined role). Do not place service-account keys or access tokens in environment variables or source.

## Job configuration

Use the same container image and mount the same bucket at `/data`. Keep the Job private and configure explicit task timeout, CPU, memory, task count (1), and retry count. The Job runtime identity needs the minimum Cloud Storage object read/write permissions on the dedicated bucket and outbound access to the allowlisted media host. The Job does not need the dispatcher shared secret.

Cloud Run Jobs injects `RENDER_JOB_ID` through the execution override. The container loads the record, marks it rendering, runs FFmpeg synchronously, persists `preview_ready` or `failed`, and exits with a matching process status. The service's existing `GET /jobs/:jobId` and `GET /preview/:jobId` endpoints continue to read the shared volume.

## API and limitations

- `POST /render` persists the manifest, dispatches a Cloud Run Job and returns HTTP 202.
- `GET /jobs/:jobId` polls the durable record written by the worker.
- `POST /preview/:jobId` queues a new Job execution for subtitle edits.
- `GET /preview/:jobId` serves the persisted MP4.

If the dispatch request has an ambiguous network outcome, the durable record is marked `dispatch_unknown` and the API does not automatically retry: Cloud Run may already have accepted the execution. Inspect Cloud Run executions before manually retrying. If a worker is terminated before it writes its terminal record, the dispatcher reconciles the Cloud Run v2 Execution during `GET /jobs/:jobId` polling. Terminal `Completed` conditions or `completionTime` with no persisted preview result mark the renderer job failed with a diagnostic message. This is request-driven reconciliation (not a background sweeper), so clients must poll status to trigger it.

## Safety and cost

No GCP resources are created by this code. Before deployment, confirm the exact region, bucket, service and Job settings, IAM bindings, quotas, and estimated cost. Budget alerts are notifications, not spending caps. Use Secret Manager, keep the dispatcher authenticated/private, and set maximum service instances and Job execution limits.


### Concurrency / idempotency boundary

The renderer serializes submissions, edits, and worker execution with an in-process per-job mutex and rejects duplicate initial submissions or edits while a job is active. This protects a single renderer process only. It is **not a distributed lock**: separate Cloud Run dispatcher instances or retried Job executions can still race on the shared volume. Before enabling multi-instance production traffic, add a storage-backed lease/compare-and-swap guard (or another coordinator with atomic conditional writes) and test it against the actual Cloud Storage FUSE mount. Do not treat the current mutex as cross-instance protection.
