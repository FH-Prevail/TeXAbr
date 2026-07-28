// Single fetch wrapper. Auth lives in an httpOnly session cookie set by the
// server; the browser sends it automatically because credentials:'include'.
// State-changing requests must echo the CSRF cookie back as a header
// (double-submit pattern) — the cookie is non-httpOnly so we can read it.

function getCsrfToken(): string | null {
  const m = document.cookie.match(/(?:^|; )texabr\.csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (!SAFE_METHODS.has(method)) {
    const csrf = getCsrfToken();
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }

  const res = await fetch(url, {
    method,
    headers,
    credentials: "include",
    // API GETs are live project state, not static assets. Browser/proxy cache
    // reuse can otherwise make a successfully deleted file remain visible.
    cache: SAFE_METHODS.has(method) ? "no-store" : "default",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try { msg = (JSON.parse(text) as { error?: string }).error ?? text; } catch {}
    throw new ApiError(res.status, msg);
  }

  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json() as Promise<T>;
  return res.text() as unknown as T;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export const api = {
  meta:    () => call<MetaResponse>("GET", "/api/meta"),
  setup:   (b: SetupBody)    => call<AuthResponse>("POST", "/api/setup", b),
  login:   (b: LoginBody)    => call<AuthResponse>("POST", "/api/auth/login", b),
  register:(b: RegisterBody) => call<AuthResponse>("POST", "/api/auth/register", b),
  logout:  () => call<{ ok: true }>("POST", "/api/auth/logout"),
  me:      () => call<{ user: User }>("GET", "/api/auth/me"),
  quota:   () => call<QuotaSnapshot>("GET", "/api/auth/quota"),
  recover: (b: { username: string; recoverySeed: string; newPassword: string }) =>
    call<{ ok: true; recoverySeed: string }>("POST", "/api/auth/recover", b),
  rotateSeed: () => call<{ ok: true; recoverySeed: string }>("POST", "/api/auth/rotate-seed"),

  projects: {
    list:   () => call<{ projects: Project[] }>("GET", "/api/projects"),
    create: (b: { name: string; engine?: string }) =>
      call<{ project: Project }>("POST", "/api/projects", b),
    get:    (id: number) => call<{ project: Project }>("GET", `/api/projects/${id}`),
    patch:  (id: number, b: Partial<Pick<Project, "name" | "main_file" | "engine">>) =>
      call<{ project: Project }>("PATCH", `/api/projects/${id}`, b),
    delete: (id: number) => call<{ ok: true }>("DELETE", `/api/projects/${id}`),
    shares: (id: number) => call<{ members: ProjectMember[] }>("GET", `/api/projects/${id}/shares`),
    share:  (id: number, b: { username: string; role: "reader" | "editor" }) =>
      call<{ members: ProjectMember[] }>("POST", `/api/projects/${id}/shares`, b),
    unshare: (id: number, userId: number) =>
      call<{ members: ProjectMember[] }>("DELETE", `/api/projects/${id}/shares/${userId}`),
    history: (id: number) => call<{ history: GitCommit[] }>("GET", `/api/projects/${id}/history`),
    historyFiles: (id: number, hash: string) =>
      call<{ files: string[] }>("GET", `/api/projects/${id}/history/${hash}/files`),
    historyFile: (id: number, hash: string, path: string) =>
      call<{ content: string }>("GET", `/api/projects/${id}/history/${hash}/file?path=${encodeURIComponent(path)}`),
    revertToCommit: (id: number, hash: string) =>
      call<{ ok: true; newHead: string; safetyTag: string; evicted: { rooms: number; sidecars: number } }>(
        "POST", `/api/projects/${id}/history/${hash}/revert`),
    lastGoodCompile: (id: number) =>
      call<{ lastGood: { hash: string; shortHash: string; author: string; timestamp: number; subject: string; isCurrentHead: boolean } | null }>(
        "GET", `/api/projects/${id}/last-good-compile`),
    revertToLastGoodCompile: (id: number) =>
      call<{ ok: true; newHead: string; safetyTag: string; evicted: { rooms: number; sidecars: number }; target: { shortHash: string; timestamp: number; author: string } }>(
        "POST", `/api/projects/${id}/last-good-compile/revert`),
    evictSessions: (id: number) =>
      call<{ ok: true; evicted: { rooms: number; sidecars: number }; epochBumped: number }>(
        "POST", `/api/projects/${id}/evict-sessions`),
    flushRealtime: (id: number) =>
      call<{ ok: true; rooms: number }>("POST", `/api/projects/${id}/flush-realtime`),
    presence: (id: number) => call<{ users: PresenceUser[] }>("GET", `/api/projects/${id}/presence`),
    heartbeat: (id: number) => call<{ ok: true }>("POST", `/api/projects/${id}/presence`),
    getState:  (id: number) => call<{ state: ProjectUiState | null }>("GET", `/api/projects/${id}/state`),
    putState:  (id: number, state: ProjectUiState) =>
      call<{ ok: true }>("PUT", `/api/projects/${id}/state`, { state }),
    proposals: (id: number) => call<{ proposals: ProjectProposal[] }>("GET", `/api/projects/${id}/proposals`),
    createProposal: (id: number, b: { title: string; description?: string }) =>
      call<{ proposal: ProjectProposal }>("POST", `/api/projects/${id}/proposals`, b),
    proposalDiff: (id: number, proposalId: number) =>
      call<{ files: GitDiffFile[] }>("GET", `/api/projects/${id}/proposals/${proposalId}/diff`),
    proposalPatch: (id: number, proposalId: number) =>
      call<string>("GET", `/api/projects/${id}/proposals/${proposalId}/patch`),
    mergeProposal: (id: number, proposalId: number) =>
      call<{ proposal: ProjectProposal }>("POST", `/api/projects/${id}/proposals/${proposalId}/merge`),
    closeProposal: (id: number, proposalId: number) =>
      call<{ proposal: ProjectProposal }>("POST", `/api/projects/${id}/proposals/${proposalId}/close`),
  },

  files: {
    tree:    (id: number, proposalId?: number | null) =>
      call<{ tree: TreeNode[] }>("GET", `/api/files/${id}/tree${proposalQuery(proposalId)}`),
    read:    (id: number, path: string, proposalId?: number | null) =>
      call<{ path: string; content: string }>(
        "GET",
        `/api/files/${id}/content?path=${encodeURIComponent(path)}${proposalParam(proposalId)}`,
      ),
    write:   (id: number, path: string, content: string, proposalId?: number | null, create = false) =>
      call<{ ok: true }>("PUT", `/api/files/${id}/content`, { path, content, proposalId, create }),
    remove:  (id: number, path: string, proposalId?: number | null) =>
      call<{ ok: true }>("DELETE", `/api/files/${id}/entry?path=${encodeURIComponent(path)}${proposalParam(proposalId)}`),
    mkdir:   (id: number, path: string, proposalId?: number | null) =>
      call<{ ok: true }>("POST", `/api/files/${id}/mkdir`, { path, proposalId }),
    rename:  (id: number, from: string, to: string, proposalId?: number | null) =>
      call<{ ok: true }>("POST", `/api/files/${id}/rename`, { from, to, proposalId }),
    copy:    (id: number, sources: string[], destination: string, proposalId?: number | null) =>
      call<{ ok: true }>("POST", `/api/files/${id}/copy`, { sources, destination, proposalId }),
    rawUrl:  (id: number, path: string, proposalId?: number | null) =>
      `/api/files/${id}/raw?path=${encodeURIComponent(path)}${proposalParam(proposalId)}`,
    rawBlob: async (id: number, path: string, proposalId?: number | null): Promise<Blob> => {
      // GET — cookie auth is automatic; CSRF not required for safe methods.
      const res = await fetch(
        `/api/files/${id}/raw?path=${encodeURIComponent(path)}${proposalParam(proposalId)}`,
        { credentials: "include" },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new ApiError(res.status, text);
      }
      return res.blob();
    },
    // Multipart upload of a single binary file. The path passed in becomes the
    // target relative path inside the project (parent dirs are auto-created on
    // the server). Used by FileExplorer's upload buttons and drag-drop handler.
    upload: async (id: number, relPath: string, file: File, proposalId?: number | null): Promise<{ ok: true; path: string }> => {
      const fd = new FormData();
      fd.append("file", file, file.name);
      fd.append("path", relPath);
      if (proposalId) fd.append("proposalId", String(proposalId));
      const csrf = getCsrfToken();
      const headers: Record<string, string> = {};
      if (csrf) headers["X-CSRF-Token"] = csrf;
      const res = await fetch(`/api/files/${id}/upload`, {
        method: "POST",
        credentials: "include",
        headers,
        body: fd,
      });
      if (!res.ok) {
        const text = await res.text();
        let msg = text;
        try { msg = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* keep raw */ }
        throw new ApiError(res.status, msg);
      }
      return res.json() as Promise<{ ok: true; path: string }>;
    },
  },

  compile: (id: number, opts?: { engine?: string; mainFile?: string; proposalId?: number | null }) =>
    call<CompileResult>("POST", `/api/compile/${id}`, opts ?? {}),

  synctex: {
    forward: (id: number, b: { file: string; line: number; column?: number; pdf?: string; proposalId?: number | null }) =>
      call<SynctexForwardResponse>("POST", `/api/synctex/${id}/forward`, b),
    inverse: (id: number, b: { pdf: string; page: number; h: number; v: number; proposalId?: number | null }) =>
      call<SynctexInverseResponse>("POST", `/api/synctex/${id}/inverse`, b),
  },

  invites: {
    list:   () => call<{ invites: Invite[] }>("GET", "/api/invites"),
    create: (b: { uses?: number; ttlHours?: number | null; note?: string }) =>
      call<{ invite: Invite }>("POST", "/api/invites", b),
    delete: (id: number) => call<{ ok: true }>("DELETE", `/api/invites/${id}`),
  },

  admin: {
    settings:    () => call<AdminSettings>("GET", "/api/admin/settings"),
    setRegistration: (b: { mode?: RegistrationMode; open?: boolean; requireInvite?: boolean }) =>
      call<{ ok: true }>("PATCH", "/api/admin/settings/registration", b),
    users:       () => call<{ users: AdminUser[] }>("GET", "/api/admin/users"),
    patchUser:   (id: number, b: { role?: "user" | "admin"; disabled?: boolean }) =>
      call<{ user: AdminUser }>("PATCH", `/api/admin/users/${id}`, b),
    resetPassword: (id: number, password: string) =>
      call<{ ok: true }>("POST", `/api/admin/users/${id}/reset-password`, { password }),
    revokeSessions: (id: number) =>
      call<{ ok: true }>("POST", `/api/admin/users/${id}/revoke-sessions`),
    deleteUser:  (id: number) =>
      call<{ ok: true }>("DELETE", `/api/admin/users/${id}`),

    registry:    () => call<{ settings: SettingDescriptor[] }>("GET", "/api/admin/registry"),
    setSetting:  (key: string, value: unknown) =>
      call<{ ok: true; value: unknown; source: SettingSource }>(
        "PATCH", `/api/admin/registry/${encodeURIComponent(key)}`, { value }),
    resetSetting: (key: string) =>
      call<{ ok: true; value: unknown; source: SettingSource }>(
        "DELETE", `/api/admin/registry/${encodeURIComponent(key)}`),

    audit: (q?: { limit?: number; offset?: number; event?: string; actorId?: number }) => {
      const params = new URLSearchParams();
      if (q?.limit !== undefined) params.set("limit", String(q.limit));
      if (q?.offset !== undefined) params.set("offset", String(q.offset));
      if (q?.event) params.set("event", q.event);
      if (q?.actorId !== undefined) params.set("actorId", String(q.actorId));
      const qs = params.toString();
      return call<{ entries: AuditEntry[] }>("GET", `/api/admin/audit${qs ? `?${qs}` : ""}`);
    },

    lockouts: () => call<{ activeLockouts: number }>("GET", "/api/admin/lockouts"),
    clearLockout: (b: { username?: string; ip?: string }) =>
      call<{ ok: true }>("POST", "/api/admin/lockouts/clear", b),

    backupRuns: () => call<{ runs: BackupRun[] }>("GET", "/api/admin/backup/runs"),
    backupNow:  () => call<{ ok: boolean; runId: number; snapshotId?: string; error?: string; durationMs: number }>(
      "POST", "/api/admin/backup/run"),
  },
};

function proposalQuery(proposalId?: number | null): string {
  return proposalId ? `?proposalId=${encodeURIComponent(String(proposalId))}` : "";
}

function proposalParam(proposalId?: number | null): string {
  return proposalId ? `&proposalId=${encodeURIComponent(String(proposalId))}` : "";
}

// ---------- types ----------
export interface User { id: number; username: string; email: string | null; role: "user" | "admin"; }
export interface AdminUser extends User {
  disabled: boolean; created_at: number; last_login_at: number | null;
}
export interface Project {
  id: number; owner_id: number; slug: string; name: string;
  main_file: string; engine: string; created_at: number; updated_at: number;
  access_role: "owner" | "editor" | "reader"; owner_username: string;
}
export interface ProjectMember {
  project_id: number; user_id: number; username: string; email: string | null;
  role: "reader" | "editor"; created_at: number; updated_at: number;
}
export interface GitCommit {
  hash: string; shortHash: string; author: string; timestamp: number; subject: string;
}
export interface ProjectProposal {
  id: number; project_id: number; created_by: number; creator_username: string;
  title: string; description: string | null; branch_name: string; worktree_path: string;
  status: "open" | "merged" | "closed" | "conflicted";
  created_at: number; updated_at: number; merged_at: number | null; closed_at: number | null;
}
export interface GitDiffFile {
  path: string; status: string; additions: number; deletions: number;
}
export interface MetaResponse {
  app: string; version: string;
  registration: { mode: RegistrationMode; open: boolean; requireInvite: boolean };
  latex: { engines: string[]; defaultEngine: string };
  bootstrapNeeded: boolean;
}
export interface AuthResponse { user: User; recoverySeed?: string; }
export interface ProjectUiState {
  openFiles?: string[];          // relative paths of open editor tabs
  activeFile?: string | null;    // path of the focused tab
  // Reserved for future shape additions (cursor positions, split sizes, …)
  // The server treats this as opaque JSON.
  [key: string]: unknown;
}

export interface PresenceUser {
  user_id: number;
  username: string;
  last_seen: number;
  status: "online" | "idle";
}

export interface QuotaSnapshot {
  usedBytes: number;
  capBytes: number;
  remainingBytes: number;
  capMb: number;
  percent: number;
}
export interface SetupBody    { token: string; username: string; password: string; email?: string; }
export interface LoginBody    { username: string; password: string; }
export interface RegisterBody { username: string; password: string; email?: string; invite?: string; }

export type TreeNode =
  | { type: "dir"; name: string; path: string; children: TreeNode[] }
  | { type: "file"; name: string; path: string; size: number };

export interface CompileResult {
  ok: boolean; engine: string; mainFile: string;
  pdfPath: string | null; log: string; durationMs: number;
}

export interface SynctexForwardResponse {
  success: boolean;
  rects?: Array<{ page: number; h: number; v: number; W: number; H: number }>;
  error?: string;
}
export interface SynctexInverseResponse {
  success: boolean;
  file?: string;
  line?: number;
  column?: number;
  error?: string;
}

export interface Invite {
  id: number; token: string | null; token_preview: string | null; created_by: number;
  uses_remaining: number; expires_at: number | null;
  note: string | null; created_at: number; consumed_count: number;
}

export type RegistrationMode = "closed" | "invite" | "open";

export interface AdminSettings {
  registration: { mode: RegistrationMode; open: boolean; requireInvite: boolean };
  https: {
    enabled: boolean; cert: string | null; key: string | null;
    certExists: boolean; keyExists: boolean; certReadable: boolean; keyReadable: boolean;
    validFrom: string | null; validTo: string | null; daysRemaining: number | null;
    subject: string | null; issuer: string | null; fingerprint256: string | null;
    errors: string[];
  };
}

export type SettingType = "bool" | "int" | "string" | "string[]" | "enum";
export type SettingSource = "db" | "config" | "default";

export interface SettingDescriptor {
  key: string;
  type: SettingType;
  group: string;
  label: string;
  description: string;
  requiresRestart: boolean;
  secret: boolean;
  min?: number;
  max?: number;
  values?: readonly string[];
  default: unknown;
  value: unknown;
  source: SettingSource;
}

export interface AuditEntry {
  id: number; ts: number;
  actor_id: number | null; actor_name: string | null;
  ip: string | null; event: string;
  target: string | null; outcome: "ok" | "denied" | "error";
  detail: string | null;
}

export interface BackupRun {
  id: number; started_at: number; ended_at: number | null;
  outcome: "running" | "success" | "failure";
  bytes: number | null; snapshot_id: string | null; detail: string | null;
}
