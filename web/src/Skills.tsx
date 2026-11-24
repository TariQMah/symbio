import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { BookOpen, Download, Plus, Sparkles, Trash2 } from "lucide-react";
import { api, type Agent, type Project, type SkillInfo } from "./api";
import { Md } from "./files";
import { Dialog } from "./ui";

// Skills (server: skills.ts): packaged methods agents load when a task calls for one. Settings has
// the library (Symbio's and the human's own, and others found on this computer to add a copy of);
// a project's settings choose core's skills and the ones core may give helpers; a helper's chat
// shows its skills, which the human can change.

function useSkills() {
  const [data, setData] = useState<{ skills: SkillInfo[]; computer: SkillInfo[]; categories: { id: string; label: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () =>
    api.skills().then(
      (d) => (setData(d), setError(null)),
      (e) => setError((e as Error).message),
    );
  useEffect(() => {
    void reload();
  }, []);
  return { data, error, reload };
}

/** Who wrote a skill: Symbio's own, or its author (linked), its license and where it comes from. */
function Credit({ skill }: { skill: SkillInfo }) {
  const c = skill.credit;
  if (!c) return null;
  if (c.author === "Symbio") return <span className="tag">Symbio's</span>;
  return (
    <span className="skill-credit subtle small">
      by{" "}
      {c.authorUrl ? (
        <a href={c.authorUrl} target="_blank" rel="noreferrer">
          {c.author}
        </a>
      ) : (
        c.author
      )}
      {c.license && ` · ${c.license}`}
      {c.source && (
        <>
          {" · "}
          <a href={c.source} target="_blank" rel="noreferrer">
            source
          </a>
        </>
      )}
    </span>
  );
}

/** A skill's SKILL.md, to read before adding or giving it. */
function SkillView({ skill, onClose, footer }: { skill: SkillInfo; onClose: () => void; footer?: React.ReactNode }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    api.skillText(skill.name).then(
      (r) => setText(r.text),
      (e) => setText(`Couldn't read it: ${(e as Error).message}`),
    );
  }, [skill.name]);
  return (
    <Dialog title={skill.name} subtitle={skill.description} onClose={onClose} wide footer={footer}>
      {skill.credit && skill.credit.author !== "Symbio" && (
        <div className="skill-credit-box small">
          <Credit skill={skill} />
          {skill.credit.changes?.length ? <div className="subtle">Symbio's copy: {skill.credit.changes.join("; ")}.</div> : null}
        </div>
      )}
      <div className="skill-source subtle small">
        {skill.dir}
        {skill.files.length > 0 && ` · also ${skill.files.length} file${skill.files.length === 1 ? "" : "s"}: ${skill.files.slice(0, 8).join(", ")}${skill.files.length > 8 ? "…" : ""}`}
      </div>
      <div className="skill-text">{text === null ? <span className="subtle">Loading…</span> : <Md text={text.replace(/^---[\s\S]*?---\s*/, "")} projectId="" />}</div>
    </Dialog>
  );
}

/** Settings → Skills: the library. */
export function SkillsSection() {
  const { data, error, reload } = useSkills();
  const [viewing, setViewing] = useState<SkillInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const [fromFolder, setFromFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const q = query.trim().toLowerCase();
  const shown = (data?.skills ?? []).filter(
    (s) => (category === "all" || s.category === category) && (!q || `${s.name} ${s.description} ${s.credit?.author ?? ""}`.toLowerCase().includes(q)),
  );
  const groups = (data?.categories ?? []).map((c) => ({ ...c, skills: shown.filter((s) => s.category === c.id) })).filter((g) => g.skills.length);
  const present = (data?.categories ?? []).filter((c) => data?.skills.some((s) => s.category === c.id));

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section" id="skills">
      <div className="section-head">
        <div>
          <h2>Skills</h2>
          <p>
            Packaged methods agents load when a task calls for one: a review, a briefing, a front-end checklist, a writing style. Each agent
            gets only the skills it's given (core's in each project's settings; helpers' from core or from you, in their chat). Skills you add
            are copies kept by Symbio: they don't change when the original does, and agents can't edit them.
          </p>
        </div>
        <button className="btn sm" onClick={() => setCreating(true)}>
          <Plus size={13} />
          New skill
        </button>
      </div>
      <div className="section-body">
        {error && <div className="error">{error}</div>}
        <div className="skill-filters">
          <input placeholder="Search skills" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search skills" />
          <div className="chips">
            {[{ id: "all", label: "All" }, ...present].map((c) => (
              <button key={c.id} className={`chip${category === c.id ? " on" : ""}`} onClick={() => setCategory(c.id)}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
        {data && shown.length === 0 && <div className="subtle small" style={{ padding: "8px 4px" }}>No skills match.</div>}
        {groups.map((g) => (
          <div key={g.id} className="skill-category" data-category={g.id}>
            <div className="skill-group-title">{g.label}</div>
            {g.skills.map((s) => (
          <div key={s.name} className="list-row skill-row">
            <Sparkles size={15} className="subtle" />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="list-title">
                {s.name} <Credit skill={s} />
              </div>
              <div className="list-sub" title={s.description}>{s.description}</div>
            </div>
            <button className="btn ghost sm" onClick={() => setViewing(s)}>
              <BookOpen size={13} />
              Read
            </button>
            {s.source === "library" && (
              <button
                className="btn ghost icon sm"
                title={`Remove ${s.name}`}
                aria-label={`Remove ${s.name}`}
                disabled={busy}
                onClick={() => confirm(`Remove the skill "${s.name}"? Agents that have it lose it.`) && act(() => api.removeSkill(s.name))}
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
            ))}
          </div>
        ))}

        {data && data.computer.length > 0 && (
          <>
            <div className="skill-group-title">On this computer, from other tools: add a copy to give it to agents</div>
            {data.computer.map((s) => (
              <div key={`${s.dir}`} className="list-row skill-row">
                <Sparkles size={15} className="subtle" />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="list-title">{s.name}</div>
                  <div className="list-sub" title={s.description}>{s.description}</div>
                </div>
                <button className="btn sm" onClick={() => setViewing(s)}>
                  <Download size={13} />
                  Read and add
                </button>
              </div>
            ))}
          </>
        )}

        <div className="skill-import row">
          <input
            placeholder="Add a skill from a folder (the one with its SKILL.md), e.g. C:\Users\me\skills\front-end"
            value={fromFolder}
            onChange={(e) => setFromFolder(e.target.value)}
          />
          <button
            className="btn sm"
            disabled={busy || !fromFolder.trim()}
            onClick={() => act(async () => (await api.importSkill(fromFolder.trim()), setFromFolder("")))}
          >
            Add a copy
          </button>
        </div>
      </div>

      <AnimatePresence>
        {viewing && (
          <SkillView
            skill={viewing}
            onClose={() => setViewing(null)}
            footer={
              viewing.source === "computer" ? (
                <>
                  <span className="subtle small grow">Read it first: a skill is instructions agents follow, and its files can be scripts they run.</span>
                  <button className="btn ghost" onClick={() => setViewing(null)}>
                    Cancel
                  </button>
                  <button className="btn primary" disabled={busy} onClick={() => act(() => api.importSkill(viewing.dir)).then(() => setViewing(null))}>
                    Add a copy
                  </button>
                </>
              ) : undefined
            }
          />
        )}
        {creating && <NewSkillDialog onClose={() => setCreating(false)} onCreated={() => (setCreating(false), void reload())} />}
      </AnimatePresence>
    </section>
  );
}

function NewSkillDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.createSkill({ name, description, instructions });
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="New skill"
      subtitle="A method agents can load when a task calls for it."
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy || !name.trim() || !description.trim() || !instructions.trim()}>
            Create
          </button>
        </>
      }
    >
      <label className="field">
        <span>Name</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "-"))} placeholder="e.g. front-end-review" />
        <span className="hint">Lowercase letters, digits and dashes.</span>
      </label>
      <label className="field">
        <span>What it's for, and when to use it</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Review a web page's layout and accessibility. Use after building or changing a page." />
        <span className="hint">Agents see this and decide when to load the skill.</span>
      </label>
      <label className="field">
        <span>Instructions</span>
        <textarea rows={12} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="The method, step by step (Markdown)." />
      </label>
      {error && <div className="error">{error}</div>}
    </Dialog>
  );
}

/** Checkboxes over the library: which skills are chosen. */
/** The library's categories, in order (as skills.ts lists them). */
const CATEGORY_ORDER = ["leading", "planning", "software", "design", "writing", "data", "operations", "media", "other"];
const CATEGORY_LABEL: Record<string, string> = {
  leading: "Leading the team",
  planning: "Planning and specs",
  software: "Software development",
  design: "Design",
  writing: "Writing",
  data: "Data and research",
  operations: "Operations and servers",
  media: "Video and media",
  other: "Other",
};

export function SkillChecklist({ skills, chosen, onChange, disabled }: { skills: SkillInfo[]; chosen: string[]; onChange: (next: string[]) => void; disabled?: boolean }) {
  const order = (s: SkillInfo) => CATEGORY_ORDER.indexOf(s.category) + (CATEGORY_ORDER.includes(s.category) ? 0 : 99);
  const sorted = [...skills].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  return (
    <div className="skill-checklist">
      {sorted.map((s, i) => (
        <div key={s.name}>
          {(i === 0 || sorted[i - 1].category !== s.category) && <div className="skill-group-title">{CATEGORY_LABEL[s.category] ?? s.category}</div>}
        <label key={s.name} className="check skill-check">
          <input
            type="checkbox"
            checked={chosen.includes(s.name)}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked ? [...chosen, s.name] : chosen.filter((x) => x !== s.name))}
          />
          <span>
            <strong>{s.name}</strong>
            <span className="hint" title={s.description}>{s.description}</span>
          </span>
        </label>
        </div>
      ))}
      {skills.length === 0 && <span className="subtle small">No skills in the library yet (Settings → Skills).</span>}
    </div>
  );
}

const DEFAULT_CORE = ["briefing", "glossary", "handoff", "review"];

/** Project settings → Skills: core's, and the ones core may give helpers. */
export function ProjectSkillsSection({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const { data } = useSkills();
  const library = data?.skills ?? [];
  const names = library.map((s) => s.name);
  const [core, setCore] = useState<string[]>(project.coreSkills ?? DEFAULT_CORE);
  const [helpers, setHelpers] = useState<string[] | null>(project.helperSkills ?? null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setCore(project.coreSkills ?? DEFAULT_CORE);
    setHelpers(project.helperSkills ?? null);
  }, [project.coreSkills, project.helperSkills]);
  const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  const dirty = !sameSet(core, project.coreSkills ?? DEFAULT_CORE) || (helpers === null) !== (project.helperSkills === undefined) || (helpers !== null && !sameSet(helpers, project.helperSkills ?? []));
  async function save() {
    setSaving(true);
    try {
      onChanged(await api.updateProject(project.id, { coreSkills: core.filter((s) => names.includes(s)), helperSkills: helpers === null ? null : helpers }));
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="section" id="project-skills">
      <div className="section-head">
        <div>
          <h2>Skills</h2>
          <p>
            core gets the skills chosen here; helpers get the ones core gives them, from the skills allowed below (or the ones you give them in
            their chat). The library is in Settings → Skills.
          </p>
        </div>
      </div>
      <div className="section-body">
        <div className="field">
          <span>core's skills</span>
          <SkillChecklist skills={library} chosen={core} onChange={setCore} />
        </div>
        <div className="field">
          <span>Skills core may give helpers</span>
          <label className="check">
            <input type="checkbox" checked={helpers === null} onChange={(e) => setHelpers(e.target.checked ? null : [...names])} />
            Any skill in the library
          </label>
          {helpers !== null && <SkillChecklist skills={library} chosen={helpers} onChange={setHelpers} />}
        </div>
        {dirty && (
          <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
            <button className="btn ghost sm" onClick={() => (setCore(project.coreSkills ?? DEFAULT_CORE), setHelpers(project.helperSkills ?? null))} disabled={saving}>
              Reset
            </button>
            <button className="btn primary sm" onClick={save} disabled={saving}>
              Save
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

/** In a chat header: the agent's skills; for a helper, a click to change them. */
export function AgentSkills({ project, agent }: { project: Project; agent: Agent }) {
  const [open, setOpen] = useState(false);
  const skills = agent.role === "coordinator" ? (project.coreSkills ?? DEFAULT_CORE) : (agent.skills ?? []);
  const label = skills.length ? `${skills.length} skill${skills.length === 1 ? "" : "s"}` : "no skills";
  return (
    <>
      {" · "}
      <button
        className="inline-select agent-skills"
        title={skills.length ? `Skills: ${skills.join(", ")}` : "No skills"}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      <AnimatePresence>{open && <AgentSkillsDialog project={project} agent={agent} onClose={() => setOpen(false)} />}</AnimatePresence>
    </>
  );
}

function AgentSkillsDialog({ project, agent, onClose }: { project: Project; agent: Agent; onClose: () => void }) {
  const { data } = useSkills();
  const [chosen, setChosen] = useState<string[]>(agent.skills ?? []);
  if (agent.role === "coordinator") {
    const mine = project.coreSkills ?? DEFAULT_CORE;
    return (
      <Dialog title="core's skills" subtitle="Chosen in this project's settings (Settings tab → Skills)." onClose={onClose}>
        <SkillChecklist skills={(data?.skills ?? []).filter((s) => mine.includes(s.name))} chosen={mine} onChange={() => {}} disabled />
      </Dialog>
    );
  }
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api.setAgentSkills(project.id, agent.id, chosen);
      onClose();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={`Skills: ${agent.name}`}
      subtitle="It loads one when a task matches its description. Skills you choose here core can't change."
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            Save
          </button>
        </>
      }
    >
      <SkillChecklist skills={data?.skills ?? []} chosen={chosen} onChange={setChosen} />
    </Dialog>
  );
}
