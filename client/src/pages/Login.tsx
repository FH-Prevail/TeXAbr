import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../api/auth-context";
import { api, type MetaResponse } from "../api/client";
import { useDocumentTitle } from "../shared/useDocumentTitle";

export function LoginPage() {
  useDocumentTitle("Sign in - TeXAbr");
  const { user, login } = useAuth();
  const nav = useNavigate();
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { void api.meta().then(setMeta); }, []);
  if (user) return <Navigate to="/" replace />;
  if (meta?.bootstrapNeeded) return <Navigate to="/setup" replace />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(username, password);
      nav("/");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const canRegister = meta && meta.registration.mode !== "closed";

  return (
    <div className="scroll-page center-card">
      <div className="card">
        <h1>TeXAbr</h1>
        <h2>Sign in</h2>
        <form onSubmit={submit}>
          <input
            placeholder="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
          <input
            type="password"
            placeholder="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "..." : "Sign in"}
          </button>
        </form>
        <p className="error">{error}</p>
        <div className="row">
          {canRegister
            ? <Link to="/register">Create an account</Link>
            : <span className="muted">Registration is closed</span>}
          <Link to="/forgot">Forgot password?</Link>
        </div>
      </div>
    </div>
  );
}
