#!/usr/bin/env bash
# Builds and starts the ingest stack for local development
# (docker/stream-server/docker-compose.local.yml). Extra arguments go to
# `docker compose`, e.g. `scripts/local/up.sh logs -f ingest-control`.
set -euo pipefail
cd "$(dirname "$0")/../.."

compose() {
  docker compose --env-file .env.local \
    -f docker/stream-server/docker-compose.yml -f docker/stream-server/docker-compose.local.yml "$@"
}

if [ "${1:-}" = "build" ]; then
  # Building needs no claim; a placeholder env is enough for compose to parse.
  shift
  TAILSCALE_IP=127.0.0.1 docker compose --env-file /dev/null \
    -f docker/stream-server/docker-compose.yml -f docker/stream-server/docker-compose.local.yml build "$@"
  exit
fi

[ -f .env.local ] || { echo "no .env.local; run scripts/local/claim.sh --token=... first" >&2; exit 1; }

if [ $# -gt 0 ]; then
  compose "$@"
  exit
fi

compose up -d --build
echo "control: http://127.0.0.1:8090/health"
echo "ingest:  srt://<this machine>:8888?streamid=<stream key>   srtla: udp 5000"
echo "output:  srt://127.0.0.1:9000?streamid=<output key>"
