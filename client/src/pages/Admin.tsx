import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, Route, Routes } from "react-router-dom";
import {
  api,
  type AdminSettings,
  type AdminUser,
  type AuditEntry,
  type BackupRun,
  type Invite,
  type RegistrationMode,
  type SettingDescriptor,
} from "../api/client";
import { useAuth } from "../api/auth-context";
import { useDocumentTitle } from "../shared/useDocumentTitle";

export function AdminPage() {
  useDocumentTitle("Admin - TeXAbr");
  const { user, logout } = useAuth();
  return (
    <div className="scroll-page layout">
      <div className="topbar">
        <Link to="/" className="brand">TeXAbr</Link>
        <span className="muted">/ Admin</span>
        <span className="grow" />
        <NavLink to="" end>Settings</NavLink>
        <NavLink to="users">Users</NavLink>
        <NavLink to="invites">Invites</NavLink>
        <NavLink to="audit">Audit</NavLink>
        <NavLink to="backup">Backup</NavLink>
        <span className="muted">{user?.username}</span>
        <button onClick={() => logout()}>Sign out</button>
      </div>
      <div style={{ padding: 24, overflow: "auto" }}>
        <Routes>
          <Route index             element={<SettingsTab />} />
          <Route path="users"      element={<UsersTab />} />
          <Route path="invites"    element={<InvitesTab />} />
          <Route path="audit"      element={<AuditTab />} />
          <Route path="backup"     element={<BackupTab />} />
        </Routes>
      </div>
    </div>
  );
}

// ---------- Settings tab (typed registry, grouped) ----------------------------
function SettingsTab() {
  const [defs, setDefs] = useState<SettingDescriptor[] | null>(null);
  const [legacy, setLegacy] = useState<AdminSettings | null>(null);
  const [error, setError] = useState("");

  async function load() {
    try {
      const [r1, r2] = await Promise.all([api.admin.registry(), api.admin.settings()]);
      setDefs(r1.settings); setLegacy(r2);
    } catch (err) { setError((err as Error).message); }
  }
  useEffect(() => { void load(); }, []);

  const groups = useMemo(() => {
    if (!defs) return [];
    const map = new Map<string, SettingDescriptor[]>();
    for (const d of defs) {
      if (!map.has(d.group)) map.set(d.group, []);
      map.get(d.group)!.push(d);
    }
    return [...map.entries()];
  }, [defs]);

  if (!defs || !legacy) return <p>Loading...</p>;

  return (
    <div style={{ maxWidth: 960 }}>
      <h2 style={{ marginTop: 0 }}>Settings</h2>
      <p className="muted">
        Each value is sourced from the database (admin override), the external
        <code> /etc/texabr/config.json</code>, or the built-in default,
        in that order. Reset clears the database override so the file or
        default takes effect.
      </p>

      <p className="error">{error}</p>

      {groups.map(([group, items]) => (
        <section key={group} style={{ margin: "32px 0" }}>
          <h3 style={{ textTransform: "capitalize" }}>{group}</h3>
          <table className="simple">
            <tbody>
              {items.map((d) => (
                <SettingRow key={d.key} def={d} onChanged={load} />
              ))}
            </tbody>
          </table>
        </section>
      ))}

      <section style={{ margin: "32px 0" }}>
        <h3>HTTPS (read-only diagnostics)</h3>
        <p className="muted">
          TLS files come from <code>config.json</code>. Toggle
          <code> auth.https.enforced</code> above to redirect HTTP and emit HSTS.
        </p>
        <table className="simple">
          <tbody>
            <tr><td>Status</td><td>{legacy.https.enabled ? "Enabled" : "Disabled"}</td></tr>
            <tr><td>Cert</td><td><code>{legacy.https.cert ?? "—"}</code></td></tr>
            <tr><td>Key</td><td><code>{legacy.https.key ?? "—"}</code></td></tr>
            <tr><td>Valid to</td><td>{legacy.https.validTo ?? "—"} ({legacy.https.daysRemaining ?? "—"} days)</td></tr>
            <tr><td>Subject</td><td><code>{legacy.https.subject ?? "—"}</code></td></tr>
            <tr><td>Issuer</td><td><code>{legacy.https.issuer ?? "—"}</code></td></tr>
            <tr><td>SHA-256</td><td><code>{legacy.https.fingerprint256 ?? "—"}</code></td></tr>
          </tbody>
        </table>
        {legacy.https.errors.length > 0 && (
          <div className="error">{legacy.https.errors.map((m) => <div key={m}>{m}</div>)}</div>
        )}
      </section>
    </div>
  );
}

function SettingRow({ def, onChanged }: { def: SettingDescriptor; onChanged: () => void }) {
  const [draft, setDraft] = useState<unknown>(def.value);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { setDraft(def.value); }, [def.value]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(def.value);

  async function save() {
    setBusy(true); setErr("");
    try { await api.admin.setSetting(def.key, draft); onChanged(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  async function reset() {
    setBusy(true); setErr("");
    try { await api.admin.resetSetting(def.key); onChanged(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <tr>
      <td style={{ width: "32%", verticalAlign: "top" }}>
        <div><strong>{def.label}</strong></div>
        <div className="muted" style={{ fontSize: 12 }}><code>{def.key}</code></div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{def.description}</div>
        {def.requiresRestart && <div className="muted" style={{ fontSize: 12, color: "#c80" }}>requires restart</div>}
      </td>
      <td style={{ verticalAlign: "top" }}>
        <SettingInput def={def} value={draft} onChange={setDraft} />
        <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center" }}>
          <button className="primary" onClick={save} disabled={!dirty || busy}>{busy ? "..." : "Save"}</button>
          <button onClick={reset} disabled={busy} title="Clear DB override; falls back to config.json or default">Reset</button>
          <span className="muted" style={{ fontSize: 12 }}>source: {def.source}</span>
          {err && <span className="error" style={{ marginLeft: 8 }}>{err}</span>}
        </div>
      </td>
    </tr>
  );
}

function SettingInput({ def, value, onChange }: { def: SettingDescriptor; value: unknown; onChange: (v: unknown) => void }) {
  if (def.secret) {
    return <span className="muted">(secret — set via config.json)</span>;
  }
  switch (def.type) {
    case "bool":
      return (
        <label>
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          <span style={{ marginLeft: 6 }}>{value ? "on" : "off"}</span>
        </label>
      );
    case "int":
      return (
        <input
          type="number"
          value={Number(value ?? 0)}
          min={def.min} max={def.max}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ width: 160 }}
        />
      );
    case "string":
      return (
        <input
          type="text"
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          style={{ width: "100%", minWidth: 280 }}
        />
      );
    case "enum":
      return (
        <select value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          {(def.values ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      );
    case "string[]": {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      return (
        <input
          type="text"
          value={arr.join(",")}
          onChange={(e) => onChange(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
          placeholder="comma-separated"
          style={{ width: "100%", minWidth: 280 }}
        />
      );
    }
    default:
      return <span className="muted">unsupported type</span>;
  }
}

// ---------- Users tab ---------------------------------------------------------
function UsersTab() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [error, setError] = useState("");
  async function load() {
    try { setUsers((await api.admin.users()).users); }
    catch (err) { setError((err as Error).message); }
  }
  useEffect(() => { void load(); }, []);

  async function patch(u: AdminUser, b: { role?: "user" | "admin"; disabled?: boolean }) {
    try { await api.admin.patchUser(u.id, b); void load(); }
    catch (err) { alert((err as Error).message); }
  }
  async function resetPassword(u: AdminUser) {
    const p = prompt(`New password for ${u.username}:`);
    if (!p) return;
    try { await api.admin.resetPassword(u.id, p); alert("password updated"); }
    catch (err) { alert((err as Error).message); }
  }
  async function revoke(u: AdminUser) {
    if (!confirm(`Revoke all sessions for ${u.username}? Their cookies will stop working.`)) return;
    try { await api.admin.revokeSessions(u.id); alert("sessions revoked"); }
    catch (err) { alert((err as Error).message); }
  }
  async function remove(u: AdminUser) {
    if (!confirm(`Delete user ${u.username}? Their projects are removed too.`)) return;
    try { await api.admin.deleteUser(u.id); void load(); }
    catch (err) { alert((err as Error).message); }
  }

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Users</h2>
      <p className="error">{error}</p>
      <table className="simple">
        <thead>
          <tr><th>User</th><th>Email</th><th>Role</th><th>Status</th><th>Last login</th><th></th></tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.username}</td>
              <td>{u.email ?? <span className="muted">—</span>}</td>
              <td>
                <select value={u.role} onChange={(e) => patch(u, { role: e.target.value as "user" | "admin" })}>
                  <option value="user">user</option>
                  <option value="admin">admin</option>
                </select>
              </td>
              <td>
                <button onClick={() => patch(u, { disabled: !u.disabled })}>
                  {u.disabled ? "Enable" : "Disable"}
                </button>
              </td>
              <td>{u.last_login_at ? new Date(u.last_login_at).toLocaleString() : "never"}</td>
              <td style={{ display: "flex", gap: 6 }}>
                <button onClick={() => resetPassword(u)}>Reset pw</button>
                <button onClick={() => revoke(u)}>Revoke sessions</button>
                <button className="danger" onClick={() => remove(u)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Invites tab -------------------------------------------------------
function InvitesTab() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [uses, setUses] = useState(1);
  const [ttlHours, setTtl] = useState<number | "">("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [newInviteLink, setNewInviteLink] = useState("");

  async function load() {
    try { setInvites((await api.invites.list()).invites); }
    catch (err) { setError((err as Error).message); }
  }
  useEffect(() => { void load(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      const result = await api.invites.create({
        uses,
        ttlHours: ttlHours === "" ? null : Number(ttlHours),
        note: note || undefined,
      });
      if (result.invite.token) setNewInviteLink(inviteLink(result.invite.token));
      setNote("");
      void load();
    } catch (err) { setError((err as Error).message); }
  }
  async function remove(i: Invite) {
    if (!confirm("Revoke this invite?")) return;
    await api.invites.delete(i.id);
    void load();
  }
  function inviteLink(token: string) {
    return `${window.location.origin}/register?invite=${encodeURIComponent(token)}`;
  }

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Invites</h2>
      <form onSubmit={create} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label>Uses
          <input type="number" min={1} max={1000} value={uses}
                 onChange={(e) => setUses(Number(e.target.value))}
                 style={{ width: 80, marginLeft: 6 }} />
        </label>
        <label>TTL (hours, blank = never)
          <input type="number" min={1} value={ttlHours}
                 onChange={(e) => setTtl(e.target.value === "" ? "" : Number(e.target.value))}
                 style={{ width: 100, marginLeft: 6 }} />
        </label>
        <input placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
        <button className="primary" type="submit">Generate</button>
      </form>
      {newInviteLink && (
        <div className="project-details" style={{ marginTop: 16 }}>
          <h3>New invite link</h3>
          <p className="muted">This full token is shown once. Existing invites below only show a preview.</p>
          <input readOnly value={newInviteLink} onFocus={(e) => e.currentTarget.select()} style={{ width: "100%" }} />
        </div>
      )}
      <p className="error">{error}</p>

      <table className="simple" style={{ marginTop: 16 }}>
        <thead>
          <tr><th>Token preview</th><th>Uses left</th><th>Consumed</th><th>Expires</th><th>Note</th><th></th></tr>
        </thead>
        <tbody>
          {invites.map((i) => (
            <tr key={i.id}>
              <td><code>{i.token_preview ?? "hidden"}</code></td>
              <td>{i.uses_remaining}</td>
              <td>{i.consumed_count}</td>
              <td>{i.expires_at ? new Date(i.expires_at).toLocaleString() : "never"}</td>
              <td>{i.note ?? <span className="muted">—</span>}</td>
              <td><button className="danger" onClick={() => remove(i)}>Revoke</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Audit tab ---------------------------------------------------------
function AuditTab() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState("");
  const [eventFilter, setEventFilter] = useState("");

  async function load() {
    try {
      const r = await api.admin.audit({ limit: 200, event: eventFilter || undefined });
      setEntries(r.entries);
    } catch (err) { setError((err as Error).message); }
  }
  useEffect(() => { void load(); }, [eventFilter]);

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Audit log</h2>
      <p className="muted">
        Append-only record of security-relevant actions. Same events also appear in
        <code> journalctl -u texabr</code>.
      </p>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          placeholder="filter by event (e.g. auth.login.fail)"
          value={eventFilter}
          onChange={(e) => setEventFilter(e.target.value)}
          style={{ flex: 1, maxWidth: 360 }}
        />
        <button onClick={() => void load()}>Refresh</button>
      </div>
      <p className="error">{error}</p>
      <table className="simple">
        <thead>
          <tr><th>When</th><th>Event</th><th>Actor</th><th>Target</th><th>Outcome</th><th>IP</th><th>Detail</th></tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td>{new Date(e.ts).toLocaleString()}</td>
              <td><code>{e.event}</code></td>
              <td>{e.actor_name ?? <span className="muted">—</span>}</td>
              <td>{e.target ?? <span className="muted">—</span>}</td>
              <td>{e.outcome}</td>
              <td>{e.ip ?? <span className="muted">—</span>}</td>
              <td style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <code title={e.detail ?? ""}>{e.detail ?? ""}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Backup tab --------------------------------------------------------
function BackupTab() {
  const [runs, setRuns] = useState<BackupRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    try { setRuns((await api.admin.backupRuns()).runs); }
    catch (err) { setError((err as Error).message); }
  }
  useEffect(() => { void load(); }, []);

  async function runNow() {
    setBusy(true); setError("");
    try {
      const r = await api.admin.backupNow();
      if (!r.ok) setError(r.error ?? "backup failed");
      void load();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Backups</h2>
      <p className="muted">
        Restic snapshots of <code>dataDir</code> + a SQLite checkpoint. Configure
        <code> backup.enabled</code>, <code>backup.repoPath</code>, and
        <code> backup.scheduleOnCalendar</code> in Settings. The systemd timer
        <code> texabr-backup.timer</code> fires the schedule.
      </p>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button className="primary" onClick={runNow} disabled={busy}>{busy ? "Running..." : "Run backup now"}</button>
        <button onClick={() => void load()}>Refresh</button>
      </div>
      <p className="error">{error}</p>
      <table className="simple">
        <thead>
          <tr><th>Started</th><th>Ended</th><th>Outcome</th><th>Snapshot</th><th>Detail</th></tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.started_at).toLocaleString()}</td>
              <td>{r.ended_at ? new Date(r.ended_at).toLocaleString() : "—"}</td>
              <td>{r.outcome}</td>
              <td><code>{r.snapshot_id ?? "—"}</code></td>
              <td style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <code title={r.detail ?? ""}>{r.detail ?? ""}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
