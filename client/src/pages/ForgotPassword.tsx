import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { RecoverySeedDialog } from "../components/RecoverySeedDialog";
import { useDocumentTitle } from "../shared/useDocumentTitle";

// Recover access using the one-time recovery code shown at registration.
// On success the server resets the password, bumps token_version (revoking
// every other session for this user), and returns a fresh recovery code
// that we present in the same one-shot modal as registration uses.

export function ForgotPasswordPage() {
  useDocumentTitle("Reset password - TeXAbr");
  const nav = useNavigate();
  const [username, setUsername] = useState("");
  const [seed, setSeed] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [nextSeed, setNextSeed] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api.recover({ username, recoverySeed: seed, newPassword });
      setNextSeed(r.recoverySeed);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="scroll-page center-card">
      <div className="card">
        <h1>Reset password</h1>
        <h2>Use your recovery code</h2>
        <p className="muted" style={{ fontSize: 13 }}>
          Paste the recovery code you saved at registration. We'll set a new
          password, sign you out everywhere else, and give you a fresh
          recovery code to save.
        </p>
        <form onSubmit={submit}>
          <input
            placeholder="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
          <input
            placeholder="recovery code (XXXX-XXXX-...)"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
          />
          <input
            type="password"
            placeholder="new password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
          />
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "..." : "Reset password"}
          </button>
        </form>
        <p className="error">{error}</p>
        <div className="row">
          <Link to="/login">Back to sign in</Link>
        </div>
      </div>

      {nextSeed && (
        <RecoverySeedDialog
          seed={nextSeed}
          context="recovery"
          onClose={() => { setNextSeed(null); nav("/login"); }}
        />
      )}
    </div>
  );
}
