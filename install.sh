#!/usr/bin/env bash
#
# TeXAbr installer.
#
# Usage:
#   sudo ./install.sh                       # interactive (prompts on existing install)
#   sudo ./install.sh --port 8217 --host 0.0.0.0
#   sudo ./install.sh --domain tex.example.com    # provision Let's Encrypt cert
#   sudo ./install.sh --self-signed               # generate self-signed cert for LAN
#   sudo ./install.sh --self-signed-ip 192.168.1.50 # self-signed cert with IP SAN
#   sudo ./install.sh --reset                     # wipe DB + projects, then install fresh
#   sudo ./install.sh --uninstall                 # remove everything (data included)
#   sudo ./install.sh -y --reset                  # non-interactive wipe + reinstall
#
# What it does:
#   1. Detects the distro and installs Node.js 20, TeX Live (full or recommended),
#      common fonts, build essentials, and sqlite.
#   2. Creates the `texabr` system user and data dirs.
#   3. Builds server + client.
#   4. Writes /etc/texabr/config.json.
#   5. Installs and starts the systemd unit.
#   6. Prints the URL and bootstrap admin token.

set -euo pipefail

# ----------------------------- defaults ----------------------------------------

APP_NAME="texabr"
APP_USER="texabr"
APP_GROUP="texabr"
INSTALL_DIR="/opt/texabr"
DATA_DIR="/var/lib/texabr"
CONFIG_DIR="/etc/texabr"
LOG_DIR="/var/log/texabr"
DEFAULT_PORT=8217
DEFAULT_HOST="0.0.0.0"
NODE_MAJOR=20
TEXLIVE_PROFILE="recommended"   # one of: minimal, recommended, full

PORT="$DEFAULT_PORT"
HOST="$DEFAULT_HOST"
DOMAIN=""
USE_SELF_SIGNED="false"
SELF_SIGNED_IP=""
NON_INTERACTIVE="false"
SKIP_TEXLIVE="false"
ACTION="install"           # install | reset | uninstall

# ----------------------------- ui helpers --------------------------------------

c_red()   { printf "\033[31m%s\033[0m" "$1"; }
c_green() { printf "\033[32m%s\033[0m" "$1"; }
c_blue()  { printf "\033[34m%s\033[0m" "$1"; }
c_dim()   { printf "\033[2m%s\033[0m" "$1"; }

log()  { echo "[$(c_blue texabr)] $*"; }
ok()   { echo "[$(c_green ok)] $*"; }
warn() { echo "[$(c_red warn)] $*" >&2; }
die()  { echo "[$(c_red error)] $*" >&2; exit 1; }

require_root() {
  if [[ "$EUID" -ne 0 ]]; then
    die "must run as root: sudo ./install.sh"
  fi
}

# ----------------------------- arg parsing -------------------------------------

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)         PORT="$2"; shift 2 ;;
    --host)         HOST="$2"; shift 2 ;;
    --domain)       DOMAIN="$2"; shift 2 ;;
    --self-signed)  USE_SELF_SIGNED="true"; shift ;;
    --self-signed-ip)
                    SELF_SIGNED_IP="$2"; USE_SELF_SIGNED="true"; shift 2 ;;
    --texlive)      TEXLIVE_PROFILE="$2"; shift 2 ;;
    --skip-texlive) SKIP_TEXLIVE="true"; shift ;;
    --reset)        ACTION="reset"; shift ;;
    --uninstall)    ACTION="uninstall"; shift ;;
    -y|--yes)       NON_INTERACTIVE="true"; shift ;;
    -h|--help)      usage ;;
    *)              die "unknown flag: $1" ;;
  esac
done

# ----------------------------- distro detection --------------------------------

detect_distro() {
  if [[ -f /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    DISTRO_ID="${ID:-unknown}"
    DISTRO_LIKE="${ID_LIKE:-}"
  else
    die "cannot detect distro: /etc/os-release missing"
  fi
}

pkg_install() {
  case "$DISTRO_ID" in
    ubuntu|debian)
      apt-get update -y
      DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
      ;;
    fedora|rhel|centos|rocky|almalinux)
      # --skip-unavailable: don't abort the whole transaction if a single
      # package name has drifted across releases (e.g. dejavu-fonts-common
      # disappeared on Fedora 43+). Missing names are warned, not fatal.
      dnf install -y --skip-unavailable "$@"
      ;;
    arch|manjaro)
      pacman -Sy --noconfirm --needed "$@"
      ;;
    *)
      if [[ "$DISTRO_LIKE" == *debian* ]]; then
        apt-get update -y
        DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
      elif [[ "$DISTRO_LIKE" == *fedora* || "$DISTRO_LIKE" == *rhel* ]]; then
        dnf install -y --skip-unavailable "$@"
      elif [[ "$DISTRO_LIKE" == *arch* ]]; then
        pacman -Sy --noconfirm --needed "$@"
      else
        die "unsupported distro: $DISTRO_ID. Install dependencies manually and rerun with --skip-texlive."
      fi
      ;;
  esac
}

# ----------------------------- step: deps --------------------------------------

install_node() {
  if command -v node >/dev/null 2>&1; then
    local v
    v="$(node -v | sed 's/^v//' | cut -d. -f1)"
    if [[ "$v" -ge "$NODE_MAJOR" ]]; then
      ok "node $(node -v) already installed"
      return
    fi
  fi

  log "installing Node.js $NODE_MAJOR"
  case "$DISTRO_ID" in
    ubuntu|debian)
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
      pkg_install nodejs
      ;;
    fedora|rhel|centos|rocky|almalinux)
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
      pkg_install nodejs
      ;;
    arch|manjaro)
      pkg_install nodejs npm
      ;;
    *)
      die "automatic Node install not supported for $DISTRO_ID; install Node $NODE_MAJOR+ manually"
      ;;
  esac
}

install_texlive() {
  if [[ "$SKIP_TEXLIVE" == "true" ]]; then
    warn "skipping TeX Live install (--skip-texlive). Make sure pdflatex and synctex are on PATH for the texabr user."
    return
  fi

  if command -v pdflatex >/dev/null 2>&1 \
     && command -v xelatex >/dev/null 2>&1 \
     && command -v lualatex >/dev/null 2>&1; then
    ok "TeX Live already present"
  else
    log "installing TeX Live ($TEXLIVE_PROFILE profile)"
    case "$DISTRO_ID" in
      ubuntu|debian)
        case "$TEXLIVE_PROFILE" in
          minimal)     pkg_install texlive-latex-base texlive-latex-recommended ;;
          recommended) pkg_install texlive-latex-base texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended texlive-xetex texlive-luatex ;;
          full)        pkg_install texlive-full ;;
        esac
        ;;
      fedora|rhel|centos|rocky|almalinux)
        pkg_install texlive-scheme-medium texlive-xetex texlive-luatex
        ;;
      arch|manjaro)
        pkg_install texlive-core texlive-latexextra texlive-fontsextra
        ;;
    esac
  fi

  if ! command -v synctex >/dev/null 2>&1; then
    log "installing SyncTeX command-line tool"
    case "$DISTRO_ID" in
      ubuntu|debian)
        pkg_install texlive-binaries
        ;;
      fedora|rhel|centos|rocky|almalinux)
        pkg_install texlive-synctex
        ;;
      arch|manjaro)
        pkg_install texlive-bin
        ;;
    esac
  fi

  if command -v synctex >/dev/null 2>&1; then
    ok "SyncTeX command available"
  else
    die "TeX Live installed, but synctex is still missing. Install your distro's TeX Live binaries/SyncTeX package and rerun."
  fi
}

install_misc() {
  log "installing build essentials, git, sqlite, fonts, sandbox, backup tools"
  # bubblewrap + util-linux give us the compile sandbox (services/sandbox.ts).
  # restic is the backup engine (services/backup.ts); only used if backup.enabled
  # is later turned on in the admin panel, but we install it up front so the
  # admin doesn't need to chase the dependency at flip time.
  # curl is used by the post-install smoke test to probe /api/healthz.
  case "$DISTRO_ID" in
    ubuntu|debian)
      pkg_install build-essential python3 git curl ca-certificates sqlite3 \
                  fontconfig fonts-dejavu fonts-liberation openssl \
                  bubblewrap util-linux restic
      ;;
    fedora|rhel|centos|rocky|almalinux)
      # Fedora 43 dropped the dejavu-fonts-common meta in favour of the
      # split *-fonts subpackages. List them individually.
      pkg_install gcc gcc-c++ make git curl ca-certificates sqlite \
                  fontconfig dejavu-sans-fonts dejavu-serif-fonts \
                  dejavu-sans-mono-fonts liberation-fonts openssl python3 \
                  bubblewrap util-linux restic
      ;;
    arch|manjaro)
      pkg_install base-devel git curl ca-certificates sqlite fontconfig \
                  ttf-dejavu ttf-liberation openssl \
                  bubblewrap util-linux restic
      ;;
  esac
}

ensure_git() {
  if command -v git >/dev/null 2>&1; then
    ok "git $(git --version | awk '{print $3}') available"
    return
  fi

  log "installing git"
  pkg_install git
  command -v git >/dev/null 2>&1 || die "git is required for shared project history"
  ok "git $(git --version | awk '{print $3}') available"
}

# ----------------------------- step: legacy-name detection ---------------------
# Earlier releases of this project shipped under the name `indipenotex`. If the
# operator is upgrading from one of those, the *new* installer would otherwise
# leave the old service running and bound to port 8217 — the new texabr.service
# then crash-loops with EADDRINUSE. Detect the old name and stop+disable it
# before doing anything else; leave its data dirs alone so the operator can
# migrate or wipe at their own pace.
legacy_indipenotex_artifacts() {
  local found=0
  systemctl list-unit-files 2>/dev/null | grep -q '^indipenotex\.service'        && found=1
  systemctl list-unit-files 2>/dev/null | grep -q '^indipenotex-backup\.timer'   && found=1
  [[ -d /opt/indipenotex    ]] && found=1
  [[ -d /etc/indipenotex    ]] && found=1
  [[ -d /var/lib/indipenotex ]] && found=1
  id indipenotex >/dev/null 2>&1 && found=1
  return $((1 - found))
}

stop_legacy_indipenotex() {
  if systemctl list-unit-files 2>/dev/null | grep -q '^indipenotex\.service'; then
    log "stopping legacy indipenotex.service"
    systemctl disable --now indipenotex.service 2>/dev/null || true
    rm -f /etc/systemd/system/indipenotex.service
  fi
  if systemctl list-unit-files 2>/dev/null | grep -q '^indipenotex-backup\.timer'; then
    log "stopping legacy indipenotex-backup.timer"
    systemctl disable --now indipenotex-backup.timer 2>/dev/null || true
    rm -f /etc/systemd/system/indipenotex-backup.timer
    rm -f /etc/systemd/system/indipenotex-backup.service
  fi
  systemctl daemon-reload 2>/dev/null || true
}

handle_legacy_install() {
  legacy_indipenotex_artifacts || return 0
  echo
  warn "legacy 'indipenotex' install detected"
  [[ -d /opt/indipenotex     ]]               && echo "    - code:    /opt/indipenotex"
  [[ -d /var/lib/indipenotex ]]               && echo "    - data:    /var/lib/indipenotex (preserved)"
  [[ -d /etc/indipenotex     ]]               && echo "    - config:  /etc/indipenotex"
  systemctl list-unit-files 2>/dev/null | grep -q '^indipenotex\.service'      && echo "    - service: indipenotex.service"
  systemctl list-unit-files 2>/dev/null | grep -q '^indipenotex-backup\.timer' && echo "    - timer:   indipenotex-backup.timer"
  id indipenotex >/dev/null 2>&1                                                && echo "    - user:    indipenotex"
  echo

  if [[ "$NON_INTERACTIVE" == "true" ]]; then
    log "non-interactive: stopping the legacy service so port 8217 is free; data dirs left in place"
    stop_legacy_indipenotex
    return 0
  fi

  echo "  How should the legacy install be handled?"
  echo "    [s] Stop and disable the old service only — keep /opt, /etc, /var/lib and the system user (DEFAULT)"
  echo "    [w] Wipe everything legacy: stop service, delete /opt/indipenotex, /etc/indipenotex, /var/lib/indipenotex, user 'indipenotex'"
  echo "    [c] Cancel"
  echo
  local choice
  read -r -p "  Choice [s/w/c]: " choice
  case "${choice,,}" in
    s|"")
      stop_legacy_indipenotex
      log "legacy service stopped; you can migrate /var/lib/indipenotex into /var/lib/texabr later"
      ;;
    w)
      read -r -p "  Type 'WIPE' to confirm legacy data deletion (this destroys old projects): " confirm
      [[ "$confirm" == "WIPE" ]] || die "legacy wipe not confirmed; aborting"
      stop_legacy_indipenotex
      rm -rf /opt/indipenotex /etc/indipenotex /var/lib/indipenotex /var/log/indipenotex
      if id indipenotex >/dev/null 2>&1; then
        userdel indipenotex 2>/dev/null || true
        getent group indipenotex >/dev/null 2>&1 && groupdel indipenotex 2>/dev/null || true
      fi
      ok "legacy install removed"
      ;;
    c|*) die "cancelled by user" ;;
  esac
}

# ----------------------------- step: existing install detection ----------------

# Returns 0 (true) if any of the install artefacts are present.
existing_install_detected() {
  [[ -d "$INSTALL_DIR" ]] && return 0
  [[ -d "$DATA_DIR"    ]] && return 0
  [[ -d "$CONFIG_DIR"  ]] && return 0
  [[ -f /etc/systemd/system/texabr.service ]] && return 0
  id "$APP_USER" >/dev/null 2>&1 && return 0
  return 1
}

# Print what's currently on disk so the user knows what they're about to lose.
describe_existing_install() {
  echo "  Existing TeXAbr install detected:"
  [[ -d "$INSTALL_DIR" ]] && echo "    - code:    $INSTALL_DIR"
  if [[ -d "$DATA_DIR" ]]; then
    local size
    size="$(du -sh "$DATA_DIR" 2>/dev/null | awk '{print $1}')"
    echo "    - data:    $DATA_DIR ${size:+($size — DB + projects)}"
  fi
  [[ -d "$CONFIG_DIR" ]]                            && echo "    - config:  $CONFIG_DIR"
  [[ -f /etc/systemd/system/texabr.service ]]  && echo "    - service: texabr.service (systemd)"
  id "$APP_USER" >/dev/null 2>&1                    && echo "    - user:    $APP_USER"
}

# Stop and remove the systemd unit. Safe to call even if it isn't installed.
stop_service() {
  if systemctl list-unit-files 2>/dev/null | grep -q '^texabr\.service'; then
    log "stopping systemd unit"
    systemctl disable --now texabr 2>/dev/null || true
    rm -f /etc/systemd/system/texabr.service
  fi
  if systemctl list-unit-files 2>/dev/null | grep -q '^texabr-backup\.timer'; then
    systemctl disable --now texabr-backup.timer 2>/dev/null || true
    rm -f /etc/systemd/system/texabr-backup.timer
    rm -f /etc/systemd/system/texabr-backup.service
  fi
  systemctl daemon-reload 2>/dev/null || true
}

# Full destructive uninstall: code, data, config, logs, user.
# Does NOT remove TeX Live, Node.js, or any system fonts — those are shared.
uninstall() {
  log "uninstalling TeXAbr"
  stop_service
  rm -rf "$INSTALL_DIR" "$DATA_DIR" "$CONFIG_DIR" "$LOG_DIR"
  rm -f /etc/sysctl.d/99-texabr.conf
  if id "$APP_USER" >/dev/null 2>&1; then
    log "removing system user $APP_USER"
    # On systems where the user owned no other files, userdel is fine.
    userdel "$APP_USER" 2>/dev/null || true
    # Group is auto-removed with userdel, but be explicit on distros where it isn't.
    getent group "$APP_GROUP" >/dev/null 2>&1 && groupdel "$APP_GROUP" 2>/dev/null || true
  fi
  # Deliberately don't tear down firewall rules — if the operator added the
  # port intentionally for something else they'd be surprised by removal.
  ok "uninstall complete"
}

# Prompt the user about what to do when an existing install is detected.
# Sets the global ACTION to "install" (upgrade) or "reset" (wipe + install).
prompt_existing_install() {
  echo
  describe_existing_install
  echo

  if [[ "$NON_INTERACTIVE" == "true" ]]; then
    # In non-interactive mode default to upgrade-in-place, since reset would
    # silently destroy data. Force --reset or --uninstall to nuke things.
    log "non-interactive mode: upgrading in place (use --reset to wipe data)"
    ACTION="install"
    return
  fi

  echo "  What would you like to do?"
  echo "    [u] Upgrade in place — rebuild code, KEEP all users/projects/config"
  echo "    [r] Reset            — WIPE database, projects, and config; reinstall fresh"
  echo "    [c] Cancel"
  echo
  local choice
  read -r -p "  Choice [u/r/c]: " choice
  case "${choice,,}" in
    u|"") ACTION="install" ;;
    r)
      read -r -p "  Type 'WIPE' to confirm destruction of all data: " confirm
      if [[ "$confirm" != "WIPE" ]]; then
        die "reset not confirmed; aborting"
      fi
      ACTION="reset"
      ;;
    c|*) die "cancelled by user" ;;
  esac
}

# ----------------------------- step: user/dirs ---------------------------------

ensure_user() {
  if id "$APP_USER" >/dev/null 2>&1; then
    ok "system user $APP_USER exists"
  else
    log "creating system user $APP_USER"
    useradd --system --create-home --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER" \
      || useradd --system --create-home --home-dir "$DATA_DIR" --shell /sbin/nologin "$APP_USER"
  fi

  mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$CONFIG_DIR" "$LOG_DIR"
  chown -R "$APP_USER:$APP_GROUP" "$DATA_DIR" "$LOG_DIR"
  chmod 750 "$DATA_DIR" "$LOG_DIR"
}

# ----------------------------- step: build app ---------------------------------

build_app() {
  log "copying source to $INSTALL_DIR"
  local here
  here="$(cd "$(dirname "$0")" && pwd)"

  rsync -a --delete \
    --exclude node_modules \
    --exclude .git \
    --exclude '*.log' \
    "$here/" "$INSTALL_DIR/"

  # Force NODE_ENV unset during install so dev deps (typescript, vite, ...)
  # are installed for the build step. The systemd unit sets NODE_ENV=production
  # at runtime; that does not affect what got installed here.
  #
  # We use `npm install` rather than `npm ci` because the scaffold ships
  # without a committed package-lock.json. If one exists already, npm will
  # honour it; if not, it'll be generated. Either way the build is reproducible
  # within the install run.
  local NPM_INSTALL_FLAGS="--no-audit --no-fund"

  log "building server"
  ( cd "$INSTALL_DIR/server" && NODE_ENV=development npm install $NPM_INSTALL_FLAGS && npm run build )

  log "building client"
  ( cd "$INSTALL_DIR/client" && NODE_ENV=development npm install $NPM_INSTALL_FLAGS && npm run build )

  # Strip dev deps from the server install (keep client/dist; client deps are
  # build-time only and the static dist is what we serve).
  ( cd "$INSTALL_DIR/server" && npm prune --omit=dev )
  rm -rf "$INSTALL_DIR/client/node_modules"

  chown -R "$APP_USER:$APP_GROUP" "$INSTALL_DIR"
}

# ----------------------------- step: tls ---------------------------------------

is_ip_literal() {
  [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ || "$1" == *:* ]]
}

first_lan_ip() {
  hostname -I 2>/dev/null | awk '{print $1}'
}

provision_self_signed() {
  local cert_ip cert_dns openssl_cfg
  cert_ip="$SELF_SIGNED_IP"
  if [[ -z "$cert_ip" && "$HOST" != "0.0.0.0" && "$HOST" != "::" ]] && is_ip_literal "$HOST"; then
    cert_ip="$HOST"
  fi
  if [[ -z "$cert_ip" ]]; then
    cert_ip="$(first_lan_ip || true)"
  fi
  cert_dns="$(hostname -f 2>/dev/null || hostname)"
  openssl_cfg="$(mktemp)"

  log "generating self-signed certificate${cert_ip:+ for https://$cert_ip:$PORT}"
  mkdir -p "$CONFIG_DIR/tls"
  cat >"$openssl_cfg" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3_req
prompt = no

[dn]
CN = ${cert_ip:-$cert_dns}

[v3_req]
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
DNS.2 = $cert_dns
EOF
  if [[ -n "$cert_ip" ]]; then
    echo "IP.1 = $cert_ip" >>"$openssl_cfg"
  fi

  openssl req -x509 -nodes -newkey rsa:4096 \
    -keyout "$CONFIG_DIR/tls/key.pem" \
    -out    "$CONFIG_DIR/tls/cert.pem" \
    -days   825 \
    -config "$openssl_cfg"
  rm -f "$openssl_cfg"
  chown -R "$APP_USER:$APP_GROUP" "$CONFIG_DIR/tls"
  chmod 600 "$CONFIG_DIR/tls/key.pem"
  TLS_CERT="$CONFIG_DIR/tls/cert.pem"
  TLS_KEY="$CONFIG_DIR/tls/key.pem"
  TLS_DISPLAY_HOST="${cert_ip:-$cert_dns}"
}

provision_letsencrypt() {
  log "provisioning Let's Encrypt cert for $DOMAIN"
  case "$DISTRO_ID" in
    ubuntu|debian) pkg_install certbot ;;
    fedora|rhel|centos|rocky|almalinux) pkg_install certbot ;;
    arch|manjaro) pkg_install certbot ;;
  esac

  certbot certonly --standalone --non-interactive --agree-tos \
    -m "admin@$DOMAIN" -d "$DOMAIN"

  TLS_CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
  TLS_KEY="/etc/letsencrypt/live/$DOMAIN/privkey.pem"
}

# ----------------------------- step: config ------------------------------------

write_config() {
  local jwt_secret bootstrap_token
  jwt_secret="$(openssl rand -hex 32)"
  bootstrap_token="$(openssl rand -hex 16)"

  local https_block='"enabled": false, "cert": null, "key": null'
  if [[ -n "${TLS_CERT:-}" && -n "${TLS_KEY:-}" ]]; then
    https_block="\"enabled\": true, \"cert\": \"$TLS_CERT\", \"key\": \"$TLS_KEY\""
  fi

  cat >"$CONFIG_DIR/config.json" <<JSON
{
  "host": "$HOST",
  "port": $PORT,
  "https": { $https_block },
  "dataDir": "$DATA_DIR",
  "auth": {
    "jwtSecret": "$jwt_secret",
    "sessionTtlHours": 168,
    "bootstrapToken": "$bootstrap_token"
  },
  "registration": {
    "open": false,
    "requireInvite": true
  },
  "latex": {
    "engines": ["pdflatex", "xelatex", "lualatex"],
    "defaultEngine": "pdflatex",
    "timeoutMs": 60000,
    "maxConcurrent": 4
  },
  "limits": {
    "maxProjectMb": 200,
    "maxFileMb": 25
  }
}
JSON

  chown root:"$APP_GROUP" "$CONFIG_DIR/config.json"
  chmod 640 "$CONFIG_DIR/config.json"

  BOOTSTRAP_TOKEN="$bootstrap_token"
}

update_existing_https_config() {
  [[ -n "${TLS_CERT:-}" && -n "${TLS_KEY:-}" ]] || return 0

  log "updating existing config with HTTPS certificate paths"
  CONFIG_PATH="$CONFIG_DIR/config.json" \
  TLS_CERT_PATH="$TLS_CERT" \
  TLS_KEY_PATH="$TLS_KEY" \
  node <<'NODE'
const fs = require("fs");

const path = process.env.CONFIG_PATH;
const cfg = JSON.parse(fs.readFileSync(path, "utf8"));
cfg.https = {
  ...(cfg.https || {}),
  enabled: true,
  cert: process.env.TLS_CERT_PATH,
  key: process.env.TLS_KEY_PATH,
};
fs.writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
NODE

  chown root:"$APP_GROUP" "$CONFIG_DIR/config.json"
  chmod 640 "$CONFIG_DIR/config.json"
}

# ----------------------------- step: systemd -----------------------------------

install_systemd() {
  log "installing systemd unit"
  install -m 644 "$INSTALL_DIR/systemd/texabr.service" /etc/systemd/system/texabr.service
  install -m 644 "$INSTALL_DIR/systemd/texabr-backup.service" /etc/systemd/system/texabr-backup.service
  install -m 644 "$INSTALL_DIR/systemd/texabr-backup.timer"   /etc/systemd/system/texabr-backup.timer
  systemctl daemon-reload
  systemctl enable texabr
  systemctl restart texabr

  # Enable the timer regardless of whether backups are flipped on. The unit's
  # ExecStart short-circuits when backup.enabled=false (see services/backup.ts),
  # so this is cheap and saves a second systemctl step when the admin enables
  # backups later via the panel.
  systemctl enable --now texabr-backup.timer
}

install_backup_password() {
  local pw_file="$CONFIG_DIR/backup-password"
  if [[ -f "$pw_file" ]]; then
    ok "backup password file already present at $pw_file"
    return
  fi
  log "generating backup password file at $pw_file"
  install -m 640 -o root -g "$APP_GROUP" /dev/null "$pw_file"
  openssl rand -hex 32 > "$pw_file"
  chmod 640 "$pw_file"
  chown root:"$APP_GROUP" "$pw_file"
  warn "store $pw_file somewhere safe — without it, restic cannot decrypt your backups"
}

# ----------------------------- step: kernel sysctls ---------------------------
# bubblewrap relies on unprivileged user namespaces. Three known knobs make
# this fail on stock distro defaults:
#   * Older Debian sets kernel.unprivileged_userns_clone=0 (Buster era).
#   * Ubuntu 24.04+ ships kernel.apparmor_restrict_unprivileged_userns=1,
#     which blocks bwrap from creating a userns even though the binary is
#     unprivileged.
#   * RHEL/Rocky/Alma sometimes lower user.max_user_namespaces to 0 in
#     hardened images.
# We drop a sysctl file to cover all three. It only sets keys that exist on
# the running kernel, so we don't spew "unknown key" warnings on distros
# where the knob isn't present.

configure_kernel_sysctls() {
  local file=/etc/sysctl.d/99-texabr.conf
  local lines=()
  if [[ -e /proc/sys/kernel/unprivileged_userns_clone ]]; then
    lines+=("kernel.unprivileged_userns_clone = 1")
  fi
  if [[ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]]; then
    lines+=("kernel.apparmor_restrict_unprivileged_userns = 0")
  fi
  if [[ -e /proc/sys/user/max_user_namespaces ]]; then
    local current
    current="$(sysctl -n user.max_user_namespaces 2>/dev/null || echo 0)"
    if [[ "$current" -lt 1024 ]]; then
      lines+=("user.max_user_namespaces = 16384")
    fi
  fi

  if [[ ${#lines[@]} -eq 0 ]]; then
    log "kernel user-namespace knobs already permissive; no sysctl drop-in needed"
    rm -f "$file"
    return
  fi

  log "writing kernel sysctls to $file (user-namespace knobs for bwrap)"
  printf '%s\n' "${lines[@]}" > "$file"
  chmod 644 "$file"
  sysctl --load "$file" >/dev/null 2>&1 || warn "sysctl --load $file produced warnings; review with 'sysctl -p $file'"
}

# ----------------------------- step: firewall --------------------------------
# Open the configured port on the host firewall so the editor URL the
# installer prints actually works from a remote browser. We only touch
# firewalls that are running; we never enable a firewall the operator hadn't
# already turned on.

configure_firewall() {
  if [[ "$HOST" != "0.0.0.0" && "$HOST" != "::" ]]; then
    log "host bound to $HOST; skipping firewall step (not a public listener)"
    return
  fi

  if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
    if firewall-cmd --query-port="$PORT/tcp" >/dev/null 2>&1; then
      ok "firewalld already permits $PORT/tcp"
    else
      log "opening $PORT/tcp on firewalld"
      firewall-cmd --permanent --add-port="$PORT/tcp" >/dev/null
      firewall-cmd --reload >/dev/null
    fi
  elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    if ufw status 2>/dev/null | grep -qE "^${PORT}/tcp.*ALLOW"; then
      ok "ufw already permits $PORT/tcp"
    else
      log "opening $PORT/tcp on ufw"
      ufw allow "$PORT/tcp" >/dev/null
    fi
  else
    log "no active firewalld/ufw detected; nothing to open"
  fi
}

# ----------------------------- step: smoke tests ------------------------------
# After the systemd unit is up, verify that:
#   1. The HTTP listener responds on /api/healthz.
#   2. bubblewrap actually works for the texabr user. This is a fast canary;
#      if it fails, the operator gets a clear message *now* instead of seeing
#      "(killed: timeout)" the first time they hit Compile.

post_install_smoke_test() {
  log "running post-install smoke tests"

  local proto url="http://127.0.0.1:$PORT/api/healthz"
  local i ok=false
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      ok=true; break
    fi
    sleep 1
  done
  if $ok; then
    ok "/api/healthz responds on $url"
  else
    warn "/api/healthz did not respond after 10s — check 'systemctl status texabr' and 'journalctl -u texabr'"
  fi

  if command -v bwrap >/dev/null 2>&1; then
    local sandbox_diag=/var/lib/texabr/.install-sandbox-probe
    install -d -m 750 -o "$APP_USER" -g "$APP_GROUP" "$sandbox_diag"

    # Mirror sandbox.ts's bind set: /lib, /lib64, /bin, /sbin must all be in
    # the sandbox or the dynamic loader can't find ld-linux to exec /usr/bin/true.
    local probe_binds=(
      --ro-bind /usr /usr
      --ro-bind /etc /etc
    )
    for d in /lib /lib64 /bin /sbin; do
      [[ -e "$d" ]] && probe_binds+=( --ro-bind "$d" "$d" )
    done

    if runuser -u "$APP_USER" -- bwrap \
         --unshare-all --die-with-parent \
         --proc /proc --dev /dev --tmpfs /tmp \
         "${probe_binds[@]}" \
         --bind "$sandbox_diag" "$sandbox_diag" --chdir "$sandbox_diag" \
         -- /usr/bin/true 2>/tmp/texabr-bwrap-probe.err; then
      ok "bwrap sandbox functional for user $APP_USER"
    else
      warn "bwrap sandbox FAILED for user $APP_USER:"
      sed 's/^/    /' /tmp/texabr-bwrap-probe.err >&2
      warn "compiles will fail until this is resolved. Common causes:"
      warn "  - kernel.unprivileged_userns_clone=0 (Debian Buster era)"
      warn "  - kernel.apparmor_restrict_unprivileged_userns=1 (Ubuntu 24.04+)"
      warn "  - SELinux denying bwrap; check 'ausearch -m AVC -ts recent'"
      warn "  - a Protect* directive in texabr.service that bind-remounts /proc"
    fi
    rm -rf "$sandbox_diag" /tmp/texabr-bwrap-probe.err
  else
    warn "bwrap not on PATH — sandboxed compiles will be impossible"
  fi
}

# ----------------------------- main --------------------------------------------

main() {
  require_root
  detect_distro
  log "detected distro: $DISTRO_ID"

  # Free port 8217 from any leftover indipenotex.service before the rest of
  # the install runs — otherwise the new texabr.service crashes on startup
  # with EADDRINUSE and the user thinks the install failed.
  handle_legacy_install

  # ---- Action gating: handle uninstall / reset / existing-install prompts ----
  if [[ "$ACTION" == "uninstall" ]]; then
    if ! existing_install_detected; then
      log "no existing install found; nothing to remove"
      exit 0
    fi
    describe_existing_install
    if [[ "$NON_INTERACTIVE" != "true" ]]; then
      echo
      read -r -p "  Type 'WIPE' to confirm full removal: " confirm
      [[ "$confirm" == "WIPE" ]] || die "uninstall not confirmed; aborting"
    fi
    uninstall
    exit 0
  fi

  if existing_install_detected; then
    if [[ "$ACTION" != "reset" ]]; then
      prompt_existing_install
    fi
    if [[ "$ACTION" == "reset" ]]; then
      log "resetting: wiping previous install before reinstall"
      uninstall
    else
      # Upgrade in place: stop the service so we can overwrite /opt/texabr
      # without the running node process holding the old code open.
      stop_service
    fi
  fi

  install_misc
  ensure_git
  install_node
  install_texlive
  ensure_user
  build_app

  if [[ -n "$DOMAIN" ]]; then
    provision_letsencrypt
  elif [[ "$USE_SELF_SIGNED" == "true" ]]; then
    provision_self_signed
  fi

  if [[ -f "$CONFIG_DIR/config.json" ]]; then
    log "keeping existing config at $CONFIG_DIR/config.json"
    BOOTSTRAP_TOKEN="(existing install; bootstrap token unchanged)"
    update_existing_https_config
  else
    write_config
  fi
  install_backup_password
  configure_kernel_sysctls
  install_systemd
  configure_firewall
  post_install_smoke_test

  local proto host_disp
  proto="http"
  [[ -n "${TLS_CERT:-}" ]] && proto="https"
  host_disp="$HOST"
  [[ "$host_disp" == "0.0.0.0" ]] && host_disp="$(hostname -I | awk '{print $1}')"
  [[ -n "${TLS_DISPLAY_HOST:-}" ]] && host_disp="$TLS_DISPLAY_HOST"
  [[ -n "$DOMAIN" ]] && host_disp="$DOMAIN"

  cat <<EOF

$(c_green '────────────────────────────────────────────────────────────')
$(c_green 'TeXAbr is installed.')
$(c_green '────────────────────────────────────────────────────────────')

  URL:              $proto://$host_disp:$PORT
  Config:           $CONFIG_DIR/config.json
  Data dir:         $DATA_DIR
  Service:          systemctl status texabr
  Logs:             journalctl -u texabr -f

  Bootstrap admin token (use it on first login at /setup):

      $BOOTSTRAP_TOKEN

  $(c_dim 'Save this token. It is only printed once.')

EOF
}

main "$@"
