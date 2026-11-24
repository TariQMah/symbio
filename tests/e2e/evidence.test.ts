// Evidence: files a helper shares are tagged (evidence, report) and tied to a task; the Files tab
// filters by both, the task links its evidence, and agents find it with list_shared_files.
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

test("shared files are tagged by kind and task: the Files tab filters them, the task links its evidence, agents list them", async () => {
  const { project, core } = await projectWithCore(symbio, "Evidence");
  const say = async (text: string) => {
    await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text });
    await idle(symbio, project.id);
  };
  await say(tool("core", "submit_plan", { goal: "A result", tasks: [{ key: "r", title: "Produce the result", description: "Run it." }] }));
  await symbio.call("POST", `/projects/${project.id}/plan/decision`, { approved: true });
  const script = [
    "@runner write result.txt all 12 cases pass",
    "@runner write notes.md # Notes",
    "@runner write scratch.txt scratch",
    // Evidence without a task goes to the one it's working on.
    tool("runner", "share_file", { path: "result.txt", caption: "The run's output", tag: "evidence" }),
    tool("runner", "share_file", { path: "notes.md", tag: "report", task_id: "T1" }),
    tool("runner", "share_file", { path: "scratch.txt" }),
  ].join("\n");
  await say(tool("core", "spawn_agent", { name: "runner", purpose: "Runs", task_id: "T1", task: script, workspace: "shared" }));
  await until("three shared files", async () => (await symbio.call("GET", `/projects/${project.id}/shared-files`)).length === 3);
  const shared = Object.fromEntries((await symbio.call("GET", `/projects/${project.id}/shared-files`)).map((f: any) => [f.rel, f]));
  assert.deepEqual([shared["result.txt"].tag, shared["result.txt"].taskId], ["evidence", "T1"]);
  assert.deepEqual([shared["notes.md"].tag, shared["notes.md"].taskId], ["report", "T1"]);
  assert.deepEqual([shared["scratch.txt"].tag, shared["scratch.txt"].taskId], [undefined, undefined]);
  await idle(symbio, project.id);

  // core finds a task's evidence.
  await say(tool("core", "list_shared_files", { task_id: "T1", tag: "evidence" }));
  const listed = await history(symbio, project.id, core.id);
  assert.match(listed, /- result\.txt · evidence · T1 · by runner — The run's output/);
  assert.doesNotMatch(listed.slice(listed.lastIndexOf("list_shared_files")), /notes\.md · report/);

  // The Files tab filters by kind and task.
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator("button.tab", { hasText: "Files" }).click();
  const cards = page.locator(".shared-files .shared-file");
  await until("all three shown", async () => (await cards.count()) === 3);
  await page.locator(".files-filters button", { hasText: "Evidence" }).click();
  await until("only the evidence", async () => (await cards.count()) === 1);
  await cards.filter({ hasText: "result.txt" }).waitFor();
  await page.locator(".files-filters button", { hasText: "Reports" }).click();
  await cards.filter({ hasText: "notes.md" }).waitFor();
  assert.equal(await cards.count(), 1);
  await page.locator(".files-filters button", { hasText: "All" }).click();
  await page.locator(".files-filters select").selectOption("T1");
  await until("the task's two files", async () => (await cards.count()) === 2);

  // The task links its evidence.
  await page.locator("button.tab", { hasText: "Plan" }).click();
  await page.locator(".task-card", { hasText: "Produce the result" }).click();
  await page.locator(".task-evidence .shared-file", { hasText: "result.txt" }).waitFor();
  assert.equal(await page.locator(".task-evidence .shared-file").count(), 1);
  assert.deepEqual((page as any).errors, []);
});
