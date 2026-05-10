import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../api/auth-context";
import { api, type MetaResponse } from "../api/client";

// First-run wizard. Consumes the bootstrap token printed by install.sh
// and creates the initial admin account.
export function SetupPage() {
  const { user, refresh } = useAuth();
  const nav = useNavigate();
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [token, setBootstrap] = useState("");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { void api.meta().then(setMeta); }, []);

  if (user) return <Navigate to="/" replace />;
  if (meta && !meta.bootstrapNeeded) return <Navigate to="/login" replace />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.setup({ token, username, password, email: email || undefined });
      await refresh();
      nav("/admin");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="scroll-page center-card">
      <div className="card">
        <h1>First-run setup</h1>
        <h2>Create the initial admin account</h2>
        <form onSubmit={submit}>
          <input
            placeholder="bootstrap token (from install.sh output)"
            value={token}
            onChange={(e) => setBootstrap(e.target.value)}
            autoFocus
          />
          <input
            placeholder="admin username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <input
            placeholder="email (optional)"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            type="password"
            placeholder="password (>= 8 chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "..." : "Create admin"}
          </button>
        </form>
        <p className="error">{error}</p>
      </div>
    </div>
  );
}
