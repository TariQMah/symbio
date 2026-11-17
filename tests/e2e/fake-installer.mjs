// Stand-in for installing an agent runtime with npm (SYMBIO_RUNTIME_INSTALLER): "installs" the
// end-to-end tests' stand-in runtimes, after a moment so the cards show it installing. Returns where
// the runtime starts, as the real installer does.
import { writeFileSync } from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const ENTRIES = { opencode: "fake-opencode.mjs", copilot: "fake-copilot.mjs" };

export async function install(kind, dir) {
  if (process.env.SYMBIO_FAKE_INSTALL_FAILS === kind) throw new Error("npm couldn't reach the registry (stand-in)");
  await new Promise((r) => setTimeout(r, 1500));
  writeFileSync(path.join(dir, "installed-by-stand-in.txt"), kind);
  return path.join(here, ENTRIES[kind]);
}
