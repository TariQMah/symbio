// Reasoning effort: the levels each model takes, the level an agent's session runs at (its own,
// else the project's for its model), and changing them (the human's or core's).

import { bus } from "../bus.js";
import { runtimeOf, type AgentRuntime, type RuntimeKind } from "../runtime/types.js";
import type { Agent, Project } from "../store.js";
import { active, type TeamCore } from "./core.js";

/** Why a level was refused: the levels the model takes. */
export const levelError = (model: string, level: string, levels: string[]) =>
  levels.length
    ? `${model} doesn't take the reasoning effort "${level}". Its levels: ${levels.join(", ")}.`
    : `${model} has no reasoning effort levels to choose.`;

export class Efforts {
  private readonly levelCache = new Map<RuntimeKind, { at: number; levels: Map<string, string[]>; limits: Map<string, number> }>();

  constructor(private readonly team: TeamCore) {}

  /** The reasoning effort levels a model takes in a runtime (cached for a few minutes). */
  async levelsOf(runtime: AgentRuntime, model: string): Promise<string[]> {
    let cache = this.levelCache.get(runtime.kind);
    if (!cache || Date.now() - cache.at > 5 * 60_000 || !cache.levels.has(model)) {
      const models = await runtime.listModels().catch(() => null);
      if (models) {
        cache = {
          at: Date.now(),
          levels: new Map(models.map((m) => [`${m.providerID}/${m.id}`, m.efforts ?? []])),
          // OpenCode's catalog gives each model's context window as limit.context.
          limits: new Map(models.flatMap((m) => (Number(m.raw?.limit?.context) > 0 ? [[`${m.providerID}/${m.id}`, Number(m.raw.limit.context)] as const] : []))),
        };
        this.levelCache.set(runtime.kind, cache);
      }
    }
    return cache?.levels.get(model) ?? [];
  }

  /** A model's context window in tokens, when the runtime's catalog says (null otherwise). */
  async limitOf(runtime: AgentRuntime, model: string): Promise<number | null> {
    await this.levelsOf(runtime, model);
    return this.levelCache.get(runtime.kind)?.limits.get(model) ?? null;
  }

  /**
   * The level an agent's session uses on a model: its own level, else the project's for the model,
   * when the model takes it; otherwise none (the model's default).
   */
  async effortFor(project: Project, agent: Pick<Agent, "effort"> | null, model: string, runtime: AgentRuntime): Promise<string | undefined> {
    const wanted = [agent?.effort?.level, project.modelEfforts?.[model]].filter((l): l is string => !!l);
    if (!wanted.length) return undefined;
    const levels = await this.levelsOf(runtime, model);
    return wanted.find((l) => levels.includes(l));
  }

  /** Sets an agent's own reasoning effort level (null: back to the project's level for its model). core can't change the human's. */
  async setEffort(project: Project, agent: Agent, level: string | null, by: "human" | "coordinator"): Promise<string> {
    if (agent.status === "stopped") throw new Error(`${agent.name} is stopped.`);
    if (by === "coordinator" && agent.effort?.by === "human" && agent.effort.level !== level) {
      throw new Error(`The human set ${agent.name}'s reasoning effort to ${agent.effort.level}; only they can change it.`);
    }
    const runtime = this.team.rt(agent);
    if (level) {
      const levels = await this.levelsOf(runtime, agent.model);
      if (!levels.includes(level)) throw new Error(levelError(agent.model, level, levels));
    }
    // The session moves first: once the setting shows, the agent's next turn runs at it.
    const next = level ? { level, by } : null;
    const effective = await this.effortFor(project, { effort: next }, agent.model, runtime);
    await runtime.switchModel(agent.sessionId, agent.model, effective ?? null);
    agent.effort = next;
    await this.team.store.update(project);
    bus.publish({ type: "project.updated", projectId: project.id });
    const text = `${agent.name}'s reasoning effort: ${effective ?? "the model's default"}${level ? "" : " (as set for its model in the project)"}.`;
    await this.team.log(project, { from: "symbio", to: "human", kind: "system", text: `${text} (${by === "human" ? "by the human" : "by core"})` });
    const coordinator = this.team.coordinator(project);
    if (by === "human" && coordinator && coordinator.id !== agent.id && active(coordinator)) {
      await this.team.note(project, coordinator, `Symbio: the human set ${text}`);
    }
    return text;
  }

  /** Sets the project's level per model and applies it to the agents on those models that have no level of their own. */
  async setModelEfforts(project: Project, efforts: Record<string, string | null>) {
    const next = { ...(project.modelEfforts ?? {}) };
    for (const [model, level] of Object.entries(efforts)) {
      if (level) next[model] = level;
      else delete next[model];
    }
    const changed = Object.keys(efforts);
    const modelEfforts = Object.keys(next).length ? next : undefined;
    // Sessions move first: once the setting shows, agents' next turns run at it.
    for (const agent of project.agents.filter((a) => active(a) && !a.effort && changed.includes(a.model))) {
      const runtime = this.team.runtimes.get(runtimeOf(agent));
      if (runtime?.state !== "running") continue; // applied when its session next changes
      const effort = await this.effortFor({ ...project, modelEfforts }, agent, agent.model, runtime);
      await runtime.switchModel(agent.sessionId, agent.model, effort ?? null).catch((err) => console.error(`[team] effort for ${agent.name}:`, err.message));
    }
    project.modelEfforts = modelEfforts;
    await this.team.store.update(project);
    bus.publish({ type: "project.updated", projectId: project.id });
  }
}
