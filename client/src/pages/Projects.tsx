import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type GitCommit, type GitDiffFile, type Project, type ProjectMember, type ProjectProposal, type QuotaSnapshot } from "../api/client";
import { useAuth } from "../api/auth-context";
import { useDocumentTitle } from "../shared/useDocumentTitle";

export function ProjectsPage() {
  useDocumentTitle("Projects - TeXAbr");
  const { user, logout } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [expandedProjectId, setExpandedProjectId] = useState<number | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [history, setHistory] = useState<GitCommit[]>([]);
  const [proposals, setProposals] = useState<ProjectProposal[]>([]);
  const [proposalDiffs, setProposalDiffs] = useState<Record<number, GitDiffFile[]>>({});
  const [shareUsername, setShareUsername] = useState("");
  const [shareRole, setShareRole] = useState<"reader" | "editor">("reader");
  const nav = useNavigate();

  async function load() {
    try {
      const r = await api.projects.list();
      setProjects(r.projects);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  async function loadQuota() {
    try { setQuota(await api.quota()); } catch { /* silent; surfaces elsewhere when writes fail */ }
  }
  useEffect(() => { void load(); void loadQuota(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const r = await api.projects.create({ name: name.trim() });
      setName("");
      nav(`/p/${r.project.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(p: Project) {
    if (p.access_role !== "owner") return;
    if (!confirm(`Delete "${p.name}"? This is permanent.`)) return;
    await api.projects.delete(p.id);
    void load();
  }

  async function toggleDetails(p: Project) {
    if (expandedProjectId === p.id) {
      setExpandedProjectId(null);
      setMembers([]);
      setHistory([]);
      setProposals([]);
      setProposalDiffs({});
      return;
    }

    setExpandedProjectId(p.id);
    setError("");
    try {
      const [historyResult, proposalResult, memberResult] = await Promise.all([
        api.projects.history(p.id),
        api.projects.proposals(p.id),
        p.access_role === "owner"
          ? api.projects.shares(p.id)
          : Promise.resolve({ members: [] as ProjectMember[] }),
      ]);
      setHistory(historyResult.history);
      setProposals(proposalResult.proposals);
      setMembers(memberResult.members);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function share(p: Project, e: React.FormEvent) {
    e.preventDefault();
    if (!shareUsername.trim()) return;
    try {
      const r = await api.projects.share(p.id, {
        username: shareUsername.trim(),
        role: shareRole,
      });
      setShareUsername("");
      setMembers(r.members);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function unshare(p: Project, userId: number) {
    try {
      const r = await api.projects.unshare(p.id, userId);
      setMembers(r.members);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function loadProposalDiff(project: Project, proposal: ProjectProposal) {
    try {
      const result = await api.projects.proposalDiff(project.id, proposal.id);
      setProposalDiffs((prev) => ({ ...prev, [proposal.id]: result.files }));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function mergeProposal(project: Project, proposal: ProjectProposal) {
    if (!confirm(`Merge "${proposal.title}" into ${project.name}?`)) return;
    try {
      await api.projects.mergeProposal(project.id, proposal.id);
      const r = await api.projects.proposals(project.id);
      setProposals(r.proposals);
      setProposalDiffs({});
      void load();
    } catch (err) {
      setError((err as Error).message);
      const r = await api.projects.proposals(project.id);
      setProposals(r.proposals);
    }
  }

  async function closeProposal(project: Project, proposal: ProjectProposal) {
    if (!confirm(`Close "${proposal.title}"?`)) return;
    try {
      await api.projects.closeProposal(project.id, proposal.id);
      const r = await api.projects.proposals(project.id);
      setProposals(r.proposals);
      setProposalDiffs({});
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="scroll-page layout">
      <div className="topbar">
        <span className="brand">TeXAbr</span>
        <span className="grow" />
        {quota && <StorageMeter q={quota} />}
        <span className="muted">{user?.username}</span>
        {user?.role === "admin" && <Link to="/admin">Admin</Link>}
        <button onClick={() => logout()}>Sign out</button>
      </div>

      <div style={{ padding: 24, overflow: "auto" }}>
        <h2 style={{ marginTop: 0 }}>Your projects</h2>

        <form onSubmit={create} style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <input
            placeholder="New project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ flex: 1, maxWidth: 360 }}
          />
          <button className="primary" type="submit">Create</button>
        </form>

        <p className="error">{error}</p>

        {projects.length === 0 ? (
          <p className="muted">No projects yet. Create one above.</p>
        ) : (
          <table className="simple">
            <thead>
              <tr>
                <th>Name</th>
                <th>Owner</th>
                <th>Access</th>
                <th>Engine</th>
                <th>Updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id}>
                  <td><Link to={`/p/${p.id}`}>{p.name}</Link></td>
                  <td>{p.owner_username ?? (p.owner_id === user?.id ? user?.username : p.owner_id)}</td>
                  <td>{p.access_role}</td>
                  <td>{p.engine}</td>
                  <td>{new Date(p.updated_at).toLocaleString()}</td>
                  <td className="project-actions">
                    <button onClick={() => toggleDetails(p)}>
                      {expandedProjectId === p.id ? "Hide" : "Details"}
                    </button>
                    {p.access_role === "owner" && (
                      <button className="danger" onClick={() => remove(p)}>Delete</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {expandedProjectId !== null && (
          <ProjectDetails
            project={projects.find((p) => p.id === expandedProjectId) ?? null}
            members={members}
            history={history}
            proposals={proposals}
            proposalDiffs={proposalDiffs}
            shareUsername={shareUsername}
            shareRole={shareRole}
            onShareUsernameChange={setShareUsername}
            onShareRoleChange={setShareRole}
            onShare={share}
            onUnshare={unshare}
            onLoadProposalDiff={loadProposalDiff}
            onMergeProposal={mergeProposal}
            onCloseProposal={closeProposal}
          />
        )}
      </div>
    </div>
  );
}

function StorageMeter({ q }: { q: QuotaSnapshot }) {
  const usedMb = (q.usedBytes / 1024 / 1024).toFixed(q.usedBytes < 1024 * 1024 ? 2 : 1);
  // Color the bar by fullness: subtle when low, orange near the cap, red over.
  const color = q.percent >= 100 ? "#dc2626" : q.percent >= 80 ? "#f59e0b" : "#2c8079";
  return (
    <div
      title={`${usedMb} MB used of ${q.capMb} MB (${q.percent}%)`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 12,
        color: "var(--text-muted, #9ca3af)",
        marginRight: 8,
      }}
    >
      <span>Storage</span>
      <div
        style={{
          width: 80,
          height: 8,
          background: "rgba(255,255,255,0.08)",
          borderRadius: 4,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${Math.min(100, q.percent)}%`,
            height: "100%",
            background: color,
            transition: "width 0.3s",
          }}
        />
      </div>
      <span>
        {usedMb}<span className="muted"> / {q.capMb} MB</span>
      </span>
    </div>
  );
}

function ProjectDetails({
  project,
  members,
  history,
  proposals,
  proposalDiffs,
  shareUsername,
  shareRole,
  onShareUsernameChange,
  onShareRoleChange,
  onShare,
  onUnshare,
  onLoadProposalDiff,
  onMergeProposal,
  onCloseProposal,
}: {
  project: Project | null;
  members: ProjectMember[];
  history: GitCommit[];
  proposals: ProjectProposal[];
  proposalDiffs: Record<number, GitDiffFile[]>;
  shareUsername: string;
  shareRole: "reader" | "editor";
  onShareUsernameChange: (value: string) => void;
  onShareRoleChange: (value: "reader" | "editor") => void;
  onShare: (project: Project, e: React.FormEvent) => void;
  onUnshare: (project: Project, userId: number) => void;
  onLoadProposalDiff: (project: Project, proposal: ProjectProposal) => void;
  onMergeProposal: (project: Project, proposal: ProjectProposal) => void;
  onCloseProposal: (project: Project, proposal: ProjectProposal) => void;
}) {
  if (!project) return null;

  return (
    <section className="project-details">
      <div>
        <h3>{project.name}</h3>
        <p className="muted">
          {project.access_role === "owner"
            ? "You own this project."
            : `Shared by ${project.owner_username}.`}
        </p>
        {project.access_role === "owner" && (
          <button
            type="button"
            onClick={async () => {
              const ok = confirm(
                `Force every live editing session for "${project.name}" to reload?\n\n` +
                "Every collaborator's open tab will reload. Use this after you (or an admin) " +
                "made a server-side change and don't want a stale collaborator's CRDT to overwrite it.\n\n" +
                "Tip: new connections will be blocked for 90 seconds, so reconnecting clients also get bounced."
              );
              if (!ok) return;
              try {
                const r = await api.projects.evictSessions(project.id);
                alert(`Reloaded ${r.evicted.rooms} live session(s), cleared ${r.evicted.sidecars} CRDT cache(s). New connections blocked for ${r.lockoutMs / 1000}s.`);
              } catch (err) {
                alert(`Failed: ${(err as Error).message}`);
              }
            }}
            style={{ marginTop: 8 }}
            title="Useful when you've edited the project from outside the editor and need every collaborator's tab to drop its in-memory CRDT and resync from disk."
          >
            Force-reload all live sessions
          </button>
        )}
      </div>

      {project.access_role === "owner" && (
        <div className="project-share">
          <h4>Share access</h4>
          <form onSubmit={(e) => onShare(project, e)}>
            <input
              placeholder="Server username"
              value={shareUsername}
              onChange={(e) => onShareUsernameChange(e.target.value)}
            />
            <select value={shareRole} onChange={(e) => onShareRoleChange(e.target.value as "reader" | "editor")}>
              <option value="reader">Reader</option>
              <option value="editor">Editor</option>
            </select>
            <button className="primary" type="submit">Grant</button>
          </form>

          {members.length === 0 ? (
            <p className="muted">No shared users yet.</p>
          ) : (
            <table className="simple compact">
              <tbody>
                {members.map((m) => (
                  <tr key={m.user_id}>
                    <td>{m.username}</td>
                    <td>{m.role}</td>
                    <td><button onClick={() => onUnshare(project, m.user_id)}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="project-history">
        <h4>Change proposals</h4>
        {proposals.length === 0 ? (
          <p className="muted">No proposals yet.</p>
        ) : (
          <table className="simple compact">
            <tbody>
              {proposals.map((proposal) => (
                <tr key={proposal.id}>
                  <td>{proposal.title}</td>
                  <td>{proposal.creator_username}</td>
                  <td>{proposal.status}</td>
                  <td>
                    {(proposal.status === "open" || proposal.status === "conflicted") && (
                      <button onClick={() => onLoadProposalDiff(project, proposal)}>Diff</button>
                    )}
                    {project.access_role === "owner" && proposal.status === "open" && (
                      <button className="primary" onClick={() => onMergeProposal(project, proposal)}>Merge</button>
                    )}
                    {(proposal.status === "open" || proposal.status === "conflicted") && (
                      <button onClick={() => onCloseProposal(project, proposal)}>Close</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {Object.entries(proposalDiffs).map(([proposalId, files]) => (
          <div className="proposal-summary" key={proposalId}>
            {files.length === 0 ? (
              <p className="muted">No changes in this proposal yet.</p>
            ) : (
              files.map((file) => (
                <div className="proposal-file" key={file.path}>
                  <span className="mono">{file.path}</span>
                  <span className="muted">+{file.additions} -{file.deletions}</span>
                </div>
              ))
            )}
          </div>
        ))}

        <h4>Recent Git history</h4>
        {history.length === 0 ? (
          <p className="muted">No committed changes yet.</p>
        ) : (
          <CommitHistory project={project} history={history} />
        )}
      </div>
    </section>
  );
}

// Browse a commit (any reader+) and, for owners, revert the project to it.
// Clicking a row expands an inline panel with that commit's file tree;
// clicking a file shows its content. Revert tags the prior HEAD as a
// safety net and evicts in-memory CRDT rooms so the live editor reloads
// the post-revert files.
function CommitHistory({ project, history }: { project: Project; history: GitCommit[] }) {
  const [openHash, setOpenHash] = useState<string | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [filesError, setFilesError] = useState("");
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [fileError, setFileError] = useState("");
  const [reverting, setReverting] = useState(false);

  async function toggle(c: GitCommit) {
    if (openHash === c.hash) {
      setOpenHash(null);
      setFiles([]);
      setActiveFile(null);
      setFileContent("");
      setFilesError("");
      setFileError("");
      return;
    }
    setOpenHash(c.hash);
    setActiveFile(null);
    setFileContent("");
    setFilesError("");
    setFileError("");
    try {
      const r = await api.projects.historyFiles(project.id, c.hash);
      setFiles(r.files);
    } catch (err) {
      setFilesError((err as Error).message);
      setFiles([]);
    }
  }

  async function viewFile(hash: string, path: string) {
    setActiveFile(path);
    setFileError("");
    setFileContent("");
    try {
      const r = await api.projects.historyFile(project.id, hash, path);
      setFileContent(r.content);
    } catch (err) {
      setFileError((err as Error).message);
    }
  }

  async function revert(c: GitCommit) {
    const msg = `Revert "${project.name}" to commit ${c.shortHash}?\n\n` +
      `"${c.subject}" by ${c.author} on ${new Date(c.timestamp).toLocaleString()}.\n\n` +
      `Everything committed AFTER this point will be removed from the working tree. ` +
      `The previous state is preserved as a "pre-revert" tag in git, so this is recoverable.`;
    if (!confirm(msg)) return;
    setReverting(true);
    try {
      const r = await api.projects.revertToCommit(project.id, c.hash);
      alert(`Reverted. Safety tag: ${r.safetyTag}\nEvicted ${r.evicted.rooms} live editor sessions; reloading.`);
      window.location.reload();
    } catch (err) {
      alert(`Revert failed: ${(err as Error).message}`);
      setReverting(false);
    }
  }

  return (
    <table className="simple compact">
      <tbody>
        {history.map((c) => (
          <React.Fragment key={c.hash}>
            <tr
              onClick={() => toggle(c)}
              style={{ cursor: "pointer", background: openHash === c.hash ? "rgba(70,130,255,0.08)" : undefined }}
              title="Click to preview files at this commit"
            >
              <td className="mono">{c.shortHash}</td>
              <td>{c.subject}</td>
              <td>{c.author}</td>
              <td>{new Date(c.timestamp).toLocaleString()}</td>
            </tr>
            {openHash === c.hash && (
              <tr>
                <td colSpan={4} style={{ padding: 12, background: "rgba(0,0,0,0.03)" }}>
                  {filesError && <p className="error">{filesError}</p>}
                  <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                    <div style={{ minWidth: 220, maxHeight: 360, overflow: "auto", borderRight: "1px solid rgba(0,0,0,0.08)", paddingRight: 12 }}>
                      <strong style={{ fontSize: 12 }}>Files at {c.shortHash}</strong>
                      {files.length === 0 && !filesError && <p className="muted" style={{ fontSize: 12 }}>(empty tree)</p>}
                      <ul style={{ listStyle: "none", padding: 0, margin: "6px 0 0" }}>
                        {files.map((f) => (
                          <li key={f}>
                            <button
                              onClick={() => viewFile(c.hash, f)}
                              className="mono"
                              style={{
                                background: activeFile === f ? "rgba(70,130,255,0.18)" : "transparent",
                                border: "none", padding: "2px 6px", cursor: "pointer",
                                fontSize: 12, textAlign: "left", width: "100%",
                              }}
                              title={f}
                            >
                              {f}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {project.access_role === "owner" && (
                        <button
                          className="primary"
                          disabled={reverting}
                          onClick={() => revert(c)}
                          style={{ marginBottom: 8 }}
                        >
                          {reverting ? "Reverting…" : `Revert project to ${c.shortHash}`}
                        </button>
                      )}
                      {activeFile ? (
                        <>
                          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                            <span className="mono">{activeFile}</span> at <span className="mono">{c.shortHash}</span>
                          </div>
                          {fileError ? (
                            <p className="error">{fileError}</p>
                          ) : (
                            <pre style={{
                              maxHeight: 320, overflow: "auto", background: "#0e1116", color: "#d4d4d4",
                              padding: 10, fontSize: 12, borderRadius: 4, margin: 0,
                            }}>{fileContent}</pre>
                          )}
                        </>
                      ) : (
                        <p className="muted" style={{ fontSize: 12 }}>Select a file on the left to preview its content at this commit (read-only).</p>
                      )}
                    </div>
                  </div>
                </td>
              </tr>
            )}
          </React.Fragment>
        ))}
      </tbody>
    </table>
  );
}
