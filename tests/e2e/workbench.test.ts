// The Workbench layout (Settings → Appearance): an activity bar with the team and the Explorer, the
// work in the middle, the chat on the right with a switcher; narrow windows keep the classic layout.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { closeBrowser, idle, openPage, projectWithCore, startSymbio, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio();
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

test("the Workbench layout keeps the chat on the right while the middle shows the plan or a file", async () => {
  const { project, core } = await projectWithCore(symbio, "Workbench");
  writeFileSync(path.join(project.directory, "brief.md"), "# The brief\n\nWhat we're making.\n");
  await symbio.call("POST", `/projects/${project.id}/agents/${core.id}/messages`, { text: "@core say Ready when you are." });
  await idle(symbio, project.id);

  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/settings`);
  await page.locator('[data-layout-id="workbench"]').click();
  assert.equal(await page.locator('[data-layout-id="workbench"]').getAttribute("aria-checked"), "true");

  await page.goto(`${symbio.base}/#/p/${project.id}`);
  const chat = page.locator(".wb-chat");
  await chat.locator(".msg-assistant, .md", { hasText: "Ready when you are." }).first().waitFor();
  assert.equal(await page.locator(".wb-center .tab.active").innerText(), "Plan", "the middle starts on the plan");

  // The Explorer opens in the side bar; a file opens as a tab in the middle, the chat stays.
  await page.getByRole("button", { name: "Explorer", exact: true }).click();
  await page.locator(".wb-side .explorer-item", { hasText: "brief.md" }).click();
  await page.locator(".wb-center h1", { hasText: "The brief" }).waitFor();
  assert.match(await page.locator(".wb-center .tab.active").innerText(), /brief\.md/);
  assert.equal(await chat.isVisible(), true);
  await page.getByRole("button", { name: "Close the file" }).click();
  assert.equal(await page.locator(".wb-file-tab").count(), 0);

  // A narrow window gets the classic layout back.
  await page.setViewportSize({ width: 800, height: 800 });
  await page.locator(".project-view").waitFor();
  assert.equal(await page.locator(".workbench").count(), 0);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator(".workbench").waitFor();

  // Back to Classic from Settings.
  await page.goto(`${symbio.base}/#/settings`);
  await page.locator('[data-layout-id="classic"]').click();
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator(".project-view").waitFor();
});
