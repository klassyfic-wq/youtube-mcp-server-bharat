# GCP deployment (Cloud Shell)

This creates a small, single-instance Cloud Run media gateway plus a one-shot Cloud Run Job, Artifact Registry, a private GCS bucket, Secret Manager secret container, service account and IAM. Default region is `asia-south1`; Vertex image generation and Marathi Chirp 3 HD use their documented global APIs.

## Prerequisites

- Existing GCP project with billing enabled and free-trial credits still valid.
- Cloud Shell with `gcloud` and Terraform installed.
- Cloudflare Worker origin: `https://youtube-mcp-server-bharat.klassyfic.workers.dev`.
- Confirm Vertex AI Gemini image generation and Cloud Text-to-Speech APIs/quotas are available for the project.

Budget alerts are notifications only; they do not stop usage. The configuration caps the Cloud Run service at one instance, sets concurrency to one, configures one Job task with zero retries, and deletes bucket objects after seven days. Vertex AI/TTS charges still accrue per request. Generate one scene at a time and inspect billing before scaling.

## 1. Bootstrap resources

From the repository root in Cloud Shell:

```bash
export PROJECT_ID="YOUR_GCP_PROJECT_ID"
export REGION="asia-south1"
export BUCKET_NAME="${PROJECT_ID}-klassyfic-video-media"
export WORKER_HOST="youtube-mcp-server-bharat.klassyfic.workers.dev"
gcloud config set project "$PROJECT_ID"
cd infra/gcp
terraform init
terraform apply -target=google_project_service.apis -target=google_artifact_registry_repository.renderer -target=google_storage_bucket.media -target=google_service_account.renderer -target=google_secret_manager_secret.renderer_shared_secret -var="project_id=$PROJECT_ID" -var="region=$REGION" -var="bucket_name=$BUCKET_NAME" -var="worker_host=$WORKER_HOST" -var="renderer_image=placeholder"
```

## 2. Create the shared secret version

Create one random value. Keep it private and never paste it into chat:

```bash
openssl rand -hex 32 > /tmp/renderer-shared-secret
gcloud secrets versions add klassyfic-renderer-shared-secret --data-file=/tmp/renderer-shared-secret
```

## 3. Build and push the renderer image

```bash
cd ../../renderer
gcloud builds submit --tag "$REGION-docker.pkg.dev/$PROJECT_ID/klassyfic-media/renderer:latest" .
cd ../infra/gcp
```

If Cloud Build cannot push the image, grant its active build service account `roles/artifactregistry.writer` on this project/repository, then retry.

## 4. Deploy Service and Job

```bash
terraform apply -var="project_id=$PROJECT_ID" -var="region=$REGION" -var="bucket_name=$BUCKET_NAME" -var="worker_host=$WORKER_HOST" -var="renderer_image=$REGION-docker.pkg.dev/$PROJECT_ID/klassyfic-media/renderer:latest"
terraform output -raw renderer_url
```

Terraform outputs the Cloud Run service URL. The service is internet reachable for the Worker, but every route requires the shared bearer secret. Terraform grants `allUsers` the Cloud Run Invoker role solely to allow the Worker to reach it; the app rejects unauthenticated requests. Do not remove application-level bearer authentication.

## 5. Configure Cloudflare Worker

Retrieve the secret locally (do not paste it into chat):

```bash
gcloud secrets versions access latest --secret=klassyfic-renderer-shared-secret
```

Set the same value as Worker secrets `RENDERER_API_KEY`, `IMAGE_API_KEY`, and `TTS_API_KEY`.

Set these Worker variables:
- `RENDERER_API_URL=<renderer_url>`
- `IMAGE_API_URL=<renderer_url>/v1/images/generations`
- `IMAGE_MODEL=gemini-2.5-flash-image`
- `TTS_API_URL=<renderer_url>/v1/audio/speech`
- `TTS_MODEL=google-cloud-tts`
- `TTS_VOICE=mr-IN-Chirp3-HD-Achird`
- `MEDIA_BASE_URL=https://youtube-mcp-server-bharat.klassyfic.workers.dev`

The Cloudflare Worker redeployment is a separate action. Keep Google OAuth settings and callback URLs unchanged.

## 6. Validate

- Call `GET <renderer_url>/health` with an Authorization bearer header; expect JSON status `ok`.
- In Claude, generate one image and one voiceover for a single scene only. These are metered API calls; do not repeat them unnecessarily.
- Review those assets, then generate the remaining scene assets.
- Call `render_video_preview`, poll `get_video_render_status`, and open `create_video_preview_link`.
- No YouTube upload or publish occurs in this flow.

## Resource and safety settings

- Cloud Run Service: max 1 instance, concurrency 1, min 0, 2 vCPU / 4 GiB, 60-minute request timeout.
- Cloud Run Job: 1 task, parallelism 1, 0 retries, 2 vCPU / 4 GiB, 60-minute timeout.
- GCS bucket: uniform bucket-level access, public access prevention, seven-day object lifecycle.
- Runtime uses Cloud Run metadata identity; no service-account key files.
- Secret Manager secret version is created outside Terraform so secret material is not stored in Terraform state.
- Budget alerts are not hard spending caps. Credits can expire and metered API usage may be chargeable.
