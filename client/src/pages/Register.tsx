import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../api/auth-context";
import { api, type MetaResponse } from "../api/client";

export function RegisterPage() {
  const { user, register } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState(params.get("invite") ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { void api.meta().then(setMeta); }, []);
  if (user) return <Navigate to="/" replace />;

  const inviteRequired = meta?.registration.mode === "invite";
  const registrationClosed = meta?.registration.mode === "closed";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    if (registrationClosed) {
      setError("Registration is closed.");
      setBusy(false);
      return;
    }
    try {
      await register({ username, password, email: email || undefined, invite: invite || undefined });
      nav("/");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="scroll-page center-card">
      <div className="card">
        <h1>Create account</h1>
        <h2>{registrationClosed ? "Registration closed" : inviteRequired ? "Invite token required" : "Open registration"}</h2>
        <form onSubmit={submit}>
          <input
            placeholder="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
          <input
            placeholder="email (optional)"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
          <input
            type="password"
            placeholder="password (>= 8 chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
          {inviteRequired && (
            <input
              placeholder="invite token"
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
            />
          )}
          <button className="primary" type="submit" disabled={busy || registrationClosed}>
            {busy ? "..." : "Create account"}
          </button>
        </form>
        <p className="error">{error}</p>
        <div className="row">
          <Link to="/login">Have an account? Sign in</Link>
        </div>
      </div>
    </div>
  );
}
