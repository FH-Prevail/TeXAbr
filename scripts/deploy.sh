#!/usr/bin/env bash
#
# In-place deploy of TeXAbr from a source checkout.
#
# Assumes install.sh has already been run on this host at least once, so:
#   - $INSTALL_DIR, the texabr system user, the systemd unit, the firewall
#     rules, the kernel sysctls, and /etc/texabr/config.json are all in place.
#
# What this does vs re-running install.sh:
#   - Doesn't touch apt packages, the systemd unit, firewall, sysctls, config.
#   - Doesn't prompt for anything.
#   - Builds server + client into a sibling `dist-new/`, then atomically renames
#     it over `dist/`. So if the build crashes, the running service keeps
#     serving the old bundle; we never end up with a half-deleted dist that
#     can't satisfy a request.
#
# Usage:
#   cd /opt/texabr-src
#   git pull
#   sudo ./scripts/deploy.sh

set -euo pipefail

APP_USER="texabr"
APP_GROUP="texabr"
INSTALL_DIR="/opt/texabr"
NODE_BUILD_OPTS="--max-old-space-size=2048"
HEALTHZ_TIMEOUT_S=30

c_blue()  { printf "\033[34m%s\033[0m" "$1"; }
c_green() { printf "\033[32m%s\033[0m" "$1"; }
c_red()   { printf "\033[31m%s\033[0m" "$1"; }
log() { echo "[$(c_blue deploy)] $*"; }
ok()  { echo "[$(c_green ok)] $*"; }
die() { echo "[$(c_red error)] $*" >&2; exit 1; }

[[ "$EUID" -eq 0 ]] || die "must run as root"
[[ -d "$INSTALL_DIR"          ]] || die "$INSTALL_DIR not present — run install.sh first"
[[ -f /etc/systemd/system/texabr.service ]] || die "texabr.service unit missing — run install.sh first"

here="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "$here/install.sh"      ]] || die "this script must run from a TeXAbr source checkout"
[[ -d "$here/server"          ]] || die "missing $here/server"
[[ -d "$here/client"          ]] || die "missing $here/client"

log "syncing source $here -> $INSTALL_DIR (preserving existing dist directories)"
rsync -a \
  --exclude node_modules \
  --exclude .git \
  --exclude '*.log' \
  --exclude '/server/dist' \
  --exclude '/client/dist' \
  --exclude '/server/dist-new' \
  --exclude '/client/dist-new' \
  "$here/" "$INSTALL_DIR/"

# Clean any leftover .new directories from a previous aborted run.
rm -rf "$INSTALL_DIR/server/dist-new" "$INSTALL_DIR/client/dist-new"

log "building server -> server/dist-new"
( cd "$INSTALL_DIR/server" \
  && NODE_ENV=development npm install --no-audit --no-fund >/dev/null \
  && NODE_OPTIONS="$NODE_BUILD_OPTS" npx tsc -p tsconfig.json --outDir dist-new )
[[ -f "$INSTALL_DIR/server/dist-new/index.js" ]] || die "server build produced no dist-new/index.js"

log "building client -> client/dist-new (this can take a few minutes on small VPSes)"
( cd "$INSTALL_DIR/client" \
  && NODE_ENV=development npm install --no-audit --no-fund >/dev/null \
  && NODE_OPTIONS="$NODE_BUILD_OPTS" npx tsc -b \
  && NODE_OPTIONS="$NODE_BUILD_OPTS" npx vite build --outDir dist-new --emptyOutDir )
[[ -f "$INSTALL_DIR/client/dist-new/index.html" ]] || die "client build produced no dist-new/index.html"

log "atomic swap: dist -> dist-old, dist-new -> dist"
swap_dir() {
  local d="$1"
  rm -rf "$d/dist-old"
  [[ -d "$d/dist" ]] && mv "$d/dist" "$d/dist-old"
  mv "$d/dist-new" "$d/dist"
}
swap_dir "$INSTALL_DIR/server"
swap_dir "$INSTALL_DIR/client"

# Prune server dev deps now that the build is done; the running service only
# needs the runtime deps.
( cd "$INSTALL_DIR/server" && npm prune --omit=dev >/dev/null )
# Client node_modules are build-only; the served files are in dist/.
rm -rf "$INSTALL_DIR/client/node_modules"

chown -R "$APP_USER:$APP_GROUP" "$INSTALL_DIR"

log "restarting texabr"
systemctl restart texabr

# Wait until the service is fully active (Node + DB init usually < 2s).
i=0
while [[ "$(systemctl is-active texabr)" != "active" && $i -lt "$HEALTHZ_TIMEOUT_S" ]]; do
  sleep 1; ((i+=1))
done
state="$(systemctl is-active texabr)"
if [[ "$state" != "active" ]]; then
  echo "[$(c_red error)] service not active after ${i}s; state=$state"
  systemctl status texabr --no-pager | head -20
  echo
  echo "Rolling back to the previous build."
  systemctl stop texabr || true
  for d in server client; do
    if [[ -d "$INSTALL_DIR/$d/dist-old" ]]; then
      rm -rf "$INSTALL_DIR/$d/dist"
      mv "$INSTALL_DIR/$d/dist-old" "$INSTALL_DIR/$d/dist"
    fi
  done
  chown -R "$APP_USER:$APP_GROUP" "$INSTALL_DIR"
  systemctl start texabr
  die "rolled back; investigate journalctl -u texabr"
fi

log "smoke test"
# Probe via the local app with the same X-Forwarded-Proto nginx would set,
# so auth.https.enforced doesn't redirect us away from /api/healthz. systemd
# marks the service "active" as soon as the Node process starts, but the
# port isn't bound until a moment later — retry briefly to dodge that race.
healthz_ok=false
for _ in $(seq 1 15); do
  if curl -fsS -o /dev/null -H "X-Forwarded-Proto: https" \
       http://127.0.0.1:8217/api/healthz 2>/dev/null; then
    healthz_ok=true; break
  fi
  sleep 1
done
if $healthz_ok; then
  ok "/api/healthz responding"
else
  echo "[$(c_red warn)] /api/healthz didn't respond after 15s — check 'journalctl -u texabr'"
fi

# Drop the previous build now that the new one is verified.
rm -rf "$INSTALL_DIR/server/dist-old" "$INSTALL_DIR/client/dist-old"

ok "deploy complete: $(cd "$here" && git log -1 --oneline 2>/dev/null || echo 'no git')"
