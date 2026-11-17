// Choosing the agent runtime: the New project dialog offers OpenCode and GitHub Copilot CLI, each with
// its own models, and the project's agents run on the one chosen.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeBrowser, idle, openPage, startSymbio, until, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio();
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

test("a new project's agents run on GitHub Copilot CLI when chosen, with its models; core answers there", async () => {
  const folder = symbio.folder("on-copilot");
  const { page } = await openPage(symbio);
  await page.locator("button", { hasText: "New project" }).first().click();
  await page.getByPlaceholder("my-project", { exact: false }).fill(folder);
  await page.locator("button.btn.primary", { hasText: "Continue" }).click();
  await page.locator("button.btn.primary", { hasText: "Continue" }).click();

  // OpenCode by default, with its models.
  assert.ok(await page.getByRole("radio", { name: /OpenCode/ }).isChecked());
  await page.locator(".model-group-title", { hasText: "fake" }).waitFor();

  // GitHub Copilot CLI: its own models instead.
  await page.locator(".runtime-choice .choice", { hasText: "GitHub Copilot CLI" }).click();
  await page.locator(".model-group-title", { hasText: "copilot" }).waitFor();
  assert.equal(await page.locator(".model-group-title", { hasText: "fake" }).count(), 0, "not OpenCode's models");
  await page.locator(".model-row").filter({ has: page.locator(".model-name", { hasText: /^Scripted$/ }) }).click();
  await page.locator("button.btn.primary", { hasText: "Create project" }).click();

  await until("the project page", () => /#\/p\//.test(page.url()));
  const project = (await symbio.call("GET", "/projects")).find((p: any) => p.directory.toLowerCase() === folder.toLowerCase());
  assert.equal(project.runtime, "copilot");
  assert.equal(project.coordinatorModel, "copilot/scripted");
  await idle(symbio, project.id);
  const core = (await symbio.call("GET", `/projects/${project.id}`)).agents[0];
  assert.equal(core.runtime, "copilot", "core runs on Copilot");
  await page.locator(".msg-assistant", { hasText: "Noted (core)" }).first().waitFor();
  assert.deepEqual((page as any).errors, []);
});

test("signing in to GitHub Copilot from Settings, with a device code", async () => {
  const signedOut = await startSymbio({ SYMBIO_FAKE_COPILOT_SIGNED_OUT: "1" });
  try {
    const { page } = await openPage(signedOut);
    // Choosing Copilot before signing in says where to sign in.
    await page.locator("button", { hasText: "New project" }).first().click();
    await page.getByPlaceholder("my-project", { exact: false }).fill(signedOut.folder("later"));
    await page.locator("button.btn.primary", { hasText: "Continue" }).click();
    await page.locator("button.btn.primary", { hasText: "Continue" }).click();
    await page.locator(".runtime-choice .choice", { hasText: "GitHub Copilot CLI" }).click();
    await page.locator(".error", { hasText: "Sign in from Settings → GitHub Copilot CLI" }).waitFor();
    await page.keyboard.press("Escape");

    await page.goto(`${signedOut.base}/#/settings`);
    const section = page.locator(".copilot-section");
    await section.locator(".list-title", { hasText: "Not signed in" }).waitFor();
    await section.locator("button", { hasText: "Sign in with GitHub" }).click();
    await section.locator(".device-code", { hasText: "FAKE-1234" }).waitFor();
    assert.equal(await section.locator("a", { hasText: "Open GitHub" }).getAttribute("href"), "https://github.com/login/device");
    // Approved on GitHub (the stand-in approves it a moment later).
    await section.locator(".list-title", { hasText: "Signed in as e2e" }).waitFor({ timeout: 15_000 });
    assert.equal(await section.locator(".device-code").count(), 0, "the code is gone");
    assert.deepEqual((page as any).errors, []);
  } finally {
    await signedOut.stop();
  }
});

