// Briefings: core asks the questions about one feature together; the human sees them grouped in
// Needs you and answers them; core gets the answers together, once all are in, written as the
// feature's spec, which the feature's tasks link to.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
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
// Conversations as text, with the JSON escapes undone.
const said = async (projectId: string, agentId: string) => (await history(symbio, projectId, agentId)).replace(/\\n/g, "\n").replace(/\\"/g, '"');

test("a briefing's questions are grouped and answered together, and become the feature's spec its tasks link to", async () => {
  const { project, core, directory } = await projectWithCore(symbio, "Briefing");
  const say = async (text: string) => {
    await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text });
    await idle(symbio, project.id);
  };
  await say(tool("core", "ask_human", { question: "Which city goes at the end of the letter?" }));
  await say(
    tool("core", "start_briefing", {
      feature: "Order form",
      why: "Before planning the order form.",
      questions: [
        { question: "Who fills in the form?", options: ["Customers", "Staff"] },
        { question: "What happens after it's sent?" },
        { question: "Does it need a print version?" },
      ],
    }),
  );
  assert.match(await said(project.id, core.id), /Briefing B1 recorded: Q2, Q3, Q4/);

  // Needs you: the briefing's questions together under its feature; the other question on its own.
  const { page } = await openPage(symbio);
  page.on("dialog", (d) => void d.accept("Not needed now"));
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator(".needs-you").click();
  const briefing = page.locator(".briefing", { hasText: "B1 · Order form" });
  await briefing.locator(".briefing-head", { hasText: "Before planning the order form." }).waitFor();
  assert.equal(await briefing.locator(".question-card").count(), 3);
  assert.equal(await page.locator(".question-card", { hasText: "Which city" }).locator("xpath=ancestor::div[contains(@class,'briefing')]").count(), 0);
  const card = (text: string) => briefing.locator(".question-card", { hasText: text });
  await card("Who fills in the form?").locator(".chip", { hasText: "Customers" }).click();
  await card("What happens after it's sent?").locator("textarea").fill("It goes to the sales inbox");
  await briefing.locator(".briefing-head", { hasText: "2 of 3 answered" }).waitFor();
  await page.locator(".questions-head button", { hasText: "Send 2 answers" }).click();
  await until("two answers recorded", async () => (await symbio.call("GET", `/projects/${project.id}/questions`)).filter((q: any) => q.state === "answered").length === 2);
  await idle(symbio, project.id);
  assert.doesNotMatch(await said(project.id, core.id), /My answers to briefing/, "not until all are in");

  // The last one set aside: core gets all the answers together, and the spec is written.
  await card("Does it need a print version?").locator("button", { hasText: "Set aside" }).click();
  await until("core to get the briefing's answers", async () =>
    /My answers to briefing B1 \(Order form\):\s*Q2: Who fills in the form\?\s*→ Customers\s*Q3: What happens after it's sent\?\s*→ It goes to the sales inbox\s*Q4: Does it need a print version\?\s*→ set aside \(Not needed now\)/.test(
      await said(project.id, core.id),
    ),
  );
  assert.match(await said(project.id, core.id), /are written to docs\/specs\/order-form\.md/);
  const spec = readFileSync(path.join(directory, "docs", "specs", "order-form.md"), "utf8");
  assert.match(spec, /^# Order form/);
  assert.match(spec, /### Who fills in the form\?\s+Customers/);
  assert.match(spec, /### Does it need a print version\?\s+\*Set aside: Not needed now\.\*/);
  const [b1] = await symbio.call("GET", `/projects/${project.id}/briefings`);
  assert.equal(b1.state, "done");
  assert.equal(b1.spec, "docs/specs/order-form.md");
  await briefing.waitFor({ state: "detached" });
  await idle(symbio, project.id);

  // The feature's task links to it; its helper is told to read it first.
  await say(tool("core", "add_task", { title: "Build the order form", description: "The form.", spec: "docs/specs/order-form.md" }));
  await say(tool("core", "spawn_agent", { name: "forms", purpose: "Forms", task_id: "T1", task: "@forms say on it", workspace: "shared" }));
  const forms = (await symbio.call("GET", `/projects/${project.id}`)).agents.find((a: any) => a.name === "forms");
  await until("the helper to get the spec", async () => /Spec: docs\/specs\/order-form\.md \(read it first/.test(await said(project.id, forms.id)));
  await page.keyboard.press("Escape");
  await page.locator("button.tab", { hasText: "Plan" }).click();
  await page.locator(".task-card", { hasText: "Build the order form" }).click();
  await page.locator(".task-spec", { hasText: "docs/specs/order-form.md" }).waitFor();
  assert.ok(existsSync(path.join(directory, "docs", "specs", "order-form.md")));
  assert.deepEqual((page as any).errors, []);
});
