// Report a problem: a link in the top bar and in Settings to a new bug report, with versions and OS filled in
// and nothing about the person's projects.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeBrowser, openPage, projectWithCore, startSymbio, until, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => {
  symbio = await startSymbio();
});
after(async () => {
  await closeBrowser();
  await symbio?.stop();
});

test("Report a problem opens a new bug report with Symbio's version and the OS, and no project details", async () => {
  await projectWithCore(symbio, "Secret project name");
  const { page } = await openPage(symbio);
  await page.goto(`${symbio.base}/#/settings`);
  const current = (await symbio.call("GET", "/update")).current as string;
  const top = page.locator(".topbar-actions a", { hasText: "Report a problem" });
  const inSettings = page.locator(".section a", { hasText: "Report a problem" });
  await top.waitFor();
  await inSettings.waitFor();
  for (const link of [top, inSettings]) {
    await until("the version in the link", async () => ((await link.getAttribute("href")) ?? "").includes(encodeURIComponent(`Symbio version or commit: ${current}`)));
    await until("the runtimes in the link", async () => ((await link.getAttribute("href")) ?? "").includes(encodeURIComponent("lists them): OpenCode")));
    const url = new URL((await link.getAttribute("href"))!);
    assert.equal(url.origin + url.pathname, "https://github.com/linkzy/symbio/issues/new");
    assert.equal(url.searchParams.get("template"), "bug_report.md");
    const body = url.searchParams.get("body")!;
    assert.match(body, /- OS: \S/);
    assert.ok(body.includes(`- Symbio version or commit: ${current}`));
    // The installed runtimes with their versions (both stand-ins are installed in the tests).
    assert.match(body, /lists them\): OpenCode.*, GitHub Copilot CLI/);
    assert.ok(!body.includes("Secret project name"));
    assert.equal(await link.getAttribute("target"), "_blank");
  }
});
