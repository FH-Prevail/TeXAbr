import { useState } from "react";

// One-time modal that shows the recovery code returned by the server at
// registration / setup / rotation. Acknowledgement gating: the user must
// tick "I have saved this" before the dismiss button enables. The seed is
// shown in monospace with a hyphenated layout so it's easy to write down,
// and a copy button puts it on the clipboard.
//
// We never store the seed anywhere in the client; it lives only in this
// component's prop and is dropped from state as soon as the user closes.

interface Props {
  seed: string;
  onClose: () => void;
  // What the user is being told. "registration" / "recovery" / "rotation"
  // change the surrounding copy only.
  context: "registration" | "recovery" | "rotation";
}

export function RecoverySeedDialog({ seed, onClose, context }: Props) {
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(seed);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard may be denied in some contexts; user can hand-copy */ }
  }

  const title = context === "registration" ? "Save your recovery code"
    : context === "recovery" ? "Your new recovery code"
    : "New recovery code";

  const intro = context === "registration"
    ? "Write this down or save it in a password manager. It is the only way to recover your account if you forget your password — there is no email reset."
    : context === "recovery"
      ? "Your password has been reset. Here is a fresh recovery code; the old one no longer works. Save this one as carefully as the last."
      : "Save the new code. Your previous code is now invalid.";

  return (
    <div className="about-overlay" onClick={(e) => e.stopPropagation()}>
      <div className="about-dialog" style={{ maxWidth: 540 }} onClick={(e) => e.stopPropagation()}>
        <div className="about-header">
          <h2>{title}</h2>
        </div>
        <div className="about-content">
          <p>{intro}</p>

          <div
            style={{
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 18,
              letterSpacing: 1,
              padding: "16px 18px",
              background: "#f3f4f6",
              border: "1px solid #e5e7eb",
              borderRadius: 8,
              userSelect: "all",
              wordBreak: "break-all",
              textAlign: "center",
              margin: "16px 0",
            }}
          >
            {seed}
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <button onClick={copy}>{copied ? "Copied" : "Copy"}</button>
          </div>

          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 14 }}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              style={{ marginTop: 3 }}
            />
            <span>
              I have saved this code somewhere safe. I understand it will not be shown again
              and that without it I may permanently lose access to my account.
            </span>
          </label>

          <div style={{ marginTop: 20 }}>
            <button className="primary" disabled={!confirmed} onClick={onClose}>
              Continue
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
