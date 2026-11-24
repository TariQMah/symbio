import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SYMBIO_HOME = mkdtempSync(path.join(os.tmpdir(), "symbio-checks-"));
const { describeFailures, normalizeChecks, runChecks } = await import("../src/server/checks.js");

const node = (code: string) => `"${process.execPath}" -e "${code}"`;

test("checks run in the helper's folder (or a folder inside it); every failure is reported with the end of its output", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "symbio-check-dir-"));
  mkdirSync(path.join(dir, "site"));
  writeFileSync(path.join(dir, "site", "page.txt"), "hello");
  const checks = normalizeChecks([
    { name: "page exists", command: node("require('fs').accessSync('page.txt')"), folder: "site" },
    { name: "fails", command: node("console.log('line one'); console.error('broken thing'); process.exit(3)") },
    { name: "also fails", command: node("process.exit(1)") },
  ]);
  const run = await runChecks(checks, dir, "report");
  assert.equal(run.state, "failed");
  assert.deepEqual(
    run.results.map((r) => [r.name, r.ok, r.exitCode]),
    [
      ["page exists", true, 0],
      ["fails", false, 3],
      ["also fails", false, 1],
    ],
  );
  const told = describeFailures(run);
  assert.match(told, /Check "fails" failed \(exited with 3/);
  assert.match(told, /broken thing/);
  assert.match(told, /Check "also fails" failed/);
  assert.doesNotMatch(told, /page exists/);
});

test("a check over its time limit is stopped, with what it started", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "symbio-check-dir-"));
  const [check] = normalizeChecks([{ name: "hangs", command: node("setInterval(() => {}, 1000)"), timeout: 1 }]);
  const started = Date.now();
  const run = await runChecks([check], dir, "merge");
  assert.ok(Date.now() - started < 15_000);
  assert.equal(run.state, "failed");
  assert.equal(run.results[0].timedOut, true);
  assert.match(describeFailures(run), /took longer than its time limit/);
});

test("checks from the human are validated: names, commands, folders inside the helper's folder, time limits", () => {
  assert.throws(() => normalizeChecks([{ name: "", command: "x" }]), /needs a name/);
  assert.throws(() => normalizeChecks([{ name: "a", command: " " }]), /needs a command/);
  assert.throws(() => normalizeChecks([{ name: "a", command: "x" }, { name: "A", command: "y" }]), /Two checks/);
  assert.throws(() => normalizeChecks([{ name: "a", command: "x", folder: "../elsewhere" }]), /inside it/);
  assert.throws(() => normalizeChecks([{ name: "a", command: "x", folder: "C:\\elsewhere" }]), /inside it/);
  assert.throws(() => normalizeChecks([{ name: "a", command: "x", timeout: 0 }]), /time limit/);
  const [kept, proposed] = normalizeChecks([
    { id: "chk_abc", name: "tests", command: "npm test", folder: "./web/", timeout: "120" },
    { name: "lint", command: "npm run lint", approved: false, proposedBy: "coordinator" },
  ]);
  assert.deepEqual(kept, { id: "chk_abc", name: "tests", command: "npm test", folder: "web", timeout: 120, approved: true });
  assert.equal(proposed.approved, false);
  assert.equal(proposed.proposedBy, "coordinator");
});
