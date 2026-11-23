// The load guard's side of the team: tells the human and core when the computer is overloaded
// (and delivers held messages once it recovers), and tells the machine monitor who started each
// program (machine.ts): the agent whose background shell it runs under, or the agents that were
// working when it started.

import { bus } from "../bus.js";
import { startedBy, type AgentProcess, type MachineLoad, type MachineMonitor, type ProgramOwner } from "../machine.js";
import { runtimeOf, type AgentRuntime } from "../runtime/types.js";
import type { Agent, Project } from "../store.js";
import path from "node:path";
import { active, type TeamCore } from "./core.js";

/** What the load guard needs of the Team, besides TeamCore. */
export interface MachineWatchHost extends TeamCore {
  /** Delivers held messages (paused team, or an overloaded machine). */
  deliverHeld(project: Project, held: { agentId: string; text: string }[]): Promise<Set<string>>;
}

export class MachineWatch {
  private readonly overloadNotified = new Set<string>();
  /** When each agent was working (agent id → its recent turns), to tell who started a program. */
  private readonly turns = new Map<string, { start: number; end: number | null }[]>();
  private shellsCache: { at: number; shells: Map<number, ProgramOwner> } | null = null;

  constructor(private readonly team: MachineWatchHost) {}

  /** When each agent was working, so the programs started then can be told apart. */
  statusChanged(agent: Agent, status: Agent["status"]) {
    const working = (s: Agent["status"]) => s === "busy" || s === "waiting";
    const turns = (this.turns.get(agent.id) ?? []).filter((t) => t.end === null || Date.now() - t.end < 6 * 3600_000).slice(-100);
    if (working(status) && !turns.some((t) => t.end === null)) turns.push({ start: Date.now(), end: null });
    if (!working(status)) for (const t of turns) t.end ??= Date.now();
    this.turns.set(agent.id, turns);
  }

  /** Listens to the machine monitor, and tells it who started each program. */
  attach(machine: MachineMonitor) {
    machine.attribution = {
      shells: () => this.backgroundShells(),
      workingAt: (at, runtime) => {
        // A turn is marked when its prompt has been sent, which a fast runtime may answer by starting a shell already:
        // agents whose turn covers the moment come first, then ones whose turn began just after it.
        const covering: ProgramOwner[] = [];
        const justAfter: ProgramOwner[] = [];
        for (const project of this.team.store.list()) {
          for (const agent of project.agents) {
            if (this.team.runtimes.get(runtimeOf(agent))?.label !== runtime) continue;
            const turns = this.turns.get(agent.id) ?? [];
            if (turns.some((t) => t.start - 100 <= at && at <= (t.end ?? Date.now()))) covering.push(ownerOf(project, agent));
            else if (turns.some((t) => t.start - 5000 <= at && at <= (t.end ?? Date.now()))) justAfter.push(ownerOf(project, agent));
          }
        }
        return covering.length ? covering : justAfter;
      },
    };
    machine.on("changed", (load) => bus.publish({ type: "machine.updated", load }));
    machine.on("overloaded", (load, heavy) => void this.onOverloaded(load, heavy).catch((err) => console.error("[machine]", err.message)));
    machine.on("recovered", (load) => void this.onRecovered(load).catch((err) => console.error("[machine]", err.message)));
  }

  /** The runtimes' background shells by pid, with the agent that started each (cached briefly: listings come every few seconds). */
  private async backgroundShells(): Promise<Map<number, ProgramOwner>> {
    if (this.shellsCache && Date.now() - this.shellsCache.at < 10_000) return this.shellsCache.shells;
    const folders = new Map<string, { runtime: AgentRuntime; directory: string; agents: { project: Project; agent: Agent }[] }>();
    for (const project of this.team.store.list()) {
      for (const agent of project.agents.filter(active)) {
        const runtime = this.team.runtimes.get(runtimeOf(agent));
        if (!runtime || runtime.state !== "running") continue;
        const key = `${runtime.kind}\n${path.resolve(agent.directory).toLowerCase()}`;
        const folder = folders.get(key) ?? { runtime, directory: agent.directory, agents: [] };
        folder.agents.push({ project, agent });
        folders.set(key, folder);
      }
    }
    const shells = new Map<number, ProgramOwner>();
    for (const { runtime, directory, agents } of folders.values()) {
      for (const s of await runtime.shells(directory).catch(() => [])) {
        if (!s.running || !s.pid) continue;
        const found = (s.sessionId && this.team.store.findAgentBySession(s.sessionId)) || (agents.length === 1 ? agents[0] : undefined);
        if (found) shells.set(s.pid, ownerOf(found.project, found.agent));
      }
    }
    this.shellsCache = { at: Date.now(), shells };
    return shells;
  }

  private async onOverloaded(load: MachineLoad, heavy: AgentProcess[]) {
    const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
    const top = heavy
      .slice(0, 5)
      .map((p) => `${p.name} (pid ${p.pid}${p.cpu !== null ? `, ${p.cpu}% CPU` : ""}, ${Math.round(p.memory / 1024 ** 2)} MB${p.owners.length ? `, ${startedBy(p)}` : ""})`)
      .join(", ");
    const state = `CPU ${load.cpu}%, ${gb(load.memory.free)} of ${gb(load.memory.total)} GB memory free`;
    console.warn(`[machine] overloaded: ${state}${top ? `; agents' programs: ${top}` : ""}`);
    for (const project of this.team.store.list()) {
      if (!project.agents.some((a) => a.status === "busy" || a.status === "waiting" || a.status === "stuck")) continue;
      this.overloadNotified.add(project.id);
      await this.team.log(project, {
        from: "symbio",
        to: "human",
        kind: "system",
        text:
          `This computer is overloaded (${state}).${top ? ` The heaviest programs agents started: ${top}.` : ""} ` +
          `${load.holding ? "New agent turns wait until it recovers. " : ""}You can stop them from the machine indicator at the top.`,
      });
      const coordinator = this.team.coordinator(project);
      if (coordinator && active(coordinator)) {
        await this.team.note(
          project,
          coordinator,
          `Symbio: this computer is overloaded (${state}).${top ? ` Programs agents started, heaviest first: ${top}.` : ""} ` +
            "Don't start more heavy work now; have helpers finish or stop what isn't needed, and run heavy jobs one at a time." +
            (load.holding ? " Messages between agents wait until the machine recovers." : ""),
        );
      }
    }
  }

  private async onRecovered(load: MachineLoad) {
    console.log(`[machine] recovered: CPU ${load.cpu}%`);
    for (const project of this.team.store.list()) {
      const told = this.overloadNotified.delete(project.id);
      // Held because of the machine (not paused by the human): deliver them now.
      const held = !project.paused ? (project.heldMessages ?? []) : [];
      if (held.length) {
        project.heldMessages = [];
        await this.team.store.update(project);
        await this.team.deliverHeld(project, held);
      }
      if (told || held.length) {
        await this.team.log(project, {
          from: "symbio",
          to: "human",
          kind: "system",
          text: `This computer has recovered (CPU ${load.cpu}%).${held.length ? ` ${held.length} held message(s) delivered.` : ""}`,
        });
        bus.publish({ type: "project.updated", projectId: project.id });
      }
    }
  }
}

const ownerOf = (project: Project, agent: Agent): ProgramOwner => ({
  projectId: project.id,
  project: project.name,
  agentId: agent.id,
  agent: agent.name,
  directory: agent.directory,
});
