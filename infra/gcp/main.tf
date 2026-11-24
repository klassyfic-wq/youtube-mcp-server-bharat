data "google_project" "current" {
  project_id = var.project_id
}

locals {
  apis = toset([
    "aiplatform.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "iam.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "serviceusage.googleapis.com",
    "storage.googleapis.com",
    "texttospeech.googleapis.com"
  ])
}

resource "google_project_service" "apis" {
  for_each           = local.apis
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "renderer" {
  project       = var.project_id
  location      = var.region
  repository_id = "klassyfic-media"
  description   = "Klassyfic video renderer containers"
  format        = "DOCKER"
  depends_on    = [google_project_service.apis]
}

# Cloud Build uses the project's default Compute Engine service account in this project.
# Grant image-push access only on the renderer repository, not project-wide.
resource "google_artifact_registry_repository_iam_member" "cloud_build_writer" {
  project    = var.project_id
  location   = google_artifact_registry_repository.renderer.location
  repository = google_artifact_registry_repository.renderer.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${data.google_project.current.number}-compute@developer.gserviceaccount.com"
}

resource "google_storage_bucket" "media" {
  project                     = var.project_id
  name                        = var.bucket_name
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age = 7
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_service_account" "renderer" {
  project      = var.project_id
  account_id   = "klassyfic-renderer"
  display_name = "Klassyfic video renderer runtime"
}

resource "google_secret_manager_secret" "renderer_shared_secret" {
  project   = var.project_id
  secret_id = "klassyfic-renderer-shared-secret"

  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "deployer_secret_access" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.renderer_shared_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.deployer_service_account}"
}

resource "google_secret_manager_secret_iam_member" "renderer_secret_access" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.renderer_shared_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.renderer.email}"
}

resource "google_storage_bucket_iam_member" "renderer_storage" {
  bucket = google_storage_bucket.media.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.renderer.email}"
}

resource "google_project_iam_member" "vertex_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.renderer.email}"
}

resource "google_project_iam_member" "service_usage" {
  project = var.project_id
  role    = "roles/serviceusage.serviceUsageConsumer"
  member  = "serviceAccount:${google_service_account.renderer.email}"
}

resource "google_project_iam_custom_role" "renderer_job_dispatcher" {
  project     = var.project_id
  role_id     = "klassyficRendererJobDispatcher"
  title       = "Klassyfic renderer Job dispatcher"
  description = "Allows the renderer service to start and inspect its dedicated Cloud Run Job."
  permissions = ["run.jobs.run", "run.jobs.runWithOverrides", "run.executions.get"]
}

resource "google_project_iam_member" "renderer_job_dispatcher" {
  project = var.project_id
  role    = google_project_iam_custom_role.renderer_job_dispatcher.name
  member  = "serviceAccount:${google_service_account.renderer.email}"
}

resource "google_cloud_run_v2_job" "renderer" {
  project             = var.project_id
  name                = "klassyfic-video-renderer-job"
  location            = var.region
  deletion_protection = false

  template {
    parallelism = 1
    task_count  = 1

    template {
      service_account = google_service_account.renderer.email
      max_retries     = 0
      timeout         = "3600s"

      containers {
        image = var.renderer_image

        resources {
          limits = {
            cpu    = "2"
            memory = "4Gi"
          }
        }
        env {
          name  = "RENDERER_DATA_DIR"
          value = "/data"
        }
        env {
          name  = "GOOGLE_CLOUD_PROJECT"
          value = var.project_id
        }
        env {
          name  = "ASSET_HOST_ALLOWLIST"
          value = "${var.worker_host},storage.googleapis.com"
        }
        env {
          name  = "VERTEX_AI_LOCATION"
          value = "global"
        }
        env {
          name  = "VERTEX_IMAGE_MODEL"
          value = "gemini-2.5-flash-image"
        }
        env {
          name  = "GOOGLE_TTS_VOICE"
          value = "mr-IN-Chirp3-HD-Achird"
        }
        volume_mounts {
          name       = "renderer-data"
          mount_path = "/data"
        }
      }

      volumes {
        name = "renderer-data"
        gcs {
          bucket = google_storage_bucket.media.name
        }
      }
    }
  }
  depends_on = [
    google_project_service.apis,
    google_storage_bucket_iam_member.renderer_storage
  ]
}

resource "google_cloud_run_v2_service" "renderer" {
  project             = var.project_id
  name                = "klassyfic-video-renderer"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account                  = google_service_account.renderer.email
    timeout                          = "3600s"
    max_instance_request_concurrency = 1

    scaling {
      max_instance_count = 1
    }

    containers {
      image = var.renderer_image

      ports {
        container_port = 8787
      }
      resources {
        limits = {
          cpu    = "2"
          memory = "4Gi"
        }
      }
      env {
        name  = "RENDERER_DATA_DIR"
        value = "/data"
      }
      env {
        name  = "RENDER_EXECUTION_MODE"
        value = "cloud-run-jobs"
      }
      env {
        name  = "CLOUD_RUN_PROJECT"
        value = var.project_id
      }
      env {
        name  = "CLOUD_RUN_LOCATION"
        value = var.region
      }
      env {
        name  = "RENDERER_JOB_NAME"
        value = google_cloud_run_v2_job.renderer.name
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name  = "VERTEX_AI_LOCATION"
        value = "global"
      }
      env {
        name  = "VERTEX_IMAGE_MODEL"
        value = "gemini-2.5-flash-image"
      }
      env {
        name  = "GOOGLE_TTS_VOICE"
        value = "mr-IN-Chirp3-HD-Achird"
      }
      env {
        name  = "ASSET_HOST_ALLOWLIST"
        value = "${var.worker_host},storage.googleapis.com"
      }
      env {
        name = "RENDERER_SHARED_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.renderer_shared_secret.secret_id
            version = "latest"
          }
        }
      }
      volume_mounts {
        name       = "renderer-data"
        mount_path = "/data"
      }
    }

    volumes {
      name = "renderer-data"
      gcs {
        bucket = google_storage_bucket.media.name
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    google_secret_manager_secret_iam_member.renderer_secret_access,
    google_storage_bucket_iam_member.renderer_storage,
    google_project_iam_member.vertex_user,
    google_project_iam_member.service_usage,
    google_project_iam_member.renderer_job_dispatcher
  ]
}

resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.renderer.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "renderer_url" {
  value       = google_cloud_run_v2_service.renderer.uri
  description = "Set as RENDERER_API_URL; append /v1/images/generations and /v1/audio/speech for provider endpoints."
}

output "bucket_name" {
  value = google_storage_bucket.media.name
}

output "service_account_email" {
  value = google_service_account.renderer.email
}

output "renderer_job_name" {
  value = google_cloud_run_v2_job.renderer.name
}


# Dedicated read-only signer for short-lived production E2E source URLs.
# The deployer can impersonate only this account; it cannot write or delete media.
resource "google_service_account" "e2e_url_signer" {
  project      = var.project_id
  account_id   = "klassyfic-e2e-signer"
  display_name = "Klassyfic production E2E signed URL reader"
}

resource "google_storage_bucket_iam_member" "e2e_url_signer_reader" {
  bucket = google_storage_bucket.media.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.e2e_url_signer.email}"
}

resource "google_service_account_iam_member" "deployer_can_sign_e2e_urls" {
  service_account_id = google_service_account.e2e_url_signer.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${var.deployer_service_account}"
}
