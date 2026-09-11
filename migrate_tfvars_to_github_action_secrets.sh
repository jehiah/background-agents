#!/usr/bin/env bash
#
# Reads terraform.tfvars (+ optional backend.tfvars) and sets each value as a
# GitHub Actions secret, using the same tfvars-key -> secret-name mapping that
# .github/workflows/terraform.yml expects (TF_VAR_<key> <- secrets.<NAME>).
#
# Defaults to a DRY RUN (prints the `gh secret set` calls without running them).
# Pass --apply to actually write secrets.
#
# Usage:
#   ./migrate_tfvars_to_github_action_secrets.sh --repo owner/name [--tfvars path] [--backend-tfvars path] [--apply]
#
# Requires: gh CLI authenticated (gh auth login) with repo admin access.

set -euo pipefail

TFVARS_FILE="terraform/environments/production/terraform.tfvars"
BACKEND_TFVARS_FILE="terraform/environments/production/backend.tfvars"
REPO=""
APPLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --tfvars) TFVARS_FILE="$2"; shift 2 ;;
    --backend-tfvars) BACKEND_TFVARS_FILE="$2"; shift 2 ;;
    --apply) APPLY=true; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$REPO" ]]; then
  echo "Usage: $0 --repo owner/name [--tfvars path] [--backend-tfvars path] [--apply]" >&2
  exit 1
fi

# tfvars key -> GitHub secret name, taken from the TF_VAR_<key>: secrets.<NAME>
# pairs in .github/workflows/terraform.yml (plan/apply job env blocks).
#
# Implemented as a case statement (not `declare -A`) because macOS ships bash
# 3.2 (no GPLv3 bash 4+ preinstalled), which lacks associative arrays and
# namerefs. This must run with plain /bin/bash.
secret_name_for() {
  case "$1" in
    cloudflare_api_token) echo CLOUDFLARE_API_TOKEN ;;
    cloudflare_account_id) echo CLOUDFLARE_ACCOUNT_ID ;;
    cloudflare_worker_subdomain) echo CLOUDFLARE_WORKER_SUBDOMAIN ;;
    cloudflare_zone_id) echo CLOUDFLARE_ZONE_ID ;;
    cloudflare_custom_domain) echo CLOUDFLARE_CUSTOM_DOMAIN ;;
    vercel_api_token) echo VERCEL_API_TOKEN ;;
    vercel_team_id) echo VERCEL_TEAM_ID ;;
    modal_token_id) echo MODAL_TOKEN_ID ;;
    modal_token_secret) echo MODAL_TOKEN_SECRET ;;
    modal_workspace) echo MODAL_WORKSPACE ;;
    modal_environment) echo MODAL_ENVIRONMENT ;;
    modal_environment_web_suffix) echo MODAL_ENVIRONMENT_WEB_SUFFIX ;;
    github_client_id) echo GH_OAUTH_CLIENT_ID ;;
    github_client_secret) echo GH_OAUTH_CLIENT_SECRET ;;
    google_client_id) echo GOOGLE_CLIENT_ID ;;
    google_client_secret) echo GOOGLE_CLIENT_SECRET ;;
    github_app_id) echo GH_APP_ID ;;
    github_app_private_key) echo GH_APP_PRIVATE_KEY ;;
    github_app_installation_id) echo GH_APP_INSTALLATION_ID ;;
    enable_slack_bot) echo ENABLE_SLACK_BOT ;;
    slack_bot_token) echo SLACK_BOT_TOKEN ;;
    slack_signing_secret) echo SLACK_SIGNING_SECRET ;;
    anthropic_api_key) echo ANTHROPIC_API_KEY ;;
    token_encryption_key) echo TOKEN_ENCRYPTION_KEY ;;
    repo_secrets_encryption_key) echo REPO_SECRETS_ENCRYPTION_KEY ;;
    nextauth_secret) echo NEXTAUTH_SECRET ;;
    modal_api_secret) echo MODAL_API_SECRET ;;
    allowed_users) echo ALLOWED_USERS ;;
    allowed_email_domains) echo ALLOWED_EMAIL_DOMAINS ;;
    allowed_emails) echo ALLOWED_EMAILS ;;
    allowed_github_orgs) echo ALLOWED_GITHUB_ORGS ;;
    deployment_name) echo DEPLOYMENT_NAME ;;
    enable_github_bot) echo ENABLE_GITHUB_BOT ;;
    github_webhook_secret) echo GH_WEBHOOK_SECRET ;;
    github_bot_username) echo GH_BOT_USERNAME ;;
    github_default_model) echo GH_DEFAULT_MODEL ;;
    app_name) echo APP_NAME ;;
    app_icon_url) echo APP_ICON_URL ;;
    enable_linear_bot) echo ENABLE_LINEAR_BOT ;;
    linear_client_id) echo LINEAR_CLIENT_ID ;;
    linear_client_secret) echo LINEAR_CLIENT_SECRET ;;
    linear_webhook_secret) echo LINEAR_WEBHOOK_SECRET ;;
    web_platform) echo WEB_PLATFORM ;;
    enable_durable_object_bindings) echo ENABLE_DURABLE_OBJECT_BINDINGS ;;
    sandbox_provider) echo SANDBOX_PROVIDER ;;
    sandbox_inactivity_timeout_ms) echo SANDBOX_INACTIVITY_TIMEOUT_MS ;;
    sandbox_connecting_timeout_ms) echo SANDBOX_CONNECTING_TIMEOUT_MS ;;
    daytona_api_url) echo DAYTONA_API_URL ;;
    daytona_api_key) echo DAYTONA_API_KEY ;;
    daytona_base_snapshot) echo DAYTONA_BASE_SNAPSHOT ;;
    daytona_target) echo DAYTONA_TARGET ;;
    vercel_sandbox_token) echo VERCEL_SANDBOX_TOKEN ;;
    vercel_sandbox_project_id) echo VERCEL_SANDBOX_PROJECT_ID ;;
    vercel_sandbox_team_id) echo VERCEL_SANDBOX_TEAM_ID ;;
    vercel_sandbox_api_base_url) echo VERCEL_SANDBOX_API_BASE_URL ;;
    vercel_base_snapshot_id) echo VERCEL_BASE_SNAPSHOT_ID ;;
    vercel_sandbox_runtime) echo VERCEL_SANDBOX_RUNTIME ;;
    vercel_snapshot_expiration_ms) echo VERCEL_SNAPSHOT_EXPIRATION_MS ;;
    opencomputer_api_url) echo OPENCOMPUTER_API_URL ;;
    opencomputer_api_key) echo OPENCOMPUTER_API_KEY ;;
    opencomputer_template) echo OPENCOMPUTER_TEMPLATE ;;
    opencomputer_project_id) echo OPENCOMPUTER_PROJECT_ID ;;
    opencomputer_target) echo OPENCOMPUTER_TARGET ;;
    e2b_api_key) echo E2B_API_KEY ;;
    e2b_template_id) echo E2B_TEMPLATE_ID ;;
    e2b_api_url) echo E2B_API_URL ;;
    e2b_sandbox_timeout_seconds) echo E2B_SANDBOX_TIMEOUT_SECONDS ;;
    e2b_auto_pause) echo E2B_AUTO_PAUSE ;;
    generic_sandbox_url) echo GENERIC_SANDBOX_URL ;;
    generic_sandbox_token) echo GENERIC_SANDBOX_TOKEN ;;
    generic_sandbox_supports_sandbox_timeout) echo GENERIC_SANDBOX_SUPPORTS_SANDBOX_TIMEOUT ;;
    generic_sandbox_supports_snapshots) echo GENERIC_SANDBOX_SUPPORTS_SNAPSHOTS ;;
    generic_sandbox_supports_restore) echo GENERIC_SANDBOX_SUPPORTS_RESTORE ;;
    generic_sandbox_supports_resume) echo GENERIC_SANDBOX_SUPPORTS_RESUME ;;
    generic_sandbox_supports_stop) echo GENERIC_SANDBOX_SUPPORTS_STOP ;;
    *) echo "" ;;
  esac
}

# backend.tfvars uses generic names (access_key/secret_key) that don't match
# the R2_* secret names used by `terraform init -backend-config=...` in the
# workflow, so they need their own lookup.
backend_secret_name_for() {
  case "$1" in
    access_key) echo R2_ACCESS_KEY_ID ;;
    secret_key) echo R2_SECRET_ACCESS_KEY ;;
    *) echo "" ;;
  esac
}

# Parses a .tfvars file into "key<TAB>value" lines on stdout.
# Handles: `key = "value"`, `key = value` (bool/number/bare), comments (#, //),
# and heredoc assignments (`key = <<-EOF ... EOF`, used by github_app_private_key).
parse_tfvars() {
  local file="$1"
  local key value in_heredoc=false heredoc_marker="" heredoc_key="" heredoc_body=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    if $in_heredoc; then
      if [[ "$line" =~ ^[[:space:]]*${heredoc_marker}[[:space:]]*$ ]]; then
        printf '%s\t%s\n' "$heredoc_key" "$heredoc_body"
        in_heredoc=false
        heredoc_body=""
      else
        heredoc_body+="${line}"$'\n'
      fi
      continue
    fi

    # strip full-line comments
    [[ "$line" =~ ^[[:space:]]*(#|//) ]] && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue

    if [[ "$line" =~ ^[[:space:]]*([A-Za-z0-9_]+)[[:space:]]*=[[:space:]]*\<\<-?([A-Za-z_]+)[[:space:]]*$ ]]; then
      heredoc_key="${BASH_REMATCH[1]}"
      heredoc_marker="${BASH_REMATCH[2]}"
      in_heredoc=true
      continue
    fi

    if [[ "$line" =~ ^[[:space:]]*([A-Za-z0-9_]+)[[:space:]]*=[[:space:]]*(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      # strip inline comment, surrounding quotes/whitespace
      value="${value%%#*}"
      value="$(echo -n "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
      value="${value%\"}"
      value="${value#\"}"
      printf '%s\t%s\n' "$key" "$value"
    fi
  done < "$file"
}

set_secret() {
  local secret_name="$1" value="$2"

  if [[ -z "$value" ]]; then
    echo "skip: $secret_name (empty value)"
    return
  fi

  if $APPLY; then
    echo "setting: $secret_name"
    gh secret set "$secret_name" --repo "$REPO" --body "$value"
  else
    echo "[dry-run] would set: $secret_name"
  fi
}

run_map() {
  local file="$1" lookup_fn="$2"
  local key value secret_name

  [[ -f "$file" ]] || { echo "skip: $file not found" >&2; return; }

  while IFS=$'\t' read -r key value; do
    secret_name="$("$lookup_fn" "$key")"
    if [[ -z "$secret_name" ]]; then
      echo "skip: $key (not wired to a secret in terraform.yml)"
      continue
    fi
    set_secret "$secret_name" "$value"
  done < <(parse_tfvars "$file")
}

run_map "$TFVARS_FILE" secret_name_for
run_map "$BACKEND_TFVARS_FILE" backend_secret_name_for

$APPLY || echo -e "\nDry run only — re-run with --apply to actually create/update secrets."
