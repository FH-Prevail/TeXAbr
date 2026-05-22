import { useEffect, useState } from "react";
import { api, type PresenceUser } from "../api/client";

// Small "who else is here" indicator for a shared project. Polls
// /api/projects/:id/presence every 30s (which also doubles as a heartbeat
// for the current viewer). Renders nothing if you're alone in the project,
// so it stays out of your way when there's nothing to show.
//
// Hover any circle for username + status. The list shrinks naturally as
// collaborators close their tab (server treats >5 min idle as offline).

const POLL_INTERVAL_MS = 30_000;

function initialsFor(name: string): string {
  const parts = name.split(/[.\s_-]+/).filter(Boolean);
  if (parts.length === 0) return name.slice(0, 2).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

// Deterministic colour from username so each user keeps the same circle
// background across reloads.
function colourFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 45%, 40%)`;
}

function describe(u: PresenceUser): string {
  const ms = Date.now() - u.last_seen;
  if (u.status === "online") return `${u.username} · online`;
  if (ms < 120_000) return `${u.username} · just idle`;
  return `${u.username} · idle ${Math.round(ms / 60_000)}m`;
}

interface Props {
  projectId: number;
}

export function PresenceBadge({ projectId }: Props) {
  const [users, setUsers] = useState<PresenceUser[]>([]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function tick() {
      // Skip while tab is hidden: don't burn requests when the user isn't
      // looking, and don't bump our own last_seen so others see us go idle.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        const r = await api.projects.presence(projectId);
        if (!cancelled) setUsers(r.users);
      } catch { /* silent; transient network errors shouldn't nag */ }
    }

    void tick();
    timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [projectId]);

  if (users.length === 0) return null;

  return (
    <div
      className="presence-badge"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        marginLeft: "auto",
        fontSize: 12,
        color: "var(--text-muted, #9ca3af)",
      }}
      aria-label="Collaborators currently viewing this project"
    >
      <span style={{ marginRight: 4 }}>With you:</span>
      <div style={{ display: "flex" }}>
        {users.slice(0, 5).map((u, i) => (
          <div
            key={u.user_id}
            title={describe(u)}
            style={{
              width: 22,
              height: 22,
              marginLeft: i === 0 ? 0 : -6,
              borderRadius: "50%",
              background: colourFor(u.username),
              border: "2px solid var(--bg, #1a1a1a)",
              color: "white",
              fontSize: 10,
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
              opacity: u.status === "idle" ? 0.55 : 1,
              userSelect: "none",
            }}
          >
            {initialsFor(u.username)}
            <span
              style={{
                position: "absolute",
                bottom: -1,
                right: -1,
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: u.status === "online" ? "#22c55e" : "#9ca3af",
                border: "1.5px solid var(--bg, #1a1a1a)",
              }}
            />
          </div>
        ))}
        {users.length > 5 && (
          <span style={{ marginLeft: 6 }}>+{users.length - 5}</span>
        )}
      </div>
    </div>
  );
}
