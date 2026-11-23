// The plan's task flow: proposing and deciding the plan, adding and assigning tasks, a helper's
// report (update_task), and merging a helper's work (which completes its tasks in review, or hands
// them to the human when they review the work).

import { changedFiles, mergeWorkspace, syncWorkspace } from "../workspaces.js";
import type { TaskInput, TaskStatus } from "../plan.js";
import type { Agent, Project } from "../store.js";
import type { TeamCore } from "./core.js";
import type { QuietHelpers } from "./quiet-helpers.js";
import type { Reviews } from "./review.js";

/** What the task flow needs of the Team, besides TeamCore. */
export interface TaskFlowHost extends TeamCore {
  readonly reviews: Reviews;
  readonly quiet: QuietHelpers;
}

export class TaskFlow {
  constructor(private readonly team: TaskFlowHost) {}

  async submitPlan(project: Project, coordinator: Agent, goal: string, tasks: TaskInput[]): Promise<string> {
    const store = await this.team.plan(project);
    const plan = await store.propose(goal, tasks);
    this.team.planChanged(project);
    await this.team.log(project, {
      from: coordinator.id,
      to: "human",
      kind: "plan",
      text: `Proposed a plan (revision ${plan.revision}, ${plan.tasks.length} tasks) — review it in the Plan tab.\n\n**Goal:** ${plan.goal}`,
    });
    return (
      `Plan submitted (revision ${plan.revision}): ${plan.tasks.map((t) => t.id).join(", ")}. ` +
      `The human reviews it in Symbio's Plan tab; their decision arrives as a message. ` +
      `Don't start assigning work until it is approved. Tell the human briefly that the plan is ready for review.`
    );
  }

  async decidePlan(project: Project, approved: boolean, feedback: string | null) {
    const store = await this.team.plan(project);
    const plan = await store.decide(approved, feedback);
    this.team.planChanged(project);
    const coordinator = this.team.coordinator(project);
    if (!coordinator) return;
    const text = approved
      ? `✅ I approved the plan (revision ${plan.revision}).${feedback ? ` Note: ${feedback}` : ""} Assign the tasks to helpers.`
      : `✏️ I'd like changes to the plan (revision ${plan.revision}): ${feedback ?? "(no details)"}\nRevise it and submit it again.`;
    await this.team.sendFromHuman(project, coordinator, text);
  }

  async addTask(project: Project, input: TaskInput): Promise<string> {
    const store = await this.team.plan(project);
    const task = await store.addTask(input);
    this.team.planChanged(project);
    return `Added ${task.id}: ${task.title}.`;
  }

  /** Gives a task to a helper: marks it in progress and sends the helper the task. */
  async assignTask(project: Project, coordinator: Agent, taskId: string, helper: Agent, extra?: string): Promise<string> {
    if (helper.role === "coordinator") {
      throw new Error("Tasks are done by helpers, not the coordinator. Assign it to a helper (spawn one if needed).");
    }
    const store = await this.team.plan(project);
    if (store.plan.status === "proposed" || store.plan.status === "changes-requested") {
      throw new Error("The plan isn't approved yet. Wait for the human's approval before assigning work.");
    }
    const task = store.task(taskId);
    const open = store.openDependencies(task);
    if (open.length) {
      throw new Error(`${task.id} depends on unfinished task(s): ${open.map((t) => `${t.id} (${t.status})`).join(", ")}.`);
    }
    await store.update(task.id, { assignee: helper.id, status: "in-progress", note: { by: coordinator.name, text: `assigned to ${helper.name}` } });
    this.team.planChanged(project);
    const assets = task.assets.length ? `\nShared assets involved: ${task.assets.join(", ")} — request them before changing them.` : "";
    const assignment = await this.team.deliver(
      project,
      coordinator,
      helper,
      "request",
      `Task ${task.id}: ${task.title}\n\n${task.description}${assets}${extra ? `\n\n${extra}` : ""}\n\n` +
        `When it's done, ${helper.branch ? "commit your work and " : ""}call update_task("${task.id}", "review", <summary>) — that is your report. ` +
        `If you get stuck, update_task("${task.id}", "blocked", <why>).`,
      { protocol: true },
    );
    // Where the work starts in the helper's session: the task's changes are diffed from here.
    if (assignment) await store.update(task.id, { work: [...(task.work ?? []).filter((w) => w.sessionId !== helper.sessionId), { sessionId: helper.sessionId, from: assignment }] });
    return `Assigned ${task.id} to ${helper.name}.`;
  }

  async updateTask(
    project: Project,
    agent: Agent,
    taskId: string,
    status: TaskStatus | undefined,
    note: string | undefined,
    guide?: string,
  ): Promise<string> {
    const store = await this.team.plan(project);
    const task = store.task(taskId);
    if (agent.role !== "coordinator" && task.assignee !== agent.id) {
      throw new Error(`${task.id} isn't assigned to you. Ask the coordinator.`);
    }
    const reviewed = this.team.reviews.gated(project, task);
    if (agent.role === "worker" && status === "review" && reviewed && !guide?.trim()) {
      throw new Error(
        "The human reviews this task, so report it with a guide: where to look (URLs, files or folders), the steps to check it and " +
          "what they should see, and whether you already ran those steps yourself. Call update_task again with guide.",
      );
    }
    if (agent.role === "worker") this.team.quiet.reported(agent); // any update on its task is news for core
    // Finished work the human reviews isn't done until they approve it.
    if (status === "done" && reviewed && task.humanReview?.state !== "approved") {
      if (note || guide) await store.update(task.id, { note: note ? { by: agent.name, text: note } : undefined, guide });
      await this.team.reviews.complete(project, task.id, agent.name);
      return `${task.id} now waits for the human's review (they check it with its guide); it's done when they approve, and tasks that depend on it wait meanwhile. You don't need to remind them.`;
    }
    if (agent.role === "worker" && status === "review") await this.team.reviews.recordReport(project, agent, task.id).catch(() => {});
    await store.update(task.id, {
      status,
      note: note ? { by: agent.name, text: note } : undefined,
      guide,
      // Reported again after being sent back: the next review starts fresh.
      ...(agent.role === "worker" && status === "review" ? { humanReview: null } : {}),
    });
    this.team.planChanged(project);

    // A helper's review/blocked update is its report to the coordinator.
    const coordinator = this.team.coordinator(project);
    if (coordinator && agent.role !== "coordinator" && (status === "review" || status === "blocked")) {
      await this.team.deliver(
        project,
        agent,
        coordinator,
        status === "review" ? "task-review" : "task-blocked",
        `${task.id} "${task.title}" → ${status}${note ? `: ${note}` : ""}` +
          (status === "review"
            ? (agent.branch
                ? `\nMerge with merge_work("${agent.name}") when it looks right.`
                : `\nIts work is already in the project folder; check it there, then mark the task done (update_task) or send it back.`) +
              (reviewed ? "\nThen it waits for the human's review, with the helper's guide." : "")
            : ""),
      );
      return `${task.id} is now ${status}. The coordinator has been notified — no separate report needed.`;
    }
    // Helpers without a branch have nothing to merge: the coordinator marking their task done
    // is the moment a fresh session fits (what merging is for the others).
    const helper = task.assignee ? project.agents.find((a) => a.id === task.assignee) : undefined;
    if (agent.role === "coordinator" && status === "done" && helper && !helper.branch && helper.role !== "coordinator") {
      await this.team.renewAfterTask(project, helper, "its task was done");
    }
    return `${task.id} is now ${task.status}.`;
  }

  async mergeWork(project: Project, agent: Agent, force: boolean): Promise<string> {
    const { committed, uncommitted } = await changedFiles(agent);
    const reg = await this.team.assets(project);
    // Asset patterns are relative to the project folder; a sub-repository's paths are relative to it.
    const inProject = (f: string) => (agent.repo ? `${agent.repo}/${f}` : f);
    const violations = reg.violations([...committed, ...uncommitted].map(inProject), agent.id, agent.workSince ?? agent.createdAt);
    if (violations.length && !force) {
      const list = violations.map((v) => `- "${v.asset.name}": ${v.files.join(", ")}`).join("\n");
      return `Not merged: ${agent.name} changed shared assets it was not granted:\n${list}\nReview the changes, then grant the asset and merge again, ask ${agent.name} to revert them, or merge with force=true.`;
    }
    const result = await mergeWorkspace(project, agent);
    if (!result.ok) return `Not merged: ${result.reason}${result.files?.length ? `\nFiles: ${result.files.join(", ")}` : ""}`;

    agent.base = await syncWorkspace(project, agent);
    agent.workSince = Date.now();
    await this.team.store.update(project);

    // Merged work completes the helper's tasks that were waiting for review (or hands them to the
    // human, when they review the work).
    const plan = await this.team.plan(project);
    const completed: string[] = [];
    const waiting: string[] = [];
    for (const task of plan.plan.tasks.filter((t) => t.assignee === agent.id && t.status === "review" && t.humanReview?.state !== "waiting")) {
      if ((await this.team.reviews.complete(project, task.id, "symbio (merged)")) === "done") completed.push(task.id);
      else waiting.push(task.id);
    }
    if (!(completed.length > 0 && (await this.team.renewAfterTask(project, agent, "its task was merged")))) {
      await this.team.system(
        project,
        agent,
        "Symbio: your committed work was merged into the project, and your workspace now includes the latest project state.",
        false,
      );
    }
    return (
      `${result.summary}\n${result.files.map((f) => `- ${f}`).join("\n")}` +
      (completed.length ? `\nMarked done: ${completed.join(", ")}.` : "") +
      (waiting.length ? `\nWaiting for the human's review: ${waiting.join(", ")} (done when they approve).` : "")
    );
  }
}
