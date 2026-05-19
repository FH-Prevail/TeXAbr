# TeXAbr 1.0

<p align="center">
  <img src="assets/logo.png" alt="TeXAbr logo" width="180" />
</p>

**A self-hosted, multi-user LaTeX editor for Linux.**

TeXAbr is the network-native sibling of [Openotex](https://github.com/FH-Prevail/Openotex). Where Openotex is a desktop Electron app that compiles LaTeX locally on each user's machine, TeXAbr is a single Linux server that hosts the editor, owns the LaTeX toolchain, fonts, and project files, and serves the editor to any browser on the network.

```
┌──────────────────────────────┐         ┌──────────────────────────────┐
│  Browsers on the LAN/WAN     │  HTTPS  │  TeXAbr server (Linux)       │
│  (any OS, no install)        │ ──────▶ │                              │
│  • Editor (Monaco)           │         │  • Express API (auth, files, │
│  • Live PDF preview          │         │    compile, admin, audit)    │
│  • File tree, terminal       │         │  • TeX Live + bubblewrap     │
│  • Admin panel (admins only) │         │    sandboxed compile         │
│                              │         │  • SQLite (users, projects,  │
│                              │         │    settings, audit, lockouts)│
│                              │         │  • Restic backups via timer  │
└──────────────────────────────┘         └──────────────────────────────┘
```

## Why a separate project?

Openotex assumes a single author with Node and TeX Live on their own machine. That doesn't fit:

- A research group sharing a beefy Linux box with TeX Live already configured.
- A classroom where students should hit a URL, log in, and start editing.
- A small team that wants Overleaf-style hosting without sending documents to a third party.

TeXAbr targets that gap. **Server-first**: install once, every user just needs a browser.

## Features

### Editing & compile
- Multi-tab Monaco editor with syntax highlighting, structure map, terminal pane.
- Real `pdflatex` / `xelatex` / `lualatex` running on the server (not a JS port).
- Live PDF preview with SyncTeX forward + inverse search.
- Two-pass compile for refs/TOC. Per-project main-file pinning.
- Project history backed by `git`; **proposals** branch from main, get edited in a worktree, and merge back when ready.

### Multi-user with sharing
- Cookie-based JWT auth, bcrypt-hashed passwords, server-side session revocation.
- Project ACLs: owner, editor, reader. Owners can invite collaborators.
- Soft single-writer file lock (default 120s TTL) so two editors can't silently overwrite each other while real-time collab is out of scope.
- Optional self-serve registration with single-use or multi-use invite tokens.

### Compile sandbox
- Each compile runs as `prlimit ... -- bwrap --unshare-all --bind <projectRoot> ... pdflatex ...`.
- POSIX rlimits enforce CPU seconds, virtual-memory cap, single-output-file size, and max processes — independently of the wall-clock kill switch.
- `-no-shell-escape` and pinned `HOME` / `TEXMFOUTPUT` / `openin_any=p` / `openout_any=p` for defense in depth.
- Per-user concurrency caps so one user can't starve everyone else.

### Quotas & limits
- Per-project size cap, per-file cap, per-project file-count cap, per-user disk quota.
- All four are tunable in the admin panel; the multer body limit pulls from the registry too.

### Auth hardening
- httpOnly + Secure + SameSite cookies (mode configurable).
- Double-submit CSRF on every state-changing request.
- Login rate-limit + per-username + per-IP lockout (counters in SQLite, persist across restarts).
- `token_version` per user — bump it to revoke every issued JWT (used on disable, password change, admin "Revoke sessions").
- Optional `auth.https.enforced`: HTTP→HTTPS 301 redirect plus HSTS.

### Password recovery (no email required)
- At registration (and bootstrap), the server generates a 128-bit recovery code formatted as `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX` and shows it to the user **once**. The DB only stores its bcrypt hash.
- If the user forgets their password, they enter username + recovery code + new password at `/forgot`. The server verifies the seed, resets the password, bumps `token_version` (signing out every other session), and issues a **fresh** recovery code (the old one is invalidated atomically).
- Recovery attempts feed the same login-lockout counters, so brute-forcing the code is rate-limited identically to password guessing.
- Logged-in users can rotate the recovery code via `POST /api/auth/rotate-seed`.

### Backups
- Restic-based snapshots of `dataDir` plus an online SQLite checkpoint.
- Driven by `texabr-backup.timer` (default `OnCalendar=*-*-* 03:00:00`).
- Repo path, password file, retention all admin-configurable.
- Run history visible in the admin panel; manual "Run backup now" button for sanity-checks.

### Audit trail
- Every login (success/fail/locked/disabled), admin action, settings update, backup run, and compile is appended to a SQLite `audit_log` table and emitted as a JSON line to the journal.
- Filter and inspect from the admin panel's Audit tab.

### Operational
- Schema-versioned migrations, structured JSON logger, `/api/healthz` + `/api/readyz`.
- Graceful shutdown drains in-flight compiles before exit; runaway PIDs get SIGKILL after a configurable grace period.
- systemd hardening: `ProtectSystem=strict`, all caps dropped, restricted syscall set, restricted address families, `RemoveIPC=true`.

## Quick start

```bash
git clone https://github.com/FH-Prevail/TeXAbr.git
cd TeXAbr
sudo ./install.sh
```

The installer will:

1. Detect your distro and install Node.js 20, TeX Live, fonts, **bubblewrap + util-linux** (sandbox), **restic** (backups), and SQLite tooling.
2. Build the server and client.
3. Create a system user `texabr` and `/var/lib/texabr` for projects + DB.
4. Generate a backup-encryption password at `/etc/texabr/backup-password` (root:texabr 0640).
5. Drop a sysctl file at `/etc/sysctl.d/99-texabr.conf` enabling unprivileged user namespaces (Debian Buster default-off, Ubuntu 24.04+ AppArmor-restricted, hardened RHEL images).
6. Install + enable `texabr.service` and `texabr-backup.timer`.
7. Open `8217/tcp` on `firewalld` (Fedora/RHEL) or `ufw` (Ubuntu) **only if the firewall is already running**. The installer never enables a firewall the operator hadn't already turned on.
8. Run a post-install smoke test: probe `/api/healthz` and run a tiny bwrap as the `texabr` user. If either fails, you get a hint immediately rather than discovering it on your first compile.
9. Print the URL (`http://<your-ip>:8217`) and a one-shot bootstrap admin token.

On first visit, sign in with the printed token at `/setup` to create the initial admin account.

### Supported distros

| Distro | Status |
|---|---|
| Debian 12+ (bookworm/trixie) | tested, sysctl drop-in handles older kernels |
| Ubuntu 22.04 / 24.04 | tested, sysctl drop-in handles AppArmor restriction |
| Fedora 40 / 41 / 42 / 43 | tested, SELinux service unconfined by default |
| RHEL / Rocky / Alma 9 | should work; report issues |
| Arch / Manjaro | should work; rolling, breakage occasional |

### Upgrading from `indipenotex` (pre-1.0)

The installer auto-detects a previous `indipenotex` install. By default it stops and disables `indipenotex.service` + `indipenotex-backup.timer` so port 8217 is free, but **leaves `/var/lib/indipenotex` untouched** so you can move data over manually:

```bash
sudo systemctl stop texabr
sudo rsync -a /var/lib/indipenotex/ /var/lib/texabr/
sudo chown -R texabr:texabr /var/lib/texabr
sudo systemctl start texabr
```

If the old data is throwaway, choose `w` at the legacy-install prompt and the installer wipes `/opt/indipenotex`, `/etc/indipenotex`, `/var/lib/indipenotex`, and the system user.

### HTTPS without a domain

For internal LAN use, serve HTTPS directly over the server IP:

```bash
sudo ./install.sh --self-signed-ip 192.168.1.50
```

Browsers will warn until the cert is trusted client-side or your org distributes its own CA. Once a cert works, flip **`auth.https.enforced`** in the admin panel to redirect HTTP and emit HSTS.

### HTTPS with a real domain

```bash
sudo ./install.sh --domain tex.example.com
```

Provisions a Let's Encrypt cert via certbot's standalone mode.

## Configuration model

TeXAbr has two layers, both editable, with the admin panel as the everyday surface:

```
admin panel → settings table (DB)   ▲ overrides
                                    │
external operator → /etc/texabr/config.json
                                    │
                                    ▼ falls back to
                          built-in registry default
```

- `/etc/texabr/config.json` provides the **core file** and **boot-time defaults** for everything else. Static keys like `port`, `host`, `dataDir`, `auth.jwtSecret`, and TLS cert paths live here.
- The admin panel writes to a `settings` table in SQLite. **DB writes win at runtime.**
- Every setting has a "Reset" button that deletes the DB row, falling back to whatever's in `config.json`, and ultimately the built-in default. Each row's `source` (`db` / `config` / `default`) is shown inline.
- Settings tagged `requires restart` need `systemctl restart texabr` to pick up.

### Setting groups (admin panel → Settings)

| Group | What's in it |
|-------|--------------|
| `registration` | Mode (closed/invite/open), password min length |
| `auth` | Session TTL, cookie SameSite, bcrypt cost, force-HTTPS, HSTS max-age |
| `lockout` | Enabled, max attempts, window, cooldown |
| `latex` | Allowed engines, default engine, per-pass timeout, server + per-user concurrency, shell-escape mode |
| `sandbox` | Enabled, CPU seconds, memory cap, output-file cap, max processes |
| `limits` | Max project MB, max file MB, max files per project, per-user disk MB |
| `backup` | Enabled, repo path, password file, schedule, retention |
| `collab` | File-lock TTL |
| `logging` | Level (debug/info/warn/error) |

The static keys still live in `config/default.json`:

| Key | Default | Meaning |
|-----|---------|---------|
| `host` | `0.0.0.0` | Interface to bind |
| `port` | `8217` | HTTP port |
| `https.enabled` | `false` | Serve TLS at this port (otherwise plain HTTP) |
| `https.cert` / `https.key` | `null` | Paths to PEM files |
| `dataDir` | `/var/lib/texabr` | Projects + SQLite + backup snapshots |
| `auth.jwtSecret` | (random per install) | HMAC key for JWTs |
| `auth.bootstrapToken` | (one-shot per install) | First-run admin claim |

## Operations

### Health
```
GET /api/healthz   # liveness — process answering
GET /api/readyz    # readiness — DB ping + dataDir writable + schema migrated
```

### Backups
- Schedule: `texabr-backup.timer`. Edit the timer's `OnCalendar=` (or use a drop-in at `/etc/systemd/system/texabr-backup.timer.d/override.conf`) and `systemctl daemon-reload`.
- One-shot: admin panel → Backup → "Run backup now", or `sudo systemctl start texabr-backup`.
- Restore: admin panel does not auto-restore (too easy to footgun). Use `restic -r <repo> --password-file <pw> restore latest --target /tmp/restore` and copy back manually.

### Audit
- Admin panel → Audit (paginated, filterable by event prefix).
- Same events also appear as JSON lines via `journalctl -u texabr --output=cat | jq`.

### Logs
- `journalctl -u texabr -f` for the live JSON log stream. Set `logging.level=debug` from the panel to see request-level traces; revert to `info` afterwards.

## Security model at a glance

- Auth: cookie-only sessions for browsers. CSRF token in non-httpOnly cookie + `X-CSRF-Token` header on state-changing requests. Login lockout per username + per IP.
- Compile: bwrap user-namespace + prlimit rlimits + `-no-shell-escape`. No network inside the sandbox. Writable scope is the project root only.
- Files: every write goes through `resolveSafe()` (path-traversal check), then the size, file-count, and per-user-quota checks.
- Sessions: server-side revocation by bumping `token_version` on the user row; admin panel exposes "Revoke sessions" per user.

What TeXAbr is **not** doing (be explicit):

- **No real-time collab.** Two simultaneous editors of the same file get a soft single-writer lock; the second sees a 409 with the holder's name. CRDT/OT collab is out of scope for 1.0.
- **No automatic restore.** Backups are written by the timer; recovery is operator-driven.

## Upgrading an already-installed host

After the first `install.sh` run, prefer `scripts/deploy.sh` for subsequent upgrades:

```bash
cd /opt/texabr-src
git pull
sudo ./scripts/deploy.sh
```

The script rsyncs your source over `/opt/texabr/` without touching the existing `dist/` trees, then builds server + client into sibling `dist-new/` directories and atomically swaps them in. If the build crashes mid-way, the running service keeps serving the old bundle. After a successful restart and `/api/healthz` probe, it drops the previous `dist`; on a failed restart it rolls back. It does **not** touch apt packages, the systemd unit, firewall rules, sysctls, or `config.json` — those are install-time concerns.

Re-run the full `install.sh -y` only when you actually need to change those install-time concerns (system packages added, systemd unit rewritten, kernel sysctls revised).

## Troubleshooting

Quick keys to common failures the install + first-compile path can throw at you.

**`bwrap: Can't mount proc on /newroot/proc: Operation not permitted`** — a systemd hardening directive on `texabr.service` is bind-remounting a path under `/proc` (read-only), and the kernel's `mount_too_revealing()` check rejects bwrap's plain `mount("proc")` as "more revealing". Known offenders: `ProtectKernelTunables`, `ProtectKernelLogs`, `ProtectHostname`, `ProtectProc=invisible`, `ProcSubset=pid`. None of these are set by the unit shipped here; if you see this after editing the unit, you re-introduced one of them. Inspect with `nsenter -t $(systemctl show -p MainPID --value texabr) -m findmnt -t proc` — if there's any procfs bind beyond plain `/proc`, that's your culprit.

**`bwrap: Can't read /proc/sys/kernel/overflowuid: No such file or directory`** — `ProcSubset=pid` is set on the unit. bwrap reads that path to populate user-namespace ID maps. Remove the directive.

**Compile times out with `(killed: timeout)` and bwrap leaves a core file** — `SystemCallFilter` is restricting syscalls bwrap needs (typically `capset`). Default action for a filtered syscall is SIGSYS (core dump), not EPERM, so bwrap dies silently inside `drop_all_caps()`. Don't add `SystemCallFilter=` back to this unit.

**`bwrap: setting up uid map: Permission denied` (Ubuntu 24.04+)** — `kernel.apparmor_restrict_unprivileged_userns=1`. The installer's `99-texabr.conf` sets this to 0; if you removed the file or skipped the kernel-sysctl step, restore it: `echo 'kernel.apparmor_restrict_unprivileged_userns = 0' | sudo tee /etc/sysctl.d/99-texabr.conf && sudo sysctl --system`.

**`Error: listen EADDRINUSE: address already in use 0.0.0.0:8217`** — usually a leftover `indipenotex.service` from before the rename. The installer auto-detects and stops it; if you skipped that path: `sudo systemctl disable --now indipenotex.service && sudo systemctl restart texabr`.

**Service is up but the URL won't load from another machine** — firewall. Fedora: `sudo firewall-cmd --permanent --add-port=8217/tcp && sudo firewall-cmd --reload`. Ubuntu (only if ufw is active): `sudo ufw allow 8217/tcp`. The installer does this automatically; re-run if you skipped or interrupted the install.

**SELinux denials on Fedora** — the texabr unit runs as `unconfined_service_t` by default, so denials should be rare. To capture: `sudo ausearch -m AVC -ts recent -c bwrap -i`. If denials show, generate a policy with `audit2allow -M texabr_bwrap` and install with `sudo semodule -i texabr_bwrap.pp`.

**SQLite `database is locked`** — multiple writers via the WAL would normally be fine; if you see this, something else opened the DB file (e.g. an `sqlite3` shell holding a write lock). Close it. Backups via `sqlite3_backup` don't lock the live DB.

**Forgot the bootstrap token** — print a new one and restart: `sudo openssl rand -hex 16 | sudo tee /tmp/bt; sudo jq --arg t "$(cat /tmp/bt)" '.auth.bootstrapToken = $t' /etc/texabr/config.json | sudo tee /etc/texabr/config.json.new && sudo mv /etc/texabr/config.json.new /etc/texabr/config.json && sudo systemctl restart texabr && sudo cat /tmp/bt && sudo rm /tmp/bt`. Only works while no admins exist; once any admin exists, `/api/setup` is closed.

## Repository layout

```
TeXAbr/
├── install.sh                       # one-shot Linux installer + uninstaller
├── server/                          # Node/TypeScript backend
│   ├── src/
│   │   ├── index.ts                 # entrypoint, http(s) bootstrap, --backup-now CLI mode
│   │   ├── config.ts                # config loader + dotted-path reader
│   │   ├── db/
│   │   │   ├── schema.ts            # CREATE IF NOT EXISTS for fresh installs
│   │   │   ├── migrations.ts        # schema-versioned upgrades
│   │   │   ├── settings.ts          # raw KV store
│   │   │   ├── settingsRegistry.ts  # typed registry (DB → config → default)
│   │   │   ├── users.ts / projects.ts / invites.ts
│   │   │   └── db.ts                # initDb() wires the lot
│   │   ├── routes/                  # auth, projects, files, compile, synctex,
│   │   │                            # admin, invites, setup, health, backup
│   │   ├── middleware/              # auth, csrf, forceHttps
│   │   └── services/                # latex, sandbox, compileQueue, quota,
│   │                                # fileLock, lockout, audit, backup,
│   │                                # logger, shutdown, registration, ...
│   └── package.json
├── client/                          # React + Monaco frontend
│   ├── src/
│   │   ├── pages/                   # Login, Register, Setup, Editor, Projects, Admin
│   │   ├── components/              # FileExplorer, Editor, Preview, Terminal, …
│   │   └── api/client.ts            # cookie + CSRF fetch wrapper
│   └── package.json
├── config/default.json              # baseline copied to /etc/texabr/config.json on install
├── systemd/
│   ├── texabr.service
│   ├── texabr-backup.service
│   └── texabr-backup.timer
└── docs/                            # design notes
```

## Differences from Openotex

| Concern | Openotex | TeXAbr |
|---|---|---|
| Runtime | Electron desktop app | Node server + browser client |
| LaTeX engine | Local install on user's PC | Server-side TeX Live |
| Sandbox | None (trusted local user) | bubblewrap + prlimit per compile |
| Storage | Local filesystem | Server filesystem under `dataDir` |
| Multi-user | Single user | Multi-user with auth, ACLs, quotas |
| Network | N/A | LAN/WAN, HTTPS, HSTS, CSRF |
| Backups | User's responsibility | Built-in restic + systemd timer |
| Update model | Electron auto-update | `git pull && sudo ./install.sh` |
| Platforms | Win / macOS / Linux | Linux server (any browser client) |

## Disclaimer

TeXAbr is provided as-is, without warranty. It works well for the deployments we run it on, but every environment is different — vet the configuration, keep the host patched, and operate within your organisation's policies. See [LICENSE](LICENSE) for the binding legal text.

## License

MIT, same as Openotex. See [LICENSE](LICENSE) for the full text.
