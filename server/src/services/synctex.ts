import { spawn } from "node:child_process";
import path from "node:path";
import type { Config } from "../config";
import { FsBoundaryError, resolveSafe } from "./projects";

export interface ForwardSearchResult {
  success: boolean;
  rects?: Array<{ page: number; h: number; v: number; W: number; H: number }>;
  error?: string;
}

export interface InverseSearchResult {
  success: boolean;
  file?: string;
  line?: number;
  column?: number;
  error?: string;
}

export async function forwardSearch(
  cfg: Config,
  projectRoot: string,
  inputFile: string,
  line: number,
  column: number,
  pdfFile?: string,
): Promise<ForwardSearchResult> {
  try {
    const inputAbs = resolveSafe(projectRoot, inputFile);
    const inputRel = path.relative(projectRoot, inputAbs);
    const pdfRel = pdfFile ? path.relative(projectRoot, resolveSafe(projectRoot, pdfFile)) : inferPdf(inputRel);

    const out = await runSynctex(cfg, projectRoot, [
      "view",
      "-i",
      `${Math.max(1, line)}:${Math.max(1, column)}:${inputRel}`,
      "-o",
      pdfRel,
    ]);
    const rects = parseForward(out.stdout);
    if (rects.length === 0) {
      return { success: false, error: "No matching PDF location found for this source line." };
    }
    return { success: true, rects };
  } catch (err) {
    return { success: false, error: toPublicError(err) };
  }
}

export async function inverseSearch(
  cfg: Config,
  projectRoot: string,
  pdfFile: string,
  page: number,
  h: number,
  v: number,
): Promise<InverseSearchResult> {
  try {
    const pdfRel = path.relative(projectRoot, resolveSafe(projectRoot, pdfFile));
    const out = await runSynctex(cfg, projectRoot, [
      "edit",
      "-o",
      `${Math.max(1, page)}:${Math.max(0, h)}:${Math.max(0, v)}:${pdfRel}`,
    ]);
    const target = parseInverse(projectRoot, out.stdout);
    if (!target) {
      return { success: false, error: "No matching source line found for this PDF position." };
    }
    return { success: true, ...target };
  } catch (err) {
    return { success: false, error: toPublicError(err) };
  }
}

function inferPdf(inputRel: string): string {
  return `${path.basename(inputRel, path.extname(inputRel))}.pdf`;
}

function runSynctex(
  cfg: Config,
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("synctex", args, {
      cwd,
      env: { ...process.env, HOME: cwd },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("SyncTeX timed out"));
    }, Math.min(cfg.latex.timeoutMs, 10_000));

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || stdout || `synctex exited with code ${code}`));
    });
  });
}

function parseForward(stdout: string): Array<{ page: number; h: number; v: number; W: number; H: number }> {
  const rects: Array<{ page: number; h: number; v: number; W: number; H: number }> = [];
  const blocks = stdout.split(/SyncTeX result begin/g).slice(1);
  for (const block of blocks) {
    const page = numField(block, "Page");
    const h = numField(block, "h") ?? numField(block, "x");
    const v = numField(block, "v") ?? numField(block, "y");
    const W = numField(block, "W") ?? 24;
    const H = numField(block, "H") ?? 12;
    if (page != null && h != null && v != null) {
      rects.push({ page, h, v, W, H });
    }
  }
  return rects;
}

function parseInverse(root: string, stdout: string): { file: string; line: number; column: number } | null {
  const input = strField(stdout, "Input");
  const line = numField(stdout, "Line");
  const column = numField(stdout, "Column") ?? 1;
  if (!input || line == null) return null;

  const absolute = path.isAbsolute(input) ? input : path.resolve(root, input);
  const rel = path.relative(root, absolute);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return { file: rel.replace(/\\/g, "/"), line, column };
}

function strField(text: string, name: string): string | null {
  const match = text.match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() || null;
}

function numField(text: string, name: string): number | null {
  const value = strField(text, name);
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toPublicError(err: unknown): string {
  if (err instanceof FsBoundaryError) return err.message;
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("ENOENT")) {
    return "SyncTeX executable not found. Ask your admin to install the TeX Live SyncTeX tool on the server.";
  }
  return message || "SyncTeX failed.";
}
