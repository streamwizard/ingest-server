#!/usr/bin/env bash
#
#                   .++==++-.
#                  -*-    .-++.
#                .*+         :*=
#               +*:            #-
#             =*-              :%
#          .=*=                 *=
#       .-==:    .:-++.         .%
#   .-+#*=-.:-====--%            ++
#   .:-------:.     #:            %.
#                   #-            =*
#                  .#              #.
#                  +:              :+
#                 --                =.
#                .:                  :
#    ..:::..                             ...
# -==-::.                                 ..:---.
# *+:.                                        .:=+-
#  .-=====--::...                                .+%
#        ..::--===========-------------------=====-.
#                       ....:::::::::::.::....
#           --:::                     .::.=.
#           == .+:     .::-::-:      :+. :+
#            +   --:.:--:  .. :--:..-=  .+
#            .+    ::.           .::.  .+
#             -=                       +.
#              -=                     +.
#               :=                .  +.
#                .=*-             *-+.
#                  :+.            -=
#                   :*+.          =:
#                    :+.         =-
#                    .=       + =-
#                    -=      =-*-
#                     +     +. .
#                     .+.  :=
#                      .=- +.
#                        :-*
#
#  ___ _                   __      ___                _ 
# / __| |_ _ _ ___ __ _ _ _\ \    / (_)_____ _ _ _ __| |
# \__ \  _| '_/ -_) _` | '  \ \/\/ /| |_ / _` | '_/ _` |
# |___/\__|_| \___\__,_|_|_|_\_/\_/ |_/__\__,_|_| \__,_|
#
#
# ingest-server node installer (Wings-style, mirroring obs-instance-manager's
# scripts/install.sh).
#
# Provisions an Ubuntu VPS to run ingest-control + ingest-media + the SRTLA
# receiver as a dedicated service account, then either links the node to a
# panel (if --rest-api-url/--token are given) or scaffolds a local .env for
# manual setup. See docs/PANEL_INTEGRATION.md for the linking contract.
#
# Usage:
#   sudo bash install.sh [options]
#
# Options:
#   --rest-api-url=URL         Panel's rest-api base URL, e.g. https://api.example.com
#   --token=TOKEN              One-time node claim token issued by the panel
#   --tailscale-authkey=KEY    Tailscale auth key for headless `tailscale up`. Only needed for a
#                              manual/no-panel setup (no --rest-api-url/--token) -- when doing a
#                              full claim, the panel mints a single-use key for you automatically
#                              and this flag is ignored. Generate one at
#                              https://login.tailscale.com/admin/settings/keys if you need it.
#   --ssh-cidr=CIDR            Source CIDR allowed to reach SSH (default: 0.0.0.0/0 -- this is a
#                              public VPS, not a LAN box; narrow this if you can)
#   --public-ip=IP             Manual override for the self-reported public IP (default: autodetect)
#   --ref=REF                  Branch/tag to fetch docker-compose.yml and .env.example from
#                              (default: main)
#   --repo-dir=DIR             Install directory (default: /opt/ingest-server)
#   --service-user=NAME        Dedicated service account to run containers as (default: ingest)
#   --start                    Bring the stack up at the end (default: build only)
#   -h, --help                 Show this help

set -euo pipefail

REST_API_URL=""
TOKEN=""
TAILSCALE_AUTHKEY=""
SSH_CIDR="0.0.0.0/0"
PUBLIC_IP_OVERRIDE=""
REF="main"
REPO_DIR="/opt/ingest-server"
SERVICE_USER="ingest"
DO_START="false"

# Node installs don't clone the repo -- they just need docker-compose.yml and
# .env.example, fetched straight from GitHub at the given ref. This keeps a
# fresh node from needing the whole monorepo (bun workspace, source, etc.)
# just to run prebuilt images (see .github/workflows/build-images.yml).
RAW_BASE="https://raw.githubusercontent.com/streamwizard/ingest-server"

log()  { echo "[streamwizard] [install] $*"; }
warn() { echo "[streamwizard] [install] WARNING: $*" >&2; }
die()  { echo "[streamwizard] [install] ERROR: $*" >&2; exit 1; }

# Retries a curl call with exponential backoff (1s, 2s, 4s, ... up to 10 tries),
# the same resilience obs-instance-manager applies to its own outbound panel
# calls so a transient network blip during linking doesn't fail the whole install.
curl_with_backoff() {
  local attempt=1 max_attempts=10 delay=1
  while true; do
    if curl "$@"; then return 0; fi
    if [ "$attempt" -ge "$max_attempts" ]; then return 1; fi
    warn "Request failed (attempt $attempt/$max_attempts), retrying in ${delay}s..."
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

for arg in "$@"; do
  case "$arg" in
    --rest-api-url=*) REST_API_URL="${arg#*=}" ;;
    --token=*) TOKEN="${arg#*=}" ;;
    --tailscale-authkey=*) TAILSCALE_AUTHKEY="${arg#*=}" ;;
    --ssh-cidr=*) SSH_CIDR="${arg#*=}" ;;
    --public-ip=*) PUBLIC_IP_OVERRIDE="${arg#*=}" ;;
    --ref=*) REF="${arg#*=}" ;;
    --repo-dir=*) REPO_DIR="${arg#*=}" ;;
    --service-user=*) SERVICE_USER="${arg#*=}" ;;
    --start) DO_START="true" ;;
    -h|--help) sed -n '47,73p' "$0"; exit 0 ;;
    *) die "Unknown option: $arg" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Must run as root (sudo bash install.sh ...)"

if [ "$SSH_CIDR" = "0.0.0.0/0" ]; then
  warn "SSH is open to 0.0.0.0/0 (the default). Pass --ssh-cidr=<your IP>/32 to restrict it."
fi

log "Installing baseline packages..."
apt-get update -qq
command -v curl >/dev/null || apt-get install -y --no-install-recommends curl >/dev/null
command -v ufw >/dev/null || apt-get install -y --no-install-recommends ufw >/dev/null

# Some VPS providers hand out flaky or no DNS at all via DHCP -- give the box
# a known-good resolver from minute one instead of trusting whatever the
# provider's network config happens to supply.
if command -v systemctl >/dev/null && systemctl is-active --quiet systemd-resolved 2>/dev/null; then
  log "Setting default DNS to Cloudflare (1.1.1.1, 1.0.0.1)..."
  mkdir -p /etc/systemd/resolved.conf.d
  cat > /etc/systemd/resolved.conf.d/99-streamwizard-dns.conf <<'EOF'
[Resolve]
DNS=1.1.1.1 1.0.0.1
FallbackDNS=8.8.8.8 8.8.4.4
EOF
  systemctl restart systemd-resolved
else
  warn "systemd-resolved not detected; skipping the Cloudflare DNS baseline (leaving whatever resolver the OS already has)."
fi

log "Checking Tailscale..."
if ! command -v tailscale >/dev/null; then
  log "Installing Tailscale..."
  curl -fsSL https://tailscale.com/install.sh | sh
else
  log "Tailscale already installed."
fi

# Whether we defer bringing Tailscale up until after claiming (so we can use
# the panel-minted key from the claim response instead of a manually-supplied
# one). Only relevant when doing a full claim; a manual/no-panel run either
# has a --tailscale-authkey to use right now or doesn't get Tailscale at all.
TAILSCALE_JOIN_DEFERRED="false"
if ! tailscale status >/dev/null 2>&1; then
  if [ -n "$TAILSCALE_AUTHKEY" ]; then
    log "Bringing Tailscale up..."
    tailscale up --authkey="$TAILSCALE_AUTHKEY" --ssh
  elif [ -n "$REST_API_URL" ] && [ -n "$TOKEN" ]; then
    log "No --tailscale-authkey given; will join Tailscale using the key returned by the claim response."
    TAILSCALE_JOIN_DEFERRED="true"
  else
    warn "Tailscale isn't up and no --tailscale-authkey was given. Skipping automated setup -- run 'tailscale up' yourself, then re-run this installer (or manually set TAILSCALE_IP in .env and add the tailscale0 ufw rule below)."
  fi
else
  log "Tailscale already up."
fi

TAILSCALE_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
if [ -n "$TAILSCALE_IP" ]; then
  log "Tailscale IP: $TAILSCALE_IP"
elif [ "$TAILSCALE_JOIN_DEFERRED" != "true" ]; then
  warn "No Tailscale IP available yet."
fi

log "Checking Docker..."
if ! command -v docker >/dev/null; then
  log "Installing Docker via get.docker.com..."
  curl -fsSL https://get.docker.com | sh
else
  log "Docker already installed ($(docker --version))."
fi
systemctl enable --now docker >/dev/null

# Port 9000 (the SRT output OBS pulls from) must be reachable ONLY via
# Tailscale, never publicly -- mirrors the compose file's
# ${TAILSCALE_IP}:9000 binding rather than a 0.0.0.0:9000 publish. No rule is
# ever added for it on the public interface. ingest-control's own HTTP port
# is never published by docker-compose at all, so `default deny incoming`
# already covers it with no rule needed.
#
# Extracted into a function (rather than inlined once) because when the
# Tailscale join is deferred to after claiming, tailscale0 doesn't exist yet
# at the point ufw is first configured -- this gets called again once the
# interface shows up, later in the claim block. The status-grep guard makes
# a second call a no-op instead of adding a duplicate rule.
add_tailscale_output_rule() {
  ip link show tailscale0 >/dev/null 2>&1 || return 1
  ufw status | grep -qi "9000.*tailscale0\|tailscale0.*9000" && return 0
  ufw allow in on tailscale0 to any port 9000 proto udp comment "SRT output (tailscale only)" >/dev/null
  log "Opened the tailscale-only ufw rule for port 9000."
}

log "Configuring ufw (SSH from $SSH_CIDR, public SRT ingest on 8888/udp, public SRTLA on 5000/udp, tailscale-only SRT output on 9000/udp)..."
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow from "$SSH_CIDR" to any port 22 proto tcp comment "SSH" >/dev/null
ufw allow proto udp to any port 8888 comment "SRT ingest (public)" >/dev/null
ufw allow proto udp to any port 5000 comment "SRTLA ingest (public)" >/dev/null
if ! add_tailscale_output_rule; then
  warn "tailscale0 interface not present yet; skipping the :9000 tailscale-only rule for now. It will be added automatically once Tailscale comes up (either below, after claiming, or the next time you run this script)."
fi
ufw --force enable >/dev/null
ufw status verbose

log "Creating service account '$SERVICE_USER'..."
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd -m -d "/home/$SERVICE_USER" -s /usr/sbin/nologin -c "Service account for ingest-server" "$SERVICE_USER"
fi
usermod -aG docker "$SERVICE_USER"

log "Fetching node config files (ref: $REF)..."
mkdir -p "$REPO_DIR"
TMP_COMPOSE="$(mktemp)"
curl_with_backoff -fsSL -o "$TMP_COMPOSE" \
  "$RAW_BASE/$REF/docker/stream-server/docker-compose.yml" \
  || die "Failed to fetch docker-compose.yml from ref '$REF'. Check the --ref value and your network connection."
# The checked-in file's env_file (../../.env) is relative to its nested repo
# location (docker/stream-server/docker-compose.yml); a node just gets the
# one flat file with no repo structure around it, so rewrite that path to
# a same-directory .env instead of preserving the nesting.
sed 's#\.\./\.\./\.env#.env#' "$TMP_COMPOSE" > "$REPO_DIR/docker-compose.yml"
rm -f "$TMP_COMPOSE"

# So a later teardown doesn't need network access to fetch this again --
# it's just sitting right next to the compose file and .env it operates on.
curl_with_backoff -fsSL -o "$REPO_DIR/uninstall.sh" "$RAW_BASE/$REF/scripts/uninstall.sh" \
  || warn "Failed to fetch uninstall.sh; to uninstall later, fetch it manually from $RAW_BASE/$REF/scripts/uninstall.sh"
chmod +x "$REPO_DIR/uninstall.sh" 2>/dev/null || true

chown -R "$SERVICE_USER:$SERVICE_USER" "$REPO_DIR"

COMPOSE_FILE="docker-compose.yml"
ENV_FILE="$REPO_DIR/.env"

if [ -n "$REST_API_URL" ] && [ -n "$TOKEN" ]; then
  log "Linking to panel via rest-api at $REST_API_URL..."
  CPU_CORES="$(nproc)"
  RAM_TOTAL_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
  STORAGE_TOTAL_MB="$(df -BM --output=size / | tail -n1 | tr -dc '0-9')"

  if [ -n "$PUBLIC_IP_OVERRIDE" ]; then
    PUBLIC_IP="$PUBLIC_IP_OVERRIDE"
  else
    PUBLIC_IP="$(curl -fsSL --max-time 5 https://ifconfig.me 2>/dev/null || true)"
    [ -n "$PUBLIC_IP" ] || PUBLIC_IP="$(curl -fsSL --max-time 5 https://api.ipify.org 2>/dev/null || true)"
    [ -n "$PUBLIC_IP" ] || warn "Could not autodetect a public IP; leaving it blank. Pass --public-ip to set it manually (informational only, never used for firewall rules)."
  fi

  # Primary NIC's own address -- on most VPS providers this is the same as
  # PUBLIC_IP (no NAT in front of the box), but on providers with a distinct
  # private network (e.g. Hetzner Cloud Networks) it's the private-network
  # address instead. Excludes tailscale0 so its 100.64.0.0/10 address never
  # gets picked up here by accident. Purely informational, like public_ip.
  LAN_IP="$(ip -o -4 addr show scope global | grep -v ' tailscale0 ' | head -n1 | awk '{print $4}' | cut -d/ -f1)"
  [ -n "$LAN_IP" ] || warn "Could not detect a LAN IP on the primary interface; leaving it blank."

  # Built via argv (not string-interpolated into the python source) so a
  # token containing quotes can't break the JSON encoding.
  CLAIM_BODY="$(python3 -c "
import json, sys
token, cpu_cores, ram_total_mb, storage_total_mb, public_ip, lan_ip, tailscale_ip = sys.argv[1:8]
print(json.dumps({
    'token': token,
    'cpu_cores': int(cpu_cores),
    'ram_total_mb': int(ram_total_mb),
    'storage_total_mb': int(storage_total_mb),
    'public_ip': public_ip or None,
    'lan_ip': lan_ip or None,
    'tailscale_ip': tailscale_ip or None,
}))
" "$TOKEN" "$CPU_CORES" "$RAM_TOTAL_MB" "$STORAGE_TOTAL_MB" "$PUBLIC_IP" "$LAN_IP" "$TAILSCALE_IP")"

  # Not -f: a 4xx here carries a JSON {"error": "..."} body from rest-api
  # (invalid/expired/already-claimed token) that we want to surface verbatim
  # instead of curl swallowing it and leaving just an opaque exit code 22.
  claim_attempt=1
  claim_max_attempts=10
  claim_delay=1
  while true; do
    CLAIM_RAW="$(curl -sS -w '\n%{http_code}' -X POST "$REST_API_URL/api/ingest-nodes/claim" \
      -H "Content-Type: application/json" \
      -d "$CLAIM_BODY")"
    CLAIM_HTTP_STATUS="${CLAIM_RAW##*$'\n'}"
    CLAIM_RESPONSE="${CLAIM_RAW%$'\n'*}"

    [ "$CLAIM_HTTP_STATUS" = "200" ] && break

    # Client errors (bad/expired/used token, malformed request) won't be
    # fixed by retrying -- fail fast with the panel's own error message
    # instead of burning ~17 minutes of backoff on a dead token.
    case "$CLAIM_HTTP_STATUS" in
      4[0-9][0-9])
        CLAIM_ERROR="$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('error','unknown error'))" "$CLAIM_RESPONSE" 2>/dev/null || echo "$CLAIM_RESPONSE")"
        die "Node claim rejected by panel (HTTP $CLAIM_HTTP_STATUS): $CLAIM_ERROR"
        ;;
    esac

    if [ "$claim_attempt" -ge "$claim_max_attempts" ]; then
      die "Node claim request to $REST_API_URL failed after $claim_max_attempts attempts (last status: $CLAIM_HTTP_STATUS). Check the URL and that rest-api's /api/ingest-nodes/claim endpoint exists (see docs/PANEL_INTEGRATION.md)."
    fi
    warn "Node claim request failed (HTTP $CLAIM_HTTP_STATUS, attempt $claim_attempt/$claim_max_attempts), retrying in ${claim_delay}s..."
    sleep "$claim_delay"
    claim_attempt=$((claim_attempt + 1))
    claim_delay=$((claim_delay * 2))
  done

  if [ "$TAILSCALE_JOIN_DEFERRED" = "true" ]; then
    CLAIM_TAILSCALE_AUTHKEY="$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('tailscale_authkey') or '')" "$CLAIM_RESPONSE")"
    if [ -n "$CLAIM_TAILSCALE_AUTHKEY" ]; then
      log "Bringing Tailscale up using the panel-minted key..."
      tailscale up --authkey="$CLAIM_TAILSCALE_AUTHKEY" --ssh
      TAILSCALE_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
      if [ -n "$TAILSCALE_IP" ]; then
        log "Tailscale IP: $TAILSCALE_IP"
        # /claim already ran and couldn't have known this IP (the auth key
        # used above came back IN that response), so report it back now via
        # its own authenticated round trip instead.
        NODE_API_KEY="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['node_api_key'])" "$CLAIM_RESPONSE")"
        REPORT_BODY="$(python3 -c "import json,sys; print(json.dumps({'tailscale_ip': sys.argv[1]}))" "$TAILSCALE_IP")"
        REPORT_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -X PATCH "$REST_API_URL/api/ingest-nodes/me" \
          -H "Authorization: Bearer $NODE_API_KEY" \
          -H "Content-Type: application/json" \
          -d "$REPORT_BODY")"
        [ "$REPORT_STATUS" = "200" ] || warn "Reported Tailscale IP to panel but got HTTP $REPORT_STATUS back; the panel's node record may still show no Tailscale IP."
      else
        warn "Joined Tailscale but couldn't read back an IP."
      fi
      add_tailscale_output_rule || warn "tailscale0 still not present after 'tailscale up'; add the :9000 rule manually: ufw allow in on tailscale0 to any port 9000 proto udp"
    else
      warn "Claim response did not include a Tailscale auth key (Tailscale API may be unreachable or misconfigured on the panel side). Run 'tailscale up' yourself, then: ufw allow in on tailscale0 to any port 9000 proto udp"
    fi
  fi

  python3 - "$ENV_FILE" "$CLAIM_RESPONSE" "$TAILSCALE_IP" <<'PY'
import json, sys
env_path, raw, tailscale_ip = sys.argv[1], sys.argv[2], sys.argv[3]
data = json.loads(raw)
with open(env_path, "w") as f:
    f.write("NODE_ENV=production\n")
    f.write(f"SUPABASE_URL={data['supabase_url']}\n")
    f.write(f"SUPABASE_SECRET_KEY={data['supabase_secret_key']}\n")
    f.write(f"INGEST_CONTROL_SECRET={data['ingest_control_secret']}\n")
    f.write("PORT=8090\n")
    f.write("INGEST_CONTROL_URL=http://ingest-control:8090\n")
    f.write("INGEST_SRT_PORT=8888\n")
    f.write("INGEST_SRTLA_SRT_PORT=8889\n")
    f.write("INGEST_OUTPUT_PORT=9000\n")
    f.write("INGEST_SRT_LATENCY_MS=4000\n")
    f.write("INGEST_CONTROL_TIMEOUT=5\n")
    f.write("INGEST_LOG_LEVEL=INFO\n")
    f.write(f"TAILSCALE_IP={tailscale_ip}\n")
    f.write("WS_SERVER_URL=\n")
    f.write(f"INFLUXDB_URL={data.get('influxdb_url') or ''}\n")
    f.write(f"INFLUXDB_TOKEN={data.get('influxdb_token') or ''}\n")
    f.write(f"INFLUXDB_ORG={data.get('influxdb_org') or ''}\n")
    f.write(f"INFLUXDB_BUCKET={data.get('influxdb_bucket') or ''}\n")
    # Blank by default -- docker-compose.yml falls back to :latest. Set this
    # to pin the node to a specific build (e.g. sha-abc1234) without editing
    # docker-compose.yml.
    f.write("INGEST_IMAGE_TAG=\n")
    # Not consumed by anything yet -- written for forward-compat with a
    # future ingest-node-authenticated heartbeat/reconcile endpoint.
    f.write(f"NODE_ID={data['node_id']}\n")
    f.write(f"NODE_API_KEY={data['node_api_key']}\n")
    f.write(f"REST_API_URL={data['rest_api_url']}\n")
PY
  log "Linked. Node ID written to $ENV_FILE."

  # The panel computed this hostname from the node's admin-chosen name and
  # already persisted it on the ingest_nodes row, so applying it here is what
  # makes a freshly imaged, generically-named VPS self-identify correctly
  # with zero manual admin steps.
  NODE_HOSTNAME="$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('hostname',''))" "$CLAIM_RESPONSE")"
  if [ -n "$NODE_HOSTNAME" ]; then
    log "Setting hostname to $NODE_HOSTNAME..."
    hostnamectl set-hostname "$NODE_HOSTNAME"
    if grep -q '^127\.0\.1\.1[[:space:]]' /etc/hosts; then
      sed -i "s/^127\.0\.1\.1[[:space:]].*/127.0.1.1\t$NODE_HOSTNAME/" /etc/hosts
    else
      echo -e "127.0.1.1\t$NODE_HOSTNAME" >> /etc/hosts
    fi
    if command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then
      tailscale set --hostname="$NODE_HOSTNAME" 2>/dev/null || warn "Couldn't set the Tailscale hostname (non-fatal)."
    fi
  else
    warn "Claim response did not include a hostname; leaving the host's hostname unchanged."
  fi
else
  if [ ! -f "$ENV_FILE" ]; then
    curl_with_backoff -fsSL -o "$ENV_FILE" "$RAW_BASE/$REF/.env.example" \
      || die "Failed to fetch .env.example from ref '$REF'. Check the --ref value and your network connection."
    warn "No --rest-api-url/--token given. Scaffolded $ENV_FILE from .env.example -- fill in SUPABASE_URL, SUPABASE_SECRET_KEY, INGEST_CONTROL_SECRET, INGEST_CONTROL_URL by hand before starting."
  else
    log "$ENV_FILE already exists, leaving it as-is."
  fi
fi
chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

log "Pulling images as $SERVICE_USER..."
sudo -u "$SERVICE_USER" bash -c "cd '$REPO_DIR' && docker compose -f '$COMPOSE_FILE' --env-file '$ENV_FILE' pull"

ENV_COMPLETE="true"
for key in SUPABASE_URL SUPABASE_SECRET_KEY INGEST_CONTROL_SECRET INGEST_CONTROL_URL; do
  grep -q "^${key}=.\+" "$ENV_FILE" || ENV_COMPLETE="false"
done

if [ "$DO_START" = "true" ]; then
  if [ "$ENV_COMPLETE" = "true" ]; then
    log "Starting the stack..."
    sudo -u "$SERVICE_USER" bash -c "cd '$REPO_DIR' && docker compose -f '$COMPOSE_FILE' --env-file '$ENV_FILE' up -d"
  else
    warn "--start was given but $ENV_FILE is missing required values; not starting. Fill it in and run: sudo -u $SERVICE_USER bash -c 'cd $REPO_DIR && docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up -d'"
  fi
else
  log "Pull complete. Not starting (pass --start to bring the stack up automatically)."
  log "To start manually: sudo -u $SERVICE_USER bash -c 'cd $REPO_DIR && docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up -d'"
fi

log "Done."
