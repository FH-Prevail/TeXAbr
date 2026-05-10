import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { Db } from "../db/db";

// Compose the argv that wraps a LaTeX engine in:
//   1. `prlimit` — applies POSIX rlimits before execve so the kernel kills
//      runaway processes (RLIMIT_CPU, RLIMIT_AS, RLIMIT_FSIZE, RLIMIT_NPROC).
//   2. `bwrap`   — namespaces: no network, read-only system tree, writable
//      project root only, private /tmp, /proc, /dev. `--die-with-parent` makes
//      sure the sandbox dies when the parent does (e.g. service restart).
//
// Both tools are looked up at import time. If either is missing we fall back
// to running the engine bare and the boot-time warning tells the admin.
//
// Note: this isolates the compile, not the host — the texabr service
// itself remains unsandboxed beyond the systemd unit hardening.

export interface SandboxOptions {
  projectRoot: string;
  engine: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  // Wall-clock kill switch, applied by the caller via SIGKILL.
}

export interface SandboxAvailability {
  bwrap: string | null;
  prlimit: string | null;
  enabled: boolean;
  reason?: string;
}

let cachedAvailability: SandboxAvailability | null = null;

export function detectSandbox(): SandboxAvailability {
  if (cachedAvailability) return cachedAvailability;
  const bwrap = which("bwrap");
  const prlimit = which("prlimit");
  cachedAvailability = {
    bwrap,
    prlimit,
    enabled: !!bwrap && !!prlimit,
    reason: !bwrap
      ? "bwrap not found on PATH (install bubblewrap)"
      : !prlimit
        ? "prlimit not found on PATH (install util-linux)"
        : undefined,
  };
  return cachedAvailability;
}

export function buildSandboxedCommand(db: Db, opts: SandboxOptions): { cmd: string; argv: string[] } {
  const av = detectSandbox();
  const sandboxOn = db.registry.getBool("latex.sandbox.enabled");

  if (!sandboxOn || !av.enabled) {
    return { cmd: opts.engine, argv: opts.args };
  }

  const cpuSec   = db.registry.getInt("latex.sandbox.cpuSeconds");
  const memMb    = db.registry.getInt("latex.sandbox.memoryMb");
  const fsizeMb  = db.registry.getInt("latex.sandbox.fileSizeMb");
  const nproc    = db.registry.getInt("latex.sandbox.maxProcesses");

  const memBytes   = memMb   * 1024 * 1024;
  const fsizeBytes = fsizeMb * 1024 * 1024;

  // prlimit accepts soft:hard pairs. We pin both to the same value.
  const prlimitArgs = [
    `--cpu=${cpuSec}:${cpuSec}`,
    `--as=${memBytes}:${memBytes}`,
    `--fsize=${fsizeBytes}:${fsizeBytes}`,
    `--nproc=${nproc}:${nproc}`,
    "--",
  ];

  const root = path.resolve(opts.projectRoot);

  // Order matters: bwrap applies mount args left-to-right. Put virtual
  // filesystems (tmpfs, proc, dev) BEFORE binds so a later --tmpfs can never
  // shadow an earlier --bind whose target sits under the same prefix.
  // (If the project root is under /tmp — which it shouldn't be in production —
  // the tmpfs would otherwise hide the bind and bwrap's --chdir would fail.)
  const bwrapArgs = [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--proc", "/proc",
    "--dev",  "/dev",
    "--tmpfs", "/tmp",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/etc", "/etc",
    ...(existsSilently("/lib")    ? ["--ro-bind", "/lib", "/lib"]       : []),
    ...(existsSilently("/lib64")  ? ["--ro-bind", "/lib64", "/lib64"]   : []),
    ...(existsSilently("/bin")    ? ["--ro-bind", "/bin", "/bin"]       : []),
    ...(existsSilently("/sbin")   ? ["--ro-bind", "/sbin", "/sbin"]     : []),
    ...(existsSilently("/var/lib/texmf") ? ["--ro-bind", "/var/lib/texmf", "/var/lib/texmf"] : []),
    "--bind", root, root,
    "--chdir", root,
    // Pin PATH so the engine resolves even when the parent env was sanitised
    // (e.g. `sudo -u texabr` strips PATH; some service managers set a minimal
    // PATH). Without this, bwrap's execvp can fail to find pdflatex.
    "--setenv", "PATH", "/usr/bin:/usr/sbin:/bin:/sbin",
    "--setenv", "HOME", root,
    "--setenv", "TEXMFOUTPUT", root,
    "--setenv", "openout_any", "p",
    "--setenv", "openin_any",  "p",
    "--",
  ];

  return {
    cmd: av.prlimit!,
    argv: [
      ...prlimitArgs,
      av.bwrap!,
      ...bwrapArgs,
      opts.engine,
      ...opts.args,
    ],
  };
}

// Spawn the (possibly-sandboxed) command and return when it exits or the
// caller invokes `kill`. detached:true puts the child in its own process
// group so we can kill the whole tree on timeout.
export function spawnSandboxed(db: Db, opts: SandboxOptions, onSpawn?: (pid: number | undefined) => void): Promise<{ code: number | null; stderr: string; killed: boolean }> {
  const built = buildSandboxedCommand(db, opts);
  return new Promise((resolve) => {
    const child = spawn(built.cmd, built.argv, {
      cwd: opts.projectRoot,
      detached: true,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    onSpawn?.(child.pid);
    let stderr = "";
    let killed = false;
    child.stdout.on("data", () => {});
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code, signal) => {
      if (signal) killed = true;
      resolve({ code, stderr, killed });
    });
  });
}

function which(bin: string): string | null {
  try {
    const out = execFileSync("which", [bin], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

function existsSilently(p: string): boolean {
  try {
    require("node:fs").accessSync(p);
    return true;
  } catch { return false; }
}
