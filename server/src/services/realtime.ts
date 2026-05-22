import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
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

export interface RoomKey {
  projectId: number;
  relPath: string;
}

interface Room {
  key: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  clients: Set<WebSocket>;
  clientIds: Map<WebSocket, number>;   // ws -> Y.Doc clientID for awareness cleanup
  filePath: string;
  saveTimer: NodeJS.Timeout | null;
  log: Logger;
}

export interface RealtimeService {
  // Called from the HTTP upgrade handler after auth + access checks pass.
  handleConnection(ws: WebSocket, filePath: string, key: RoomKey, log: Logger): void;
  // Used by the compile flow to materialise the latest in-memory text to
  // disk before pdflatex sees it. No-op if no room exists.
  flushBeforeCompile(filePath: string): Promise<void>;
  // Inspect: how many rooms are live (admin diagnostics).
  status(): { rooms: number; clients: number };
}

const keyOf = (k: RoomKey) => `${k.projectId}:${k.relPath}`;

export function makeRealtime(rootLog: Logger): RealtimeService {
  const rooms = new Map<string, Room>();

  function createRoom(key: string, filePath: string, log: Logger): Room {
    const doc = new Y.Doc();
    // Seed the doc with current file content. Marked with a special origin
    // so the update listener below doesn't echo this as a "client edit".
    let initial = "";
    try { initial = fs.readFileSync(filePath, "utf8"); } catch { /* file doesn't exist yet, that's fine */ }
    if (initial.length > 0) {
      doc.transact(() => doc.getText("content").insert(0, initial), "server-load");
    }

    const awareness = new awarenessProtocol.Awareness(doc);
    const room: Room = {
      key,
      doc,
      awareness,
      clients: new Set(),
      clientIds: new Map(),
      filePath,
      saveTimer: null,
      log,
    };

    // Broadcast updates to all peers except the origin; also debounce-save.
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "server-load") return;
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
      // Ensure parent dirs exist (e.g. for a brand-new nested path).
      fs.mkdirSync(path.dirname(room.filePath), { recursive: true });
      fs.writeFileSync(room.filePath, text, "utf8");
      room.log.debug("realtime: flushed", { key: room.key, bytes: text.length });
    } catch (err) {
      room.log.warn("realtime: flush failed", { key: room.key, err });
    }
  }

  function destroyRoom(room: Room) {
    rooms.delete(room.key);
    try { room.doc.destroy(); } catch { /* already destroyed */ }
    room.log.info("realtime: room closed", { key: room.key });
  }

  function handleConnection(ws: WebSocket, filePath: string, key: RoomKey, log: Logger) {
    const k = keyOf(key);
    let room = rooms.get(k);
    if (!room) {
      room = createRoom(k, filePath, log.child({ room: k }));
      rooms.set(k, room);
      room.log.info("realtime: room opened", { filePath });
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
            // Track the first awareness client ID we see for this ws so the
            // cleanup on disconnect is precise.
            try {
              const inner = decoding.createDecoder(update);
              const count = decoding.readVarUint(inner);
              if (count > 0) {
                const cid = decoding.readVarUint(inner);
                if (!room!.clientIds.has(ws)) {
                  room!.clientIds.set(ws, cid);
                }
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
      const cid = room!.clientIds.get(ws);
      if (cid !== undefined) {
        awarenessProtocol.removeAwarenessStates(room!.awareness, [cid], "disconnect");
        room!.clientIds.delete(ws);
      }
      if (room!.clients.size === 0) {
        // Last client out: flush synchronously, drop the room. A future
        // join re-hydrates from disk.
        void (async () => {
          await saveNow(room!);
          destroyRoom(room!);
        })();
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

  rootLog.info("realtime: service ready");
  return { handleConnection, flushBeforeCompile, status };
}
