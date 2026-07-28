import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";
import * as encoding from "lib0/encoding";
import { WebSocket } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";

import type { Config } from "../src/config";
import type { Db } from "../src/db/db";
import { migrate } from "../src/db/migrations";
import { schema } from "../src/db/schema";
import { makeFileEpochs } from "../src/services/fileEpoch";
import type { Logger } from "../src/services/logger";
import { makeRealtime } from "../src/services/realtime";

const silentLog: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() { return silentLog; },
};

const testConfig = (dataDir: string): Config => ({
  host: "127.0.0.1",
  port: 8217,
  https: { enabled: false, cert: null, key: null },
  dataDir,
  auth: { jwtSecret: "test-secret", sessionTtlHours: 1, bootstrapToken: null },
  registration: { open: false, requireInvite: false },
  latex: { engines: ["pdflatex"], defaultEngine: "pdflatex", timeoutMs: 1_000, maxConcurrent: 1 },
  limits: { maxProjectMb: 10, maxFileMb: 1 },
  raw: {},
  configPath: "test",
});

test("migration 8 rolls existing implicit and explicit generations forward", () => {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  raw.exec(schema);
  raw.prepare(
    `INSERT INTO users (id, username, password_hash, created_at)
     VALUES (1, 'owner', 'unused', 1)`,
  ).run();
  raw.prepare(
    `INSERT INTO projects (id, owner_id, slug, name, created_at, updated_at)
     VALUES (7, 1, 'project', 'Project', 1, 1)`,
  ).run();
  raw.prepare(
    `INSERT INTO file_epoch (project_id, rel_path, epoch, updated_at)
     VALUES (7, 'changed.tex', 4, 1)`,
  ).run();
  const markApplied = raw.prepare(
    `INSERT INTO schema_version (version, applied_at, name) VALUES (?, 1, 'test')`,
  );
  for (let version = 1; version <= 7; version++) markApplied.run(version);

  migrate(raw, testConfig("/tmp"));

  const baseline = raw.prepare<[number], { epoch: number }>(
    `SELECT epoch FROM project_epoch WHERE project_id = ?`,
  ).get(7);
  const file = raw.prepare<[number, string], { epoch: number }>(
    `SELECT epoch FROM file_epoch WHERE project_id = ? AND rel_path = ?`,
  ).get(7, "changed.tex");
  assert.equal(baseline?.epoch, 2);
  assert.equal(file?.epoch, 5);
  raw.close();
});

test("project-wide epoch bumps include files with no file_epoch row", () => {
  const raw = new Database(":memory:");
  raw.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY);
    CREATE TABLE project_epoch (
      project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      epoch INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE file_epoch (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      rel_path TEXT NOT NULL,
      epoch INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, rel_path)
    );
    INSERT INTO projects (id) VALUES (7);
  `);

  const epochs = makeFileEpochs({ raw } as Db);
  assert.equal(epochs.get(7, "old.tex"), 1);

  assert.equal(epochs.bumpAllInProject(7), 1);
  assert.equal(epochs.get(7, "old.tex"), 2);

  assert.equal(epochs.bump(7, "changed.tex"), 3);
  assert.equal(epochs.bumpAllInProject(7), 2);
  assert.equal(epochs.get(7, "old.tex"), 3);
  assert.equal(epochs.get(7, "changed.tex"), 4);

  raw.close();
});

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent: Uint8Array[] = [];
  closeCode: number | null = null;

  send(data: Uint8Array) {
    this.sent.push(data);
  }

  close(code: number) {
    this.closeCode = code;
  }

  finishClose() {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}

test("an evicted room cannot save stale text from its delayed close event", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "texabr-realtime-test-"));
  const filePath = path.join(dataDir, "projects", "1", "9", "main.tex");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "disk-before", "utf8");

  const realtime = makeRealtime(silentLog, testConfig(dataDir));
  const socket = new FakeSocket();

  realtime.handleConnection(
    socket as unknown as WebSocket,
    filePath,
    { projectId: 9, relPath: "main.tex", epoch: 1 },
    silentLog,
  );

  const staleClient = new Y.Doc();
  staleClient.getText("content").insert(0, "stale-client");
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(staleClient));
  socket.emit("message", Buffer.from(encoding.toUint8Array(enc)));

  assert.equal(realtime.evictFile(9, "main.tex").rooms, 1);
  assert.equal(socket.closeCode, 4000);

  fs.writeFileSync(filePath, "authoritative", "utf8");
  socket.finishClose();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(fs.readFileSync(filePath, "utf8"), "authoritative");
  assert.deepEqual(realtime.status(), { rooms: 0, clients: 0 });

  staleClient.destroy();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("closing a stale room cannot recreate a file deleted on disk", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "texabr-delete-test-"));
  const filePath = path.join(dataDir, "projects", "1", "12", "deleted.tex");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "delete me", "utf8");

  const realtime = makeRealtime(silentLog, testConfig(dataDir));
  const socket = new FakeSocket();
  realtime.handleConnection(
    socket as unknown as WebSocket,
    filePath,
    { projectId: 12, relPath: "deleted.tex", epoch: 1 },
    silentLog,
  );

  fs.rmSync(filePath);
  socket.finishClose();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(fs.existsSync(filePath), false);
  realtime.evictFile(12, "deleted.tex");
  fs.rmSync(dataDir, { recursive: true, force: true });
});
