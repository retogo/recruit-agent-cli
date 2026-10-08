variable "account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "worker_name" {
  description = "Name of the Worker, used in its workers.dev URL"
  type        = string
  default     = "recruit-agent-mcp"
}

variable "auth_password" {
  description = "Password entered on the consent page when connecting an MCP client"
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.auth_password) >= 16
    error_message = "auth_password must be at least 16 characters."
  }
}
