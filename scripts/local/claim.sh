#!/usr/bin/env bash
# Claims this dev box as an ingest node of the LOCAL StreamWizard stack and
# writes .env.local for docker-compose.local.yml. Does what install.sh's claim
# step does, minus Tailscale/ufw/systemd/hostname:
#   1. POST /api/ingest-nodes/claim on the local rest-api with the token
#   2. write .env.local from the response, pointed at host.docker.internal
#
# Get the token from web-admin: Ingest → Add node. It's the --token=... value
# in the install command it shows, and it expires after 15 minutes.
#
# Needs: local Supabase (supabase start) and rest-api (bun dev) running.
#
#   scripts/local/claim.sh --token=<claim token> [--start]
#
# --start runs scripts/local/up.sh afterwards.
set -euo pipefail

cd "$(dirname "$0")/../.."

TOKEN=""
START=false
REST="${REST_API_URL_HOST:-http://localhost:8080}"

for arg in "$@"; do
  case "$arg" in
    --token=*) TOKEN="${arg#*=}" ;;
    --start) START=true ;;
    -h|--help) sed -n 2,16p "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

[ -n "$TOKEN" ] || { echo "--token=<claim token> is required (web-admin: Ingest → Add node)" >&2; exit 2; }

if [ -f .env.local ]; then
  echo ".env.local already exists; remove it first to claim a new node." >&2
  exit 1
fi

curl -fsS -m 5 -o /dev/null "$REST/health" 2>/dev/null || {
  echo "rest-api not reachable at $REST (cd streamwizard/apps/rest-api && bun run dev)" >&2
  exit 1
}

RAM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
DISK_MB="$(df -Pm / | awk 'NR==2 {print $2}')"
BODY="$(jq -n --arg token "$TOKEN" --argjson ram "$RAM_MB" --argjson disk "$DISK_MB" --argjson cores "$(nproc)" \
  '{token:$token, cpu_cores:$cores, ram_total_mb:$ram, storage_total_mb:$disk, public_ip:"127.0.0.1", lan_ip:"127.0.0.1", tailscale_ip:null}')"

RESP="$(curl -sS -m 30 -o - -w '%{http_code}' -X POST "$REST/api/ingest-nodes/claim" \
  -H 'Content-Type: application/json' -d "$BODY")"
HTTP_STATUS="${RESP: -3}"
RESP="${RESP%???}"
if [ "$HTTP_STATUS" != "200" ]; then
  echo "claim failed (HTTP $HTTP_STATUS): $RESP" >&2
  exit 1
fi

# The URLs in the response are the ones rest-api was configured with, which
# locally means localhost. Inside a container that's the container itself,
# so point them at the host instead.
to_host() { sed -e 's#//localhost\b#//host.docker.internal#' -e 's#//127\.0\.0\.1\b#//host.docker.internal#'; }

REST_API_URL="$(jq -r .rest_api_url <<<"$RESP" | to_host)"
INFLUXDB_URL="$(jq -r '.influxdb_url // ""' <<<"$RESP" | to_host)"

sed -e "s|^INGEST_NODE_ID=.*|INGEST_NODE_ID=$(jq -r .node_id <<<"$RESP")|" \
    -e "s|^NODE_API_KEY=.*|NODE_API_KEY=$(jq -r .node_api_key <<<"$RESP")|" \
    -e "s|^INGEST_CONTROL_SECRET=.*|INGEST_CONTROL_SECRET=$(jq -r .ingest_control_secret <<<"$RESP")|" \
    -e "s|^REST_API_URL=.*|REST_API_URL=$REST_API_URL|" \
    -e "s|^INFLUXDB_URL=.*|INFLUXDB_URL=$INFLUXDB_URL|" \
    -e "s|^INFLUXDB_TOKEN=.*|INFLUXDB_TOKEN=$(jq -r '.influxdb_token // ""' <<<"$RESP")|" \
    -e "s|^INFLUXDB_ORG=.*|INFLUXDB_ORG=$(jq -r '.influxdb_org // ""' <<<"$RESP")|" \
    .env.local.example > .env.local
chmod 600 .env.local

echo "linked as $(jq -r .hostname <<<"$RESP") ($(jq -r .node_id <<<"$RESP")). .env.local written."

if $START; then
  exec scripts/local/up.sh
fi
echo "start with scripts/local/up.sh"
