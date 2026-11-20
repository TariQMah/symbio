// The programs agents started, from a process listing: what runs under a runtime's shells, and
// programs seen that way before whose parent has exited since.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentProcesses, type ProcessInfo } from "../src/server/machine.js";

const p = (pid: number, parent: number, name: string, started = 1): ProcessInfo => ({ pid, parent, name, command: name, memory: 1, cpuTime: 0, started });

test("agents' programs: under a runtime's shells, without the shells or the runtime's own helpers", () => {
  const list = [
    p(10, 1, "opencode.exe"),
    p(11, 10, "node.exe"), // the runtime's own helper (a language server): not an agent's program
    p(12, 10, "pwsh.exe"),
    p(13, 12, "blender.exe"),
    p(14, 13, "blender-worker.exe"),
    p(15, 12, "conhost.exe"), // Windows' console host for the shell: not a program of its own
    p(20, 1, "msedge.exe"), // the user's own browser
  ];
  assert.deepEqual(agentProcesses(list, [10], new Map()).map((x) => x.pid).sort(), [13, 14]);
});

test("a program seen before keeps counting after its parent exits; a reused pid doesn't", () => {
  const before = [p(10, 1, "opencode.exe"), p(12, 10, "cmd.exe"), p(13, 12, "node.exe"), p(15, 13, "msedge.exe", 5)];
  const known = new Map(agentProcesses(before, [10], new Map()).map((x) => [x.pid, x.started]));
  // The script that launched the browser ended: the browser (and what it started) is still the agents'.
  const after = [p(10, 1, "opencode.exe"), p(15, 999, "msedge.exe", 5), p(16, 15, "msedge.exe", 6)];
  assert.deepEqual(agentProcesses(after, [10], known).map((x) => x.pid).sort(), [15, 16]);
  // The same pid, started at another time, is someone else's.
  const reused = [p(10, 1, "opencode.exe"), p(15, 999, "msedge.exe", 50)];
  assert.deepEqual(agentProcesses(reused, [10], known), []);
});
