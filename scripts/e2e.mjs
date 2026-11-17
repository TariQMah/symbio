#!/usr/bin/env node
// Runs the end-to-end tests once per agent runtime (tests/e2e/harness.ts), so a change that works
// on one runtime can't break the other unnoticed.
//
//   node scripts/e2e.mjs                         every test, on OpenCode then on GitHub Copilot CLI
//   node scripts/e2e.mjs --runtime copilot       one runtime
//   node scripts/e2e.mjs tests/e2e/team.test.ts  some files (on both)

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const args = process.argv.slice(2);
const at = args.indexOf("--runtime");
const runtimes = at >= 0 ? [args.splice(at, 2)[1]] : ["opencode", "copilot"];
const files = args.length ? args : ["tests/e2e/*.test.ts"];
const tsx = path.join(path.dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist", "cli.mjs");

const failed = [];
for (const runtime of runtimes) {
  console.log(`\n=== End-to-end tests on ${runtime} ===\n`);
  const run = spawnSync(process.execPath, [tsx, "--test", "--test-concurrency=1", ...files], {
    stdio: "inherit",
    env: { ...process.env, SYMBIO_E2E_RUNTIME: runtime },
  });
  if (run.status !== 0) failed.push(runtime);
}
if (failed.length) {
  console.error(`\nEnd-to-end tests failed on: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`\nEnd-to-end tests passed on: ${runtimes.join(", ")}`);
