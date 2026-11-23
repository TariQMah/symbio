// Skills (skills.ts): the library, what a runtime is told, and that agents can't change them.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SYMBIO_HOME = mkdtempSync(path.join(os.tmpdir(), "sym-skills-"));
const { createSkill, importSkill, listSkills, parseSkill, removeSkill, skillText } = await import("../src/server/skills.js");
const { skillRules, withSkillRoots } = await import("../src/server/opencode/runtime.js");
const { AGENT_PERMISSIONS, wildcardMatch } = await import("../src/server/guard.js");

test("the library: Symbio's skills, then the human's; names are unique; Symbio's can't be removed", async () => {
  const builtin = listSkills().filter((s) => s.source === "builtin").map((s) => s.name);
  assert.deepEqual(builtin, ["briefing", "glossary", "handoff", "review"]);
  await assert.rejects(createSkill({ name: "Bad Name", description: "x", instructions: "y" }), /lowercase/);
  await assert.rejects(createSkill({ name: "review", description: "x", instructions: "y" }), /already a skill named "review"/);
  const made = await createSkill({ name: "front-end", description: "Review a page. Use after changing one.", instructions: "1. Open it." });
  assert.equal(made.source, "library");
  assert.match(skillText("front-end"), /^---\nname: front-end\ndescription: Review a page\. Use after changing one\.\n---\n\n1\. Open it\./);
  await assert.rejects(removeSkill("review"), /comes with Symbio/);
  await removeSkill("front-end");
  assert.ok(!listSkills().some((s) => s.name === "front-end"));
});

test("importing a skill copies its folder (with its files), checked first", async () => {
  const src = mkdtempSync(path.join(os.tmpdir(), "sym-skill-src-"));
  const dir = path.join(src, "writing-style");
  mkdirSync(path.join(dir, "examples"), { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), "---\nname: writing-style\ndescription: The house style.\n---\n\nShort sentences.\n");
  writeFileSync(path.join(dir, "examples", "good.md"), "Good.");
  const added = await importSkill(dir);
  assert.equal(added.name, "writing-style");
  assert.deepEqual(added.files, ["examples/good.md"]);
  await assert.rejects(importSkill(dir), /already a skill/);
  const noMeta = path.join(src, "bare");
  mkdirSync(noMeta);
  writeFileSync(path.join(noMeta, "SKILL.md"), "Just text.");
  await assert.rejects(importSkill(noMeta), /no name and description/);
  assert.equal(parseSkill("---\nname: a\n---\nx"), null, "a description is required");
});

test("OpenCode: Symbio's folders in its config, kept with the user's; a session's skills as rules where the last match wins", () => {
  const config = JSON.parse(withSkillRoots(JSON.stringify({ skills: ["C:/mine"], theme: "dark" })));
  assert.equal(config.theme, "dark");
  assert.ok(config.skills.paths.includes("C:/mine"));
  assert.ok(config.skills.paths.some((p: string) => p.endsWith("skills")));
  assert.deepEqual(skillRules(undefined), [], "no skills given: no rules");
  const rules = skillRules(["glossary"]);
  const last = (name: string) => rules.findLast((r) => r.action === "skill" && wildcardMatch(r.resource, name))?.effect;
  assert.equal(last("glossary"), "allow");
  assert.equal(last("briefing"), "deny");
  assert.equal(last("someone-elses"), "deny");
});

test("agents can't change the skills (they'd be instructions for other agents), but can run a skill's scripts", () => {
  const effect = (action: string, resource: string) => AGENT_PERMISSIONS.findLast((r) => r.action === action && wildcardMatch(r.resource, resource))?.effect;
  assert.equal(effect("edit", String.raw`C:\Users\me\.symbio\skills\review\SKILL.md`), "deny");
  assert.equal(effect("edit", "/home/me/.symbio/skills/review/SKILL.md"), "deny");
  assert.notEqual(effect("shell", String.raw`python C:\Users\me\.symbio\skills\charts\make.py`), "deny");
});
