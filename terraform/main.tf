locals {
  # wrangler.jsonc is the single source for runtime settings shared with `wrangler dev`
  wrangler   = jsondecode(file("${path.module}/../wrangler.jsonc"))
  rate_limit = one(local.wrangler.ratelimits)
  bundle     = "${path.module}/../dist/worker.js"
}

resource "cloudflare_workers_kv_namespace" "oauth" {
  account_id = var.account_id
  title      = "${var.worker_name}-oauth"
}

resource "cloudflare_workers_kv_namespace" "session" {
  account_id = var.account_id
  title      = "${var.worker_name}-session"
}

resource "cloudflare_workers_script" "this" {
  account_id          = var.account_id
  script_name         = var.worker_name
  content_file        = local.bundle
  content_sha256      = filesha256(local.bundle)
  main_module         = "worker.js"
  compatibility_date  = local.wrangler.compatibility_date
  compatibility_flags = local.wrangler.compatibility_flags

  bindings = [
    {
      type         = "kv_namespace"
      name         = "OAUTH_KV"
      namespace_id = cloudflare_workers_kv_namespace.oauth.id
    },
    {
      type         = "kv_namespace"
      name         = "SESSION_KV"
      namespace_id = cloudflare_workers_kv_namespace.session.id
    },
    {
      type         = "ratelimit"
      name         = local.rate_limit.name
      namespace_id = local.rate_limit.namespace_id
      simple       = local.rate_limit.simple
    },
    {
      type = "secret_text"
      name = "AUTH_PASSWORD"
      text = var.auth_password
    },
  ]
}

resource "cloudflare_workers_cron_trigger" "this" {
  account_id  = var.account_id
  script_name = cloudflare_workers_script.this.script_name
  schedules   = [for cron in local.wrangler.triggers.crons : { cron = cron }]
}

resource "cloudflare_workers_script_subdomain" "this" {
  account_id       = var.account_id
  script_name      = cloudflare_workers_script.this.script_name
  enabled          = true
  previews_enabled = false
}
