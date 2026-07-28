// window.api shim
//
// Openotex was built for Electron and talks to its main process via
// `window.api.*`. We reuse the entire renderer in TeXAbr by satisfying
// that exact contract — but every call here is translated into a REST request
// against our own server.
//
// Key idea: TeXAbr is project-scoped (one project per editor URL),
// so the shim holds a `currentProjectId` and synthesises an absolute-looking
// root path (`/__texabr__/<id>`) that Openotex's components can pass
// around as if it were a real filesystem path. The shim strips that prefix
// before hitting the API.

import { api as rest } from "../api/client";

let currentProjectId: number | null = null;
let currentProposalId: number | null = null;
let lastServerPdfPath: string | null = null;
let projectEventSource: EventSource | null = null;

interface FilesystemEvent {
  root: string;
  event: "resync" | "upsert" | "delete" | "rename";
  path?: string;
  to?: string;
  revision?: number;
}

const filesystemListeners = new Set<(payload: FilesystemEvent) => void>();

function emitFilesystemEvent(payload: FilesystemEvent) {
  for (const listener of filesystemListeners) {
    try { listener(payload); } catch { /* one UI listener must not break others */ }
  }
}

export function setShimProject(id: number) {
  if (currentProjectId !== id && projectEventSource) {
    projectEventSource.close();
    projectEventSource = null;
  }
  currentProjectId = id;
  currentProposalId = null;
  lastServerPdfPath = null;
}

export function setShimProposal(id: number | null) {
  currentProposalId = id;
  lastServerPdfPath = null;
}

export function shimProjectRoot(id: number = currentProjectId ?? 0): string {
  return `/__texabr__/${id}`;
}

function pid(): number {
  if (currentProjectId == null) {
    throw new Error("texabr: project id not set on shim");
  }
  return currentProjectId;
}

// Strip the synthetic root from a path, returning the project-relative path.
function rel(p: string): string {
  if (!p) return "";
  p = p.replace(/\\/g, "/").replace(/^[a-zA-Z]:\//, "");
  const root = shimProjectRoot();
  if (p === root) return "";
  if (p.startsWith(root + "/")) return p.slice(root.length + 1);
  if (p.startsWith("/__texabr__/")) {
    throw new Error("path belongs to a different TeXAbr project");
  }
  // Already relative (some callers pass plain "main.tex").
  return p.replace(/^\/+/, "");
}

// Re-exported so non-shim callers (e.g. the realtime collab hook in
// EditorApp) can produce the same project-relative path the REST endpoints
// already see. Avoids the double-prefix bug where the virtual root would
// otherwise be sent verbatim to the server's resolveSafe.
export function shimRelPath(p: string): string { return rel(p); }

// Re-attach the synthetic root so paths stay consistent throughout the UI.
function abs(r: string): string {
  if (!r) return shimProjectRoot();
  if (r.startsWith("/")) return r;
  return `${shimProjectRoot()}/${r}`;
}

// ----------------------------------------------------------------------------
// Path helpers — pure string ops; we don't import node:path in the browser.
// ----------------------------------------------------------------------------

const pathHelpers = {
  basename(p: string, suffix = ""): string {
    const cleaned = p.replace(/\\/g, "/").replace(/\/+$/, "");
    const i = cleaned.lastIndexOf("/");
    const base = i >= 0 ? cleaned.slice(i + 1) : cleaned;
    return suffix && base.endsWith(suffix) ? base.slice(0, -suffix.length) : base;
  },
  dirname(p: string): string {
    const cleaned = p.replace(/\\/g, "/").replace(/\/+$/, "");
    const i = cleaned.lastIndexOf("/");
    if (i < 0) return ".";
    if (i === 0) return "/";
    return cleaned.slice(0, i);
  },
  extname(p: string): string {
    const base = pathHelpers.basename(p);
    const dot = base.lastIndexOf(".");
    if (dot <= 0) return "";
    return base.slice(dot);
  },
  join(...parts: string[]): string {
    const segs: string[] = [];
    let leading = "";
    for (const part of parts) {
      if (!part) continue;
      const cleanPart = part.replace(/\\/g, "/");
      if (segs.length === 0 && cleanPart.startsWith("/")) leading = "/";
      for (const s of cleanPart.split("/")) {
        if (!s || s === ".") continue;
        if (s === "..") segs.pop();
        else segs.push(s);
      }
    }
    return leading + segs.join("/");
  },
};

// ----------------------------------------------------------------------------
// File operations
// ----------------------------------------------------------------------------

async function readFile(filePath: string) {
  try {
    const r = await rest.files.read(pid(), rel(filePath), currentProposalId);
    return { success: true, content: r.content };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

async function readFileBase64(filePath: string) {
  try {
    const blob = await rest.files.rawBlob(pid(), rel(filePath), currentProposalId);
    const b64 = await blobToBase64(blob);
    return { success: true, content: b64, data: b64, mimeType: blob.type };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

async function readBinaryFile(filePath: string) {
  // Openotex callers feed the result back into <img src="data:..."> tags,
  // so a base64 string with mime is the most useful shape.
  return readFileBase64(filePath);
}

async function writeFile(filePath: string, content: string, options?: { create?: boolean }) {
  try {
    await rest.files.write(pid(), rel(filePath), content, currentProposalId, options?.create === true);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

async function createFile(filePath: string) {
  try {
    const relPath = rel(filePath);
    await rest.files.write(pid(), relPath, "", currentProposalId, true);
    if (currentProposalId == null) {
      emitFilesystemEvent({ root: shimProjectRoot(), event: "upsert", path: abs(relPath) });
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

async function deletePath(filePath: string) {
  try {
    const relPath = rel(filePath);
    await rest.files.remove(pid(), relPath, currentProposalId);
    if (currentProposalId == null) {
      emitFilesystemEvent({
        root: shimProjectRoot(),
        event: "delete",
        path: abs(relPath),
      });
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

async function renamePath(oldPath: string, newPath: string) {
  try {
    const from = rel(oldPath);
    const to = rel(newPath);
    await rest.files.rename(pid(), from, to, currentProposalId);
    if (currentProposalId == null) {
      emitFilesystemEvent({
        root: shimProjectRoot(),
        event: "rename",
        path: abs(from),
        to: abs(to),
      });
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

async function createDirectory(dirPath: string) {
  try {
    const relPath = rel(dirPath);
    await rest.files.mkdir(pid(), relPath, currentProposalId);
    if (currentProposalId == null) {
      emitFilesystemEvent({ root: shimProjectRoot(), event: "upsert", path: abs(relPath) });
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

async function copyPaths(sources: string[], destination: string) {
  try {
    await rest.files.copy(
      pid(),
      sources.map(rel),
      rel(destination),
      currentProposalId,
    );
    if (currentProposalId == null) {
      emitFilesystemEvent({ root: shimProjectRoot(), event: "resync" });
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// Upload an arbitrary collection of (file, relPath-inside-the-uploaded-bundle)
// items into a destination directory in the project tree. Used by both the
// "Upload file(s)" button (relPath = file.name) and the "Upload folder"
// button / OS drag-drop (relPath = folder/subdir/file.tex preserving the
// uploaded folder structure).
//
// Returns a per-item outcome list so the caller can surface partial failures
// (e.g. one file rejected by quota).
async function uploadFiles(
  items: Array<{ file: File; relPath: string }>,
  destinationFullPath: string,
): Promise<{ success: boolean; uploaded: number; errors: Array<{ path: string; error: string }> }> {
  const destRel = rel(destinationFullPath);
  const errors: Array<{ path: string; error: string }> = [];
  let uploaded = 0;
  for (const item of items) {
    const joined = [destRel, item.relPath].filter(Boolean).join("/");
    try {
      await rest.files.upload(pid(), joined, item.file, currentProposalId);
      uploaded += 1;
    } catch (err) {
      errors.push({ path: item.relPath, error: (err as Error).message });
    }
  }
  if (currentProposalId == null && uploaded > 0) {
    emitFilesystemEvent({ root: shimProjectRoot(), event: "resync" });
  }
  return { success: errors.length === 0, uploaded, errors };
}

// Fetch a single file's bytes over the authed /raw endpoint and trigger a
// browser download. Used by the file tree's "Download" context-menu action so
// a user can pull one file out of the project without zipping the whole thing.
async function downloadFile(filePath: string) {
  try {
    const blob = await rest.files.rawBlob(pid(), rel(filePath), currentProposalId);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = pathHelpers.basename(filePath) || "download";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

async function readDirectory(dirPath: string) {
  try {
    const r = await rest.files.tree(pid(), currentProposalId);
    const target = rel(dirPath);
    const targetSeg = target ? target.split("/") : [];
    type Tree = typeof r.tree;
    let cursor: Tree | null = r.tree;
    for (const seg of targetSeg) {
      if (!cursor) break;
      const next: Tree[number] | undefined = cursor.find(
        (n) => n.type === "dir" && n.name === seg,
      );
      cursor = next && next.type === "dir" ? next.children : null;
    }
    if (!cursor) return { success: false, error: `not a directory: ${dirPath}` };
    return {
      success: true,
      files: cursor.map((n) => ({
        name: n.name,
        path: abs(target ? `${target}/${n.name}` : n.name),
        isDirectory: n.type === "dir",
      })),
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ----------------------------------------------------------------------------
// Project structure events. Contents use per-file Yjs rooms; create/delete/
// rename/upload are server-authoritative metadata and arrive over one SSE
// stream per editor. EventSource automatically reconnects after network blips,
// and the server starts every connection with a full-tree resync event.
// ----------------------------------------------------------------------------

function watchPath(_root: string) {
  if (currentProjectId == null) {
    return Promise.resolve({ success: false, error: "project id not set" });
  }
  if (projectEventSource) return Promise.resolve({ success: true });

  const source = new EventSource(`/api/projects/${currentProjectId}/events`, {
    withCredentials: true,
  });
  projectEventSource = source;
  source.onmessage = (message) => {
    try {
      // Proposal worktrees are intentionally isolated from the live main
      // project. Main-tree events must not close proposal tabs with the same
      // relative path.
      if (currentProposalId != null) return;
      const event = JSON.parse(message.data) as {
        type: FilesystemEvent["event"];
        path?: string;
        to?: string;
        revision?: number;
      };
      emitFilesystemEvent({
        root: shimProjectRoot(),
        event: event.type,
        path: event.path ? abs(event.path) : undefined,
        to: event.to ? abs(event.to) : undefined,
        revision: event.revision,
      });
    } catch { /* malformed event; the next resync repairs the tree */ }
  };
  return Promise.resolve({ success: true });
}
function unwatchPath() {
  projectEventSource?.close();
  projectEventSource = null;
  return Promise.resolve({ success: true });
}
function onFilesystemEvent(listener: (payload: FilesystemEvent) => void) {
  filesystemListeners.add(listener);
  return () => filesystemListeners.delete(listener);
}

// ----------------------------------------------------------------------------
// Dialogs / system — most don't apply in a browser; stub gracefully.
// ----------------------------------------------------------------------------

function openDirectoryDialog() {
  // Web has no native folder picker that would map onto a server path.
  // Returning canceled is safe — App.tsx already handles a missing folder.
  return Promise.resolve({ canceled: true, filePaths: [] });
}
function getDefaultProjectsDirectory() {
  return Promise.resolve({ success: true, path: shimProjectRoot() });
}
function showInFileBrowser(_p: string) {
  return Promise.resolve({ success: false, error: "not available in self-hosted mode" });
}
function openExternal(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
  return Promise.resolve({ success: true });
}

async function saveZipFile({ defaultPath, data }: { defaultPath: string; data: string }) {
  // Openotex hands us a base64-encoded ZIP. Trigger a browser download.
  try {
    const bytes = base64ToBytes(data);
    // Cast through BlobPart: TS5 narrows Uint8Array.buffer to
    // `ArrayBufferLike` (which can be SharedArrayBuffer); Blob() wants ArrayBuffer.
    const blob = new Blob([bytes as unknown as BlobPart], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = pathHelpers.basename(defaultPath) || "project.zip";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ----------------------------------------------------------------------------
// LaTeX — server runs the real toolchain.
// ----------------------------------------------------------------------------

function checkLatexInstallation() {
  // The whole point of installing on Linux is that LaTeX is right there.
  return Promise.resolve({
    success: true,
    installed: true,
    distribution: "TeX Live (server)",
    version: "TeX Live (server)",
  });
}
function checkPackageInstalled(_packageName: string) {
  return Promise.resolve({ installed: true });
}
function installLatexPackage(_packageName: string) {
  return Promise.resolve({
    success: false,
    error: "Package management runs on the server. Ask your admin to install via tlmgr / dnf / apt.",
  });
}
function openLatexDownload() {
  window.open("https://www.tug.org/texlive/", "_blank", "noopener,noreferrer");
  return Promise.resolve({ success: true });
}

const compilationListeners = new Set<(s: { stage: string; message: string }) => void>();
function onCompilationStatus(listener: (s: { stage: string; message: string }) => void) {
  compilationListeners.add(listener);
  return () => { compilationListeners.delete(listener); };
}
function emitStatus(stage: string, message: string) {
  for (const l of compilationListeners) l({ stage, message });
}

async function compileLatex(
  texFilePath: string,
  engine: "pdflatex" | "xelatex" | "lualatex",
) {
  emitStatus("starting", `Compiling with ${engine}…`);
  try {
    const r = await rest.compile(pid(), { engine, mainFile: rel(texFilePath), proposalId: currentProposalId });
    if (!r.ok) {
      emitStatus("failed", "Compile failed.");
      return {
        success: false,
        error: "Compile failed",
        log: r.log,
        engine: r.engine,
      };
    }

    // Openotex expects a local file:// path it can hand to PDF.js.
    // We can't do that in a browser, so we stream the PDF in via an authed
    // fetch and hand back a blob: URL. Components already accept any URL the
    // <iframe>/PDF.js can load.
    let pdfUrl: string | null = null;
    let pdfData: string | null = null;
    lastServerPdfPath = r.pdfPath;
    if (r.pdfPath) {
      const blob = await rest.files.rawBlob(pid(), r.pdfPath, currentProposalId);
      pdfData = await blobToBase64(blob);
      pdfUrl = URL.createObjectURL(blob);
    }
    emitStatus("done", `Compiled in ${r.durationMs}ms`);
    return {
      success: true,
      pdfPath: pdfUrl,        // a blob: URL
      pdfData,
      log: r.log,
      engine: r.engine,
      durationMs: r.durationMs,
    };
  } catch (err) {
    emitStatus("failed", (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
}

const synctex = {
  forward: async (texFilePath: string, line: number, column: number, pdfPath?: string) => {
    try {
      return await rest.synctex.forward(pid(), {
        file: rel(texFilePath),
        line,
        column,
        pdf: serverPdfPath(pdfPath),
        proposalId: currentProposalId,
      });
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
  inverse: async (pdfPath: string, page: number, h: number, v: number) => {
    try {
      const r = await rest.synctex.inverse(pid(), {
        pdf: serverPdfPath(pdfPath) || "main.pdf",
        page,
        h,
        v,
        proposalId: currentProposalId,
      });
      if (r.success && r.file) {
        return { ...r, file: abs(r.file) };
      }
      return r;
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
};

function serverPdfPath(candidate?: string): string | undefined {
  if (!candidate || candidate.startsWith("blob:")) return lastServerPdfPath ?? undefined;
  return rel(candidate);
}

// ----------------------------------------------------------------------------
// Git terminal — intentionally removed in TeXAbr (multi-user host
// shouldn't expose arbitrary shell access).
// ----------------------------------------------------------------------------

const gitTerminal = {
  start: async (_o?: { cwd?: string }) =>
    ({ success: false, error: "git terminal disabled in TeXAbr" }),
  stop:  async () => ({ success: true }),
  run:   async (_c: string) => ({ success: false, error: "git terminal disabled" }),
  onData: (_l: (data: string) => void) => () => {},
  onExit: (_l: (code: number | null) => void) => () => {},
};

const git = {
  status: async (_o: any) => ({ success: false, error: "git disabled" }),
  commit: async (_o: any) => ({ success: false, error: "git disabled" }),
  pull:   async (_o: any) => ({ success: false, error: "git disabled" }),
  push:   async (_o: any) => ({ success: false, error: "git disabled" }),
  init:   async (_o: any) => ({ success: false, error: "git disabled" }),
  check:  async () => ({ success: false, available: false }),
};

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error);
    r.onload = () => {
      const result = r.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    r.readAsDataURL(blob);
  });
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ----------------------------------------------------------------------------
// Install on window
// ----------------------------------------------------------------------------

export function installShim() {
  const api = {
    readFile, readFileBase64, readBinaryFile,
    writeFile, createFile, deletePath, renamePath,
    readDirectory, createDirectory, copyPaths, uploadFiles,
    saveZipFile, downloadFile,
    watchPath, unwatchPath, onFilesystemEvent,
    openDirectoryDialog, getDefaultProjectsDirectory, showInFileBrowser, openExternal,
    checkLatexInstallation, checkPackageInstalled, installLatexPackage, openLatexDownload,
    compileLatex, onCompilationStatus,
    synctex, gitTerminal, git,
    path: pathHelpers,
  };
  (window as any).api = api;
  return api;
}
