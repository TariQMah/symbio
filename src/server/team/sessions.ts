// Fresh sessions: an agent continues in a new session of its runtime, keeping its identity (name,
// folder, branch, tasks, assets), from a handoff note. Long sessions get slow, costly (every step
// re-reads the conversation) and lossy (compactions); what the team knows lives in Symbio and the
// project's documents, so a new session loses little. Also the agent's "last words" (one more turn
// answered as text, its own handoff) and the handoff note Symbio writes from its records.

import { bus } from "../bus.js";
import { accountUsage, emptyUsage } from "../costs.js";
import type { PermissionRule } from "../guard.js";
import { runtimeOf, type AgentRuntime } from "../runtime/types.js";
import type { Agent, Project } from "../store.js";
import type { TeamCore } from "./core.js";

/** What fresh sessions need of the Team, besides TeamCore. */
export interface SessionsHost extends TeamCore {
  permissionsFor(project: Project, agent: Pick<Agent, "role">): PermissionRule[];
  /** The URL of Symbio's tool server for a folder. */
  toolsUrl(project: Project, directory: string): string;
  effortFor(project: Project, agent: Pick<Agent, "effort"> | null, model: string, runtime: AgentRuntime): Promise<string | undefined>;
  /** The skills an agent's session has. */
  skillsFor(project: Project, agent: Pick<Agent, "role"> & Partial<Pick<Agent, "skills">>): string[];
  /** Sends an agent's brief and permissions to its session again. */
  refreshInstructions(project: Project, agent: Agent): Promise<void>;
  /** Before starting an agent's turn: its runtime, folder, tools and private docs in place. */
  prepare(project: Project, agent: Agent): Promise<void>;
  /** Prompts an agent's session and marks it working (unless its turn already ended). */
  wake(project: Project, agent: Agent, text: string, delivery: "queue" | "steer"): Promise<string | undefined>;
  /** Counts what an agent's session has used so far. */
  refreshUsage(project: Project, agent: Agent): Promise<void>;
  /** Forgets what was tied to an agent's old session: queued messages, an open question. */
  forgetSession(agent: Agent): void;
}

export interface HandoffOptions {
  /** It moved from its own copy into the project folder. */
  moved?: boolean;
  /** The human gave it the fresh session; `own` is the agent's own handoff, when it wrote one. */
  byHuman?: { own: string | null };
  /** The project moved to another runtime; `own` is the agent's own handoff, when it wrote one. */
  switched?: { from: string; to: string; own: string | null };
}

/** What the agent is asked for in a last turn, before a fresh session the human gave it. */
export const RENEW_HANDOFF_REQUEST =
  "Symbio: the human is giving you a fresh session. This is your last turn in this one: you'll continue as yourself in a new " +
  "session that starts only from a handoff note. Write your part of that note now, as your answer (no tools, and don't start new " +
  "work): what you're in the middle of and the exact next step, decisions made and why, what you learned that isn't in the plan, " +
  "tasks or the project's documents (gotchas, commands, where things are), and anything you're waiting for. Be specific; skip " +
  "what the plan, your tasks and the documents already say. If something belongs in the documents or the glossary, say so.";

export class Sessions {
  /** Agents getting a fresh session right now (one at a time each). */
  private readonly renewing = new Set<string>();

  constructor(private readonly team: SessionsHost) {}

  /**
   * Gives an agent a fresh session; the old one stays readable. With `ownHandoff`, the agent first
   * writes its own handoff in a last turn (the human's choice), which goes into the note.
   */
  async renew(project: Project, agent: Agent, reason: string, opts: { moved?: boolean; ownHandoff?: boolean } = {}): Promise<void> {
    if (this.renewing.has(agent.id)) throw new Error(`${agent.name} is already moving to a fresh session.`);
    this.renewing.add(agent.id);
    try {
      await this.renewNow(project, agent, reason, opts);
    } finally {
      this.renewing.delete(agent.id);
    }
  }

  private async renewNow(project: Project, agent: Agent, reason: string, opts: { moved?: boolean; ownHandoff?: boolean }): Promise<void> {
    const team = this.team;
    if (agent.status === "busy" || agent.status === "waiting" || agent.status === "stuck") {
      throw new Error(`${agent.name} is working; give it a fresh session when it's idle.`);
    }
    if (agent.status === "stopped") throw new Error(`${agent.name} is stopped.`);
    const runtime = team.rt(agent);
    const oldSession = agent.sessionId;

    const own = opts.ownHandoff ? await this.lastWords(project, agent, RENEW_HANDOFF_REQUEST).catch(() => "") : null;
    // Count everything the old session used before leaving it.
    await team.refreshUsage(project, agent).catch(() => {});
    const handoff = await this.handoffNote(project, agent, oldSession, {
      moved: opts.moved,
      ...(opts.ownHandoff ? { byHuman: { own: own || null } } : {}),
    });

    const sessionId = await runtime.createSession({
      title: `${project.name} · ${agent.name}`,
      directory: agent.directory,
      model: agent.model,
      permissions: team.permissionsFor(project, agent),
      toolsUrl: team.toolsUrl(project, agent.directory),
      effort: await team.effortFor(project, agent, agent.model, runtime),
      skills: team.skillsFor(project, agent),
    });
    agent.previousSessions = [...(agent.previousSessions ?? []), { sessionId: oldSession, endedAt: Date.now(), runtime: runtimeOf(agent) }];
    agent.sessionId = sessionId;
    accountUsage(agent, agent.usage ?? emptyUsage());
    agent.usage = emptyUsage();
    agent.usageSeen = emptyUsage();
    agent.context = null;
    agent.status = "idle";
    agent.lastActivity = Date.now();
    team.forgetSession(agent);
    await team.store.update(project);
    await team.refreshInstructions(project, agent);
    await runtime.setInstruction(agent.sessionId, "symbio-handoff", handoff);
    await team.log(project, {
      from: "symbio",
      to: "human",
      kind: "system",
      text: `${agent.name} continues in a fresh session (${reason}). Its earlier conversation is still readable in its chat.`,
    });
    bus.publish({ type: "project.updated", projectId: project.id });
  }

  /** With "after-task" renewal, a helper with no other task under way gets a fresh session. */
  async renewAfterTask(project: Project, agent: Agent, reason: string): Promise<boolean> {
    const plan = await this.team.plan(project);
    const renew =
      project.renewSessions === "after-task" &&
      agent.status === "idle" &&
      !plan.plan.tasks.some((t) => t.assignee === agent.id && t.status !== "done" && t.status !== "todo");
    if (!renew) return false;
    await this.renew(project, agent, reason).catch((err) => console.error(`[renew] ${agent.name}:`, err.message));
    return true;
  }

  /**
   * One more turn for an agent, answered as text (its handoff before a runtime switch): sent even
   * while the team is paused, and waited for (up to 5 minutes, then interrupted).
   */
  async lastWords(project: Project, agent: Agent, request: string): Promise<string> {
    const team = this.team;
    await team.prepare(project, agent);
    const runtime = team.rt(agent);
    await team.log(project, { from: "symbio", to: agent.id, kind: "system", text: request });
    await team.wake(project, agent, request, "queue");
    const end = Date.now() + 5 * 60_000;
    // The status follows the session's events (busy → idle); a question to the human ends it too.
    await new Promise((r) => setTimeout(r, 1000));
    while (agent.status === "busy" && Date.now() < end) await new Promise((r) => setTimeout(r, 500));
    if (agent.status !== "idle") {
      await runtime.interrupt(agent.sessionId).catch(() => {});
      team.setStatus(project, agent, "idle");
    }
    // Its answer: the text of the assistant messages after the request.
    const { messages } = await runtime.historyPage(agent.sessionId, 20);
    const after = messages.slice(messages.findLastIndex((m: any) => m.type === "user") + 1);
    return after
      .filter((m: any) => m.type === "assistant")
      .flatMap((m: any) => (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text))
      .join("\n")
      .trim();
  }

  /** What an agent needs to carry on in a fresh session, from Symbio's own records. */
  async handoffNote(project: Project, agent: Agent, oldSession: string, opts: HandoffOptions = {}): Promise<string> {
    const team = this.team;
    const { moved, switched, byHuman } = opts;
    const plan = (await team.plan(project)).plan;
    const reg = await team.assets(project);
    const mine = plan.tasks.filter((t) => t.assignee === agent.id);
    const open = mine.filter((t) => t.status !== "done");
    const done = mine.filter((t) => t.status === "done").slice(-8);
    const lastNote = (t: (typeof mine)[number]) => t.notes?.filter((n) => n.by === agent.name).at(-1)?.text;
    const held = reg.list().filter((a) => a.holder === agent.id).map((a) => a.name);
    const log = (await team.store.readMessages(project)).filter((m) => m.from === agent.id || m.to === agent.id).slice(-8);
    const nameOf = (id: string) => (id === "human" ? "human" : id === "symbio" ? "Symbio" : team.agentName(project, id) ?? id);
    // The old session's runtime may be gone (a switch away from an uninstalled one): the note still works.
    const lastText = await Promise.resolve()
      .then(() => team.rt(agent).historyPage(oldSession, 30))
      .then(({ messages }) => {
        const last = messages.filter((m) => m.type === "assistant" && (m.content ?? []).some((c: any) => c.type === "text" && c.text)).at(-1);
        return (last?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      })
      .catch(() => "");
    const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

    const parts = [
      `# Handoff: you are continuing as ${agent.name} in a fresh session`,
      (switched
        ? `The human moved this project from ${switched.from} to ${switched.to}, so you continue in a new session on ${switched.to}. ` +
          `Nothing about your role changed, but your tools may be named and behave a little differently here: check before relying on habits. ` +
          `Background processes you had running were stopped; start again the ones you need. `
        : moved
          ? `You now work in the project folder itself instead of your own copy, so Symbio started a new session there. ` +
            `Nothing else about your role changed. `
          : byHuman
            ? `The human gave you a fresh session. Nothing about your role changed. `
            : `Your previous session had grown long, so Symbio started a new one. Nothing about your role changed. `) +
        `This note is what carries over; the project's docs (AGENTS.md, docs/) hold the durable knowledge, ` +
        `and your work is in your folder.`,
      agent.purpose ? `**Your purpose:** ${agent.purpose}` : "",
      agent.role === "coordinator"
        ? `**Plan:** ${plan.status}${plan.goal ? ` — ${plan.goal}` : ""}\n${plan.tasks.map((t) => `- ${t.id} [${t.status}] ${t.title}${t.assignee ? ` (${nameOf(t.assignee)})` : ""}`).join("\n")}`
        : "",
      agent.role === "coordinator"
        ? ""
        : agent.branch
          ? `**Your folder:** ${agent.directory} (branch ${agent.branch}).`
          : `**Your folder:** ${agent.directory} (the project folder, shared with the team).`,
      open.length
        ? `**Your open tasks:**\n${open.map((t) => `- ${t.id} [${t.status}] ${t.title}\n  ${cut(t.description, 600)}${t.doneWhen ? `\n  Done when: ${cut(t.doneWhen.replace(/\s*\n\s*/g, "; "), 600)}` : ""}`).join("\n")}`
        : "**Open tasks:** none right now; wait for the next one.",
      done.length ? `**Recently finished:**\n${done.map((t) => `- ${t.id} ${t.title}${lastNote(t) ? ` — ${cut(lastNote(t)!, 300)}` : ""}`).join("\n")}` : "",
      held.length ? `**Shared assets you hold:** ${held.join(", ")} (release them when done).` : "",
      log.length ? `**Latest messages:**\n${log.map((m) => `- ${nameOf(m.from)} → ${nameOf(m.to)} (${m.kind}): ${cut(m.text.replace(/\s+/g, " "), 400)}`).join("\n")}` : "",
      switched?.own || byHuman?.own
        ? `**Your own handoff, written at the end of your previous session:**\n${cut((switched?.own || byHuman?.own)!, 6000)}`
        : lastText
          ? `**Your last answer in the previous session:**\n${cut(lastText, 2500)}`
          : "",
    ];
    return parts.filter(Boolean).join("\n\n");
  }
}
