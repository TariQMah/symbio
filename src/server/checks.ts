// Project checks: commands the human approves (build, tests, a spellcheck, a link check, a render…)
// that Symbio runs itself in a helper's folder when it reports a task, and again before its work is
// merged. A failure goes back to the helper with the output; nobody takes "it passes" on trust.
// Core may propose a check; only the human approves one, and only approved checks run.

import { spawn } from "node:child_process";
import path from "node:path";
import { newId } from "./store.js";
import { killTreeSync, lowerPriority } from "./machine.js";

export interface Check {
  id: string;
  name: string;
  command: string;
  /** Where it runs, relative to the helper's folder (unset: the folder itself). */
  folder?: string;
  /** Time limit in seconds (unset: DEFAULT_CHECK_TIMEOUT). */
  timeout?: number;
  /** Approved by the human. Core's proposals wait for it; unapproved checks never run. */
  approved: boolean;
  proposedBy?: "coordinator";
}

export interface CheckResult {
  name: string;
  ok: boolean;
  exitCode: number | null;
  timedOut?: boolean;
  seconds: number;
  /** The end of what it printed (the part with the errors, usually). */
  output: string;
}

/** The latest run of a task's checks. */
export interface CheckRun {
  state: "running" | "passed" | "failed";
  at: number;
  /** "report": when the helper reported the task; "merge": before its work was merged. */
  when: "report" | "merge";
  results: CheckResult[];
  /** What the folder looked like when they ran (git commit and changes), to skip running them again before a merge. */
  snapshot?: string | null;
}

export const DEFAULT_CHECK_TIMEOUT = 600;
const MAX_TIMEOUT = 3 * 3600;
const MAX_CHECKS = 20;
/** Output kept per check (its end). */
const KEEP_OUTPUT = 64 * 1024;
/** Output shown to the helper per failing check. */
const TELL_OUTPUT = 6000;

const ENV = { CI: "1", npm_config_yes: "true", GIT_TERMINAL_PROMPT: "0", PIP_NO_INPUT: "1" };

/** Validates checks from the human (the API); keeps ids of the ones that already exist. */
export function normalizeChecks(input: unknown): Check[] {
  if (!Array.isArray(input)) throw new Error("checks must be a list");
  if (input.length > MAX_CHECKS) throw new Error(`At most ${MAX_CHECKS} checks.`);
  const names = new Set<string>();
  return input.map((raw: any) => {
    const name = String(raw?.name ?? "").trim().slice(0, 80);
    const command = String(raw?.command ?? "").trim();
    if (!name) throw new Error("Each check needs a name.");
    if (!command) throw new Error(`Check "${name}" needs a command.`);
    if (command.length > 2000) throw new Error(`Check "${name}": the command is too long.`);
    if (names.has(name.toLowerCase())) throw new Error(`Two checks are named "${name}".`);
    names.add(name.toLowerCase());
    const folder = cleanFolder(raw?.folder);
    const timeout = raw?.timeout === undefined || raw?.timeout === null || raw?.timeout === "" ? undefined : Number(raw.timeout);
    if (timeout !== undefined && !(Number.isFinite(timeout) && timeout >= 1 && timeout <= MAX_TIMEOUT)) {
      throw new Error(`Check "${name}": the time limit is in seconds, from 1 to ${MAX_TIMEOUT}.`);
    }
    return {
      id: typeof raw?.id === "string" && /^chk_[\w-]+$/.test(raw.id) ? raw.id : newId("chk"),
      name,
      command,
      ...(folder ? { folder } : {}),
      ...(timeout !== undefined ? { timeout: Math.round(timeout) } : {}),
      approved: raw?.approved !== false,
      ...(raw?.proposedBy === "coordinator" ? { proposedBy: "coordinator" as const } : {}),
    };
  });
}

/** A folder inside the helper's folder: relative, without "..". */
function cleanFolder(value: unknown): string | undefined {
  const folder = String(value ?? "").trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (!folder || folder === ".") return undefined;
  if (path.isAbsolute(folder) || /^[a-z]:/i.test(folder) || folder.split("/").includes("..")) {
    throw new Error(`"${folder}": a check's folder is relative to the helper's folder, and inside it.`);
  }
  return folder;
}

export const approvedChecks = (checks: Check[] | undefined): Check[] => (checks ?? []).filter((c) => c.approved);

/** Runs checks one after the other in a folder; all of them, so the helper hears every failure at once. */
export async function runChecks(checks: Check[], directory: string, when: CheckRun["when"], snapshot?: string | null): Promise<CheckRun> {
  const results: CheckResult[] = [];
  for (const check of checks) results.push(await runCheck(check, directory));
  return { state: results.every((r) => r.ok) ? "passed" : "failed", at: Date.now(), when, results, ...(snapshot !== undefined ? { snapshot } : {}) };
}

/** Checks running now (pids), stopped when Symbio stops so none outlives it (see stopRunningChecks). */
const runningPids = new Set<number>();

/** Stops every check still running (Symbio is shutting down; they run again on the next start). */
export function stopRunningChecks() {
  for (const pid of runningPids) stop(pid);
  runningPids.clear();
}

export function runCheck(check: Check, directory: string): Promise<CheckResult> {
  const started = Date.now();
  const limit = (check.timeout ?? DEFAULT_CHECK_TIMEOUT) * 1000;
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    const keep = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > KEEP_OUTPUT * 2) output = output.slice(-KEEP_OUTPUT);
    };
    const done = (exitCode: number | null, extra = "") => {
      clearTimeout(timer);
      if (child?.pid) runningPids.delete(child.pid);
      resolve({
        name: check.name,
        ok: exitCode === 0 && !timedOut,
        exitCode,
        ...(timedOut ? { timedOut: true } : {}),
        seconds: Math.round((Date.now() - started) / 100) / 10,
        output: (output + extra).slice(-KEEP_OUTPUT),
      });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(check.command, {
        cwd: check.folder ? path.join(directory, check.folder) : directory,
        shell: true,
        windowsHide: true,
        // Its own process group off Windows, so a time limit stops what it started too.
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...ENV },
      });
    } catch (err: any) {
      resolve({ name: check.name, ok: false, exitCode: null, seconds: 0, output: String(err?.message ?? err) });
      return;
    }
    if (child.pid) runningPids.add(child.pid);
    // Like the agents' work: the human's own programs come first.
    void lowerPriority(child.pid);
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const timer = setTimeout(() => {
      timedOut = true;
      stop(child.pid);
    }, limit);
    child.on("error", (err) => done(null, `\n${err.message}`));
    child.on("close", (code) => done(code, timedOut ? `\n[stopped by Symbio after ${limit / 1000} s]` : ""));
  });
}

function stop(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32") return killTreeSync(pid);
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** What a helper (or core) is told about failed checks: each failure with the end of its output. */
export function describeFailures(run: CheckRun): string {
  return run.results
    .filter((r) => !r.ok)
    .map((r) => {
      const why = r.timedOut ? "took longer than its time limit" : r.exitCode === null ? "couldn't run" : `exited with ${r.exitCode}`;
      const tail = r.output.trim().slice(-TELL_OUTPUT);
      return `Check "${r.name}" failed (${why}, ${r.seconds} s):\n\`\`\`\n${tail || "(no output)"}\n\`\`\``;
    })
    .join("\n\n");
}

export const passedNames = (run: CheckRun): string => run.results.map((r) => r.name).join(", ");
