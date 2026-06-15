import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { Config } from "../config";
import type { Logger } from "./logger";

// Per-(project, file) collaborative editing rooms backed by Yjs. The wire
// protocol matches what y-websocket clients (and `y-protocols/{sync,awareness}`)
// expect, so we don't need a custom client-side adapter — `WebsocketProvider`
// from y-websocket talks to this directly.
//
// Persistence model:
//   - On first join, load the file from disk into the room's Y.Doc.
//   - On every update from any client, schedule a debounced save (~2s of
//     inactivity) and broadcast the update to the other clients.
//   - When the last client disconnects, do a final synchronous flush, drop
//     the room from memory. Next connection re-hydrates from disk.
//
// Auth (cookie + JWT + project access) and URL routing are handled by the
// caller (server/src/index.ts upgrade hook); this module is the protocol
// engine.

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const SAVE_DEBOUNCE_MS = 2_000;
// How long to keep a room alive in memory after the last client disconnects.
// Briefly reconnecting clients (e.g. tab refresh, mobile network blip) find
// the same Y.Doc and avoid a re-hydrate roundtrip — and avoid the rare race
// where the disk write hasn't fully landed before the room is recreated.
const GRACE_PERIOD_MS = 60_000;
// Symbol so the "this update came from disk-seeding, don't echo it" check
// can never collide with a string origin that arrived legitimately from
// y-protocols' readSyncMessage (which uses the originating WebSocket as
// the transaction origin).
const ORIGIN_SERVER_LOAD = Symbol("server-load");

// Sidecar path for the binary CRDT state. We hash the absolute file path so
// the sidecar tree never reflects user-visible paths (no need to mirror
// project structure, no path-traversal surface). Lives under dataDir/yjs-state/
// so restic backups cover it for free.
function sidecarPathFor(cfg: Config, filePath: string): string {
  const hash = crypto.createHash("sha256").update(filePath).digest("hex");
  return path.join(cfg.dataDir, "yjs-state", `${hash}.bin`);
}

export interface RoomKey {
  projectId: number;
  relPath: string;
}

interface Room {
  key: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  clients: Set<WebSocket>;
  // Multiple awareness clientIds may belong to the same socket (a peer can
  // publish state on behalf of itself plus echoed-back peers in one update).
  // Track the full set so we clean up every state on disconnect.
  clientIds: Map<WebSocket, Set<number>>;
  filePath: string;
  sidecarPath: string;
  saveTimer: NodeJS.Timeout | null;
  // Pending destruction after a grace period when the last client left.
  // Cancelled if any client rejoins within GRACE_PERIOD_MS.
  graceTimer: NodeJS.Timeout | null;
  log: Logger;
}

export interface RealtimeService {
  // Called from the HTTP upgrade handler after auth + access checks pass.
  handleConnection(ws: WebSocket, filePath: string, key: RoomKey, log: Logger): void;
  // Used by the compile flow to materialise the latest in-memory text to
  // disk before pdflatex sees it. No-op if no room exists.
  flushBeforeCompile(filePath: string): Promise<void>;
  // Tear down every room for a project and delete its CRDT sidecars.
  // Used by the revert flow so the in-memory CRDT doesn't re-stamp the
  // pre-revert content over the freshly-reset working tree. Disconnects
  // all attached clients so they reconnect into a fresh room hydrated
  // from disk. Returns the number of rooms destroyed and sidecars removed.
  evictProject(projectId: number): { rooms: number; sidecars: number };
  // Lock the project out for N ms: any new WS upgrade for the project
  // gets force-closed with code 4000 (which triggers a client-side
  // window.location.reload via useRealtimeFile, dropping the local
  // Y.Doc). Used together with evictProject when a server-side edit
  // would otherwise be over-stamped by a stale client's CRDT on
  // reconnect.
  setLockout(projectId: number, durationMs: number): void;
  isLockedOut(projectId: number): boolean;
  // Inspect: how many rooms are live (admin diagnostics).
  status(): { rooms: number; clients: number };
}

const keyOf = (k: RoomKey) => `${k.projectId}:${k.relPath}`;

function walkFiles(dir: string, visit: (abs: string) => void): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, visit);
    else if (e.isFile()) visit(full);
  }
}

export function makeRealtime(rootLog: Logger, cfg: Config): RealtimeService {
  const rooms = new Map<string, Room>();
  // Per-project lockout window: while now < lockoutUntil[pid], every
  // incoming WS upgrade for that project gets closed with code 4000 so
  // the client reloads with a fresh Y.Doc. Used by setLockout, checked
  // by handleConnection.
  const lockoutUntil = new Map<number, number>();

  function createRoom(key: string, filePath: string, log: Logger): Room {
    const doc = new Y.Doc();
    const scPath = sidecarPathFor(cfg, filePath);

    // Hydration order: binary CRDT sidecar first (preserves the full doc
    // history so a reconnecting client's local CRDT items merge cleanly
    // against server state), then plain text as a fallback for first-time
    // opens / projects uploaded via HTTP without a sidecar yet.
    let hydratedFromBin = false;
    try {
      const bin = fs.readFileSync(scPath);
      if (bin.length > 0) {
        doc.transact(() => Y.applyUpdate(doc, new Uint8Array(bin)), ORIGIN_SERVER_LOAD);
        hydratedFromBin = true;
        log.info("realtime: hydrated room from sidecar", { sidecar: scPath, bytes: bin.length });
      }
    } catch { /* missing or unreadable — fall through to plain-text seed */ }

    if (!hydratedFromBin) {
      let initial = "";
      try { initial = fs.readFileSync(filePath, "utf8"); } catch { /* file doesn't exist yet */ }
      if (initial.length > 0) {
        doc.transact(() => doc.getText("content").insert(0, initial), ORIGIN_SERVER_LOAD);
      }
    }

    const awareness = new awarenessProtocol.Awareness(doc);
    const room: Room = {
      key,
      doc,
      awareness,
      clients: new Set(),
      clientIds: new Map(),
      filePath,
      sidecarPath: scPath,
      saveTimer: null,
      graceTimer: null,
      log,
    };

    // Broadcast updates to all peers except the origin; also debounce-save.
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === ORIGIN_SERVER_LOAD) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeUpdate(enc, update);
      const msg = encoding.toUint8Array(enc);
      for (const peer of room.clients) {
        if (peer !== origin && peer.readyState === WebSocket.OPEN) {
          try { peer.send(msg); } catch { /* peer disconnected mid-broadcast */ }
        }
      }
      scheduleSave(room);
    });

    awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        const changed = added.concat(updated, removed);
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
        const msg = encoding.toUint8Array(enc);
        for (const peer of room.clients) {
          if (peer !== origin && peer.readyState === WebSocket.OPEN) {
            try { peer.send(msg); } catch { /* peer disconnected */ }
          }
        }
      },
    );

    return room;
  }

  function scheduleSave(room: Room) {
    if (room.saveTimer) clearTimeout(room.saveTimer);
    room.saveTimer = setTimeout(() => {
      void saveNow(room);
    }, SAVE_DEBOUNCE_MS);
  }

  async function saveNow(room: Room) {
    if (room.saveTimer) {
      clearTimeout(room.saveTimer);
      room.saveTimer = null;
    }
    const text = room.doc.getText("content").toString();
    try {
      // Plain text: what pdflatex, backup tools, and external viewers read.
      fs.mkdirSync(path.dirname(room.filePath), { recursive: true });
      fs.writeFileSync(room.filePath, text, "utf8");

      // Binary CRDT state: what re-hydrates the room next time someone opens
      // this file. Preserves item identity / vector clocks so a reconnecting
      // client's local edits merge cleanly against server state instead of
      // being treated as fresh items against a plain-text-seeded doc.
      fs.mkdirSync(path.dirname(room.sidecarPath), { recursive: true });
      const update = Y.encodeStateAsUpdate(room.doc);
      fs.writeFileSync(room.sidecarPath, Buffer.from(update));

      room.log.debug("realtime: flushed", {
        key: room.key, bytes: text.length, sidecarBytes: update.length,
      });
    } catch (err) {
      room.log.warn("realtime: flush failed", { key: room.key, err });
    }
  }

  function scheduleDestroy(room: Room) {
    if (room.graceTimer) clearTimeout(room.graceTimer);
    room.log.info("realtime: room idle, scheduling destruction", {
      key: room.key, graceMs: GRACE_PERIOD_MS,
    });
    room.graceTimer = setTimeout(() => {
      // Race: a client may have re-joined during the grace window.
      if (room.clients.size > 0) {
        room.log.info("realtime: grace expired but clients present; keeping room", { key: room.key });
        room.graceTimer = null;
        return;
      }
      void (async () => {
        await saveNow(room);
        destroyRoom(room);
      })();
    }, GRACE_PERIOD_MS);
  }

  function cancelDestroy(room: Room) {
    if (room.graceTimer) {
      clearTimeout(room.graceTimer);
      room.graceTimer = null;
      room.log.info("realtime: grace cancelled by re-join", { key: room.key });
    }
  }

  function destroyRoom(room: Room) {
    rooms.delete(room.key);
    // awareness.destroy() unregisters timers and listeners; do it first so
    // the doc destruction below can't leave dangling awareness state.
    try { room.awareness.destroy(); } catch { /* already destroyed */ }
    try { room.doc.destroy(); } catch { /* already destroyed */ }
    room.log.info("realtime: room closed", { key: room.key });
  }

  function handleConnection(ws: WebSocket, filePath: string, key: RoomKey, log: Logger) {
    // Lockout check: if the project was recently force-evicted (manual
    // disk edit, or the post-deploy startup hook), refuse the connection
    // and tell the client to reload. After reload its local Y.Doc is
    // gone and the next connect attempt sees clean state.
    if (isLockedOut(key.projectId)) {
      log.info("realtime: connection refused — project locked out", { projectId: key.projectId });
      try { ws.close(4000, "project reset — please reload"); } catch { /* already closed */ }
      return;
    }
    const k = keyOf(key);
    let room = rooms.get(k);
    if (!room) {
      room = createRoom(k, filePath, log.child({ room: k }));
      rooms.set(k, room);
      room.log.info("realtime: room opened", { filePath });
    } else {
      // A client may rejoin during the post-last-disconnect grace window;
      // cancel the pending destruction so we keep the in-memory CRDT state
      // instead of falling back to disk hydration.
      cancelDestroy(room);
    }
    room.clients.add(ws);

    // Track this ws's awareness client ID so we can clean up on disconnect.
    // Awareness uses Y.Doc clientID; each connection gets its own, set by
    // the client when it pushes its first awareness state.
    ws.on("message", (data: Buffer) => {
      try {
        const arr = new Uint8Array(data);
        const decoder = decoding.createDecoder(arr);
        const messageType = decoding.readVarUint(decoder);

        switch (messageType) {
          case MESSAGE_SYNC: {
            const enc = encoding.createEncoder();
            encoding.writeVarUint(enc, MESSAGE_SYNC);
            // syncProtocol.readSyncMessage uses ws as the transactionOrigin
            // for any update it applies — that's how our doc.on('update')
            // listener above identifies the originating client.
            syncProtocol.readSyncMessage(decoder, enc, room!.doc, ws);
            if (encoding.length(enc) > 1) {
              ws.send(encoding.toUint8Array(enc));
            }
            break;
          }
          case MESSAGE_AWARENESS: {
            const update = decoding.readVarUint8Array(decoder);
            // Track every clientId that this socket announces. A single
            // awareness update can carry multiple clientIds; we record them
            // all so the disconnect cleanup removes every state the socket
            // owns, not just the first one we noticed.
            try {
              const inner = decoding.createDecoder(update);
              const count = decoding.readVarUint(inner);
              let bag = room!.clientIds.get(ws);
              if (!bag) { bag = new Set(); room!.clientIds.set(ws, bag); }
              for (let i = 0; i < count; i++) {
                const cid = decoding.readVarUint(inner);
                bag.add(cid);
                // Skip the rest of this client's entry (clock + state JSON).
                decoding.readVarUint(inner);       // clock
                decoding.readVarString(inner);     // state JSON
              }
            } catch { /* malformed awareness update — drop */ }
            awarenessProtocol.applyAwarenessUpdate(room!.awareness, update, ws);
            break;
          }
          default:
            // Unknown message type. The protocol is small; ignore unknown
            // tags to allow forward-compat with future client extensions.
            break;
        }
      } catch (err) {
        room!.log.warn("realtime: message decode failed", { err });
      }
    });

    ws.on("close", () => {
      room!.clients.delete(ws);
      const ids = room!.clientIds.get(ws);
      if (ids && ids.size > 0) {
        awarenessProtocol.removeAwarenessStates(room!.awareness, Array.from(ids), "disconnect");
      }
      room!.clientIds.delete(ws);
      if (room!.clients.size === 0) {
        // Last client out: persist immediately, then schedule destruction
        // after the grace period. A reconnect within that window reuses
        // the same Y.Doc instance (preserves clientIDs + vector clocks).
        void saveNow(room!).then(() => scheduleDestroy(room!));
      }
    });

    ws.on("error", (err) => {
      room!.log.warn("realtime: ws error", { err });
    });

    // Send initial sync-step-1 so the client can reply with everything it has.
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(enc, room.doc);
    ws.send(encoding.toUint8Array(enc));

    // Also send any existing awareness states so a late joiner immediately
    // sees other people's cursors.
    const awStates = room.awareness.getStates();
    if (awStates.size > 0) {
      const enc2 = encoding.createEncoder();
      encoding.writeVarUint(enc2, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        enc2,
        awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(awStates.keys())),
      );
      ws.send(encoding.toUint8Array(enc2));
    }
  }

  function evictProject(projectId: number): { rooms: number; sidecars: number } {
    let rooms_evicted = 0;
    let sidecars_removed = 0;
    const prefix = `${projectId}:`;
    const victims: Room[] = [];
    for (const room of rooms.values()) {
      if (room.key.startsWith(prefix)) victims.push(room);
    }
    for (const room of victims) {
      // Cancel any pending grace-destroy timer so we don't double-fire.
      if (room.graceTimer) { clearTimeout(room.graceTimer); room.graceTimer = null; }
      if (room.saveTimer) { clearTimeout(room.saveTimer); room.saveTimer = null; }
      // Close any attached sockets so clients reconnect into the fresh room.
      for (const ws of room.clients) {
        try { ws.close(4000, "project reverted"); } catch { /* already closed */ }
      }
      // Drop the sidecar so the next open hydrates from disk (= the new
      // post-revert content), not from the pre-revert CRDT state.
      try {
        fs.unlinkSync(room.sidecarPath);
        sidecars_removed++;
      } catch { /* may not exist yet */ }
      destroyRoom(room);
      rooms_evicted++;
    }
    // Also scan the on-disk sidecar dir for any other paths that belonged to
    // this project but had no live room. We can't reverse the sha256, so we
    // enumerate every file currently on disk under <dataDir>/projects/*/<id>/
    // and delete the sidecars whose hashes match those paths.
    try {
      // Owner ID is encoded in the room key when available, but we may have
      // no live rooms left for the project (orphan sidecars from prior
      // sessions). Walk the projects tree for all owners and find the
      // <id>/<projectId> directory.
      const projectsRoot = path.join(cfg.dataDir, "projects");
      for (const ownerDir of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
        if (!ownerDir.isDirectory()) continue;
        const projectDir = path.join(projectsRoot, ownerDir.name, String(projectId));
        if (!fs.existsSync(projectDir)) continue;
        walkFiles(projectDir, (abs) => {
          const side = sidecarPathFor(cfg, abs);
          try {
            fs.unlinkSync(side);
            sidecars_removed++;
          } catch { /* no sidecar for this path */ }
        });
        break;
      }
    } catch (err) {
      rootLog.warn("evictProject: orphan-sidecar sweep failed", { err, projectId });
    }
    rootLog.info("realtime: project evicted", { projectId, rooms: rooms_evicted, sidecars: sidecars_removed });
    return { rooms: rooms_evicted, sidecars: sidecars_removed };
  }

  async function flushBeforeCompile(filePath: string): Promise<void> {
    // Find any room that backs this file and flush it. Lookup is by absolute
    // path since the room key is project-scoped while the compile flow knows
    // only the resolved fs path.
    for (const room of rooms.values()) {
      if (room.filePath === filePath) {
        await saveNow(room);
        return;
      }
    }
  }

  function status() {
    let clients = 0;
    for (const r of rooms.values()) clients += r.clients.size;
    return { rooms: rooms.size, clients };
  }

  function setLockout(projectId: number, durationMs: number): void {
    lockoutUntil.set(projectId, Date.now() + durationMs);
    rootLog.info("realtime: lockout set", { projectId, durationMs });
  }

  function isLockedOut(projectId: number): boolean {
    const until = lockoutUntil.get(projectId);
    if (!until) return false;
    if (Date.now() >= until) {
      lockoutUntil.delete(projectId);
      return false;
    }
    return true;
  }

  // Post-deploy startup hook: read a marker file written by the admin
  // CLI flow ("after I edit something on disk, evict everyone"). Lockout
  // the listed project IDs for 90s so the very first client that
  // reconnects after the service restart gets force-reloaded — instead
  // of re-stamping its stale Y.Doc onto the freshly-edited disk content.
  // Marker is deleted after read so the lockout doesn't fire on every
  // subsequent boot.
  try {
    const marker = path.join(cfg.dataDir, ".evict-on-start-projects");
    const raw = fs.readFileSync(marker, "utf8");
    // Each token: "<projectId>" (defaults to 1h) or "<projectId>:<seconds>".
    // 90s was too short — by the time a collaborator actually opened a tab
    // the lockout had already expired, and their stale Y.Doc reasserted
    // itself. 1h covers normal working-day timescales.
    const tokens = raw.split(/[\s,]+/).filter(Boolean);
    const applied: { id: number; durationMs: number }[] = [];
    for (const tok of tokens) {
      const [idStr, secStr] = tok.split(":");
      const id = Number(idStr);
      if (!Number.isInteger(id) || id <= 0) continue;
      const seconds = Number(secStr);
      const durationMs = (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000;
      setLockout(id, durationMs);
      applied.push({ id, durationMs });
    }
    if (applied.length) rootLog.info("realtime: post-restart lockouts applied from marker", { applied });
    fs.unlinkSync(marker);
  } catch { /* no marker — normal startup */ }

  rootLog.info("realtime: service ready");
  return { handleConnection, flushBeforeCompile, evictProject, setLockout, isLockedOut, status };
}

// Module-level singleton so the compile flow can call flushBeforeCompile()
// from latex.ts without threading a service handle through every route.
// index.ts calls initRealtime once at boot; everything else uses
// getRealtime() (returns null if not yet initialised, e.g. in tests).
let _instance: RealtimeService | null = null;
export function initRealtime(log: Logger, cfg: Config): RealtimeService {
  if (_instance) return _instance;
  _instance = makeRealtime(log, cfg);
  return _instance;
}
export function getRealtime(): RealtimeService | null {
  return _instance;
}
