// The Explorer tab: the project's folders and files, read-only, without secrets; folders open on a
// click, text shows beside the tree, and Refresh picks up what the team wrote since.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { closeBrowser, openPage, projectWithCore, startSymbio, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio();
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

test("the Explorer lists the project's files, hides secrets and shows a file beside the tree", async () => {
  const { project } = await projectWithCore(symbio, "Explorer");
  const dir = project.directory;
  mkdirSync(path.join(dir, "chapters"), { recursive: true });
  writeFileSync(path.join(dir, "chapters", "01-intro.md"), "# Intro\n\nThe **start** of the guide.\n");
  writeFileSync(path.join(dir, "notes.txt"), "first line\nsecond line\n");
  writeFileSync(path.join(dir, ".env"), "SECRET=1\n");

  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/p/${project.id}`);
  await page.locator(".tab", { hasText: "Explorer" }).click();
  const tree = page.locator(".explorer-tree");
  const item = (name: string) => tree.locator(".explorer-item", { hasText: name });
  await item("notes.txt").waitFor();
  assert.equal(await item("chapters").count(), 1);
  assert.equal(await item(".env").count(), 0, "files that may hold secrets aren't listed");

  await item("chapters").click();
  await item("01-intro.md").click();
  const view = page.locator(".explorer-view");
  await view.locator("h1", { hasText: "Intro" }).waitFor();
  assert.match(await view.innerText(), /The start of the guide/);

  await item("notes.txt").click();
  await view.locator(".code-line", { hasText: "second line" }).waitFor();

  writeFileSync(path.join(dir, "chapters", "02-next.md"), "# Next\n");
  assert.equal(await item("02-next.md").count(), 0);
  await page.getByRole("button", { name: "Refresh" }).click();
  await item("02-next.md").waitFor();
});
