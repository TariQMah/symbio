// Pinned models: a helper pinned to its model waits and retries it when it fails (pauses shortened
// here), instead of being switched to another allowed model; unpinned, it switches as before. Pinned
// by core (spawn_agent pin_model) or by the human (the pin in the helper's chat).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeBrowser, FLAKY_MODEL, history, idle, MODEL, openPage, projectWithCore, startSymbio, until, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio({ SYMBIO_PINNED_RETRY_SECONDS: "1,2" });
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

const agentNamed = async (projectId: string, name: string) => (await symbio.call("GET", `/projects/${projectId}`)).agents.find((a: any) => a.name === name);

test("a pinned helper keeps its model through an outage; an unpinned one switches", async () => {
  const { project, core } = await projectWithCore(symbio, "Pinned", { models: [MODEL, FLAKY_MODEL] });
  const spawn = (name: string, pin: boolean) =>
    `@core tool spawn_agent ${JSON.stringify({ name, purpose: "Writes", task: `@${name} say done`, workspace: "shared", model: FLAKY_MODEL, pin_model: pin })}`;
  await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text: [spawn("steady", true), spawn("loose", false)].join("\n") });
  await until("both helpers", async () => !!(await agentNamed(project.id, "steady")) && !!(await agentNamed(project.id, "loose")));

  // The model is overloaded for each helper's first turn. The pinned one waits, tries the same model again and gets
  // through: it answers (the stand-in model replies to what it's given; a real one would pick its task up again).
  await until("the pinned helper to get through", async () => /trying your pinned model[\s\S]*"type":"assistant"[^\n]*"text"/.test(await history(symbio, project.id, (await agentNamed(project.id, "steady")).id)), 30_000);
  const steady = await agentNamed(project.id, "steady");
  assert.equal(steady.model, FLAKY_MODEL, "still on its model");
  assert.equal(steady.modelPinned?.by, "coordinator");
  assert.match(await history(symbio, project.id, steady.id), /trying your pinned model .* again/);

  // The unpinned one was switched to the other allowed model, as before.
  await until("the unpinned helper to switch", async () => (await agentNamed(project.id, "loose")).model === MODEL, 30_000);
  await idle(symbio, project.id);

  // In the browser: the pin in the chat header, and the marker in the team list; the human can unpin (and pin) it.
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator(".agent-row", { hasText: "steady" }).locator(".agent-pin").waitFor();
  assert.equal(await page.locator(".agent-row", { hasText: "loose" }).locator(".agent-pin").count(), 0);
  await page.locator(".agent-row", { hasText: "steady" }).click();
  const pin = page.locator(".chat-head .pin-model");
  assert.equal(await pin.getAttribute("aria-pressed"), "true");
  await pin.click();
  await until("unpinned", async () => !(await agentNamed(project.id, "steady")).modelPinned);
  await page.locator(".agent-row", { hasText: "steady" }).locator(".agent-pin").waitFor({ state: "detached" });
  await pin.click();
  await until("pinned by the human", async () => (await agentNamed(project.id, "steady")).modelPinned?.by === "human");
  assert.deepEqual((page as any).errors, []);
});
