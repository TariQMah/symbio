// Skills: core starts with Symbio's skills for leading, the human adds one to the library, core gives
// it to a helper (only from the ones the project allows), the human changes a helper's skills in its
// chat, and each agent's session has exactly its own.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeBrowser, history, idle, openPage, projectWithCore, startSymbio, until, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio();
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

const tool = (agent: string, name: string, args: object) => `@${agent} tool ${name} ${JSON.stringify(args)}`;
const said = async (projectId: string, agentId: string, pattern: RegExp) => until(`"${pattern.source}"`, async () => pattern.test(await history(symbio, projectId, agentId)));

test("core has Symbio's skills; a skill the human adds goes to the helper core gives it to, and nowhere else", async () => {
  const { project, core } = await projectWithCore(symbio, "Skills");
  const say = async (text: string) => {
    await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text });
    await idle(symbio, project.id);
  };
  await say("@core skills");
  await said(project.id, core.id, /skills: briefing, glossary, handoff, review/);

  // The human writes a skill in Settings → Skills.
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/settings`);
  const section = page.locator("#skills");
  await section.locator(".list-title", { hasText: "briefing" }).waitFor();
  await section.getByRole("button", { name: "New skill" }).click();
  const dialog = page.locator(".dialog", { hasText: "New skill" });
  await dialog.locator("label.field", { hasText: "Name" }).locator("input").fill("front end");
  await dialog.locator("label.field", { hasText: "What it's for" }).locator("input").fill("Review a page's layout. Use after changing a page.");
  await dialog.locator("textarea").fill("1. Open the page.\n2. Check the layout.");
  await dialog.getByRole("button", { name: "Create" }).click();
  await section.locator(".list-title", { hasText: "front-end" }).waitFor();

  // core gives it to a helper; the helper has exactly that one.
  await say(tool("core", "spawn_agent", { name: "ui", purpose: "Pages", task: "@ui skills", workspace: "shared", skills: ["front-end"] }));
  const ui = (await symbio.call("GET", `/projects/${project.id}`)).agents.find((a: any) => a.name === "ui");
  assert.deepEqual(ui.skills, ["front-end"]);
  await said(project.id, ui.id, /skills: front-end/);
  // core's own didn't change.
  await say("@core skills");
  assert.doesNotMatch((await history(symbio, project.id, core.id)).split("skills: ").at(-1)!, /front-end/);

  // Only the skills the project allows helpers.
  await symbio.call("PATCH", `/projects/${project.id}`, { helperSkills: ["review"] });
  await say(tool("core", "spawn_agent", { name: "other", purpose: "x", task: "@other say hi", workspace: "shared", skills: ["front-end"] }));
  assert.match(await history(symbio, project.id, core.id), /Not among the skills helpers may use: front-end/);

  // The human changes the helper's skills in its chat; core can't change them after that.
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator(".agent-row", { hasText: "ui" }).click();
  await page.locator(".chat-head .agent-skills", { hasText: "1 skill" }).click();
  const pick = page.locator(".dialog", { hasText: "Skills: ui" });
  const box = (name: string) => pick.locator("label.skill-check", { has: page.locator("strong", { hasText: new RegExp(`^${name}$`) }) }).locator("input");
  await box("review").check();
  await box("front-end").uncheck();
  await pick.getByRole("button", { name: "Save" }).click();
  await until("the human's choice", async () => (await symbio.call("GET", `/projects/${project.id}`)).agents.find((a: any) => a.name === "ui").skills.join() === "review");
  await symbio.call("POST", `/projects/${project.id}/agents/${ui.id}/messages`, { text: "@ui skills" });
  await idle(symbio, project.id);
  await said(project.id, ui.id, /skills: review/);
  await say(tool("core", "set_skills", { agent: "ui", skills: [] }));
  assert.match(await history(symbio, project.id, core.id), /The human chose ui's skills; only they can change them/);
  assert.deepEqual((page as any).errors, []);
});
