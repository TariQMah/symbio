import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SYMBIO_HOME = mkdtempSync(path.join(os.tmpdir(), "sym-briefs-home-"));
const { coordinatorBrief, workerBrief } = await import("../src/server/prompts.js");

test("briefs: Symbio's secrets are off-limits, the project's own credentials may be used but not spread", () => {
  const project: any = { name: "p", directory: os.tmpdir(), allowedModels: ["a/b"], docsLocation: "project", origin: "new", agents: [] };
  const agent: any = { name: "dev", role: "worker", directory: os.tmpdir(), branch: "symbio/dev" };
  for (const brief of [coordinatorBrief(project), workerBrief(project, agent, "core")]) {
    assert.match(brief, /Symbio's secrets are off-limits/);
    assert.match(brief, /project's own credentials[\s\S]*may be used for the task/);
    assert.match(brief, /never put a credential into anything that is committed/);
    assert.match(brief, /read-only mirror/);
    // The old blanket rule made agents refuse legitimate work.
    assert.doesNotMatch(brief, /never look for them on this machine/);
  }
});

test("briefs: AI co-author lines are left out of commits unless the project allows them", () => {
  const project: any = { name: "p", directory: os.tmpdir(), allowedModels: ["a/b"], docsLocation: "project", origin: "new", agents: [] };
  const own: any = { name: "dev", role: "worker", directory: os.tmpdir(), branch: "symbio/dev" };
  for (const brief of [coordinatorBrief(project), workerBrief(project, own, "core")]) assert.match(brief, /don't add `Co-authored-by`/);
  project.aiCoauthors = true;
  for (const brief of [coordinatorBrief(project), workerBrief(project, own, "core")]) assert.doesNotMatch(brief, /Co-authored-by/);
});

test("briefs: helpers in the project folder get the commit rule too", () => {
  const project: any = { name: "p", directory: os.tmpdir(), allowedModels: ["a/b"], docsLocation: "project", origin: "new", agents: [] };
  const shared: any = { name: "dev", role: "worker", directory: os.tmpdir(), branch: null };
  assert.match(workerBrief(project, shared, "core"), /don't add `Co-authored-by`/);
});
