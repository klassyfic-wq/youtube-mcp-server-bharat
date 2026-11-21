variable "project_id" { type = string }
variable "region" { type = string default = "asia-south1" }
variable "bucket_name" { type = string }
variable "worker_host" { type = string default = "youtube-mcp-server-bharat.klassyfic.workers.dev" }
variable "renderer_image" { type = string default = "placeholder" }
