// Owns a private `opencode serve` process: starts it, restarts it if it dies,
// and keeps a single event subscription alive across restarts.

import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { OpencodeClient, parseModel } from "./client.js";
import { sessionUsage, type Usage } from "../costs.js";
import type { PermissionRule } from "../guard.js";
import type {
  AgentRuntime,
  BackgroundShell,
  ChildSession,
  FileChange,
  NewSession,
  RuntimeEvents,
  RuntimeModel,
  RuntimeState,
} from "../runtime/types.js";

const execFileAsync = promisify(execFile);

export type { RuntimeState };

// Environment that keeps agent shell commands from waiting on input forever.
const NON_INTERACTIVE_ENV = {
  CI: "1",
  npm_config_yes: "true",
  GIT_TERMINAL_PROMPT: "0",
  PIP_NO_INPUT: "1",
};

export class OpencodeRuntime extends EventEmitter<RuntimeEvents> implements AgentRuntime {
  readonly kind = "opencode";
  readonly label = "OpenCode";
  state: RuntimeState = "stopped";
  client: OpencodeClient | null = null;
  version: string | null = null;
  lastError: string | null = null;
  restarts = 0;

  private proc: ChildProcess | null = null;
  private stopping = false;
  private subscription: AbortController | null = null;
  private recentCrashes: number[] = [];

  /** @param pidFile where the server pid is recorded, so an orphan from a hard-killed run can be cleaned up. */
  constructor(private readonly pidFile: string) {
    super();
  }

  async start(): Promise<void> {
    if (this.state === "running" || this.state === "starting") return;
    this.stopping = false;
    this.setState("starting");
    killOrphan(this.pidFile);

    const port = await freePort();
    const password = randomBytes(24).toString("base64url");
    const { command, args, shell } = resolveOpencode();

    // --stdio: OpenCode removes the password from its own environment after reading it,
    // so agents' shells don't inherit it (they could otherwise call OpenCode directly and
    // change their own permissions). It also exits when our end of stdin closes, so the
    // server never outlives Symbio.
    const proc = spawn(command, [...args, "serve", "--hostname", "127.0.0.1", "--port", String(port), "--stdio"], {
      env: { ...process.env, ...NON_INTERACTIVE_ENV, OPENCODE_SERVER_PASSWORD: password },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell,
    });
    this.proc = proc;
    if (proc.pid) writeFileSync(this.pidFile, String(proc.pid));

    const tail: string[] = [];
    const remember = (buf: Buffer) => {
      tail.push(...buf.toString().split(/\r?\n/).filter(Boolean));
      if (tail.length > 40) tail.splice(0, tail.length - 40);
    };
    proc.stdout!.on("data", remember);
    proc.stderr!.on("data", remember);

    proc.on("exit", (code, signal) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.subscription?.abort();
      this.client = null;
      if (this.stopping) {
        this.setState("stopped");
        return;
      }
      this.lastError = `opencode exited (code ${code ?? "?"}${signal ? `, ${signal}` : ""}): ${tail.slice(-5).join(" | ")}`;
      console.error(`[runtime] ${this.lastError}`);
      this.setState("crashed");
      this.scheduleRestart();
    });

    const client = new OpencodeClient(`http://127.0.0.1:${port}`, password);
    try {
      await waitFor(async () => {
        if (!this.proc) throw new Error(`opencode exited during startup: ${tail.join(" | ")}`);
        const info = await client.info().catch(() => null);
        if (info) this.version = info.version;
        return !!info;
      }, 60_000);
    } catch (err) {
      this.lastError = String((err as Error).message);
      this.killProc();
      this.setState("crashed");
      throw err;
    }

    this.client = client;
    this.lastError = null;
    this.setState("running");
    this.subscribe(client);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.subscription?.abort();
    this.killProc();
    this.setState("stopped");
  }

  /** Restart on purpose (e.g. memory recycling). */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
    this.restarts++;
    this.emit("restarted");
  }

  /** Last measured memory of the opencode process tree, in bytes. */
  lastMemory: number | null = null;

  /** Measures memory used by the opencode process tree, in bytes (Windows/Linux/macOS best effort). */
  async memoryUsage(): Promise<number | null> {
    const pid = this.proc?.pid;
    if (!pid) return null;
    const bytes = await processTreeMemory(pid);
    if (bytes !== null) this.lastMemory = bytes;
    return bytes;
  }

  // ---------------------------------------------------------------- AgentRuntime (sessions)

  /** The client; throws when OpenCode isn't running. */
  private api(): OpencodeClient {
    if (!this.client) throw new Error(`OpenCode is not running (${this.state})`);
    return this.client;
  }

  async listModels(): Promise<RuntimeModel[]> {
    const models = await this.api().listModels();
    return models.map((m: any) => ({ providerID: String(m.providerID), id: String(m.id), name: String(m.name ?? m.id), raw: m }));
  }

  async createSession(opts: NewSession): Promise<string> {
    await this.ensureTools(opts.directory, opts.toolsUrl, true);
    const session = await this.api().createSession({
      title: opts.title,
      directory: opts.directory,
      model: parseModel(opts.model),
      permissions: opts.permissions,
    });
    return session.id;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.api().request("DELETE", `/api/session/${sessionId}`);
  }

  async setPermissions(sessionId: string, rules: PermissionRule[]): Promise<void> {
    await this.api().setPermissions(sessionId, rules);
  }

  async setInstruction(sessionId: string, key: string, value: string | null): Promise<void> {
    if (value === null) await this.api().removeInstruction(sessionId, key);
    else await this.api().setInstruction(sessionId, key, value);
  }

  async prompt(sessionId: string, text: string, delivery: "queue" | "steer"): Promise<string | undefined> {
    const res: any = await this.api().prompt(sessionId, text, delivery);
    // OpenCode gives the queued item the id of the user message it becomes (verified).
    return res?.data?.id;
  }

  async note(sessionId: string, text: string): Promise<void> {
    await this.api().synthetic(sessionId, text, false);
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.api().interrupt(sessionId);
  }

  async switchModel(sessionId: string, model: string): Promise<void> {
    await this.api().switchModel(sessionId, parseModel(model));
  }

  async queued(sessionId: string): Promise<string[]> {
    const res = await this.api().request("GET", `/api/session/${sessionId}/inbox`);
    return (res?.data ?? []).map((i: any) => String(i.id));
  }

  async cancelQueued(sessionId: string, id: string): Promise<boolean> {
    return this.api()
      .request("DELETE", `/api/session/${sessionId}/inbox/${id}`)
      .then(
        () => true,
        () => false,
      );
  }

  async forms(sessionId: string): Promise<any[]> {
    const res = await this.api().request("GET", `/api/session/${sessionId}/form`);
    return res?.data ?? [];
  }

  async answerForm(sessionId: string, formId: string, answer: Record<string, unknown>): Promise<void> {
    await this.api().request("POST", `/api/session/${sessionId}/form/${formId}/reply`, { answer });
  }

  async answerPermission(sessionId: string, requestId: string, decision: "once" | "reject", message?: string | null): Promise<void> {
    await this.api().request("POST", `/api/session/${sessionId}/permission/${requestId}/reply`, {
      decision,
      ...(message !== undefined ? { message } : {}),
    });
  }

  history(sessionId: string): Promise<any[]> {
    return this.api().messages(sessionId);
  }

  historyPage(sessionId: string, limit: number, before?: string) {
    return this.api().messagePage(sessionId, limit, before);
  }

  async sessionUsage(sessionId: string): Promise<Usage | null> {
    const res = await this.api().request("GET", `/api/session/${sessionId}`);
    return sessionUsage(res?.data ?? res);
  }

  async childSessions(sessionId: string): Promise<ChildSession[]> {
    const res = await this.api().request("GET", `/api/session?parentID=${encodeURIComponent(sessionId)}&limit=100`);
    return (res?.data ?? []).map((child: any) => ({
      id: String(child.id),
      model: child.model?.providerID && child.model?.id ? `${child.model.providerID}/${child.model.id}` : null,
      usage: sessionUsage(child),
    }));
  }

  async changes(sessionId: string, from: string, to: string): Promise<FileChange[]> {
    const res = await this.api().request(
      "GET",
      `/api/session/${sessionId}/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&context=3`,
    );
    return (res?.data ?? []).map((f: any) => ({
      file: String(f.file),
      status: f.status === "added" || f.status === "deleted" ? f.status : "modified",
      additions: Number(f.additions) || 0,
      deletions: Number(f.deletions) || 0,
      patch: String(f.patch ?? ""),
    }));
  }

  /**
   * Registers Symbio's MCP server for a folder. Registrations live in OpenCode's memory and are
   * dropped when it restarts or unloads an idle folder, so this checks first unless `force`.
   */
  async ensureTools(directory: string, url: string, force = false): Promise<void> {
    const where = `location%5Bdirectory%5D=${encodeURIComponent(directory)}`;
    if (!force) {
      const res = await this.api()
        .request<{ data?: { name: string; status?: { status?: string } }[] }>("GET", `/api/mcp?${where}`)
        .catch(() => null);
      if (res?.data?.some((s) => s.name === "symbio" && s.status?.status === "connected")) return;
    }
    await this.api().request("PUT", `/api/experimental/mcp/symbio?${where}`, { config: { type: "remote", url } });
  }

  async shells(directory: string): Promise<BackgroundShell[]> {
    return (await this.api().shells(directory)).map((s: any) => ({
      id: String(s.id),
      command: String(s.command ?? ""),
      pid: s.pid ?? undefined,
      started: Number(s.time?.started) || 0,
      running: s.status === "running",
      // OpenCode records the session that started a shell (verified 2.1.4).
      sessionId: s.metadata?.sessionID ?? undefined,
    }));
  }

  async stopShell(directory: string, id: string): Promise<void> {
    await this.api().stopShell(directory, id);
  }

  private scheduleRestart() {
    const now = Date.now();
    this.recentCrashes = this.recentCrashes.filter((t) => now - t < 5 * 60_000);
    this.recentCrashes.push(now);
    // Back off if it keeps dying, so a broken install doesn't spin forever.
    if (this.recentCrashes.length > 5) {
      this.lastError = `opencode crashed ${this.recentCrashes.length} times in 5 minutes; not restarting. ${this.lastError}`;
      console.error(`[runtime] ${this.lastError}`);
      return;
    }
    const delay = 1000 * 2 ** (this.recentCrashes.length - 1);
    setTimeout(() => {
      if (this.stopping || this.state === "running") return;
      this.start()
        .then(() => {
          this.restarts++;
          this.emit("restarted");
        })
        .catch((err) => console.error("[runtime] restart failed:", err.message));
    }, delay);
  }

  private subscribe(client: OpencodeClient) {
    const controller = new AbortController();
    this.subscription = controller;
    const loop = async () => {
      while (!controller.signal.aborted && this.client === client) {
        try {
          await client.subscribe((e) => this.emit("event", e), controller.signal);
        } catch (err) {
          if (controller.signal.aborted) return;
          console.error("[runtime] event stream error:", (err as Error).message);
        }
        await sleep(1000);
      }
    };
    void loop();
  }

  private killProc() {
    const proc = this.proc;
    this.proc = null;
    this.client = null;
    if (!proc?.pid) return;
    killTree(proc.pid);
    rmSync(this.pidFile, { force: true });
  }

  private setState(state: RuntimeState) {
    if (this.state === state) return;
    this.state = state;
    this.emit("state", state);
  }
}

/**
 * The OpenCode executable that ships with Symbio (the @opencode/cli dependency, pinned to a
 * version Symbio was verified against). Its postinstall puts the platform binary at the
 * path its package.json declares.
 */
export function bundledOpencode(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@opencode/cli/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.opencode;
    const exe = rel ? path.resolve(path.dirname(pkgPath), rel) : null;
    return exe && existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

/**
 * Finds a way to launch opencode: an explicit SYMBIO_OPENCODE_BIN, the bundled copy, a global
 * install, then whatever `opencode` is on the PATH. Prefers the real executable so we can
 * kill/monitor it directly instead of a .cmd shim.
 */
export function resolveOpencode(): { command: string; args: string[]; shell: boolean } {
  const override = process.env.SYMBIO_OPENCODE_BIN;
  // A .js/.mjs file runs with this Node: the end-to-end tests' stand-in OpenCode (tests/e2e).
  if (override && /\.m?js$/i.test(override)) return { command: process.execPath, args: [override], shell: false };
  if (override) return { command: override, args: [], shell: false };
  const bundled = bundledOpencode();
  if (bundled) return { command: bundled, args: [], shell: false };
  if (process.platform === "win32") {
    try {
      const root = execFileSync("npm.cmd", ["root", "-g"], { encoding: "utf8", windowsHide: true, shell: true }).trim();
      const exe = path.join(root, "@opencode", "cli", "bin", "opencode.exe");
      if (existsSync(exe)) return { command: exe, args: [], shell: false };
    } catch {
      // fall through
    }
    return { command: "opencode", args: [], shell: true };
  }
  return { command: "opencode", args: [], shell: false };
}

function killTree(pid: number) {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // already gone
  }
}

/** Kills the server left behind by a previous run, but only if that pid is still an opencode process. */
function killOrphan(pidFile: string) {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  rmSync(pidFile, { force: true });
  if (!pid) return;
  try {
    // Match the exact way we launch it, so a reused pid (or the user's own opencode) is never killed.
    const cmdline =
      process.platform === "win32"
        ? execFileSync(
            "powershell.exe",
            ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
            { encoding: "utf8", windowsHide: true, timeout: 10_000 },
          )
        : execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" });
    if (/opencode/i.test(cmdline) && /serve --hostname 127\.0\.0\.1 --port/.test(cmdline)) {
      console.warn(`[runtime] killing orphaned opencode server from a previous run (pid ${pid})`);
      killTree(pid);
    }
  } catch {
    // not running
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(500);
  }
  throw new Error("timed out waiting for opencode to start");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Memory of a process and its descendants, in bytes (Windows/Linux/macOS best effort); null when unknown. */
export async function processTreeMemory(pid: number): Promise<number | null> {
  try {
    if (process.platform === "win32") {
      // List every process once ("pid parent bytes" per line) and sum the tree here.
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize)\" }"],
        { encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
      );
      return sumProcessTree(stdout, pid) || null;
    }
    const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
    return Number(stdout.trim()) * 1024 || null;
  } catch {
    return null;
  }
}

/** Sums the memory of a process and all its descendants from "pid parent bytes" lines. */
export function sumProcessTree(listing: string, root: number): number {
  const children = new Map<number, number[]>();
  const memory = new Map<number, number>();
  for (const line of listing.split(/\r?\n/)) {
    const [pid, parent, bytes] = line.trim().split(/\s+/).map(Number);
    if (!pid) continue;
    memory.set(pid, bytes || 0);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(pid);
  }
  let total = 0;
  const seen = new Set<number>();
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue; // pid reuse can create cycles
    seen.add(pid);
    total += memory.get(pid) ?? 0;
    stack.push(...(children.get(pid) ?? []));
  }
  return total;
}
