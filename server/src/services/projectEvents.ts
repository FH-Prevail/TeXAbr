import type { Request, Response } from "express";

// Server-authoritative project structure events. File contents continue to
// use Yjs; this stream covers metadata that does not belong in a text CRDT:
// create, delete, rename, upload, revert, and other tree-wide resets.
//
// EventSource reconnects automatically. We intentionally do not replay an
// in-memory event log: every new/reconnected subscriber first receives a
// "resync" event and reloads the authoritative tree.

export type ProjectEvent =
  | { type: "resync" }
  | { type: "upsert"; path: string }
  | { type: "delete"; path: string }
  | { type: "rename"; path: string; to: string };

type ProjectEventEnvelope = ProjectEvent & {
  projectId: number;
  revision: number;
};

const subscribers = new Map<number, Set<Response>>();
const revisions = new Map<number, number>();

function nextRevision(projectId: number): number {
  const revision = (revisions.get(projectId) ?? 0) + 1;
  revisions.set(projectId, revision);
  return revision;
}

function send(res: Response, event: ProjectEventEnvelope) {
  res.write(`id: ${event.revision}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function subscribeToProjectEvents(req: Request, res: Response, projectId: number) {
  res.status(200);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-store",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write("retry: 2000\n\n");

  let projectSubscribers = subscribers.get(projectId);
  if (!projectSubscribers) {
    projectSubscribers = new Set();
    subscribers.set(projectId, projectSubscribers);
  }
  projectSubscribers.add(res);

  // A reconnect may have missed any number of events. Full tree reload is the
  // recovery protocol, so there is no stale browser tree to merge.
  send(res, {
    type: "resync",
    projectId,
    revision: revisions.get(projectId) ?? 0,
  });

  const heartbeat = setInterval(() => {
    try { res.write(": keepalive\n\n"); } catch { /* close handler cleans up */ }
  }, 20_000);
  heartbeat.unref();

  req.on("close", () => {
    clearInterval(heartbeat);
    projectSubscribers!.delete(res);
    if (projectSubscribers!.size === 0) subscribers.delete(projectId);
  });
}

export function publishProjectEvent(projectId: number, event: ProjectEvent): number {
  const revision = nextRevision(projectId);
  const envelope = { ...event, projectId, revision } as ProjectEventEnvelope;
  for (const res of subscribers.get(projectId) ?? []) {
    try { send(res, envelope); } catch { /* request close removes it */ }
  }
  return revision;
}
