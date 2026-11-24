variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "asia-south1"
}

variable "bucket_name" {
  type = string
}

variable "worker_host" {
  type    = string
  default = "youtube-mcp-server-bharat.klassyfic.workers.dev"
}

variable "renderer_image" {
  type    = string
  default = "placeholder"
}

variable "deployer_service_account" {
  type        = string
  description = "GitHub Actions deployer service account that needs read access to sync the renderer secret."
}
