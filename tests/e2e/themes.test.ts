// Settings → Appearance: picking a theme changes the page's colors at once and is kept in this
// browser across reloads; picking Symbio again goes back to the default look.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeBrowser, openPage, startSymbio, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio();
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

test("a theme chosen in Settings applies at once and survives a reload", async () => {
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/settings`);
  const background = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme ?? null);
  const original = await background();
  assert.equal(await theme(), null);

  const light = page.locator('[data-theme-id="light-modern"]');
  await light.click();
  assert.equal(await light.getAttribute("aria-checked"), "true");
  assert.equal(await theme(), "light-modern");
  assert.equal(await background(), "#fff");

  await page.reload();
  await page.locator('[data-theme-id="light-modern"][aria-checked="true"]').waitFor();
  assert.equal(await theme(), "light-modern");
  assert.equal(await background(), "#fff");

  await page.locator('[data-theme-id="symbio"]').click();
  assert.equal(await theme(), null);
  assert.equal(await background(), original);
});
