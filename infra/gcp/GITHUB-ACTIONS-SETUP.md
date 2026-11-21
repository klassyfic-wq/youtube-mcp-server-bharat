# Keyless GCP deployment from GitHub Actions

This repository deploys the GCP media pipeline through a manually triggered GitHub Actions workflow. Authentication uses GitHub OIDC and Google Workload Identity Federation (WIF); no service-account JSON key is created or stored.

## One-time Google Cloud setup (Console)

Use the same GCP project that has the available billing account/credits. Record its **Project ID** and **Project number** from Google Cloud Console → project selector / Project dashboard.

### 1. Create a dedicated deployment service account

Open **IAM & Admin → Service Accounts → Create service account**.

- Name: `github-terraform-deployer`
- Email will be: `github-terraform-deployer@PROJECT_ID.iam.gserviceaccount.com`

Grant this service account the following project roles. These are deployment permissions; do not grant them to the renderer runtime service account.

- `roles/artifactregistry.admin`
- `roles/cloudbuild.builds.editor`
- `roles/iam.roleAdmin`
- `roles/iam.serviceAccountAdmin`
- `roles/iam.serviceAccountUser`
- `roles/resourcemanager.projectIamAdmin`
- `roles/run.admin`
- `roles/secretmanager.admin`
- `roles/serviceusage.serviceUsageAdmin`
- `roles/storage.admin`

The deployment identity needs these permissions because Terraform creates APIs, IAM bindings, service accounts, Artifact Registry, Secret Manager, Cloud Storage, Cloud Run, and a custom renderer Job-dispatch role. Revisit and narrow these permissions after the initial deployment is stable.

### 2. Create the GitHub Actions workload identity pool/provider

Open **IAM & Admin → Workload Identity Federation → Create pool**.

Pool:
- Name: `github-actions-klassyfic`
- Pool ID: `github-actions-klassyfic`

Add a provider:
- Provider type: OpenID Connect (OIDC)
- Provider name / ID: `github-klassyfic`
- Issuer URL: `https://token.actions.githubusercontent.com`
- Audience: default audience

Attribute mappings:
- `google.subject` = `assertion.sub`
- `attribute.repository` = `assertion.repository`
- `attribute.ref` = `assertion.ref`
- `attribute.event_name` = `assertion.event_name`

Attribute condition (restricts trust to this repository, main branch and manual dispatch):
```
assertion.repository == 'klassyfic-wq/youtube-mcp-server-bharat' &&
assertion.ref == 'refs/heads/main' &&
assertion.event_name == 'workflow_dispatch'
```

### 3. Allow only this repository identity to impersonate the deployer

On the service account `github-terraform-deployer`, open **Permissions → Grant access** and add this principal (replace PROJECT_NUMBER with the numeric project number):

```
principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-actions-klassyfic/attribute.repository/klassyfic-wq/youtube-mcp-server-bharat
```

Grant only:
```
roles/iam.workloadIdentityUser
```

The provider condition further restricts this principal to workflow_dispatch on main. Do not create or download a service-account key.

## One-time GitHub repository variables

Open repository **Settings → Secrets and variables → Actions → Variables** and create:

| Variable | Value |
|---|---|
| `GCP_PROJECT_ID` | GCP Project ID |
| `GCP_TF_STATE_BUCKET` | Globally unique bucket name, e.g. `PROJECT_ID-klassyfic-tfstate` |
| `GCP_MEDIA_BUCKET` | Globally unique bucket name, e.g. `PROJECT_ID-klassyfic-video-media` |
| `GCP_WIF_PROVIDER` | `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-actions-klassyfic/providers/github-klassyfic` |
| `GCP_TERRAFORM_SERVICE_ACCOUNT` | `github-terraform-deployer@PROJECT_ID.iam.gserviceaccount.com` |

These identifiers are not credentials; store them as repository **Variables**, not Secrets. Do not put passwords, access tokens, or JSON keys in GitHub.

## Deploy

After this PR is merged to main and the one-time setup above is complete:

1. Open **Actions → Deploy GCP media pipeline**.
2. Select **Run workflow** on branch `main`.
3. Choose `yes` for `confirm_deploy` and run it.

The workflow:
- Authenticates with a short-lived GitHub OIDC token.
- Creates a separate versioned GCS bucket for Terraform state if it does not exist.
- Initializes Terraform with the remote GCS backend.
- Bootstraps the media bucket, APIs, Artifact Registry, runtime service account and Secret Manager secret container.
- Generates a random renderer shared secret on the runner and stores it directly in Secret Manager if no enabled version exists. The secret is not printed in logs.
- Builds and pushes the renderer container using Cloud Build.
- Applies the complete Cloud Run Service and Job configuration and reports the service URL.

The first run creates metered GCP resources and can incur charges. Budget alerts are notifications, not hard spending limits. Vertex AI image generation and Cloud Text-to-Speech are metered separately when called. The workflow does not call either media provider and does not upload or publish to YouTube.

After deployment, retrieve the shared secret directly in Google Cloud Console → Secret Manager and set the same value as Cloudflare Worker secrets `RENDERER_API_KEY`, `IMAGE_API_KEY`, and `TTS_API_KEY`. Set the Worker endpoint variables from the Terraform output and redeploy the Production Worker. Never paste the secret into chat.

## Terraform state

Terraform state is stored in the dedicated GCS state bucket with object versioning enabled. Keep this bucket private and do not delete it while the infrastructure exists. The media bucket is separate and has the seven-day object lifecycle configured by Terraform.
