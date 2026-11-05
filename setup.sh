#!/usr/bin/env bash
# Exports the Nx remote cache env vars to $GITHUB_ENV.
# Run by main.mjs. Inputs (env): INPUT_SERVER, INPUT_READ_TOKEN. Uses a 1-hour write token from the
# server's GitHub OIDC exchange when the job has an OIDC token, else the read token.
# A pull_request run's write token is confined to that PR's namespace (pr-<n>).
# In write mode it starts gateway.mjs on 127.0.0.1 and points Nx at it, so an
# artifact over Cloudflare's 100 MB body limit goes straight to R2.
# Optional input (env): INPUT_LARGE_UPLOAD_THRESHOLD, bytes, default 95 MiB.
set -euo pipefail

TOKEN_RE='^nxc_[A-Za-z0-9_-]{43}$'
JWT_RE='^[A-Za-z0-9._-]+$'
NAMESPACE_RE='^pr-[1-9][0-9]{0,9}$'
PR_REF_RE='^refs/pull/[1-9][0-9]{0,9}/merge$'
SERVER_RE='^(https://[A-Za-z0-9.-]+|http://(localhost|127\.0\.0\.1))(:[0-9]+)?$'

server="${INPUT_SERVER:-}"
read_token="${INPUT_READ_TOKEN:-}"
threshold="${INPUT_LARGE_UPLOAD_THRESHOLD:-99614720}"
action_dir="${GITHUB_ACTION_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

if [[ -z "$read_token" ]]; then
  echo "::warning::read-token is empty (fork PR or Dependabot run?). Remote cache is disabled for this run."
  exit 0
fi
if [[ ! "$read_token" =~ $TOKEN_RE ]]; then
  echo "::error::read-token is not a valid cache token." >&2
  exit 1
fi
echo "::add-mask::$read_token"

if [[ -z "$server" ]]; then
  echo "::error::server is empty. Pass the 'server' input (for example vars.NX_SELF_HOSTED_REMOTE_CACHE_SERVER)." >&2
  exit 1
fi
server="${server%/}"
if [[ ! "$server" =~ $SERVER_RE ]]; then
  echo "::error::server must be an https origin without path, for example https://cache.example.com." >&2
  exit 1
fi

token="$read_token"
mode="read"

exchange() {
  local id_json jwt audience resp code body err

  echo "::add-mask::$ACTIONS_ID_TOKEN_REQUEST_TOKEN"
  audience="$(jq -rn --arg s "$server" '$s | @uri')"
  # Header and body go through stdin so no token appears in a process argv.
  id_json="$(printf 'Authorization: bearer %s\n' "$ACTIONS_ID_TOKEN_REQUEST_TOKEN" |
    curl -sf --max-time 15 -H @- \
      "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=$audience")" || {
    echo "OIDC: id token request failed"
    return 1
  }
  jwt="$(jq -r '.value // empty' <<<"$id_json" 2>/dev/null || true)"
  if [[ ! "$jwt" =~ $JWT_RE ]]; then
    echo "OIDC: id token response was not a token"
    return 1
  fi
  echo "::add-mask::$jwt"

  resp="$(JWT="$jwt" jq -n '{token: env.JWT}' |
    curl -s --max-time 15 -w '\n%{http_code}' -X POST \
      -H 'Content-Type: application/json' --data @- \
      "$server/v1/oidc/github")" || {
    echo "OIDC: exchange request failed"
    return 1
  }
  code="${resp##*$'\n'}"
  body="${resp%$'\n'*}"

  if [[ "$code" != "200" ]]; then
    err="$(jq -r '.error // empty' <<<"$body" 2>/dev/null || true)"
    [[ "$err" =~ ^[a-z0-9-]{1,64}$ ]] || err="unknown"
    echo "OIDC: exchange refused (HTTP $code, $err)"
    return 1
  fi

  new_token="$(jq -r '.token // empty' <<<"$body" 2>/dev/null || true)"
  if [[ ! "$new_token" =~ $TOKEN_RE ]]; then
    echo "OIDC: exchange returned a malformed token"
    return 1
  fi
  # null for a shared token; pr-<n> for a pull request's namespaced one.
  new_namespace="$(jq -r 'if .namespace == null then "" elif (.namespace | type) == "string" then .namespace else "invalid" end' <<<"$body" 2>/dev/null || echo invalid)"
  if [[ -n "$new_namespace" && ! "$new_namespace" =~ $NAMESPACE_RE ]]; then
    echo "OIDC: exchange returned a malformed namespace"
    return 1
  fi
  echo "::add-mask::$new_token"
}

# The server mints shared write tokens for these events on the default branch,
# and namespaced ones for pull_request runs on refs/pull/<n>/merge (never
# pull_request_target). Skipping the exchange elsewhere keeps refused attempts
# out of its audit log.
eligible() {
  case "${GITHUB_EVENT_NAME:-}" in
  push | workflow_dispatch | schedule) ;;
  pull_request)
    [[ "${GITHUB_REF:-}" =~ $PR_REF_RE ]]
    return
    ;;
  *) return 1 ;;
  esac
  local default_branch=""
  if [[ -r "${GITHUB_EVENT_PATH:-}" ]]; then
    default_branch="$(jq -r '.repository.default_branch // empty' "$GITHUB_EVENT_PATH" 2>/dev/null || true)"
  fi
  [[ -z "$default_branch" || "${GITHUB_REF:-}" == "refs/heads/$default_branch" ]]
}

new_token=""
new_namespace=""
if [[ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" && -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]] && eligible; then
  if exchange; then
    token="$new_token"
    mode="write"
    if [[ -n "$new_namespace" ]]; then
      mode="write ($new_namespace)"
    fi
  fi
fi

# Starts the gateway in the background and sets gateway_server to its origin.
# It gets no token: the environment loses the read token and the OIDC request
# token, and it forwards the Authorization header Nx sends.
start_gateway() {
  local dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
  local port_file="$dir/nx-cache-gateway.port"
  local log="$dir/nx-cache-gateway.log"
  local pid_file="$dir/nx-cache-gateway.pid"
  local pid port i

  if [[ ! "$threshold" =~ ^[1-9][0-9]{0,15}$ ]]; then
    echo "::warning::large-upload-threshold must be a byte count, for example 99614720. Artifacts over 100 MB will not be cached."
    return 1
  fi
  rm -f "$port_file"
  NX_CACHE_GATEWAY_UPSTREAM="$server" \
    NX_CACHE_GATEWAY_THRESHOLD="$threshold" \
    NX_CACHE_GATEWAY_PORT_FILE="$port_file" \
    nohup env -u INPUT_READ_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
    -u ACTIONS_ID_TOKEN_REQUEST_URL \
    node "$action_dir/gateway.mjs" </dev/null >"$log" 2>&1 &
  pid=$!
  # post.mjs stops the gateway at the end of the job.
  printf '%s' "$pid" >"$pid_file"
  # Up to 5 s for the port file; a gateway that exits stops the wait early.
  for ((i = 0; i < 50; i++)); do
    [[ -s "$port_file" ]] && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  port="$(cat "$port_file" 2>/dev/null || true)"
  if [[ ! "$port" =~ ^[1-9][0-9]{0,4}$ ]]; then
    echo "::warning::nx-cache gateway did not start (log: $log). Artifacts over 100 MB will not be cached."
    return 1
  fi
  gateway_server="http://127.0.0.1:$port"
}

gateway_server=""
large_uploads=""
if [[ "$mode" == write* ]]; then
  if start_gateway; then
    large_uploads="via gateway"
  else
    large_uploads="off"
  fi
fi

{
  echo "NX_SELF_HOSTED_REMOTE_CACHE_SERVER=${gateway_server:-$server}"
  echo "NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN=$token"
} >>"$GITHUB_ENV"

echo "Nx remote cache mode: $mode"
if [[ -n "$large_uploads" ]]; then
  echo "Nx remote cache large uploads: $large_uploads"
fi
