import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { UserRow } from "../db/users";

const execFileAsync = promisify(execFile);

const DEFAULT_GITIGNORE = `# TeXAbr server/runtime metadata
.metadata/
.openotex-*
*_backups_/
*_timeline_/

# Common LaTeX build products
*.aux
*.bbl
*.bcf
*.blg
*.fls
*.fdb_latexmk
*.log
*.out
*.run.xml
*.synctex.gz
*.toc
`;

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  timestamp: number;
  subject: string;
}

export interface GitDiffFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export async function ensureGitRepo(root: string): Promise<void> {
  try {
    await fs.access(path.join(root, ".git"));
  } catch {
    try {
      await runGit(root, ["init", "--initial-branch=main"]);
    } catch {
      await runGit(root, ["init"]);
      await runGit(root, ["branch", "-M", "main"]).catch(() => {});
    }
    await runGit(root, ["config", "user.name", "TeXAbr"]);
    await runGit(root, ["config", "user.email", "texabr@localhost"]);
  }

  const ignorePath = path.join(root, ".gitignore");
  try {
    await fs.access(ignorePath);
  } catch {
    await fs.writeFile(ignorePath, DEFAULT_GITIGNORE, "utf8");
  }
}

export async function commitProject(root: string, message: string, actor: UserRow): Promise<string | null> {
  await ensureGitRepo(root);
  await runGit(root, ["add", "-A", "--", "."]);
  const status = await runGit(root, ["status", "--porcelain"]);
  if (!status.trim()) return null;

  const safeName = actor.username || `user-${actor.id}`;
  const email = actor.email || `${safeName.replace(/[^a-zA-Z0-9_.-]/g, "_")}@texabr.local`;
  await runGit(root, [
    "-c", `user.name=${safeName}`,
    "-c", `user.email=${email}`,
    "commit",
    "-m", message.slice(0, 200),
  ]);
  return (await runGit(root, ["rev-parse", "HEAD"])).trim();
}

export async function createProposalWorktree(projectRoot: string, worktreeRoot: string, branchName: string): Promise<void> {
  await ensureGitRepo(projectRoot);
  await commitProjectIfNeeded(projectRoot);
  await fs.mkdir(path.dirname(worktreeRoot), { recursive: true });
  await fs.rm(worktreeRoot, { recursive: true, force: true });
  await runGit(projectRoot, ["worktree", "prune"]);
  await runGit(projectRoot, ["worktree", "add", "-b", branchName, worktreeRoot, "HEAD"]);
  await runGit(worktreeRoot, ["config", "user.name", "TeXAbr"]);
  await runGit(worktreeRoot, ["config", "user.email", "texabr@localhost"]);
}

export async function removeProposalWorktree(projectRoot: string, worktreeRoot: string): Promise<void> {
  await ensureGitRepo(projectRoot);
  await runGit(projectRoot, ["worktree", "remove", "--force", worktreeRoot]).catch(async () => {
    await fs.rm(worktreeRoot, { recursive: true, force: true });
  });
  await runGit(projectRoot, ["worktree", "prune"]).catch(() => {});
}

export async function diffProposal(projectRoot: string, branchName: string): Promise<GitDiffFile[]> {
  await ensureGitRepo(projectRoot);
  const out = await runGit(projectRoot, ["diff", "--numstat", "--find-renames", "HEAD..."+branchName, "--"]);
  if (!out.trim()) return [];
  return out.split("\n").filter(Boolean).map((line) => {
    const [addRaw, delRaw, ...pathParts] = line.split("\t");
    return {
      additions: addRaw === "-" ? 0 : Number(addRaw),
      deletions: delRaw === "-" ? 0 : Number(delRaw),
      path: pathParts.join("\t"),
      status: "modified",
    };
  });
}

export async function diffProposalPatch(projectRoot: string, branchName: string): Promise<string> {
  await ensureGitRepo(projectRoot);
  return runGit(projectRoot, ["diff", "--find-renames", "--stat", "--patch", "HEAD..."+branchName, "--"]);
}

export async function mergeProposal(projectRoot: string, branchName: string, actor: UserRow, title: string): Promise<{
  ok: boolean;
  conflict?: string;
}> {
  await ensureGitRepo(projectRoot);
  await commitProjectIfNeeded(projectRoot);

  const safeName = actor.username || `user-${actor.id}`;
  const email = actor.email || `${safeName.replace(/[^a-zA-Z0-9_.-]/g, "_")}@texabr.local`;
  try {
    await runGit(projectRoot, [
      "-c", `user.name=${safeName}`,
      "-c", `user.email=${email}`,
      "merge",
      "--no-ff",
      branchName,
      "-m",
      `Merge proposal: ${title}`.slice(0, 200),
    ]);
    return { ok: true };
  } catch (err) {
    await runGit(projectRoot, ["merge", "--abort"]).catch(() => {});
    return {
      ok: false,
      conflict: String((err as Error & { stderr?: string }).stderr ?? (err as Error).message),
    };
  }
}

export async function deleteBranch(projectRoot: string, branchName: string): Promise<void> {
  await ensureGitRepo(projectRoot);
  await runGit(projectRoot, ["branch", "-D", branchName]).catch(() => {});
}

export async function listHistory(root: string, limit = 30): Promise<GitCommit[]> {
  await ensureGitRepo(root);
  let out = "";
  try {
    out = await runGit(root, [
      "log",
      `--max-count=${Math.max(1, Math.min(limit, 100))}`,
      "--pretty=format:%H%x1f%h%x1f%an%x1f%ct%x1f%s",
    ]);
  } catch (err) {
    const stderr = String((err as Error & { stderr?: string }).stderr ?? "");
    if (stderr.includes("does not have any commits yet") || stderr.includes("bad default revision")) {
      return [];
    }
    throw err;
  }
  if (!out.trim()) return [];
  return out.split("\n").filter(Boolean).map((line) => {
    const [hash, shortHash, author, ts, subject] = line.split("\x1f");
    return {
      hash,
      shortHash,
      author,
      timestamp: Number(ts) * 1000,
      subject,
    };
  });
}

async function commitProjectIfNeeded(root: string): Promise<void> {
  await ensureGitRepo(root);
  const status = await runGit(root, ["status", "--porcelain"]);
  if (!status.trim()) return;
  await runGit(root, ["add", "-A", "--", "."]);
  await runGit(root, ["commit", "-m", "Save pending project changes"]);
}

export async function runGit(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  return stdout;
}
