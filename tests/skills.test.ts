// Skills (skills.ts): the library, what a runtime is told, and that agents can't change them.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SYMBIO_HOME = mkdtempSync(path.join(os.tmpdir(), "sym-skills-"));
const { builtinSkillsDir, createSkill, importSkill, listSkills, parseSkill, removeSkill, skillText } = await import("../src/server/skills.js");
const { skillRules, withSkillRoots } = await import("../src/server/opencode/runtime.js");
const { AGENT_PERMISSIONS, wildcardMatch } = await import("../src/server/guard.js");

test("the library: Symbio's skills, then the human's; names are unique; Symbio's can't be removed", async () => {
  const builtin = listSkills().filter((s) => s.source === "builtin").map((s) => s.name);
  for (const name of ["briefing", "glossary", "handoff", "review", "grilling", "code-review", "server-administration"]) assert.ok(builtin.includes(name), name);
  await assert.rejects(createSkill({ name: "Bad Name", description: "x", instructions: "y" }), /lowercase/);
  await assert.rejects(createSkill({ name: "review", description: "x", instructions: "y" }), /already a skill named "review"/);
  const made = await createSkill({ name: "front-end", description: "Review a page. Use after changing one.", instructions: "1. Open it." });
  assert.equal(made.source, "library");
  assert.match(skillText("front-end"), /^---\nname: front-end\ndescription: "Review a page\. Use after changing one\."\n---\n\n1\. Open it\./);
  const byCore = await createSkill({ name: "invoice-check", description: 'Check an "invoice": totals and dates.', instructions: "1. Add it up.", category: "data", author: "core, in Shop" });
  assert.deepEqual([byCore.description, byCore.category, byCore.credit?.author], ['Check an "invoice": totals and dates.', "data", "core, in Shop"]);
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

test("every skill Symbio ships has a category and a credit; third-party ones keep their license and a pinned source", () => {
  const catalog = JSON.parse(readFileSync(path.join(builtinSkillsDir(), "catalog.json"), "utf8"));
  const builtin = listSkills().filter((s) => s.source === "builtin");
  assert.deepEqual(builtin.map((s) => s.name).sort(), Object.keys(catalog).sort(), "the catalog lists exactly the skills shipped");
  for (const s of builtin) {
    assert.notEqual(s.category, "other", `${s.name} has a category`);
    assert.ok(s.credit?.author, `${s.name} is credited`);
    // Runtimes read the frontmatter as YAML: an unquoted value with ": " in it isn't (Copilot skipped such a skill).
    const front = readFileSync(path.join(s.dir, "SKILL.md"), "utf8").split(/\r?\n---\r?\n/)[0];
    for (const line of front.split(/\r?\n/).slice(1)) {
      const value = line.match(/^[A-Za-z][\w-]*:\s*(.*)$/)?.[1] ?? "";
      if (!/^["'|>]/.test(value)) assert.doesNotMatch(value, /: /, `${s.name}: quote "${line.slice(0, 40)}…"`);
    }
    if (s.credit!.author === "Symbio") continue;
    assert.match(s.credit!.license ?? "", /^(MIT|Apache-2\.0)$/, `${s.name}'s license`);
    assert.match(s.credit!.source ?? "", /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/tree\/[0-9a-f]{40}/, `${s.name} is pinned to a commit`);
    assert.ok(existsSync(path.join(s.dir, "LICENSE.txt")), `${s.name} ships its license`);
    assert.match(readFileSync(path.join(s.dir, "SKILL.md"), "utf8"), /^> \*\*In Symbio\.\*\*/m, `${s.name} says how it maps to Symbio`);
  }
});

test("frontmatter: quoted values, block values and nested keys", () => {
  const quoted = parseSkill('---\nname: a\ndescription: "Say \\"hi\\": then go"\nmetadata:\n  version: 2\n---\nbody');
  assert.equal(quoted?.description, 'Say "hi": then go');
  const block = parseSkill("---\nname: b\ndescription: |\n  First line,\n  second line.\nlicense: MIT\n---\nbody");
  assert.deepEqual([block?.description, block?.meta.license], ["First line, second line.", "MIT"]);
  assert.equal(parseSkill("---\nname: c\ndescription: 'It''s fine'\n---\n")?.description, "It's fine");
});
