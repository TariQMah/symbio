import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { ArrowRightLeft, Check, Loader2 } from "lucide-react";
import { api, RUNTIME_LABEL, subscribe, type ModelInfo, type Project, type RuntimeKind, type RuntimeView, type SwitchProgress } from "./api";
import { ModelPicker, choiceOf, type ModelChoice } from "./ModelPicker";
import { useRuntimes } from "./Runtimes";
import { Dialog } from "./ui";

/** Project settings: the runtime the project's agents run on, and moving them to another one. */
export function RuntimeSection({ project }: { project: Project }) {
  const current = project.runtime ?? "opencode";
  const { runtimes } = useRuntimes();
  const others = (runtimes ?? []).filter((r) => r.installed && r.kind !== current);
  const [progress, setProgress] = useState<SwitchProgress | null>(null);
  const [choosing, setChoosing] = useState(false);

  useEffect(() => {
    api
      .switchState(project.id)
      .then(setProgress)
      .catch(() => {});
    return subscribe((e) => {
      if (e.type === "runtime.switch" && e.projectId === project.id) setProgress(e.progress);
    });
  }, [project.id]);

  const running = progress?.status === "running";
  return (
    <section className="section" id="agent-runtime">
      <div className="section-head">
        <div>
          <h2>Agent runtime</h2>
          <p>
            This project's agents run on <strong>{RUNTIME_LABEL[current]}</strong>. Moving them to another runtime keeps the team, plan, tasks,
            folders and branches; each agent continues in a fresh session there, from a handoff note.
          </p>
        </div>
        {!running && others.length > 0 && (
          <button className="btn sm" onClick={() => setChoosing(true)}>
            <ArrowRightLeft size={13} />
            Switch runtime…
          </button>
        )}
      </div>
      {(progress || (runtimes && others.length === 0)) && (
        <div className="section-body" style={{ padding: "4px 16px 14px" }}>
          {progress ? (
            <SwitchStatus progress={progress} />
          ) : (
            <p className="subtle small" style={{ margin: 0 }}>
              To move it, install another runtime in Settings → Agent runtimes.
            </p>
          )}
        </div>
      )}
      <AnimatePresence>
        {choosing && <SwitchDialog project={project} targets={others} onClose={() => setChoosing(false)} onStarted={setProgress} />}
      </AnimatePresence>
    </section>
  );
}

function SwitchStatus({ progress: p }: { progress: SwitchProgress }) {
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  const route = `${RUNTIME_LABEL[p.from]} → ${RUNTIME_LABEL[p.to]}`;
  if (p.status === "running") {
    return (
      <div className="switch-status">
        <div className="row" style={{ gap: 8 }}>
          <Loader2 size={13} className="spin" />
          <span>
            Moving to {RUNTIME_LABEL[p.to]}: {p.step}…
          </span>
        </div>
        <div className="switch-track">
          <div className="switch-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }
  if (p.status === "failed") return <div className="error">Moving {route} failed, and nothing changed: {p.error}</div>;
  return (
    <div className="switch-status done">
      <div className="row" style={{ gap: 8 }}>
        <Check size={13} />
        <span>
          Moved {route} {new Date(p.finishedAt ?? p.startedAt).toLocaleString()}.
          {p.withoutHandoff.length > 0 && ` Without their own handoff (Symbio's note only): ${p.withoutHandoff.join(", ")}.`}
        </span>
      </div>
    </div>
  );
}

/** A model's name without its provider, for finding the same model on another runtime. */
const bare = (ref: string) => (ref.split("/").at(-1) ?? ref).toLowerCase().replace(/[^a-z0-9]/g, "");

/** The project's model choice carried over to another runtime's models, where the same models exist there. */
export function carryOver(choice: ModelChoice, models: ModelInfo[]): ModelChoice {
  const map = (ref: string) => models.find((m) => bare(m.ref) === bare(ref))?.ref;
  const list = (refs: string[]) => [...new Set(refs.map(map).filter((r): r is string => !!r))];
  const allowed = list(choice.allowed);
  const core = list(choice.core);
  const coreOnly = list(choice.coreOnly);
  const coordinator = map(choice.coordinator) ?? core[0] ?? allowed[0] ?? "";
  return { allowed, core: core.length ? core : [...allowed], coreOnly: coreOnly.length < allowed.length ? coreOnly : [], coordinator };
}

function SwitchDialog({
  project,
  targets,
  onClose,
  onStarted,
}: {
  project: Project;
  targets: RuntimeView[];
  onClose: () => void;
  onStarted: (p: SwitchProgress) => void;
}) {
  const from = project.runtime ?? "opencode";
  const [to, setTo] = useState<RuntimeKind>(targets[0].kind);
  const [choice, setChoice] = useState<ModelChoice | null>(null);
  const [askHandoffs, setAskHandoffs] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { runtimes } = useRuntimes();
  const fromInstalled = !!runtimes?.find((r) => r.kind === from)?.installed;
  const working = project.agents.filter((a) => a.status === "busy" || a.status === "waiting" || a.status === "stuck").map((a) => a.name);
  const active = project.agents.filter((a) => a.status !== "stopped").length;

  // The project's models, carried over where the new runtime has them; the picker then adjusts them.
  useEffect(() => {
    setChoice(null);
    setError(null);
    api
      .models(to)
      .then((models) => setChoice(carryOver(choiceOf(project), models)))
      .catch((e) => setError(e.message));
  }, [to]); // eslint-disable-line react-hooks/exhaustive-deps

  const helpersLeft = !!choice && choice.allowed.some((m) => !choice.coreOnly.includes(m));
  const ready = !!choice && choice.allowed.length > 0 && !!choice.coordinator && helpersLeft;

  async function start() {
    if (!choice) return;
    setBusy(true);
    setError(null);
    try {
      const { progress } = await api.switchRuntime(project.id, {
        to,
        allowedModels: choice.allowed,
        coordinatorModel: choice.coordinator,
        coreModels: choice.core,
        coreOnlyModels: choice.coreOnly,
        askHandoffs: askHandoffs && fromInstalled,
      });
      onStarted(progress);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Move ${project.name} to another runtime`}
      subtitle={`From ${RUNTIME_LABEL[from]}`}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={start} disabled={!ready || busy}>
            {busy ? "Starting…" : `Move to ${RUNTIME_LABEL[to]}`}
          </button>
        </>
      }
    >
      <div className="notice switch-warning">
        <strong>Best done when the team is idle,</strong> with nothing waiting on you and the work that's ready merged. The team is paused while it
        moves{working.length ? `: ${working.join(", ")} will be interrupted` : ""}. Each agent continues in a fresh session from a handoff note: its
        earlier conversation stays readable in its chat but doesn't carry over, and agents will behave differently on another runtime. Expect to
        steer them for a while. Stopped helpers move when you restart them.
      </div>

      {targets.length > 1 && (
        <div className="field">
          <span>Move to</span>
          <div className="runtime-choice">
            {targets.map((r) => (
              <label className="choice" key={r.kind}>
                <input type="radio" name="switch-to" checked={to === r.kind} onChange={() => setTo(r.kind)} />
                <span className="choice-body">
                  <span className="choice-title">{r.label}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      <label className="choice">
        <input type="checkbox" checked={askHandoffs && fromInstalled} disabled={!fromInstalled} onChange={(e) => setAskHandoffs(e.target.checked)} />
        <span className="choice-body">
          <span className="choice-title">Ask each agent for its own handoff first</span>
          <span className="choice-desc">
            {fromInstalled
              ? `One last turn for each of the ${active} active agent(s) on ${RUNTIME_LABEL[from]}, to write down what's in its head. Otherwise Symbio's note (plan, tasks, latest messages) is all they get.`
              : `${RUNTIME_LABEL[from]} isn't installed, so Symbio's note (plan, tasks, latest messages) is what they get.`}
          </span>
        </span>
      </label>

      <div className="field">
        <span>Models on {RUNTIME_LABEL[to]}</span>
        <span className="subtle small">The project's models were carried over where {RUNTIME_LABEL[to]} has them; adjust as needed.</span>
        {choice ? <ModelPicker key={to} value={choice} onChange={setChoice} runtime={to} /> : !error && <Loader2 size={14} className="spin" />}
      </div>
      {error && <div className="error">{error}</div>}
    </Dialog>
  );
}
