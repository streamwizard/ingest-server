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
# ingest-server node uninstaller. Reverses what scripts/install.sh did, using
# the same defaults (service user, repo dir, compose file) so it undoes
# exactly what was set up.
#
# By default this only removes things install.sh itself created: the ingest
# containers/images/network and the repo checkout, plus the service account.
# It deliberately leaves Docker, ufw, and Tailscale installed, since other
# things on the box may depend on them. Pass the --purge-*/--disable-ufw
# flags below to also tear those down (e.g. to reset a test VM to a clean slate).
#
# Unlike obs-instance-manager's uninstaller, there's no --keep-data flag --
# install.sh never creates a persistent data directory (the compose file
# defines no volumes), so there's nothing to preserve.
#
# Usage:
#   sudo bash uninstall.sh [options]
#
# Options:
#   --repo-dir=DIR           Install directory to remove (default: /opt/ingest-server)
#   --service-user=NAME      Service account to remove (default: ingest)
#   --keep-user              Don't delete the service account/home directory
#   --remove-ufw-rules       Remove the 8888/udp, 5000/udp, and tailscale0:9000/udp ufw rules
#                            (leaves the SSH rule alone)
#   --disable-ufw            Reset ALL ufw rules and disable it (not just the ingest ones — use with care)
#   --purge-docker           Uninstall Docker engine + containerd entirely (affects the whole host)
#   --purge-tailscale        Bring Tailscale down and uninstall it entirely
#   --all                    Shorthand for --remove-ufw-rules --purge-docker --purge-tailscale --disable-ufw
#   --yes                    Skip the confirmation prompt
#   -h, --help               Show this help

set -euo pipefail

REPO_DIR="/opt/ingest-server"
SERVICE_USER="ingest"
COMPOSE_FILE="docker/stream-server/docker-compose.yml"
NETWORK_NAME="stream-server"
KEEP_USER="false"
REMOVE_UFW_RULES="false"
DISABLE_UFW="false"
PURGE_DOCKER="false"
PURGE_TAILSCALE="false"
SKIP_CONFIRM="false"

log()  { echo "[streamwizard] [uninstall] $*"; }
warn() { echo "[streamwizard] [uninstall] WARNING: $*" >&2; }
die()  { echo "[streamwizard] [uninstall] ERROR: $*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --repo-dir=*) REPO_DIR="${arg#*=}" ;;
    --service-user=*) SERVICE_USER="${arg#*=}" ;;
    --keep-user) KEEP_USER="true" ;;
    --remove-ufw-rules) REMOVE_UFW_RULES="true" ;;
    --disable-ufw) DISABLE_UFW="true" ;;
    --purge-docker) PURGE_DOCKER="true" ;;
    --purge-tailscale) PURGE_TAILSCALE="true" ;;
    --all) REMOVE_UFW_RULES="true"; DISABLE_UFW="true"; PURGE_DOCKER="true"; PURGE_TAILSCALE="true" ;;
    --yes) SKIP_CONFIRM="true" ;;
    -h|--help) sed -n '47,75p' "$0"; exit 0 ;;
    *) die "Unknown option: $arg" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Must run as root (sudo bash uninstall.sh ...)"

log "This will remove:"
log "  - the ingest-server docker compose stack, its containers/images, and the '$NETWORK_NAME' network"
log "  - $REPO_DIR"
[ "$KEEP_USER" = "true" ] || log "  - the '$SERVICE_USER' service account and its home directory"
[ "$REMOVE_UFW_RULES" = "true" ] && log "  - the ufw allow rules for 8888/udp, 5000/udp, and tailscale0:9000/udp"
[ "$DISABLE_UFW" = "true" ] && log "  - ALL ufw rules (full reset + disable, not just the ones above)"
[ "$PURGE_DOCKER" = "true" ] && log "  - Docker engine + containerd entirely (affects anything else on this host using Docker)"
[ "$PURGE_TAILSCALE" = "true" ] && log "  - Tailscale entirely (tailscale down + package removal)"
log "This will NOT touch: SSH, or anything outside the above."

if [ "$SKIP_CONFIRM" != "true" ]; then
  read -r -p "[uninstall] Continue? [y/N] " REPLY
  case "$REPLY" in
    y|Y|yes|YES) ;;
    *) log "Aborted."; exit 0 ;;
  esac
fi

if command -v docker >/dev/null; then
  if [ -f "$REPO_DIR/$COMPOSE_FILE" ]; then
    log "Stopping the compose stack..."
    sudo -u "$SERVICE_USER" bash -c "cd '$REPO_DIR' && docker compose -f '$COMPOSE_FILE' down -v" 2>/dev/null \
      || warn "Could not bring the stack down cleanly (may already be stopped)."
  fi

  log "Removing ingest-control / ingest-media / srtla-receiver images and any leftover containers..."
  for img in $(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -iE 'ingest-control|ingest-media|srtla-receiver' || true); do
    docker rmi -f "$img" >/dev/null 2>&1 || true
  done

  log "Removing the '$NETWORK_NAME' network..."
  docker network rm "$NETWORK_NAME" >/dev/null 2>&1 || true
else
  warn "Docker not found; skipping container/image/network cleanup."
fi

log "Removing $REPO_DIR..."
rm -rf "$REPO_DIR"

if [ "$KEEP_USER" != "true" ]; then
  if id "$SERVICE_USER" >/dev/null 2>&1; then
    log "Removing service account '$SERVICE_USER'..."
    userdel -r "$SERVICE_USER" 2>/dev/null || warn "Could not fully remove '$SERVICE_USER' (processes may still be running as it)."
  fi
fi

if command -v ufw >/dev/null; then
  if [ "$REMOVE_UFW_RULES" = "true" ]; then
    log "Removing the ufw rules for 8888/udp, 5000/udp, and tailscale0:9000/udp..."
    for port_proto in "8888/udp" "5000/udp" "9000/udp"; do
      while true; do
        RULE_NUM="$(ufw status numbered | grep -E "^\[[0-9]+\].*[[:space:]]${port_proto}" | head -n1 | sed -E 's/^\[([0-9]+)\].*/\1/' || true)"
        [ -n "$RULE_NUM" ] || break
        yes | ufw delete "$RULE_NUM" >/dev/null
      done
    done
  fi
  if [ "$DISABLE_UFW" = "true" ]; then
    warn "Resetting ufw entirely (this removes ALL rules, including the SSH one, and disables the firewall)."
    ufw --force reset >/dev/null
    ufw disable >/dev/null
  fi
fi

if [ "$PURGE_TAILSCALE" = "true" ]; then
  log "Purging Tailscale..."
  command -v tailscale >/dev/null && tailscale down >/dev/null 2>&1 || true
  apt-get purge -y tailscale >/dev/null 2>&1 || true
  rm -rf /var/lib/tailscale
  rm -f /etc/apt/sources.list.d/tailscale.list /usr/share/keyrings/tailscale-archive-keyring.gpg
fi

if [ "$PURGE_DOCKER" = "true" ]; then
  log "Purging Docker engine + containerd..."
  apt-get purge -y docker-ce docker-ce-cli docker-ce-rootless-extras docker-buildx-plugin docker-compose-plugin docker-model-plugin containerd.io >/dev/null 2>&1 || true
  rm -rf /var/lib/docker /var/lib/containerd /etc/docker
  rm -f /etc/apt/sources.list.d/docker.list /usr/share/keyrings/docker.gpg /etc/apt/keyrings/docker.asc /etc/apt/keyrings/docker.gpg
fi

log "Done."
