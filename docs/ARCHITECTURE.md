# TeXAbr architecture

This document explains the *shape* of TeXAbr — what each layer is
responsible for, why it is split that way, and where you'd reach to extend it.
It is meant for someone who has read the README and wants to start coding.

## Trust boundaries

```
┌───────────────────────────┐
│  Browser (untrusted)      │
│  • runs React app         │
│  • holds JWT in localStorage + cookie
│  • can never touch the FS directly
└────────────┬──────────────┘
             │ HTTPS
┌────────────▼──────────────┐
│  TeXAbr server       │
│  ┌────────────────────┐   │
│  │ Express API        │   │  ← all auth, validation, rate limiting
│  ├────────────────────┤   │
│  │ Service layer      │   │  ← pure functions: project paths, slugify
│  ├────────────────────┤   │
│  │ Compile worker     │   │  ← spawn pdflatex/xelatex, bounded concurrency
│  ├────────────────────┤   │
│  │ SQLite (WAL)       │   │  ← users, projects, invites, settings
│  ├────────────────────┤   │
│  │ Filesystem         │   │  ← /var/lib/texabr/projects/<uid>/<pid>/
│  └────────────────────┘   │
└───────────────────────────┘
```

Two things deserve special attention:

1. **Path safety.** Every filesystem call goes through `resolveSafe()` in
   [server/src/services/projects.ts](../server/src/services/projects.ts). It
   normalises the user-supplied relative path and then asserts that the
   absolute result still sits under the project root. Without this guard a
   malicious `../../../../etc/passwd` request could read system files.

2. **LaTeX is hostile.** A `.tex` file is a Turing-complete program with
   filesystem access via `\write18` and `\input`. We:
   - launch the compiler with `openin_any=p` and `openout_any=p` (paranoid
     mode — restricts reads/writes to the cwd subtree),
   - never pass `-shell-escape`,
   - override `HOME` so packages can't poke at the daemon user's dotfiles,
   - kill the process with `SIGKILL` after `latex.timeoutMs`,
   - cap concurrent compiles via the in-process semaphore so a classroom
     can't fork-bomb the box.

   This is enough for typical academic LaTeX. If you ever need shell-escape
   (e.g. for `minted`), do it inside a per-compile container — not by
   relaxing these flags globally.

## Data model

| Table     | Purpose                                                        |
|-----------|----------------------------------------------------------------|
| `users`   | username, bcrypt hash, role (`user`/`admin`), disabled flag.   |
| `projects`| owner-scoped projects with engine + main file pointer.         |
| `invites` | tokens with use count + optional expiry; consumed atomically.  |
| `settings`| runtime-mutable settings (admin can flip without a restart).   |

Schema lives in
[server/src/db/schema.ts](../server/src/db/schema.ts). Each table has a tiny
typed wrapper module (`users.ts`, `projects.ts`, ...) that owns its
prepared statements; routes never call `db.prepare(...)` directly.

## Configuration

There are **two** sources of truth:

- `config.json` (file): things that need a service restart. Bind host/port,
  TLS cert paths, JWT secret, dataDir, LaTeX engine list, limits.
- `settings` table (SQLite): things admins flip at runtime. Today that is
  just `registration.open` and `registration.requireInvite`.

The split exists because TLS and the JWT secret cannot safely change at
runtime without restarting connections, but registration policy should be
flippable from the admin UI without SSH.

## Request lifecycle

```
POST /api/compile/42
  → helmet (security headers)
  → cors
  → cookieParser + json body
  → requireAuth middleware       (verifies JWT, loads user)
  → compileRouter handler        (verifies project ownership)
  → ensureProjectDir             (creates dir if first compile)
  → compile()                    (semaphore.acquire, spawn engine, read .log)
  → JSON: { ok, pdfPath, log, durationMs }
```

Errors thrown inside services bubble to Express's default handler (which is
fine for a scaffold). When you flesh this out, replace the trailing
`throw err` blocks in routes with a typed error class + a single error
middleware.

## Extending it

| You want to add...                  | Start here                                          |
|-------------------------------------|-----------------------------------------------------|
| BibTeX / biber pass                 | `services/latex.ts` — extend `compile()` to a small pipeline |
| Real-time collaboration             | `server/src/ws/` (currently empty), use the existing JWT to auth WS connections |
| Project sharing between users       | new `project_collaborators` table + middleware to allow non-owner read/write |
| OAuth / SSO                         | new route under `/api/auth/oauth/*`; reuse `signToken()` |
| Per-user disk quota                 | check `du` inside `files.ts` write paths, store quota on `users` |
| Audit log                           | new `audit_log` table; helper module called from admin routes |
| Containerised compiles              | replace `spawn(opts.engine)` with `spawn("docker", ["run", ...])` |

## Why not Overleaf?

Overleaf is excellent but is a Rails monolith with Mongo, Redis, an active
record translator, real-time CRDT collaboration, and a separate
docker-compose stack to run. TeXAbr is intentionally one Node process,
one SQLite file, one TeX install, one systemd unit. The trade is: no
real-time co-editing yet, and no rich-text mode. Most groups that asked for
"can we just self-host an editor" don't actually need either.
