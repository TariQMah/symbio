import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { AlertTriangle, Bot, Gauge, Square } from "lucide-react";
import { api, subscribe, type AgentProgram, type MachineLoad } from "./api";
import { Drawer } from "./ui";

// This computer, in the top bar: its load, the programs agents started (stoppable, also from a
// phone), and what happens when it's overloaded (server: machine.ts).

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const mb = (bytes: number) => (bytes >= 1024 ** 3 ? gb(bytes) : `${Math.round(bytes / 1024 ** 2)} MB`);

/** "overdrive · core", or the agents that were working when it started when Symbio can't tell which one. */
function ownerText(p: AgentProgram): string {
  if (!p.owners.length) return "Started by an agent Symbio can't tell";
  if (p.owners.length === 1) return `${p.owners[0].project} · ${p.owners[0].agent}`;
  const names = p.owners.map((o) => (new Set(p.owners.map((x) => x.projectId)).size > 1 ? `${o.project} · ${o.agent}` : o.agent));
  const one = `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
  return new Set(p.owners.map((x) => x.projectId)).size > 1 ? `One of: ${one}` : `${p.owners[0].project} · ${one}`;
}

export function MachineBadge() {
  const [load, setLoad] = useState<MachineLoad | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    api.machine().then(setLoad, () => {});
    return subscribe((e) => {
      if (e.type === "machine.updated") setLoad(e.load);
    });
  }, []);
  if (!load) return null;
  const used = load.memory.total - load.memory.free;
  return (
    <>
      <button
        className={`btn ghost sm machine-badge ${load.overloaded ? "overloaded" : ""}`}
        onClick={() => setOpen(true)}
        title={`This computer: CPU ${load.cpu}%, memory ${gb(used)} of ${gb(load.memory.total)} used. Click for the programs agents started.`}
      >
        {load.overloaded ? <AlertTriangle size={14} /> : <Gauge size={14} />}
        <span className="btn-label tnum">{load.overloaded ? "Overloaded" : `CPU ${load.cpu}%`}</span>
      </button>
      <AnimatePresence>{open && <MachineDrawer load={load} onLoad={setLoad} onClose={() => setOpen(false)} />}</AnimatePresence>
    </>
  );
}

function MachineDrawer({ load, onLoad, onClose }: { load: MachineLoad; onLoad: (l: MachineLoad) => void; onClose: () => void }) {
  const [programs, setPrograms] = useState<AgentProgram[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<number | null>(null);
  const [project, setProject] = useState("");
  useEffect(() => {
    let live = true;
    // CPU per program is measured between two listings: the second one, a few seconds later, has it.
    const refresh = () =>
      api.machinePrograms().then(
        (p) => live && (setPrograms(p), setError(null)),
        (e) => live && setError((e as Error).message),
      );
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  async function stop(p: AgentProgram) {
    if (!confirm(`Stop ${p.name} (pid ${p.pid}) and everything it started? The agent that runs it is told by its command failing.`)) return;
    setStopping(p.pid);
    try {
      await api.stopProgram(p.pid);
      setPrograms((list) => list?.filter((x) => x.pid !== p.pid) ?? null);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setStopping(null);
    }
  }

  const used = load.memory.total - load.memory.free;
  // Programs by the project whose agent started them ("?" for ones Symbio can't tell), for the filter.
  const projectOf = (p: AgentProgram) => {
    const ids = [...new Set(p.owners.map((o) => o.projectId))];
    return ids.length === 1 ? ids[0] : "?";
  };
  const projects = new Map<string, { name: string; count: number }>();
  for (const p of programs ?? []) {
    const id = projectOf(p);
    const entry = projects.get(id) ?? { name: id === "?" ? "Not known" : p.owners[0].project, count: 0 };
    entry.count++;
    projects.set(id, entry);
  }
  const shown = programs?.filter((p) => !project || projectOf(p) === project);
  return (
    <Drawer title="This computer" onClose={onClose}>
      <div className="machine">
        <div className="machine-load">
          <div>
            <span className="subtle small">CPU ({load.cores} threads)</span>
            <strong className="tnum">{load.cpu}%</strong>
            <span className="machine-bar">
              <span style={{ width: `${Math.min(100, load.cpu)}%` }} className={load.cpu >= 90 ? "high" : ""} />
            </span>
          </div>
          <div>
            <span className="subtle small">Memory</span>
            <strong className="tnum">
              {gb(used)} <span className="subtle">of {gb(load.memory.total)}</span>
            </strong>
            <span className="machine-bar">
              <span style={{ width: `${Math.min(100, (100 * used) / load.memory.total)}%` }} className={load.memory.free / load.memory.total < 0.12 ? "high" : ""} />
            </span>
          </div>
        </div>
        {load.overloaded && (
          <div className="banner red">
            <AlertTriangle size={15} />
            <div className="grow">
              <strong>Overloaded</strong>
              {load.since ? ` since ${new Date(load.since).toLocaleTimeString()}` : ""}.{" "}
              <span className="muted">
                core and you were told{load.holding ? "; messages between agents wait until it recovers" : ""}. Stop what isn't needed below.
              </span>
            </div>
          </div>
        )}

        <div className="machine-section-title">
          <span className="grow">Programs agents started</span>
          {programs && projects.size > 1 && (
            <select className="machine-filter" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
              <option value="">All projects ({programs.length})</option>
              {[...projects]
                .sort((a, b) => (a[0] === "?" ? 1 : b[0] === "?" ? -1 : a[1].name.localeCompare(b[1].name)))
                .map(([id, e]) => (
                  <option key={id} value={id}>
                    {e.name} ({e.count})
                  </option>
                ))}
            </select>
          )}
        </div>
        {error && <div className="error">{error}</div>}
        {!programs && !error && <div className="subtle small">Looking…</div>}
        {programs?.length === 0 && <div className="subtle small">None running.</div>}
        <div className="machine-programs">
          {shown?.map((p) => (
            <div key={p.pid} className="machine-program" data-pid={p.pid}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="machine-program-head">
                  <strong>{p.name}</strong>
                  <span className="subtle small tnum">
                    pid {p.pid} · {p.cpu === null ? "CPU …" : `CPU ${p.cpu}%`} · {mb(p.memory)}
                    {p.runtime ? ` · ${p.runtime}` : ""}
                    {p.started ? ` · since ${new Date(p.started).toLocaleTimeString()}` : ""}
                  </span>
                </div>
                <div className="machine-owner small">
                  <Bot size={12} />
                  {ownerText(p)}
                </div>
                <code className="machine-command" title={p.command}>
                  {p.command}
                </code>
              </div>
              <button className="btn sm" disabled={stopping === p.pid} onClick={() => stop(p)} aria-label={`Stop ${p.name} (pid ${p.pid})`}>
                <Square size={12} />
                Stop
              </button>
            </div>
          ))}
        </div>

        <label className="check machine-hold">
          <input
            type="checkbox"
            checked={load.settings.holdTurns}
            onChange={(e) => api.machineSettings({ holdTurns: e.target.checked }).then(onLoad, (err) => alert(err.message))}
          />
          <span>
            When this computer is overloaded, also hold messages between agents until it recovers
            <span className="hint">
              Agents already working finish their step; new turns wait, so tokens aren't spent while the machine struggles. You can
              still talk to them.
            </span>
          </span>
        </label>
        <p className="subtle small">
          Programs agents start run at low priority, so the system, remote desktop tools and you come first. Stopping one here stops it
          and what it started, by its process id; only programs agents started are listed.
        </p>
      </div>
    </Drawer>
  );
}
