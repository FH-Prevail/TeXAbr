import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

// React hook: open / keep / close a y-websocket connection to a single
// (projectId, filePath) collaboration room. Returns the Y.Text the editor
// should bind to plus the Awareness instance for cursor sharing.
//
// Epoch protocol:
//   1. Before opening the WS, fetch the current per-file epoch via HTTP.
//   2. Tag the WS URL with ?epoch=N. The server rejects mismatches with
//      close code 4000 + reason "epoch mismatch".
//   3. On that close, destroy this tab's Y.Doc and the WebsocketProvider,
//      refetch the epoch, and rebuild the room. No window.location.reload,
//      no sessionStorage flags, no per-tab race state — just a small
//      restart of the React effect.
//
// This replaces the older "lockout + fresh=1 + sessionStorage" workaround.
// The epoch is the only thing that decides whether a client's CRDT state
// belongs to the current server-side document generation.

export interface RealtimeFileHandle {
  yText: Y.Text | null;
  doc: Y.Doc | null;
  awareness: WebsocketProvider["awareness"] | null;
  status: "connecting" | "connected" | "disconnected";
}

export function useRealtimeFile(projectId: number | null, filePath: string | null): RealtimeFileHandle {
  const [yText, setYText] = useState<Y.Text | null>(null);
  const [doc, setDoc] = useState<Y.Doc | null>(null);
  const [awareness, setAwareness] = useState<WebsocketProvider["awareness"] | null>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("disconnected");
  // Bumping epochResetNonce restarts the effect, which destroys the existing
  // Y.Doc + provider and rebuilds at the (now-current) epoch. The actual
  // epoch fetch happens inside the effect.
  const [epochResetNonce, setEpochResetNonce] = useState(0);

  const providerRef = useRef<WebsocketProvider | null>(null);

  useEffect(() => {
    if (!projectId || !filePath) {
      setYText(null); setDoc(null); setAwareness(null); setStatus("disconnected");
      return;
    }

    let cancelled = false;
    let provider: WebsocketProvider | null = null;
    let ydoc: Y.Doc | null = null;
    let visibilityHandler: (() => void) | null = null;

    async function fetchEpoch(): Promise<number> {
      const url = `/api/projects/${projectId}/file-epoch?path=${encodeURIComponent(filePath!)}`;
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) throw new Error(`epoch fetch failed: ${r.status}`);
      const j = await r.json() as { epoch: number };
      return j.epoch;
    }

    (async () => {
      let epoch: number;
      try {
        epoch = await fetchEpoch();
      } catch {
        // If the epoch endpoint is unreachable, fall back to 1 — matches the
        // server's default-on-miss behavior so we don't deadlock the editor.
        epoch = 1;
      }
      if (cancelled) return;

      ydoc = new Y.Doc();
      const wsProto = window.location.protocol === "https:" ? "wss" : "ws";
      const serverUrl = `${wsProto}://${window.location.host}/api/projects/${projectId}/files-yjs`;

      provider = new WebsocketProvider(serverUrl, filePath!, ydoc, {
        connect: true,
        params: { epoch: String(epoch) },
      });
      providerRef.current = provider;

      const text = ydoc.getText("content");
      setDoc(ydoc);
      setYText(text);
      setAwareness(provider.awareness);
      setStatus("connecting");

      const onStatus = (e: { status: "connected" | "disconnected" | "connecting" }) => {
        setStatus(e.status === "connected" ? "connected" : e.status === "connecting" ? "connecting" : "disconnected");
      };
      provider.on("status", onStatus);

      // Server close code 4000 means "this client's epoch is stale (or the
      // doc was reset)." Tear down the local Y.Doc + provider entirely and
      // bump epochResetNonce, which restarts this effect from scratch. The
      // fresh effect run refetches the epoch and builds a new room.
      const onClose = (event: CloseEvent | null) => {
        if (event?.code !== 4000) return;
        provider?.off("status", onStatus);
        provider?.off("connection-close", onClose);
        try { provider?.disconnect(); } catch { /* already disconnected */ }
        try { provider?.destroy(); } catch { /* already destroyed */ }
        try { ydoc?.destroy(); } catch { /* already destroyed */ }
        providerRef.current = null;
        setYText(null); setDoc(null); setAwareness(null); setStatus("disconnected");
        setEpochResetNonce((n) => n + 1);
      };
      provider.on("connection-close", onClose);

      // Pause WS while the tab is backgrounded (Chrome throttles WS heartbeats,
      // which used to flap reconnects and leak React state). Resume on visible.
      visibilityHandler = () => {
        if (!provider) return;
        if (document.visibilityState === "hidden") {
          try { provider.disconnect(); } catch { /* already disconnected */ }
        } else {
          try { provider.connect(); } catch { /* already connected */ }
        }
      };
      document.addEventListener("visibilitychange", visibilityHandler);
    })();

    return () => {
      cancelled = true;
      if (visibilityHandler) document.removeEventListener("visibilitychange", visibilityHandler);
      try { provider?.disconnect(); } catch { /* already disconnected */ }
      try { provider?.destroy(); } catch { /* already destroyed */ }
      try { ydoc?.destroy(); } catch { /* already destroyed */ }
      providerRef.current = null;
    };
  }, [projectId, filePath, epochResetNonce]);

  return { yText, doc, awareness, status };
}
