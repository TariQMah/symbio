import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Download, ExternalLink, File, FileAudio, FileImage, FileText, FileVideo, Folder, FolderOpen, FolderTree, RefreshCw } from "lucide-react";
import { api, openProjectFile, projectFileBlob, type DirEntry, type Project } from "./api";
import { FileViewer, formatSize } from "./files";
import { EmptyState } from "./ui";

// The Explorer tab: the project's folders and files (or a helper's copy, where its branch's work is
// before it's merged), read-only. Folders load when opened; what the server hides (git's internals,
// Symbio's own files, secrets) never shows. Text opens beside the tree, other files open or download.

type Listing = { entries: DirEntry[]; truncated: boolean } | { error: string } | "loading";

const ICONS = { image: FileImage, video: FileVideo, audio: FileAudio, pdf: FileText, markdown: FileText, text: FileText, other: File };

export function Explorer({ project }: { project: Project }) {
  // Whose folder: the project's (null) or a helper's own copy.
  const copies = project.agents.filter((a) => a.branch && a.role !== "coordinator");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [open, setOpen] = useState<Set<string>>(new Set([""]));
  const [selected, setSelected] = useState<{ path: string; entry: DirEntry } | null>(null);

  const load = useCallback(
    (dir: string) => {
      setListings((l) => ({ ...l, [dir]: l[dir] && l[dir] !== "loading" ? l[dir] : "loading" }));
      api
        .fileTree(project.id, dir, agentId)
        .then((r) => setListings((l) => ({ ...l, [dir]: { entries: r.entries, truncated: r.truncated } })))
        .catch((e) => setListings((l) => ({ ...l, [dir]: { error: (e as Error).message } })));
    },
    [project.id, agentId],
  );

  useEffect(() => {
    setListings({});
    setOpen(new Set([""]));
    setSelected(null);
    load("");
  }, [load]);

  const toggle = (dir: string) => {
    const next = new Set(open);
    if (next.has(dir)) next.delete(dir);
    else {
      next.add(dir);
      if (!listings[dir] || "error" in (listings[dir] as object)) load(dir);
    }
    setOpen(next);
  };
  const refresh = () => [...open].forEach(load);

  const renderDir = (dir: string, depth: number): React.ReactNode => {
    const listing = listings[dir];
    const pad = { paddingLeft: 8 + depth * 14 };
    if (!listing || listing === "loading") return <div className="explorer-note" style={pad}>Loading…</div>;
    if ("error" in listing) return <div className="explorer-note explorer-error" style={pad}>{listing.error}</div>;
    if (listing.entries.length === 0) return <div className="explorer-note" style={pad}>{depth === 0 ? "The folder is empty." : "Empty"}</div>;
    return (
      <>
        {listing.entries.map((e) => {
          const p = dir ? `${dir}/${e.name}` : e.name;
          if (e.dir) {
            const isOpen = open.has(p);
            return (
              <div key={p} className="explorer-folder">
                <button className="explorer-item" style={pad} onClick={() => toggle(p)} aria-expanded={isOpen} title={p}>
                  {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  {isOpen ? <FolderOpen size={14} /> : <Folder size={14} />}
                  <span className="grow">{e.name}</span>
                </button>
                {isOpen && renderDir(p, depth + 1)}
              </div>
            );
          }
          const Icon = ICONS[e.kind ?? "other"];
          return (
            <button
              key={p}
              className={`explorer-item file ${selected?.path === p ? "active" : ""}`}
              style={pad}
              onClick={() => setSelected({ path: p, entry: e })}
              title={`${p} · ${formatSize(e.size)}`}
            >
              <span className="explorer-spacer" />
              <Icon size={14} />
              <span className="grow">{e.name}</span>
            </button>
          );
        })}
        {listing.truncated && <div className="explorer-note" style={pad}>Only the first 2000 entries are shown.</div>}
      </>
    );
  };

  return (
    <div className="docs explorer">
      <nav className="docs-list explorer-tree" aria-label="Project files">
        <div className="explorer-head">
          {copies.length > 0 ? (
            <select value={agentId ?? ""} onChange={(e) => setAgentId(e.target.value || null)} aria-label="Whose folder" title="The project folder, or a helper's own copy (its branch, before it's merged)">
              <option value="">Project folder</option>
              {copies.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}'s copy
                </option>
              ))}
            </select>
          ) : (
            <span className="explorer-title grow">Project folder</span>
          )}
          <button className="btn ghost icon xs" onClick={refresh} title="Refresh" aria-label="Refresh">
            <RefreshCw size={13} />
          </button>
        </div>
        {renderDir("", 0)}
      </nav>
      <section className="docs-view explorer-view">
        {selected ? (
          <Preview key={`${agentId}|${selected.path}`} projectId={project.id} agentId={agentId} path={selected.path} entry={selected.entry} />
        ) : (
          <EmptyState icon={<FolderTree size={20} />} title="The project's files">
            Pick a file to see it. This view is read-only: the team does the editing.
          </EmptyState>
        )}
      </section>
    </div>
  );
}

function Preview({ projectId, agentId, path, entry }: { projectId: string; agentId: string | null; path: string; entry: DirEntry }) {
  const [src, setSrc] = useState<string | null>(null);
  const kind = entry.kind ?? "other";
  useEffect(() => {
    if (kind === "image") projectFileBlob(projectId, path, agentId).then(setSrc, () => setSrc(null));
  }, [projectId, path, agentId, kind]);
  if (kind === "markdown" || kind === "text") {
    return (
      <div className="docs-body explorer-body">
        <FileViewer projectId={projectId} rel={path} agentId={agentId} embedded />
      </div>
    );
  }
  const Icon = ICONS[kind];
  return (
    <div className="docs-body explorer-body">
      <div className="explorer-file">
        <div className="explorer-file-head">
          <Icon size={16} className="subtle" />
          <strong className="ellipsis">{path}</strong>
          <span className="small subtle">{formatSize(entry.size)}</span>
          <span className="grow" />
          {kind !== "other" && (
            <button className="btn sm" onClick={() => openProjectFile(projectId, { rel: path, agentId })}>
              <ExternalLink size={13} />
              Open
            </button>
          )}
          <button className="btn ghost sm" onClick={() => openProjectFile(projectId, { rel: path, agentId }, true)}>
            <Download size={13} />
            Download
          </button>
        </div>
        {kind === "image" && src && <img className="explorer-image" src={src} alt={path} />}
        {kind === "other" && <p className="subtle small">Symbio can't show this kind of file; download it to open it on your computer.</p>}
      </div>
    </div>
  );
}
