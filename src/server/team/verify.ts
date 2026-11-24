// What happens between a helper's report and core: the project's checks (commands Symbio runs
// itself, checks.ts), then, when the human requires it, a reviewer (a one-off helper that checks the
// work against the task's Done when, the rules and the glossary). A failing check or a reviewer's
// findings go back to the helper without spending core's or the human's attention; core hears of
// the task once it got through. Checks run again before a merge when the work changed since.

import { approvedChecks, describeFailures, passedNames, runChecks, type CheckRun } from "../checks.js";
import { git } from "../git.js";
import type { Task } from "../plan.js";
import type { Agent, Project } from "../store.js";
import { active, type TeamCore } from "./core.js";
import type { Reviews } from "./review.js";

/** What verification needs of the Team, besides TeamCore. */
export interface VerifyHost extends TeamCore {
  readonly reviews: Reviews;
  stopAgent(project: Project, agent: Agent, reason: string): Promise<string>;
  /** Creates a reviewer for a task: a helper in the task's helper's folder that can't edit files. */
  createReviewer(project: Project, task: Task, helper: Agent, by: "coordinator" | "required"): Promise<Agent>;
}

/** After this many returns of the same task, core is told too (the helper may be stuck in a loop). */
const RETURNS_BEFORE_CORE = 3;

export class Verifier {
  /** Tasks whose checks are running now ("project:task"). */
  private readonly running = new Set<string>();
  /** How many times in a row each task came back to its helper ("project:task"). */
  private readonly returns = new Map<string, number>();
  /** Reviewers already reminded to give their verdict. */
  private readonly nudged = new Set<string>();

  constructor(private readonly team: VerifyHost) {}

  checking(project: Project, taskId: string): boolean {
    return this.running.has(`${project.id}:${taskId}`);
  }

  /**
   * A helper reported a task for review (its status is already "review"). Returns what the helper
   * is told; the checks run in the background, and core hears of the task once they pass.
   */
  async reported(project: Project, helper: Agent, taskId: string, note?: string): Promise<string> {
    const checks = approvedChecks(project.checks);
    if (!checks.length) return this.passedChecks(project, helper, taskId, note, null);
    const key = `${project.id}:${taskId}`;
    if (this.running.has(key)) return `Symbio is still running the checks on ${taskId}; you'll hear back. End your turn.`;
    this.running.add(key);
    const store = await this.team.plan(project);
    await store.update(taskId, { checks: { state: "running", at: Date.now(), when: "report", results: [] } });
    this.team.planChanged(project);
    void this.checkReport(project, helper, taskId, note)
      .catch((err) => console.error(`[checks] ${project.name}/${taskId}:`, err.message))
      .finally(() => this.running.delete(key));
    return (
      `${taskId} is reported. Symbio is running the project's checks (${checks.map((c) => c.name).join(", ")}) on your work: ` +
      "if one fails, you get its output to fix it; otherwise your report goes on to the coordinator. End your turn now."
    );
  }

  private async checkReport(project: Project, helper: Agent, taskId: string, note?: string) {
    const run = await runChecks(approvedChecks(project.checks), helper.directory, "report", await snapshot(helper.directory));
    // Done running: what follows (a reviewer, the report to core) mustn't see them as still running.
    this.running.delete(`${project.id}:${taskId}`);
    const store = await this.team.plan(project);
    const task = await store.update(taskId, { checks: run });
    this.team.planChanged(project);
    // Moved on meanwhile (core sent it back, the helper was stopped): the result is on the task, that's all.
    if (task.status !== "review" || task.assignee !== helper.id || !active(helper)) return;
    if (run.state === "failed") {
      await this.sendBack(project, helper, task, `the project's checks failed:\n\n${describeFailures(run)}`, "checks failed");
      return;
    }
    await this.passedChecks(project, helper, taskId, note, run);
  }

  /** Checks passed (or there are none): a reviewer when the human requires one, else core. */
  private async passedChecks(project: Project, helper: Agent, taskId: string, note: string | undefined, run: CheckRun | null): Promise<string> {
    if (project.requireReviewer) {
      await this.startReview(project, taskId, "required");
      return `${taskId} is reported. A reviewer checks it before the coordinator sees it; if it finds something, you'll hear from Symbio.`;
    }
    await this.toCoordinator(project, helper, taskId, note, run ? [`Symbio's checks passed: ${passedNames(run)}.`] : []);
    return `${taskId} is now review. The coordinator has been notified — no separate report needed.`;
  }

  /** The helper's report, delivered to core (with what checks and reviewers found). */
  async toCoordinator(project: Project, helper: Agent, taskId: string, note: string | undefined, extra: string[]) {
    const coordinator = this.team.coordinator(project);
    if (!coordinator) return;
    const store = await this.team.plan(project);
    const task = store.task(taskId);
    this.returns.delete(`${project.id}:${taskId}`);
    const report = note ?? [...task.notes].reverse().find((n) => n.by === helper.name)?.text;
    const humanReviews = this.team.reviews.gated(project, task);
    await this.team.deliver(
      project,
      helper,
      coordinator,
      "task-review",
      `${task.id} "${task.title}" → review${report ? `: ${report}` : ""}` +
        (extra.length ? `\n${extra.join("\n")}` : "") +
        (helper.branch
          ? `\nMerge with merge_work("${helper.name}") when it looks right.`
          : `\nIts work is already in the project folder; check it there, then mark the task done (update_task) or send it back.`) +
        (humanReviews ? "\nThen it waits for the human's review, with the helper's guide." : ""),
    );
  }

  /** Sends a task back to its helper with what was found; core is told when it keeps coming back. */
  private async sendBack(project: Project, helper: Agent, task: Task, why: string, short: string) {
    const key = `${project.id}:${task.id}`;
    const times = (this.returns.get(key) ?? 0) + 1;
    this.returns.set(key, times);
    const store = await this.team.plan(project);
    await store.update(task.id, { status: "in-progress", note: { by: "symbio", text: `Sent back to ${helper.name}: ${short}.` } });
    this.team.planChanged(project);
    await this.team.system(
      project,
      helper,
      `Symbio: ${task.id} "${task.title}" came back to you: ${why}\n\n` +
        `Fix it, then report again with update_task("${task.id}", "review", <summary>).`,
    );
    const coordinator = this.team.coordinator(project);
    if (times >= RETURNS_BEFORE_CORE && coordinator && active(coordinator)) {
      await this.team.system(
        project,
        coordinator,
        `Symbio: ${task.id} has come back to ${helper.name} ${times} times in a row (latest: ${short}). Take a look: it may need ` +
          "a different approach, a change to its Done when, or the human.",
      );
    }
  }

  /** Checks left running when Symbio stopped: run them again, as if the helper had just reported. */
  async resume(project: Project, store: { plan: { tasks: Task[] } }) {
    for (const task of store.plan.tasks.filter((t) => t.status === "review" && t.checks?.state === "running")) {
      const helper = task.assignee ? project.agents.find((a) => a.id === task.assignee) : undefined;
      if (helper && active(helper) && !this.checking(project, task.id)) await this.reported(project, helper, task.id);
    }
  }

  // ---------------------------------------------------------------- reviewers

  /** Starts a reviewer on a task in review: by core's request, or because the human requires one. */
  async startReview(project: Project, taskId: string, by: "coordinator" | "required", focus?: string): Promise<string> {
    const store = await this.team.plan(project);
    const task = store.task(taskId);
    if (task.status !== "review") throw new Error(`${task.id} is ${task.status}; a reviewer checks tasks in review.`);
    const helper = task.assignee ? project.agents.find((a) => a.id === task.assignee) : undefined;
    if (!helper || !active(helper)) throw new Error(`${task.id} has no active helper; its work can't be reviewed in place.`);
    const current = task.reviewer ? project.agents.find((a) => a.id === task.reviewer) : undefined;
    if (current && active(current) && !current.reviewer?.done) return `${current.name} is already reviewing ${task.id}.`;
    if (this.checking(project, task.id)) throw new Error(`Symbio is still running the checks on ${task.id}; ask again once they're done.`);
    const reviewer = await this.team.createReviewer(project, task, helper, by);
    await store.update(task.id, { reviewer: reviewer.id, note: { by: "symbio", text: `${reviewer.name} is reviewing it.` } });
    this.team.planChanged(project);
    await this.team.system(project, reviewer, reviewAssignment(task, helper, focus));
    return `${reviewer.name} is reviewing ${task.id} in ${helper.name}'s folder. Its verdict comes to you as a message${by === "coordinator" ? "" : " if it passes"}.`;
  }

  /** A reviewer's verdict: passed on to core, or back to the helper with the findings. */
  async submitReview(project: Project, reviewer: Agent, taskId: string, verdict: "pass" | "changes", findings: string): Promise<string> {
    const role = reviewer.reviewer;
    if (!role || role.taskId !== taskId.toUpperCase()) throw new Error(`You aren't reviewing ${taskId}.`);
    if (role.done) throw new Error("Your verdict is already in.");
    if (verdict !== "pass" && verdict !== "changes") throw new Error('verdict is "pass" or "changes".');
    if (!findings.trim()) throw new Error("Give your findings: what you checked, and what's wrong when it's changes.");
    const store = await this.team.plan(project);
    let task = store.task(taskId);
    task = await store.update(task.id, { addReview: { by: reviewer.name, verdict, findings: findings.trim(), at: Date.now() }, reviewer: null });
    this.team.planChanged(project);
    role.done = true;
    await this.team.store.update(project);
    await this.team.log(project, {
      from: "symbio",
      to: "human",
      kind: "system",
      text: `${reviewer.name} reviewed ${task.id}: ${verdict === "pass" ? "it passes" : "changes needed"}.`,
    });

    const helper = project.agents.find((a) => a.id === role.of);
    const coordinator = this.team.coordinator(project);
    const changes = (task.reviews ?? []).filter((r) => r.verdict === "changes").length;
    if (verdict === "pass") {
      if (role.by === "required" && helper) await this.toCoordinator(project, helper, task.id, undefined, [`Reviewed by ${reviewer.name}: it passes.\n${findings.trim()}`]);
      else if (coordinator && active(coordinator)) {
        await this.team.system(project, coordinator, `Symbio: ${reviewer.name} reviewed ${task.id} "${task.title}": it passes.\n${findings.trim()}`);
      }
    } else if (helper && active(helper) && task.status === "review" && changes < RETURNS_BEFORE_CORE) {
      await this.sendBack(project, helper, task, `a reviewer (${reviewer.name}) found it isn't done yet:\n\n${findings.trim()}`, `${reviewer.name} asked for changes`);
      if (role.by === "coordinator" && coordinator && active(coordinator)) {
        await this.team.system(project, coordinator, `Symbio: ${reviewer.name} sent ${task.id} back to ${helper.name} with its findings (it's in the task).`, false);
      }
    } else if (coordinator && active(coordinator)) {
      await this.team.system(
        project,
        coordinator,
        `Symbio: ${reviewer.name} reviewed ${task.id} "${task.title}" and asked for changes` +
          (changes >= RETURNS_BEFORE_CORE ? ` (the ${changes}th time); it's yours to decide now` : "") +
          `:\n${findings.trim()}`,
      );
    }
    return "Your verdict is recorded. Your review is finished; end your turn (Symbio stops you then).";
  }

  /** A reviewer's turn ended: stop it once its verdict is in; remind it once if it forgot. */
  async reviewerTurnEnded(project: Project, reviewer: Agent) {
    const role = reviewer.reviewer;
    if (!role || !active(reviewer)) return;
    if (role.done) {
      await this.team.stopAgent(project, reviewer, "its review is done");
      return;
    }
    if (!this.nudged.has(reviewer.id)) {
      this.nudged.add(reviewer.id);
      await this.team.system(project, reviewer, `Symbio: give your verdict on ${role.taskId} with submit_review("${role.taskId}", "pass" or "changes", <findings>).`);
      return;
    }
    // Still no verdict: the task goes on without one.
    this.nudged.delete(reviewer.id);
    role.done = true;
    const store = await this.team.plan(project);
    await store.update(role.taskId, { reviewer: null, note: { by: "symbio", text: `${reviewer.name} gave no verdict.` } });
    this.team.planChanged(project);
    await this.team.stopAgent(project, reviewer, "it gave no verdict");
    const helper = project.agents.find((a) => a.id === role.of);
    const task = store.task(role.taskId);
    if (helper && task.status === "review") {
      if (role.by === "required") await this.toCoordinator(project, helper, task.id, undefined, [`The reviewer (${reviewer.name}) gave no verdict.`]);
      else {
        const coordinator = this.team.coordinator(project);
        if (coordinator && active(coordinator)) await this.team.system(project, coordinator, `Symbio: ${reviewer.name} ended without a verdict on ${task.id}.`);
      }
    }
  }

  // ---------------------------------------------------------------- before a merge

  /**
   * Before merging a helper's work: its tasks' checks, run again unless they already passed on this
   * exact state of its folder. Returns null when the merge may go on, or why it may not.
   */
  async beforeMerge(project: Project, helper: Agent): Promise<{ ok: true; note: string } | { ok: false; reason: string }> {
    const checks = approvedChecks(project.checks);
    if (!checks.length) return { ok: true, note: "" };
    const store = await this.team.plan(project);
    const tasks = store.plan.tasks.filter((t) => t.assignee === helper.id && t.status === "review");
    for (const t of tasks) if (this.checking(project, t.id)) return { ok: false, reason: `Symbio is still running the checks on ${t.id}; merge once they're done.` };
    const now = await snapshot(helper.directory);
    const fresh = tasks.find((t) => t.checks?.state === "passed" && now && t.checks.snapshot === now);
    if (fresh) return { ok: true, note: `Symbio's checks passed on this work (${passedNames(fresh.checks!)}).` };
    const run = await runChecks(checks, helper.directory, "merge", now);
    for (const t of tasks) await store.update(t.id, { checks: run });
    if (tasks.length) this.team.planChanged(project);
    if (run.state === "passed") return { ok: true, note: `Symbio ran the checks before merging: passed (${passedNames(run)}).` };
    return { ok: false, reason: `Symbio ran the project's checks before merging, and they failed:\n\n${describeFailures(run)}` };
  }
}

/** The state of a folder: its commit and uncommitted changes (null without git). */
async function snapshot(directory: string): Promise<string | null> {
  try {
    const head = await git(directory, "rev-parse", "HEAD");
    const changes = await git(directory, "status", "--porcelain");
    return `${head}\n${changes}`;
  } catch {
    return null;
  }
}

/** What a reviewer gets to start: the task, the helper's report, and what to do with its verdict. */
function reviewAssignment(task: Task, helper: Agent, focus?: string): string {
  const report = [...task.notes].reverse().find((n) => n.by === helper.name)?.text;
  const earlier = (task.reviews ?? []).map((r) => `- ${r.by} (${r.verdict}): ${r.findings}`).join("\n");
  const checks =
    task.checks && task.checks.state !== "running"
      ? `Symbio's checks (${task.checks.when}): ${task.checks.results.map((r) => `${r.name} ${r.ok ? "passed" : "failed"}`).join(", ")}`
      : "";
  return [
    `Symbio: review ${task.id} "${task.title}", done by ${helper.name}. Its work is in this folder${helper.branch ? ` (branch ${helper.branch})` : ""}.`,
    task.description ? `\nThe task:\n${task.description}` : "",
    task.spec ? `\nIts spec (what the human decided; read it): ${task.spec}` : "",
    task.doneWhen ? `\nDone when:\n${task.doneWhen}` : "\nIt has no Done when: judge it by the task and what the human asked.",
    report ? `\n${helper.name}'s report:\n${report}` : "",
    task.guide ? `\nIts guide for checking it:\n${task.guide}` : "",
    checks ? `\n${checks}` : "",
    earlier ? `\nEarlier reviews:\n${earlier}` : "",
    focus ? `\nThe coordinator asks you to look especially at: ${focus}` : "",
    `\nLoad your review skill and follow it: check each point of Done when yourself, against the project's rules and glossary. ` +
      `Don't change any file. Then call submit_review("${task.id}", "pass" or "changes", <findings>): what you checked and, for changes, ` +
      "what's wrong and where, concretely enough to fix without asking you.",
  ]
    .filter(Boolean)
    .join("\n");
}
