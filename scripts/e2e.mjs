#!/usr/bin/env node
// Runs the end-to-end tests once per agent runtime (tests/e2e/harness.ts), so a change that works
// on one runtime can't break the other unnoticed. Both runtimes run at the same time, each running
// several test files at once: every file starts its own Symbio, ports and folders, so they don't
// share anything.
//
//   node scripts/e2e.mjs                         every test, on OpenCode and on GitHub Copilot CLI
//   node scripts/e2e.mjs --runtime copilot       one runtime
//   node scripts/e2e.mjs tests/e2e/team.test.ts  some files (on both)
//   node scripts/e2e.mjs --jobs 1                test files at once per runtime (default: from this
//                                                computer's CPU threads and memory; SYMBIO_E2E_JOBS)
//   node scripts/e2e.mjs --serial                one runtime after the other, one file at a time

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
const take = (flag, hasValue = true) => {
  const at = args.indexOf(flag);
  if (at < 0) return undefined;
  return hasValue ? args.splice(at, 2)[1] : args.splice(at, 1)[0];
};
const runtimeArg = take("--runtime");
const serial = !!take("--serial", false);
const jobsArg = take("--jobs") ?? process.env.SYMBIO_E2E_JOBS;
const runtimes = runtimeArg ? [runtimeArg] : ["opencode", "copilot"];
const files = args.length ? args : ["tests/e2e/*.test.ts"];
const tsx = path.join(path.dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist", "cli.mjs");

// Each running file is a Symbio, a stand-in runtime and a browser: about a CPU thread and 700 MB
// at its peak. Too many at once and waits time out, so stay well within the machine (measured on
// 28 threads / 32 GB: 4 files per runtime is as fast as 8, and steady).
function defaultJobs() {
  const threads = os.availableParallelism?.() ?? os.cpus().length;
  const byCpu = Math.floor(threads / (3 * runtimes.length)) || 1;
  const byMemory = Math.floor(os.totalmem() / (1.5 * 1024 ** 3 * runtimes.length)) || 1;
  return Math.max(1, Math.min(4, byCpu, byMemory));
}
const jobs = serial ? 1 : Math.max(1, Number(jobsArg) || defaultJobs());

function run(runtime) {
  const started = Date.now();
  const child = spawn(process.execPath, [tsx, "--test", `--test-concurrency=${jobs}`, ...files], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SYMBIO_E2E_RUNTIME: runtime },
  });
  // Both runtimes write at once: each line says which it's from.
  const tag = runtimes.length > 1 && !serial ? `[${runtime}] ` : "";
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on("line", (line) => console.log(tag + line));
  }
  return new Promise((resolve) => child.on("close", (code) => resolve({ runtime, ok: code === 0, seconds: Math.round((Date.now() - started) / 1000) })));
}

const started = Date.now();
console.log(`End-to-end tests on ${runtimes.join(" and ")}, ${jobs} file(s) at a time per runtime${serial ? ", one runtime after the other" : ""}.`);
const results = [];
if (serial) {
  for (const runtime of runtimes) {
    console.log(`\n=== End-to-end tests on ${runtime} ===\n`);
    results.push(await run(runtime));
  }
} else {
  results.push(...(await Promise.all(runtimes.map(run))));
}

console.log("");
for (const r of results) console.log(`${r.runtime}: ${r.ok ? "passed" : "FAILED"} in ${r.seconds}s`);
const failed = results.filter((r) => !r.ok).map((r) => r.runtime);
const total = Math.round((Date.now() - started) / 1000);
if (failed.length) {
  console.error(`End-to-end tests failed on: ${failed.join(", ")} (${total}s)`);
  process.exit(1);
}
console.log(`End-to-end tests passed on: ${runtimes.join(", ")} (${total}s)`);
