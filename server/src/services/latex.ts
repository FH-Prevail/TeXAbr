import path from "node:path";
import fs from "node:fs/promises";
import type { Config } from "../config";
import type { Db } from "../db/db";
import { FsBoundaryError, mbToBytes, pathSizeBytes, resolveSafe } from "./projects";
import { detectSandbox, spawnSandboxed } from "./sandbox";
import { makeCompileQueue, type CompileQueue } from "./compileQueue";
import { trackProc, untrackProc } from "./shutdown";

export interface CompileResult {
  ok: boolean;
  engine: string;
  mainFile: string;
  pdfPath: string | null;
  log: string;
  durationMs: number;
  sandboxed: boolean;
}

let queue: CompileQueue | null = null;
function getQueue(db: Db): CompileQueue {
  if (!queue) queue = makeCompileQueue(db);
  return queue;
}

export interface CompileOptions {
  engine: string;
  mainFile: string;
  userId: number;
  projectId: number;
}

export async function compile(
  cfg: Config,
  db: Db,
  projectRoot: string,
  opts: CompileOptions,
): Promise<CompileResult> {
  const allowedEngines = db.registry.getStringList("latex.engines");
  if (!allowedEngines.includes(opts.engine)) {
    throw new Error(`engine not allowed: ${opts.engine}`);
  }

  const q = getQueue(db);
  await q.acquire(opts.userId);
  const started = Date.now();

  const sandboxAv = detectSandbox();
  const sandboxOn = db.registry.getBool("latex.sandbox.enabled") && sandboxAv.enabled;

  db.audit.record({
    event: "compile.start",
    actor: { id: opts.userId },
    target: `project:${opts.projectId}`,
    detail: { engine: opts.engine, mainFile: opts.mainFile, sandboxed: sandboxOn },
  });

  try {
    const mainAbs = resolveSafe(projectRoot, opts.mainFile);
    if (mainAbs === path.resolve(projectRoot) || !mainAbs.startsWith(path.resolve(projectRoot) + path.sep)) {
      throw new Error("main file escapes project root");
    }
    const main = path.relative(projectRoot, mainAbs);
    // chdir the engine into the directory that holds the main .tex so that
    // `\input{...}` and `\includegraphics{figures/...}` resolve relative to
    // that file (the conventional LaTeX workflow Overleaf/latexmk/TeXshop
    // all use). Without this, a project laid out as paper/paper.tex with
    // paper/figures/* fails with "file not found" because pdflatex resolves
    // relative paths from CWD = projectRoot.
    const mainDirAbs = path.dirname(mainAbs);
    const mainDirRel = path.relative(projectRoot, mainDirAbs);  // "" or "paper" or "paper/sub"
    const mainBasename = path.basename(mainAbs);

    const shellEscapeMode = db.registry.getEnum("latex.shellEscape");
    const args = [
      "-interaction=nonstopmode",
      "-halt-on-error",
      "-file-line-error",
      shellEscapeMode === "off" ? "-no-shell-escape" : "-shell-restricted",
      "-synctex=1",
      mainBasename,
    ];

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Even with the sandbox these block \write18 pathways and stop TeX from
      // sniffing $HOME for arbitrary aux files. Point both at the working
      // directory (the main file's dir) so auxiliary files land next to the
      // .tex rather than at the project root.
      HOME: mainDirAbs,
      TEXMFOUTPUT: mainDirAbs,
      openout_any: "p",
      openin_any:  "p",
    };

    const timeoutMs = db.registry.getInt("latex.timeoutMs");
    let timer: NodeJS.Timeout | null = null;
    let killedByTimeout = false;
    let activePid: number | undefined;

    const run = async () => {
      const result = await spawnSandboxed(db, {
        projectRoot,
        engine: opts.engine,
        args,
        env,
        cwd: mainDirAbs,
      }, (pid) => {
        activePid = pid;
        trackProc(pid);
        timer = setTimeout(() => {
          killedByTimeout = true;
          if (activePid) {
            try { process.kill(-activePid, "SIGKILL"); }
            catch {
              try { process.kill(activePid, "SIGKILL"); } catch {}
            }
          }
        }, timeoutMs);
      });
      if (timer) clearTimeout(timer);
      untrackProc(activePid);
      return result;
    };

    const r1 = await run();
    let last = r1;
    if (r1.code === 0 && !killedByTimeout) {
      last = await run();
    }

    if (await pathSizeBytes(projectRoot) > mbToBytes(db.registry.getInt("limits.maxProjectMb"))) {
      throw new Error(`project exceeds maxProjectMb (${db.registry.getInt("limits.maxProjectMb")} MB) after compile`);
    }

    // PDF and log land next to the .tex file (in the chdir'd directory).
    // Return paths RELATIVE to projectRoot so the client can fetch them via
    // /api/files/.../raw?path=… without any extra subdir reasoning.
    const baseNoExt = path.basename(mainBasename, path.extname(mainBasename));
    const pdfRel = mainDirRel ? `${mainDirRel}/${baseNoExt}.pdf` : `${baseNoExt}.pdf`;
    const logRel = mainDirRel ? `${mainDirRel}/${baseNoExt}.log` : `${baseNoExt}.log`;
    const pdfAbs = path.join(projectRoot, pdfRel);
    const logAbs = path.join(projectRoot, logRel);

    const pdfExists = await exists(pdfAbs);
    let log = "";
    try {
      log = await fs.readFile(logAbs, "utf8");
    } catch {
      log = last.stderr || (killedByTimeout ? "(killed: timeout)" : "(no log)");
    }

    const result: CompileResult = {
      ok: pdfExists && last.code === 0 && !killedByTimeout,
      engine: opts.engine,
      mainFile: main,
      pdfPath: pdfExists ? pdfRel : null,
      log,
      durationMs: Date.now() - started,
      sandboxed: sandboxOn,
    };

    db.audit.record({
      event: "compile.finish",
      actor: { id: opts.userId },
      target: `project:${opts.projectId}`,
      outcome: result.ok ? "ok" : "error",
      detail: {
        engine: opts.engine,
        durationMs: result.durationMs,
        timedOut: killedByTimeout,
        sandboxed: sandboxOn,
      },
    });

    return result;
  } catch (err) {
    db.audit.record({
      event: "compile.finish",
      actor: { id: opts.userId },
      target: `project:${opts.projectId}`,
      outcome: "error",
      detail: { error: (err as Error).message },
    });
    if (err instanceof FsBoundaryError) {
      throw new Error(err.message);
    }
    throw err;
  } finally {
    q.release(opts.userId);
  }
}

async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
