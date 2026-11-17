// Moving a project to another agent runtime (Project settings → Agent runtime → Switch).
//
// Nothing is converted from one runtime's format to another's: what a team knows lives in Symbio
// (plan, tasks, messages, assets, docs) and in git (folders, branches), so each agent continues in
// a new session on the other runtime, from a handoff note, as after New session. Optionally each
// agent first writes its own handoff, in a last turn on the old runtime. The new sessions are all
// created before the project changes runtime; if one can't be, they're discarded and nothing changed.

import { bus } from "../bus.js";
import type { RuntimeKind } from "../runtime/types.js";

export interface SwitchOptions {
  to: RuntimeKind;
  /** The project's models on the new runtime (as in New project). */
  allowedModels: string[];
  coordinatorModel: string;
  coreModels?: string[];
  coreOnlyModels?: string[];
  /** Ask each active agent for its own handoff first (one turn each, on the old runtime). */
  askHandoffs: boolean;
}

/** Where a switch stands, for the progress bar. */
export interface SwitchProgress {
  projectId: string;
  from: RuntimeKind;
  to: RuntimeKind;
  status: "running" | "done" | "failed";
  /** What it's doing now (or what failed). */
  step: string;
  done: number;
  total: number;
  error: string | null;
  /** Agents whose own handoff couldn't be had (Symbio's note was used). */
  withoutHandoff: string[];
  startedAt: number;
  finishedAt: number | null;
}

/** One switch per project at a time; the last one's outcome stays readable. */
export class Switches {
  private progress = new Map<string, SwitchProgress>();

  get(projectId: string): SwitchProgress | null {
    return this.progress.get(projectId) ?? null;
  }

  running(projectId: string): boolean {
    return this.progress.get(projectId)?.status === "running";
  }

  begin(projectId: string, from: RuntimeKind, to: RuntimeKind, total: number): SwitchProgress {
    const p: SwitchProgress = {
      projectId,
      from,
      to,
      status: "running",
      step: "Starting",
      done: 0,
      total,
      error: null,
      withoutHandoff: [],
      startedAt: Date.now(),
      finishedAt: null,
    };
    this.progress.set(projectId, p);
    this.publish(p);
    return p;
  }

  step(p: SwitchProgress, step: string, advance = 0) {
    p.step = step;
    p.done = Math.min(p.total, p.done + advance);
    this.publish(p);
  }

  advance(p: SwitchProgress, by = 1) {
    this.step(p, p.step, by);
  }

  finish(p: SwitchProgress, error: string | null) {
    p.status = error ? "failed" : "done";
    p.error = error;
    if (!error) {
      p.done = p.total;
      p.step = "Done";
    }
    p.finishedAt = Date.now();
    this.publish(p);
  }

  private publish(p: SwitchProgress) {
    bus.publish({ type: "runtime.switch", projectId: p.projectId, progress: { ...p } });
  }
}

/** The handoff request each agent answers in its last turn on the old runtime. */
export const handoffRequest = (fromLabel: string, toLabel: string) =>
  `Symbio: the human is moving this project from ${fromLabel} to ${toLabel}. This is your last turn in this session: ` +
  `you'll continue as yourself in a new session on ${toLabel}, which starts only from a handoff note. Write your part of that note now, ` +
  `as your answer (no tools, and don't start new work): what you're in the middle of and the exact next step, decisions you made and why, ` +
  `what you learned that isn't in the plan, tasks or docs (gotchas, commands, where things are), background processes you had running ` +
  `and how to start them again, and anything you were waiting for. Be specific; skip what the plan and your tasks already say.`;
