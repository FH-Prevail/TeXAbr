import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

// React hook: open / keep / close a y-websocket connection to a single
// (projectId, filePath) collaboration room. Returns the Y.Text the editor
// should bind to plus the Awareness instance for cursor sharing in phase 3.
//
// Lifecycle:
//   - When projectId or filePath changes, tear down the previous provider
//     and open a new one against the new room.
//   - Returns nulls during the brief window before the first connect; the
//     editor falls back to its plain-text rendering during that window.
//   - On unmount, disconnects and destroys the doc so server-side
//     last-disconnect persistence kicks in.

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

  // Keep the latest provider around in a ref so unmount cleanup can reach it
  // even if React batches multiple effect runs.
  const providerRef = useRef<WebsocketProvider | null>(null);

  useEffect(() => {
    if (!projectId || !filePath) {
      setYText(null); setDoc(null); setAwareness(null); setStatus("disconnected");
      return;
    }

    const ydoc = new Y.Doc();
    // Build the server URL relative to the current origin so the same code
    // works on http://dev and https://editor.texabr.org. The protocol is
    // upgraded to ws:// or wss:// automatically by WebsocketProvider when
    // we pass an absolute URL — we construct it explicitly.
    const wsProto = window.location.protocol === "https:" ? "wss" : "ws";
    const serverUrl = `${wsProto}://${window.location.host}/api/projects/${projectId}/files-yjs`;
    // y-websocket appends `/${roomName}` to serverUrl. We pass the file's
    // relative path as the room — the server matches anything after
    // /files-yjs/ as the file path, then resolveSafe rejects escapes.
    const provider = new WebsocketProvider(serverUrl, filePath, ydoc, {
      // Cookies are sent automatically; auth happens during the HTTP upgrade.
      connect: true,
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

    // Backgrounded tabs in Chrome throttle timers and WS heartbeats, which
    // makes y-websocket's reconnect loop flap repeatedly. Each flap fires a
    // status event and re-renders, and historically also leaked binding
    // state. Pausing the provider while hidden is also nicer to the server
    // (fewer awareness pings) and the user's battery.
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        try { provider.disconnect(); } catch { /* already disconnected */ }
      } else {
        try { provider.connect(); } catch { /* already connected */ }
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      provider.off("status", onStatus);
      try { provider.disconnect(); } catch { /* already disconnected */ }
      try { provider.destroy(); } catch { /* already destroyed */ }
      try { ydoc.destroy(); } catch { /* already destroyed */ }
      providerRef.current = null;
    };
  }, [projectId, filePath]);

  return { yText, doc, awareness, status };
}
