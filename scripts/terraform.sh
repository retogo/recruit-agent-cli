#!/usr/bin/env bash
# Builds the Worker and runs Terraform with the Wrangler login (`wrangler login`) instead of an API token.
# usage: scripts/terraform.sh <terraform-command> [args ...]
set -euo pipefail
cd "$(dirname "$0")/.."

bun run build

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  CLOUDFLARE_API_TOKEN=$(bunx wrangler auth token --json | jq -r .token)
  export CLOUDFLARE_API_TOKEN
fi

# Only an unambiguous account is passed; terraform.tfvars takes precedence
if [ -z "${TF_VAR_account_id:-}" ]; then
  account_id=$(bunx wrangler whoami --json | jq -r 'if (.accounts | length) == 1 then .accounts[0].id else empty end')
  if [ -n "$account_id" ]; then
    export TF_VAR_account_id="$account_id"
  fi
fi

terraform -chdir=terraform "$@"
