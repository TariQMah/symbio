// Symbio ships no agent runtime: on a first run it asks for one, installs the one the human picks
// (here with a stand-in for npm that "installs" the stand-in runtimes), offers only installed ones
// for new projects, and installs again one that existing projects use but that's missing.
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { closeBrowser, idle, MODEL, openPage, RUNTIME, startSymbio, until, type Symbio } from "./harness.js";

const OTHER = RUNTIME === "copilot" ? "opencode" : "copilot";
const LABEL = { opencode: "OpenCode", copilot: "GitHub Copilot CLI" } as const;

// Nothing installed: no runtime from the environment, nor from Symbio's own node_modules.
// Given an earlier instance's folder, the same data (Symbio's, and the runtimes').
const freshEnv = (root?: string): Record<string, string> => ({
  SYMBIO_OPENCODE_BIN: "",
  SYMBIO_COPILOT_SDK: "",
  SYMBIO_NO_DEV_RUNTIMES: "1",
  SYMBIO_RUNTIME_INSTALLER: path.resolve(import.meta.dirname, "fake-installer.mjs"),
  ...(root
    ? Object.fromEntries([
        ["SYMBIO_HOME", path.join(root, "home")],
        ...["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"].map((k) => [k, path.join(root, k)]),
      ])
    : {}),
});

const running: Symbio[] = [];
after(async () => {
  await closeBrowser();
  for (const s of running) await s.stop();
});

test("a first run asks for an agent runtime, installs the one chosen, and offers only that one", async () => {
  const symbio = await startSymbio(freshEnv());
  running.push(symbio);
  const runtimes = await symbio.call("GET", "/runtimes");
  assert.deepEqual(
    runtimes.map((r: any) => [r.kind, r.installed]),
    [
      ["opencode", false],
      ["copilot", false],
    ],
  );

  const { page } = await openPage(symbio);
  await page.locator(".first-run h2", { hasText: "Install an agent runtime to start" }).waitFor();
  assert.ok(await page.locator(".page-head button", { hasText: "New project" }).isDisabled(), "nothing to run agents on yet");
  // A project can't be created on a runtime that isn't installed.
  await assert.rejects(
    symbio.call("POST", "/projects", { name: "early", directory: symbio.folder("early"), coordinatorModel: MODEL, allowedModels: [MODEL], runtime: RUNTIME }),
    /isn't installed/,
  );

  const card = page.locator(`.first-run .runtime-card[data-runtime="${RUNTIME}"]`);
  await card.locator("button", { hasText: "Install" }).click();
  await card.locator(".runtime-install-log").waitFor();
  await until("the first-run cards to go", async () => (await page.locator(".first-run").count()) === 0, 20_000, symbio.output);
  assert.ok(existsSync(path.join(symbio.root, "home", "runtimes", RUNTIME, "runtime.json")), "installed in Symbio's folder");

  // New project: only the installed runtime.
  await page.locator(".page-head button", { hasText: "New project" }).click();
  await page.getByPlaceholder("my-project", { exact: false }).fill(symbio.folder("first"));
  await page.locator("button.btn.primary", { hasText: "Continue" }).click();
  await page.locator("button.btn.primary", { hasText: "Continue" }).click();
  await page.locator(".runtime-choice .choice", { hasText: LABEL[RUNTIME] }).waitFor();
  assert.equal(await page.locator(".runtime-choice .choice").count(), 1, `${LABEL[OTHER]} isn't offered`);
  assert.ok(await page.getByRole("radio", { name: new RegExp(LABEL[RUNTIME]) }).isChecked());
  await page.keyboard.press("Escape");

  // Settings: the installed one can be removed, the other installed.
  await page.goto(`${symbio.base}/#/settings`);
  await page.locator(`.runtime-card[data-runtime="${RUNTIME}"] .list-sub`, { hasText: "Installed" }).waitFor();
  await page.locator(`.runtime-card[data-runtime="${OTHER}"] button`, { hasText: "Install" }).waitFor();
  assert.deepEqual((page as any).errors, []);
});

test("a runtime agents run on can't be removed; one projects use is installed again when missing", async () => {
  const symbio = await startSymbio(freshEnv());
  running.push(symbio);
  await symbio.call("POST", `/runtimes/${RUNTIME}/install`);
  await until("the install", async () => (await symbio.call("GET", "/runtimes")).find((r: any) => r.kind === RUNTIME).installed, 20_000, symbio.output);
  const project = await symbio.call("POST", "/projects", {
    name: "kept",
    directory: symbio.folder("kept"),
    coordinatorModel: MODEL,
    allowedModels: [MODEL],
    runtime: RUNTIME,
  });
  await symbio.call("POST", `/projects/${project.id}/start`);
  await idle(symbio, project.id);
  await assert.rejects(symbio.call("DELETE", `/runtimes/${RUNTIME}`), /stop them first/);

  // The copy is gone (as after updating from a Symbio that came with OpenCode): the next start installs it.
  const home = path.join(symbio.root, "home");
  await symbio.stop();
  rmSync(path.join(home, "runtimes", RUNTIME), { recursive: true, force: true });
  const again = await startSymbio(freshEnv(symbio.root));
  running.push(again);
  await until("the runtime to be installed again", async () => (await again.call("GET", "/runtimes")).find((r: any) => r.kind === RUNTIME).installed, 20_000, again.output);
  assert.match(again.output(), /isn't installed, and projects use it/);
  await idle(again, project.id);
  const core = (await again.call("GET", `/projects/${project.id}`)).agents[0];
  assert.notEqual(core.status, "error", "core carries on");
  assert.equal((await again.call("GET", "/runtimes")).find((r: any) => r.kind === OTHER).installed, false, "only what projects use");

  // Without agents on it, it can be removed.
  await again.call("DELETE", `/projects/${project.id}`);
  await again.call("DELETE", `/runtimes/${RUNTIME}`);
  assert.equal((await again.call("GET", "/runtimes")).find((r: any) => r.kind === RUNTIME).installed, false);
  assert.ok(!existsSync(path.join(home, "runtimes", RUNTIME)));
});
