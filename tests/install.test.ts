// Finding and installing agent runtimes (runtime/install.ts): Symbio ships none.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

process.env.SYMBIO_HOME = mkdtempSync(path.join(os.tmpdir(), "sym-install-home-"));
const { locate, RuntimeInstaller, runtimesDir, testedVersion } = await import("../src/server/runtime/install.js");

const standIn = path.resolve(import.meta.dirname, "e2e", "fake-installer.mjs");
const saved = { ...process.env };
afterEach(() => {
  for (const k of ["SYMBIO_OPENCODE_BIN", "SYMBIO_COPILOT_SDK", "SYMBIO_NO_DEV_RUNTIMES", "SYMBIO_RUNTIME_INSTALLER", "SYMBIO_FAKE_INSTALL_FAILS"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("a development checkout finds the runtimes in its own node_modules, at the versions it installs", () => {
  delete process.env.SYMBIO_OPENCODE_BIN;
  delete process.env.SYMBIO_COPILOT_SDK;
  for (const kind of ["opencode", "copilot"] as const) {
    const found = locate(kind);
    assert.equal(found?.source, "development", kind);
    assert.ok(existsSync(found!.entry), kind);
    // The installed version is the one Symbio is developed and tested with.
    assert.ok(testedVersion(kind).includes(found!.version!.split(".").slice(0, 2).join(".")), kind);
  }
});

test("without one installed (nor in the environment), a runtime isn't found", () => {
  process.env.SYMBIO_NO_DEV_RUNTIMES = "1";
  process.env.SYMBIO_OPENCODE_BIN = "  ";
  assert.equal(locate("opencode"), null);
  process.env.SYMBIO_OPENCODE_BIN = "/somewhere/opencode";
  assert.deepEqual(locate("opencode"), { entry: "/somewhere/opencode", source: "environment", version: null });
});

test("installing writes where the runtime starts; a failed install leaves nothing behind", async () => {
  process.env.SYMBIO_NO_DEV_RUNTIMES = "1";
  delete process.env.SYMBIO_COPILOT_SDK;
  process.env.SYMBIO_RUNTIME_INSTALLER = standIn;
  const installer = new RuntimeInstaller();
  const changes: string[] = [];
  installer.on("change", (kind) => changes.push(kind));

  process.env.SYMBIO_FAKE_INSTALL_FAILS = "copilot";
  await assert.rejects(installer.install("copilot"), /couldn't reach the registry/);
  assert.match(installer.state("copilot").error!, /couldn't reach the registry/);
  assert.equal(existsSync(path.join(runtimesDir(), "copilot")), false);
  assert.equal(locate("copilot"), null);

  delete process.env.SYMBIO_FAKE_INSTALL_FAILS;
  // Asking twice while it installs is one install.
  const first = installer.install("copilot");
  assert.equal(installer.install("copilot"), first);
  assert.equal(installer.state("copilot").installing, true);
  await first;
  const found = locate("copilot");
  assert.equal(found?.source, "symbio");
  assert.equal(found?.entry, path.resolve(import.meta.dirname, "e2e", "fake-copilot.mjs"));
  assert.equal(JSON.parse(readFileSync(path.join(runtimesDir(), "copilot", "runtime.json"), "utf8")).kind, "copilot");
  assert.deepEqual(installer.state("copilot"), { installing: false, log: [], error: null });
  assert.ok(changes.length >= 4);

  await installer.remove("copilot");
  assert.equal(existsSync(path.join(runtimesDir(), "copilot")), false);
  assert.equal(locate("copilot"), null);
});
