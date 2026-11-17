import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { ArrowLeft, ArrowRight, FolderOpen, FolderPlus, Plus } from "lucide-react";
import { api, subscribe, type DocsLocation, type Inspection, type Project, type ProjectConnection, type RuntimeInfo, type RuntimeKind, type RuntimeView } from "./api";
import { RuntimeCards, useRuntimes } from "./Runtimes";
import { ConnectionsPicker } from "./ConnectionsPicker";
import { FolderSummary } from "./FolderSummary";
import { FolderBrowser } from "./FolderBrowser";
import { ModelPicker, choiceBody, type ModelChoice } from "./ModelPicker";
import { ProjectMenu } from "./ProjectMenu";
import { Avatar, Dialog, EmptyState, timeAgo } from "./ui";

function baseName(p: string) {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

export function Home({ runtime, create }: { runtime: RuntimeInfo | null; create?: boolean }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const load = () =>
      api
        .projects()
        .then(setProjects)
        .catch(() => setProjects([]));
    load();
    return subscribe((e) => {
      if (e.type === "project.updated" || e.type === "agent.status") load();
    });
  }, []);

  // Symbio ships no agent runtime: projects need one installed. Runtimes start when needed (their
  // models load when the dialog asks), so installed is enough.
  const { runtimes, reload: reloadRuntimes } = useRuntimes();
  const installed = runtimes?.filter((r) => r.installed) ?? [];
  const canCreate = runtime !== null && installed.length > 0;

  // Opened as "#/new" (New project… in the project switcher): open the dialog once it can be used,
  // and drop "new" from the address so closing it, or reloading, doesn't bring it back.
  useEffect(() => {
    if (!create || !canCreate) return;
    setCreating(true);
    history.replaceState(null, "", "#/");
  }, [create, canCreate]);

  // First steps with OpenCode only: nothing to run agents on until a model provider is connected.
  const [noProviders, setNoProviders] = useState(false);
  const onlyOpenCode = installed.length === 1 && installed[0].kind === "opencode";
  useEffect(() => {
    if (!onlyOpenCode || projects?.length !== 0) return;
    api
      .providers()
      .then((p) => setNoProviders(p.connected.every((c) => c.models === 0)))
      .catch(() => {});
  }, [onlyOpenCode, projects?.length]);

  return (
    <div className="page-inner">
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p>Each project gets core, an agent that talks the scope through with you and coordinates the work.</p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)} disabled={!canCreate}>
          <Plus size={15} />
          New project
        </button>
      </div>

      {runtimes && installed.length === 0 && (
        <div className="first-run section" style={{ padding: 16 }}>
          <div>
            <h2>Install an agent runtime to start</h2>
            <p>
              Agents run on an agent runtime, and Symbio doesn't come with one: install at least one. Each project picks the one its agents run
              on; you can add or remove them later in Settings → Agent runtimes.
            </p>
          </div>
          <RuntimeCards runtimes={runtimes} onChange={reloadRuntimes} />
        </div>
      )}

      {noProviders && (
        <div className="notice row" style={{ justifyContent: "space-between", gap: 12 }}>
          <span>No model provider is connected yet, so agents have no models to run on.</span>
          <a className="btn sm" href="#/settings">
            Connect a provider
          </a>
        </div>
      )}

      {projects && projects.length === 0 && !(runtimes && installed.length === 0) && (
        <div className="section">
          <EmptyState
            icon={<FolderPlus size={20} />}
            title="No projects yet"
            action={
              <button className="btn primary" onClick={() => setCreating(true)} disabled={!canCreate}>
                <Plus size={15} />
                New project
              </button>
            }
          >
            Point Symbio at a folder — empty or existing — and core will take it from there.
          </EmptyState>
        </div>
      )}

      {projects && projects.length > 0 && (
        <div className="project-list">
          {projects.map((p) => (
            <ProjectRow key={p.id} project={p} />
          ))}
        </div>
      )}

      <AnimatePresence>
        {creating && (
          // New projects run on the runtime of the latest one, until the human picks another.
          <NewProjectDialog
            onClose={() => setCreating(false)}
            runtimes={installed}
            initialRuntime={pickRuntime(installed, projects?.slice().sort((a, b) => b.createdAt - a.createdAt)[0]?.runtime ?? "opencode")}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function ProjectRow({ project: p }: { project: Project }) {
  const active = p.agents.filter((a) => a.status !== "stopped");
  const working = active.filter((a) => a.status === "busy").length;
  const waiting = active.filter((a) => a.status === "waiting").length;
  const problems = active.filter((a) => a.problem || a.status === "error").length;
  const last = Math.max(p.createdAt, ...p.agents.map((a) => a.lastActivity ?? 0));

  let status: React.ReactNode = <span className="subtle">{active.length ? "Idle" : "Not started"}</span>;
  if (p.paused) status = <span className="tag blue">Paused</span>;
  else if (problems) status = <span className="tag red">Needs attention</span>;
  else if (waiting) status = <span className="tag amber">Waiting for you</span>;
  else if (working) status = <span className="tag green">{working} working</span>;

  return (
    <a className="project-row" href={`#/p/${p.id}`}>
      <div style={{ minWidth: 0 }}>
        <div className="project-name">{p.name}</div>
        <div className="project-dir ellipsis" title={p.directory}>
          {p.directory}
        </div>
      </div>
      <div className="avatar-stack" title={active.map((a) => a.name).join(", ")}>
        {active.slice(0, 5).map((a) => (
          <Avatar key={a.id} name={a.name} size="sm" />
        ))}
      </div>
      <div className="project-meta">
        {status}
        <span className="subtle">· {timeAgo(last)}</span>
      </div>
      <div onClick={(e) => e.preventDefault()}>
        <ProjectMenu project={p} />
      </div>
    </a>
  );
}

const STEPS = ["Folder", "Setup", "Models"] as const;

/** The runtime wanted if it's installed, else the first installed one. */
const pickRuntime = (installed: RuntimeView[], wanted: RuntimeKind): RuntimeKind =>
  installed.some((r) => r.kind === wanted) ? wanted : (installed[0]?.kind ?? wanted);

const RUNTIME_CHOICE: Record<RuntimeKind, string> = {
  opencode: "Models from the providers you connect in Settings.",
  copilot: "Your GitHub Copilot subscription and its models (sign in from Settings).",
};

function NewProjectDialog({ onClose, initialRuntime, runtimes }: { onClose: () => void; initialRuntime: RuntimeKind; runtimes: RuntimeView[] }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [directory, setDirectory] = useState("");
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [initGit, setInitGit] = useState(true);
  const [docsLocation, setDocsLocation] = useState<DocsLocation>("project");
  const [rulesRegister, setRulesRegister] = useState(true);
  const [projectConnections, setProjectConnections] = useState<ProjectConnection[]>([]);
  const [runtime, setRuntime] = useState<RuntimeKind>(initialRuntime);
  const [models, setModels] = useState<ModelChoice>({ allowed: [], coordinator: "", core: [], coreOnly: [] });
  const coordinator = models.coordinator;
  // Each runtime has its own models: a new runtime starts the choice over.
  const chooseRuntime = (next: RuntimeKind) => {
    if (next === runtime) return;
    setRuntime(next);
    setModels({ allowed: [], coordinator: "", core: [], coreOnly: [] });
  };
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  // Through remote access the native dialog would open on the other computer: use the in-page browser.
  const [remoteSession, setRemoteSession] = useState(false);
  useEffect(() => {
    api
      .remote()
      .then((r) => setRemoteSession(r.active && r.code === undefined))
      .catch(() => {});
  }, []);
  const [error, setError] = useState<string | null>(null);

  // Inspect the folder as the user types (debounced).
  useEffect(() => {
    const dir = directory.trim();
    setInspection(null);
    setInspectError(null);
    if (!dir) return;
    const timer = setTimeout(() => {
      api
        .inspect(dir)
        .then((i) => {
          setInspection(i);
          if (!nameTouched) setName(baseName(i.directory));
        })
        .catch((e) => setInspectError(e.message));
    }, 400);
    return () => clearTimeout(timer);
  }, [directory]); // eslint-disable-line react-hooks/exhaustive-deps

  const conflict = inspection?.existingProject;
  // A folder of repositories keeps them as they are; helpers work inside each one.
  const offerGit = inspection && !inspection.isGit && !inspection.repos.length && inspection.gitAvailable;
  const stepValid = [!!(name.trim() && inspection && !conflict), true, !!coordinator][step];

  // The dialog opens on the machine running Symbio (browsers can't reveal full paths).
  async function browse() {
    if (remoteSession) return setBrowsing(true);
    setPicking(true);
    setInspectError(null);
    try {
      const { path } = await api.pickFolder(directory.trim() || undefined);
      if (path) setDirectory(path);
    } catch (err) {
      setInspectError((err as Error).message);
    } finally {
      setPicking(false);
    }
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const project = await api.createProject({
        name: name.trim(),
        directory: directory.trim(),
        ...choiceBody(models),
        runtime,
        docsLocation,
        rulesRegister,
        initGit: !!offerGit && initGit,
        connections: projectConnections,
      });
      await api.start(project.id);
      location.hash = `#/p/${project.id}`;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="New project"
      onClose={onClose}
      wide={step === 2}
      header={
        <div className="steps">
          {STEPS.map((s, i) => (
            <span key={s} className="row" style={{ gap: 6 }}>
              {i > 0 && <span className="sep" />}
              <span className={`step ${i === step ? "on" : i < step ? "done" : ""}`}>
                <span className="step-num">{i + 1}</span>
                {s}
              </span>
            </span>
          ))}
        </div>
      }
      footer={
        <>
          {error && <div className="error grow">{error}</div>}
          {step > 0 && (
            <button className="btn ghost" onClick={() => setStep(step - 1)} disabled={busy}>
              <ArrowLeft size={14} />
              Back
            </button>
          )}
          {step < STEPS.length - 1 ? (
            <button className="btn primary" onClick={() => setStep(step + 1)} disabled={!stepValid}>
              Continue
              <ArrowRight size={14} />
            </button>
          ) : (
            <button className="btn primary" onClick={create} disabled={!stepValid || busy}>
              {busy ? "Starting core…" : "Create project"}
            </button>
          )}
        </>
      }
    >
      {step === 0 && (
        <>
          <label className="field">
            <span>Folder</span>
            <span className="input-row">
              <input
                value={directory}
                onChange={(e) => setDirectory(e.target.value)}
                placeholder="C:\Users\you\projects\my-project"
                autoFocus
              />
              <button type="button" className="btn" onClick={browse} disabled={picking}>
                <FolderOpen size={14} />
                {picking ? "Choosing…" : "Browse…"}
              </button>
            </span>
            <span className="hint">An empty folder starts a new project; an existing one is studied first. Created if it doesn't exist.</span>
          </label>
          {browsing && (
            <FolderBrowser
              start={directory.trim() || undefined}
              onCancel={() => setBrowsing(false)}
              onPick={(p) => {
                setDirectory(p);
                setBrowsing(false);
              }}
            />
          )}
          <label className="field">
            <span>Name</span>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              placeholder="My project"
            />
          </label>
          {inspectError && <div className="error">{inspectError}</div>}
          {conflict && (
            <div className="error">
              This folder already belongs to the project <a href={`#/p/${conflict.id}`}>“{conflict.name}”</a>.
            </div>
          )}
          {inspection && !conflict && <FolderSummary inspection={inspection} />}
          {offerGit && (
            <label className="choice">
              <input type="checkbox" checked={initGit} onChange={(e) => setInitGit(e.target.checked)} />
              <span className="choice-body">
                <span className="choice-title">Set up version history (git)</span>
                <span className="choice-desc">
                  Lets several agents work in parallel without stepping on each other, and keeps a history you can roll back. Adds a
                  hidden <code>.git</code> folder with a first snapshot.
                </span>
              </span>
            </label>
          )}
          {inspection && !conflict && inspection.repos.length > 0 && (
            <div className="notice">
              This folder holds {inspection.repos.length === 1 ? "a git repository" : `${inspection.repos.length} git repositories`} (
              {inspection.repos.join(", ")}). Symbio keeps them as they are: each helper works in one of them, and pushes go to that
              repository's own remote.
            </div>
          )}
          {inspection && !conflict && inspection.swallowed && (
            <div className="notice">
              This folder is a git repository that contains other repositories ({inspection.swallowed.inner.join(", ")}) without
              tracking their files
              {inspection.swallowed.createdBySymbio ? ", created on top of them by an earlier version of Symbio" : ""}. Agents would
              commit to the outer one. core can switch the project to work in each inner repository instead (nothing on disk changes),
              and Settings → Team switches it back.
            </div>
          )}
          {inspection && !inspection.isGit && !inspection.repos.length && !inspection.gitAvailable && (
            <div className="notice">Git isn't installed, so agents will share the folder directly.</div>
          )}
        </>
      )}

      {step === 1 && (
        <>
          <div className="field">
            <span>Project documentation</span>
            <label className="choice">
              <input type="radio" checked={docsLocation === "project"} onChange={() => setDocsLocation("project")} />
              <span className="choice-body">
                <span className="choice-title">
                  In the project <span className="tag accent">Recommended</span>
                </span>
                <span className="choice-desc">
                  <code>AGENTS.md</code> and a <code>docs/</code> folder — useful to any agent or person working on it.
                </span>
              </span>
            </label>
            <label className="choice">
              <input type="radio" checked={docsLocation === "private"} onChange={() => setDocsLocation("private")} />
              <span className="choice-body">
                <span className="choice-title">Private</span>
                <span className="choice-desc">
                  Kept in <code>.symbio/docs</code>, outside your files — for folders you don't want AI documentation in.
                </span>
              </span>
            </label>
          </div>
          <label className="choice">
            <input type="checkbox" checked={rulesRegister} onChange={(e) => setRulesRegister(e.target.checked)} />
            <span className="choice-body">
              <span className="choice-title">Keep a rules register</span>
              <span className="choice-desc">
                Agents record the project's rules (requirements, decisions, constraints) with where each came from and whether it's met.
                You browse and filter them in the Docs tab. You can turn it off later.
              </span>
            </span>
          </label>
          <div className="field">
            <span>Connections</span>
            <span className="hint">GitHub accounts and servers agents may use. Optional — you can change this later.</span>
            <ConnectionsPicker value={projectConnections} onChange={setProjectConnections} />
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <div className="field">
            <span>Agents run on</span>
            {/* Only the installed runtimes (Settings → Agent runtimes installs the others). */}
            <div className="runtime-choice">
              {runtimes.map((r) => (
                <label className="choice" key={r.kind}>
                  <input type="radio" name="runtime" checked={runtime === r.kind} onChange={() => chooseRuntime(r.kind)} />
                  <span className="choice-body">
                    <span className="choice-title">{r.label}</span>
                    <span className="choice-desc">{RUNTIME_CHOICE[r.kind]}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <ModelPicker value={models} onChange={setModels} runtime={runtime} />
        </>
      )}

      {step === 0 && !inspection && !inspectError && directory.trim() === "" && (
        <div className="row subtle small">
          <FolderOpen size={14} />
          Browse for a folder, or paste its full path.
        </div>
      )}
    </Dialog>
  );
}
