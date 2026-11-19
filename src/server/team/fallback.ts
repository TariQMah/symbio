// Failing providers: an agent whose model fails (quota, outage, timeouts) is switched to the next
// allowed model; one whose conversation got too large to send continues in a fresh session; when
// nothing is left, the human is told, and resumeStuck wakes the agents once models are back.

import { bus } from "../bus.js";
import { modelsFor, type Agent, type Project } from "../store.js";
import { active, type TeamCore } from "./core.js";

// A failed model is skipped for this long; switch after this many provider retries.
const FAILED_MODEL_COOLDOWN_MS = 30 * 60_000;
const RETRIES_BEFORE_FALLBACK = 4;
const RETRIES_BEFORE_FALLBACK_ON_TIMEOUT = 2;
/** A pinned agent's retries: growing pauses, then every 10 minutes. */
// SYMBIO_PINNED_RETRY_SECONDS (e.g. "1,2") shortens them, for the end-to-end tests.
const retryOverride = (process.env.SYMBIO_PINNED_RETRY_SECONDS ?? "").split(",").map(Number).filter((n) => n > 0);
export const PINNED_RETRY_SECONDS = retryOverride.length ? retryOverride : [15, 30, 60, 120, 300, 600];
/** A pinned model still failing after this long is reported to the human (once). */
const PINNED_ALERT_AFTER_MS = 60 * 60_000;
/** A failure this long after the last retry starts the pauses over (the model had recovered). */
const PINNED_FRESH_AFTER_MS = 15 * 60_000;

/** Errors waiting won't fix: the model is gone or the key is refused. */
const permanentFailure = (status: number, message: string) =>
  [401, 403, 404].includes(status) || /not available|not found|does not exist|unauthori[sz]ed|invalid (api )?key|forbidden|no-route/i.test(message);

export class ModelFallback {
  private failedModels = new Map<string, Map<string, number>>(); // agentId → model → failedAt
  private busy = new Set<string>();
  /** When each agent last got a fresh session because its conversation was too large to send. */
  private oversizedAt = new Map<string, number>();
  /** Pinned agents' scheduled retries. */
  private retries = new Map<string, NodeJS.Timeout>();

  constructor(private readonly team: TeamCore) {}

  /** A provider retry event: after a few, stop waiting and fall back. */
  onRetry(project: Project, agent: Agent, data: any) {
    const attempt = Number(data?.attempt ?? data?.retry?.attempt ?? 0);
    const error = data?.error ?? data?.retry?.error ?? { message: "provider not responding" };
    // A timed-out attempt already cost minutes of waiting; don't sit through four of them.
    const timedOut = /timed? ?out/i.test(String(error?.message ?? ""));
    if (attempt >= (timedOut ? RETRIES_BEFORE_FALLBACK_ON_TIMEOUT : RETRIES_BEFORE_FALLBACK)) {
      void this.onFailure(project, agent, error, true);
    }
  }

  /**
   * When an agent's model fails for provider reasons (quota, outage, timeouts), switch it to the
   * next allowed model and tell it to continue.
   */
  async onFailure(project: Project, agent: Agent, error: any, interruptFirst = false) {
    if (agent.status === "stopped" || this.busy.has(agent.id)) return;
    const message = String(error?.message ?? error ?? "unknown error");
    const type = String(error?.type ?? "");
    const status = Number(error?.status ?? 0);
    if (/interrupt|abort|cancel/i.test(`${type} ${message}`)) return; // our own interrupts
    // The conversation itself is too big to send (seen with Copilot: "Timed out reading request
    // body", after an agent read several large images). Another model won't help; a fresh session will.
    if (status === 413 || /request body|request size|payload too large|request too large|request entity too large/i.test(message)) {
      // Still retrying the same oversized request: stop it before moving on.
      if (interruptFirst) await this.team.rt(agent).interrupt(agent.sessionId).catch(() => {});
      await this.renewOversized(project, agent, message);
      return;
    }
    const providerProblem =
      type.startsWith("provider") ||
      [401, 402, 403, 404, 408, 429].includes(status) ||
      status >= 500 ||
      /limit|quota|not available|unavailable|timed out|timeout|overloaded|rate|not responding/i.test(message);
    if (!providerProblem) return;
    // Pinned to its model: wait and retry it, never another.
    if (agent.modelPinned) {
      await this.waitForPinned(project, agent, message, status, interruptFirst);
      return;
    }

    this.busy.add(agent.id);
    try {
      const failed = this.failedModels.get(agent.id) ?? new Map<string, number>();
      this.failedModels.set(agent.id, failed);
      failed.set(agent.model, Date.now());
      const now = Date.now();
      const next = modelsFor(project, agent.role).find((m) => m !== agent.model && !(failed.has(m) && now - failed.get(m)! < FAILED_MODEL_COOLDOWN_MS));
      if (!next) {
        if (agent.problem) return; // already reported
        const problem = `Every allowed model failed recently. Last error (${agent.model}): ${message}`;
        agent.problem = problem;
        this.team.setStatus(project, agent, "error");
        await this.team.store.update(project);
        bus.publish({ type: "project.updated", projectId: project.id });
        await this.team.log(project, {
          from: "symbio",
          to: "human",
          kind: "alert",
          text: `${agent.name} can't continue: ${problem}\n\nAdd another model to the project (Models in the sidebar) — stuck agents resume automatically — or use “Retry now” once the quota resets.`,
        });
        return;
      }
      const previous = agent.model;
      if (interruptFirst) await this.team.rt(agent).interrupt(agent.sessionId).catch(() => {});
      await this.team.setModel(project, agent, next);
      await this.team.system(project, agent, `Symbio: your model (${previous}) failed — ${message}. You were switched to ${next}. Continue where you left off.`);
    } catch (err) {
      console.error(`[fallback] ${project.name}/${agent.name}:`, (err as Error).message);
    } finally {
      this.busy.delete(agent.id);
    }
  }

  /**
   * An agent whose conversation got too large to send continues in a fresh session (with the
   * usual handoff note) and is told why. Once per 15 minutes: if the fresh one fails the same
   * way, the human is told instead of looping.
   */
  private async renewOversized(project: Project, agent: Agent, message: string) {
    const last = this.oversizedAt.get(agent.id) ?? 0;
    const cantContinue = async (problem: string) => {
      agent.problem = problem;
      this.team.setStatus(project, agent, "error");
      await this.team.store.update(project);
      bus.publish({ type: "project.updated", projectId: project.id });
      await this.team.log(project, { from: "symbio", to: "human", kind: "alert", text: `${agent.name} can't continue: ${agent.problem}` });
    };
    if (Date.now() - last < 15 * 60_000) {
      if (agent.problem) return;
      await cantContinue(`Its conversation is too large to send, even after a fresh session (${message}).`);
      return;
    }
    this.oversizedAt.set(agent.id, Date.now());
    this.busy.add(agent.id);
    try {
      agent.problem = null;
      if (agent.status !== "idle") this.team.setStatus(project, agent, "idle");
      await this.team.renewSession(project, agent, "its conversation had grown too large to send");
      await this.team.system(
        project,
        agent,
        "Symbio: your previous conversation had grown too large to send to the model (the provider said: " +
          `"${message}"), so you continue in this fresh session; the handoff note above has what carries over. ` +
          "Usually it's images read in full: each one stays in the conversation and is sent again every turn. " +
          "To look at an image, read a small copy (scaled down to about 1000 px wide) or have a helper review it. " +
          "Continue where you left off.",
      );
    } catch (err) {
      await cantContinue(`Its conversation is too large to send (${message}), and a fresh session couldn't start: ${(err as Error).message}. Use New session in its chat.`);
    } finally {
      this.busy.delete(agent.id);
    }
  }

  /**
   * A pinned agent's model failed: it waits (growing pauses, up to 10 minutes) and retries the same
   * model. Errors waiting won't fix are reported at once; a model still failing after an hour is
   * reported once, and the retries go on.
   */
  private async waitForPinned(project: Project, agent: Agent, message: string, status: number, interruptFirst: boolean) {
    if (this.busy.has(agent.id)) return;
    this.busy.add(agent.id);
    try {
      if (interruptFirst) await this.team.rt(agent).interrupt(agent.sessionId).catch(() => {});
      this.cancelRetry(agent.id);
      if (permanentFailure(status, message)) {
        agent.modelWait = null;
        const problem = `${agent.model} can't be used (${message}). ${agent.name} is pinned to it, so it isn't switched: unpin it or choose another model in its chat.`;
        if (agent.problem === problem) return;
        agent.problem = problem;
        this.team.setStatus(project, agent, "error");
        await this.team.store.update(project);
        bus.publish({ type: "project.updated", projectId: project.id });
        await this.team.log(project, { from: "symbio", to: "human", kind: "alert", text: `${agent.name} can't continue: ${problem}` });
        return;
      }
      const now = Date.now();
      const last = agent.modelWait;
      const fresh = !last || now - last.until > PINNED_FRESH_AFTER_MS;
      const attempt = fresh ? 0 : last.attempt + 1;
      const delay = PINNED_RETRY_SECONDS[Math.min(attempt, PINNED_RETRY_SECONDS.length - 1)] * 1000;
      agent.modelWait = { until: now + delay, attempt, since: fresh ? now : last.since, error: message, alerted: fresh ? false : last.alerted };
      agent.problem = `${agent.model} isn't responding (${message}). ${agent.name} is pinned to it, so it waits and tries again.`;
      this.team.setStatus(project, agent, "error");
      if (!agent.modelWait.alerted && now - agent.modelWait.since >= PINNED_ALERT_AFTER_MS) {
        agent.modelWait.alerted = true;
        await this.team.log(project, {
          from: "symbio",
          to: "human",
          kind: "alert",
          text: `${agent.name}'s pinned model ${agent.model} has been failing for over an hour (${message}). It keeps retrying every 10 minutes; unpin it in its chat to let it switch to another model.`,
        });
      }
      await this.team.store.update(project);
      bus.publish({ type: "project.updated", projectId: project.id });
      this.scheduleRetry(project, agent, delay);
    } catch (err) {
      console.error(`[fallback] ${project.name}/${agent.name}:`, (err as Error).message);
    } finally {
      this.busy.delete(agent.id);
    }
  }

  private scheduleRetry(project: Project, agent: Agent, delay: number) {
    this.cancelRetry(agent.id);
    const timer = setTimeout(() => {
      this.retries.delete(agent.id);
      void this.retryPinned(project.id, agent.id).catch((err) => console.error(`[fallback] retry ${agent.name}:`, err.message));
    }, delay);
    timer.unref?.();
    this.retries.set(agent.id, timer);
  }

  cancelRetry(agentId: string) {
    const timer = this.retries.get(agentId);
    if (timer) clearTimeout(timer);
    this.retries.delete(agentId);
  }

  /** Tries a pinned agent's model again: it's woken to continue; if the model fails again, it waits longer. */
  async retryPinned(projectId: string, agentId: string) {
    const project = this.team.store.get(projectId);
    const agent = project?.agents.find((a) => a.id === agentId);
    if (!project || !agent || !active(agent) || !agent.modelWait) return;
    this.cancelRetry(agent.id);
    const attempt = agent.modelWait.attempt + 1;
    // Keep the record (until = now) so a new failure continues the pauses instead of starting over.
    agent.modelWait = { ...agent.modelWait, until: Date.now() };
    agent.problem = null;
    this.team.setStatus(project, agent, "idle");
    await this.team.store.update(project);
    bus.publish({ type: "project.updated", projectId: project.id });
    await this.team.system(project, agent, `Symbio: trying your pinned model ${agent.model} again (attempt ${attempt + 1}). Continue where you left off.`);
  }

  /** After a restart: pinned agents that were waiting get their retries back. */
  resumeWaits() {
    for (const project of this.team.store.list()) {
      for (const agent of project.agents.filter((a) => active(a) && a.modelPinned && a.modelWait && a.problem)) {
        this.scheduleRetry(project, agent, Math.max(5000, agent.modelWait!.until - Date.now()));
      }
    }
  }

  /**
   * Wakes agents that stopped because every allowed model failed: after the human added models
   * (or with `forgetFailures`, when they want to retry the same ones).
   */
  async resumeStuck(project: Project, forgetFailures: boolean): Promise<string[]> {
    const resumed: string[] = [];
    const now = Date.now();
    for (const agent of project.agents.filter((a) => a.problem && active(a))) {
      // Pinned and waiting (Retry now): its own model, at once.
      if (agent.modelPinned) {
        if (!agent.modelWait && !forgetFailures) continue;
        agent.modelWait = agent.modelWait ?? { until: now, attempt: 0, since: now, error: agent.problem ?? "" };
        await this.retryPinned(project.id, agent.id);
        resumed.push(agent.name);
        continue;
      }
      const failed = this.failedModels.get(agent.id) ?? new Map<string, number>();
      if (forgetFailures) failed.clear();
      const usable = (m: string) => !(failed.has(m) && now - failed.get(m)! < FAILED_MODEL_COOLDOWN_MS);
      const mine = modelsFor(project, agent.role);
      const model = usable(agent.model) && mine.includes(agent.model) ? agent.model : mine.find(usable);
      if (!model) continue;
      agent.problem = null;
      if (model !== agent.model) await this.team.setModel(project, agent, model);
      await this.team.store.update(project);
      await this.team.system(project, agent, `Symbio: models are available again (you're on ${model}). Continue where you left off.`);
      resumed.push(agent.name);
    }
    if (resumed.length) bus.publish({ type: "project.updated", projectId: project.id });
    return resumed;
  }
}
