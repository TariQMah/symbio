// GitHub Copilot CLI as an agent runtime, driven through the Copilot SDK (docs/copilot-api.md).
//
// One Copilot runtime process (started by the SDK over stdio) holds every session. Unlike
// OpenCode, Copilot leaves tool permissions to its host, so Symbio's rules (guard.ts) are applied
// here; it has no "note without a turn", so notes wait for the agent's next prompt; and it speaks
// its own event vocabulary, translated here into the one the team and the chat use
// (runtime/types.ts).

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyUsage, type Usage } from "../costs.js";
import { evaluate, type PermissionRule } from "../guard.js";
import type {
  AgentRuntime,
  BackgroundShell,
  ChildSession,
  FileChange,
  NewSession,
  RuntimeEvent,
  RuntimeEvents,
  RuntimeModel,
  RuntimeState,
} from "../runtime/types.js";

/** Models are stored as "<provider>/<id>"; Copilot's own ids have no provider. */
export const COPILOT_PROVIDER = "copilot";
const NOTES_OPEN = "<symbio-notes>";
const NOTES_CLOSE = "</symbio-notes>";

// What Symbio uses of the SDK, so tests can stand in for it.
export interface SdkSession {
  readonly sessionId: string;
  send(options: { prompt: string; mode?: "enqueue" | "immediate" }): Promise<string>;
  abort(): Promise<void>;
  setModel(model: string): Promise<unknown>;
  getEvents(): Promise<any[]>;
  on(handler: (event: any) => void): () => void;
  disconnect(): Promise<void>;
  readonly rpc: any;
}

export interface SdkClient {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  getStatus(): Promise<{ version?: string }>;
  getAuthStatus(): Promise<{ isAuthenticated: boolean; login?: string; statusMessage?: string }>;
  listModels(): Promise<any[]>;
  createSession(config: any): Promise<SdkSession>;
  resumeSession(sessionId: string, config: any): Promise<SdkSession>;
  deleteSession(sessionId: string): Promise<void>;
  getSessionMetadata(sessionId: string): Promise<any>;
}

export type SdkClientFactory = (options: { baseDirectory: string }) => Promise<SdkClient>;

const defaultFactory: SdkClientFactory = async (options) => {
  const { CopilotClient } = await import("@github/copilot-sdk");
  return new CopilotClient({ baseDirectory: options.baseDirectory, logLevel: "error" } as any) as unknown as SdkClient;
};

/** What Symbio knows about a session: enough to open it again (after a restart, or with new instructions). */
interface SessionState {
  directory: string | null;
  permissions: PermissionRule[];
  instructions: Map<string, string>;
  /** Instructions or tools changed since the session was opened: reopen it before its next turn. */
  stale: boolean;
  notes: string[];
  busy: boolean;
  turnError: { type: string; message: string; status?: number } | null;
  /** Prompts sent and not yet in the conversation (id → text), for taking them back. */
  queued: Map<string, string>;
  usage: Usage;
}

interface OpenQuestion {
  sessionId: string;
  form: { id: string; title: string; fields: any[] };
  choices: string[];
  resolve: (answer: { answer: string; wasFreeform: boolean }) => void;
}

interface OpenPermission {
  sessionId: string;
  resolve: (result: any) => void;
}

export class CopilotRuntime extends EventEmitter<RuntimeEvents> implements AgentRuntime {
  readonly kind = "copilot";
  readonly label = "GitHub Copilot CLI";
  state: RuntimeState = "stopped";
  version: string | null = null;
  lastError: string | null = null;
  restarts = 0;
  lastMemory: number | null = null;
  /** The GitHub login the runtime uses, when signed in. */
  login: string | null = null;

  private client: SdkClient | null = null;
  private open = new Map<string, { session: SdkSession; off: () => void }>();
  private opening = new Map<string, Promise<SdkSession>>();
  private sessions = new Map<string, SessionState>();
  private toolsByFolder = new Map<string, string>();
  private questions = new Map<string, OpenQuestion>();
  private permissionRequests = new Map<string, OpenPermission>();

  /**
   * @param home Copilot's data folder for Symbio's sessions (COPILOT_HOME), kept apart from the
   *   user's own Copilot history; the user's GitHub login is reused (see seedLogin).
   */
  constructor(
    private readonly home: string,
    private readonly factory: SdkClientFactory = defaultFactory,
  ) {
    super();
  }

  // ---------------------------------------------------------------- process

  async start(): Promise<void> {
    if (this.state === "running" || this.state === "starting") return;
    this.setState("starting");
    try {
      mkdirSync(this.home, { recursive: true });
      seedLogin(this.home);
      const client = await this.factory({ baseDirectory: this.home });
      await client.start();
      this.version = (await client.getStatus().catch(() => ({}) as { version?: string })).version ?? null;
      const auth = await client.getAuthStatus().catch(() => null);
      this.login = auth?.isAuthenticated ? (auth.login ?? null) : null;
      this.lastError = auth?.isAuthenticated ? null : "Not signed in to GitHub Copilot: run `copilot login` in a terminal, then restart the runtime.";
      this.client = client;
      this.setState("running");
    } catch (err) {
      this.lastError = (err as Error).message;
      this.setState("crashed");
      throw err;
    }
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    for (const { off, session } of this.open.values()) {
      off();
      await session.disconnect().catch(() => {});
    }
    this.open.clear();
    this.opening.clear();
    // Waiting permission requests and questions die with the process.
    for (const p of this.permissionRequests.values()) p.resolve({ kind: "user-not-available" });
    this.permissionRequests.clear();
    for (const q of this.questions.values()) q.resolve({ answer: "", wasFreeform: true });
    this.questions.clear();
    for (const s of this.sessions.values()) s.busy = false;
    if (client) await client.stop().catch(() => {});
    this.setState("stopped");
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
    this.restarts++;
    this.emit("restarted");
  }

  async memoryUsage(): Promise<number | null> {
    // The SDK doesn't expose the runtime's process id.
    return null;
  }

  // ---------------------------------------------------------------- models

  async listModels(): Promise<RuntimeModel[]> {
    const models = await this.api().listModels();
    return models
      .filter((m: any) => m?.id && m.id !== "auto")
      .map((m: any) => ({
        providerID: COPILOT_PROVIDER,
        id: String(m.id),
        name: String(m.name ?? m.id),
        raw: { ...m, providerID: COPILOT_PROVIDER, id: String(m.id), capabilities: { ...m.capabilities, input: { image: !!m.capabilities?.supports?.vision } } },
      }));
  }

  // ---------------------------------------------------------------- sessions

  async createSession(opts: NewSession): Promise<string> {
    const sessionId = randomUUID();
    this.toolsByFolder.set(opts.directory, opts.toolsUrl);
    const state = this.state_(sessionId);
    state.directory = opts.directory;
    state.permissions = opts.permissions;
    const session = await this.api().createSession({
      ...this.config(sessionId, state),
      sessionId,
      name: sessionName(opts.title),
      model: modelId(opts.model),
    });
    this.attach(sessionId, session);
    return sessionId;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.close(sessionId);
    this.sessions.delete(sessionId);
    await this.api().deleteSession(sessionId);
  }

  async setPermissions(sessionId: string, rules: PermissionRule[]): Promise<void> {
    // Applied by Symbio on each request (onPermission): nothing to send.
    this.state_(sessionId).permissions = rules;
  }

  async setInstruction(sessionId: string, key: string, value: string | null): Promise<void> {
    const state = this.state_(sessionId);
    if ((state.instructions.get(key) ?? null) === value) return;
    if (value === null) state.instructions.delete(key);
    else state.instructions.set(key, value);
    // Copilot takes instructions when a session is opened: an open one is reopened before its next turn.
    if (this.open.has(sessionId)) state.stale = true;
  }

  async prompt(sessionId: string, text: string, delivery: "queue" | "steer"): Promise<string | undefined> {
    const state = this.state_(sessionId);
    if (state.stale && !state.busy) await this.close(sessionId);
    const session = await this.session(sessionId);
    const prompt = state.notes.length ? `${text}\n\n${NOTES_OPEN}\n${state.notes.join("\n\n")}\n${NOTES_CLOSE}` : text;
    state.notes = [];
    const id = await session.send({ prompt, mode: delivery === "steer" ? "immediate" : "enqueue" });
    if (id && delivery === "queue") state.queued.set(id, prompt);
    return id;
  }

  async note(sessionId: string, text: string): Promise<void> {
    // Copilot can't add to a conversation without a turn: it goes with the next prompt.
    this.state_(sessionId).notes.push(text);
  }

  async interrupt(sessionId: string): Promise<void> {
    const live = this.open.get(sessionId);
    if (live) await live.session.abort();
  }

  async switchModel(sessionId: string, model: string): Promise<void> {
    await (await this.session(sessionId)).setModel(modelId(model));
  }

  async queued(sessionId: string): Promise<string[]> {
    const live = this.open.get(sessionId);
    if (!live) return [];
    const res = await live.session.rpc.queue.pendingItems();
    return (res?.items ?? []).map((i: any) => i.messageId).filter(Boolean);
  }

  async cancelQueued(sessionId: string, id: string): Promise<boolean> {
    const live = this.open.get(sessionId);
    const state = this.sessions.get(sessionId);
    const prompt = state?.queued.get(id);
    if (!live || !state || prompt === undefined) return false;
    const res = await live.session.rpc.queue.withdrawMessage({ messageId: id, expectedPrompt: prompt }).catch(() => null);
    if (res?.removed) state.queued.delete(id);
    return !!res?.removed;
  }

  // ---------------------------------------------------------------- questions and permissions

  async forms(sessionId: string): Promise<any[]> {
    return [...this.questions.values()].filter((q) => q.sessionId === sessionId).map((q) => q.form);
  }

  async answerForm(sessionId: string, formId: string, answer: Record<string, unknown>): Promise<void> {
    const q = this.questions.get(formId);
    if (!q || q.sessionId !== sessionId) throw new Error("That question is no longer open.");
    const text = String(answer.answer ?? "");
    this.questions.delete(formId);
    q.resolve({ answer: text, wasFreeform: !q.choices.includes(text) });
  }

  async answerPermission(sessionId: string, requestId: string, decision: "once" | "reject", message?: string | null): Promise<void> {
    const p = this.permissionRequests.get(requestId);
    if (!p || p.sessionId !== sessionId) return;
    this.permissionRequests.delete(requestId);
    p.resolve(decision === "once" ? { kind: "approve-once" } : { kind: "reject", ...(message ? { feedback: message } : {}) });
    this.emitEvent(sessionId, "permission.replied", { requestID: requestId });
  }

  // ---------------------------------------------------------------- history, usage, changes

  async history(sessionId: string): Promise<any[]> {
    return toHistory(await (await this.session(sessionId)).getEvents());
  }

  async historyPage(sessionId: string, limit: number, before?: string): Promise<{ messages: any[]; hasMore: boolean }> {
    const all = await this.history(sessionId);
    const at = before ? all.findIndex((m) => m.id === before) : -1;
    const end = at < 0 ? all.length : at;
    const start = Math.max(0, end - limit);
    return { messages: all.slice(start, end), hasMore: start > 0 };
  }

  async sessionUsage(sessionId: string): Promise<Usage | null> {
    const live = this.open.get(sessionId);
    const metrics = live ? await live.session.rpc.usage.getMetrics().catch(() => null) : null;
    const t = metrics?.tokenDetails;
    if (t) {
      return {
        cost: 0, // priced by Symbio from the model's prices
        input: t.input?.tokenCount ?? 0,
        output: t.output?.tokenCount ?? 0,
        reasoning: 0,
        cacheRead: t.cache_read?.tokenCount ?? 0,
        cacheWrite: t.cache_write?.tokenCount ?? 0,
      };
    }
    return this.sessions.get(sessionId)?.usage ?? null;
  }

  async childSessions(): Promise<ChildSession[]> {
    // Copilot's sub-agents run inside the session; their usage is in its totals.
    return [];
  }

  /** Copilot tracks what a session changed, but not between two given turns: all of the session's changes. */
  async changes(sessionId: string): Promise<FileChange[]> {
    const res = await (await this.session(sessionId)).rpc.workspaces.diff({ mode: "session" });
    return (res?.changes ?? []).map((c: any) => {
      const patch = String(c.diff ?? "");
      const lines = patch.split("\n");
      return {
        file: String(c.path),
        status: c.changeType === "added" || c.changeType === "deleted" ? c.changeType : "modified",
        additions: lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length,
        deletions: lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length,
        patch,
      };
    });
  }

  // ---------------------------------------------------------------- tools and processes

  async ensureTools(directory: string, url: string): Promise<void> {
    // Copilot's MCP servers are per session, given when one is opened.
    if (this.toolsByFolder.get(directory) === url) return;
    this.toolsByFolder.set(directory, url);
    for (const [id, state] of this.sessions) if (state.directory === directory && this.open.has(id)) state.stale = true;
  }

  async shells(): Promise<BackgroundShell[]> {
    // Not verified for Copilot yet (docs/copilot-api.md).
    return [];
  }

  async stopShell(): Promise<void> {
    throw new Error("Stopping background processes isn't available with GitHub Copilot CLI yet.");
  }

  // ---------------------------------------------------------------- internals

  private api(): SdkClient {
    if (!this.client || this.state !== "running") throw new Error(`${this.label} is not running (${this.state})`);
    return this.client;
  }

  private state_(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        directory: null,
        permissions: [],
        instructions: new Map(),
        stale: false,
        notes: [],
        busy: false,
        turnError: null,
        queued: new Map(),
        usage: emptyUsage(),
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /** The session's settings, as Copilot takes them when a session is created or opened. */
  private config(sessionId: string, state: SessionState) {
    const url = state.directory ? this.toolsByFolder.get(state.directory) : undefined;
    const instructions = [...state.instructions.values()].join("\n\n");
    return {
      clientName: "symbio",
      streaming: true,
      enableFileChangeTracking: true,
      ...(state.directory ? { workingDirectory: state.directory } : {}),
      ...(instructions ? { systemMessage: { mode: "append", content: instructions } } : {}),
      mcpServers: url ? { symbio: { type: "http", url, headers: { "x-symbio-session": sessionId }, tools: ["*"] } } : {},
      onPermissionRequest: (request: any) => this.onPermission(sessionId, request),
      onUserInputRequest: (request: any) => this.onQuestion(sessionId, request),
    };
  }

  /** An open session, opening it (after a Symbio or runtime restart, or with new instructions) when needed. */
  private async session(sessionId: string): Promise<SdkSession> {
    const live = this.open.get(sessionId);
    if (live) return live.session;
    let pending = this.opening.get(sessionId);
    if (!pending) {
      pending = (async () => {
        const state = this.state_(sessionId);
        if (!state.directory) state.directory = (await this.api().getSessionMetadata(sessionId).catch(() => null))?.context?.cwd ?? null;
        const session = await this.api().resumeSession(sessionId, this.config(sessionId, state));
        state.stale = false;
        this.attach(sessionId, session);
        return session;
      })().finally(() => this.opening.delete(sessionId));
      this.opening.set(sessionId, pending);
    }
    return pending;
  }

  private async close(sessionId: string) {
    const live = this.open.get(sessionId);
    if (!live) return;
    this.open.delete(sessionId);
    live.off();
    await live.session.disconnect().catch(() => {});
  }

  private attach(sessionId: string, session: SdkSession) {
    const off = session.on((e) => this.translate(sessionId, e));
    this.open.set(sessionId, { session, off });
  }

  private emitEvent(sessionId: string, type: string, data: Record<string, unknown> = {}) {
    const event: RuntimeEvent = { id: randomUUID(), type, data: { sessionID: sessionId, ...data } };
    this.emit("event", event);
  }

  /** Copilot's events in the vocabulary of runtime/types.ts. */
  private translate(sessionId: string, e: any) {
    const state = this.state_(sessionId);
    const d = e?.data ?? {};
    const started = () => {
      if (state.busy) return;
      state.busy = true;
      state.turnError = null;
      this.emitEvent(sessionId, "session.execution.started");
    };
    switch (e?.type) {
      case "user.message":
        if (d.messageId) {
          state.queued.delete(d.messageId);
          this.emitEvent(sessionId, "session.inbox.delivered", { inboxID: d.messageId });
        }
        started();
        break;
      case "assistant.turn_start":
        started();
        break;
      case "assistant.message_start":
        this.emitEvent(sessionId, "session.text.started", { assistantMessageID: d.messageId });
        break;
      case "assistant.message_delta":
        this.emitEvent(sessionId, "session.text.delta", { assistantMessageID: d.messageId, delta: d.deltaContent ?? "" });
        break;
      case "assistant.message":
        if (d.content) this.emitEvent(sessionId, "session.text.ended", { assistantMessageID: d.messageId, text: d.content });
        break;
      case "assistant.reasoning_delta":
        this.emitEvent(sessionId, "session.reasoning.delta", { assistantMessageID: d.reasoningId ?? d.messageId, delta: d.deltaContent ?? "" });
        break;
      case "tool.execution_start": {
        const name = toolName(d.toolName, d.mcpServerName);
        this.emitEvent(sessionId, "session.tool.input.started", { id: d.toolCallId, name });
        this.emitEvent(sessionId, "session.tool.called", { id: d.toolCallId, name, input: d.arguments });
        break;
      }
      case "tool.execution_complete":
        if (d.success) this.emitEvent(sessionId, "session.tool.success", { id: d.toolCallId, content: [{ type: "text", text: resultText(d.result) }] });
        else this.emitEvent(sessionId, "session.tool.failed", { id: d.toolCallId, error: { message: d.error?.message ?? "The step failed." } });
        break;
      case "assistant.usage":
        state.usage = {
          ...state.usage,
          input: state.usage.input + (d.inputTokens ?? 0),
          output: state.usage.output + (d.outputTokens ?? 0),
          cacheRead: state.usage.cacheRead + (d.cacheReadTokens ?? 0),
          cacheWrite: state.usage.cacheWrite + (d.cacheWriteTokens ?? 0),
        };
        this.emitEvent(sessionId, "session.usage.updated");
        break;
      case "session.error":
        state.turnError = { type: String(d.errorType ?? "error"), message: String(d.message ?? "The turn failed."), status: d.statusCode };
        break;
      case "session.idle": {
        const error = d.aborted ? { type: "aborted", message: "The turn was interrupted." } : state.turnError;
        state.busy = false;
        state.turnError = null;
        this.emitEvent(sessionId, error ? "session.execution.failed" : "session.execution.succeeded", error ? { error } : {});
        break;
      }
    }
  }

  /** Copilot asks before each tool call: Symbio's rules decide, or the human does. */
  private onPermission(sessionId: string, request: any): any {
    const call = permissionCall(request);
    if (!call) return { kind: "approve-once" };
    const { effect } = evaluate(this.state_(sessionId).permissions, call.action, call.resources);
    if (effect === "allow") return { kind: "approve-once" };
    if (effect === "deny") {
      return { kind: "reject", feedback: `Symbio blocks this (${call.action}: ${call.resources.join("; ")}). Your instructions say what to do instead.` };
    }
    const id = randomUUID();
    return new Promise((resolve) => {
      this.permissionRequests.set(id, { sessionId, resolve });
      this.emitEvent(sessionId, "permission.asked", { id, action: call.action, resources: call.resources, save: [] });
    });
  }

  /** The agent's ask_user: a form the human answers in the chat. */
  private onQuestion(sessionId: string, request: any): Promise<{ answer: string; wasFreeform: boolean }> {
    const id = String(request?.requestId ?? randomUUID());
    const question = String(request?.question ?? "");
    const choices: string[] = Array.isArray(request?.choices) ? request.choices.map(String) : [];
    const field = {
      key: "answer",
      type: "string",
      title: question,
      required: true,
      ...(choices.length ? { options: choices.map((c) => ({ value: c, label: c })), custom: request?.allowFreeform !== false } : {}),
    };
    return new Promise((resolve) => this.questions.set(id, { sessionId, form: { id, title: question, fields: [field] }, choices, resolve }));
  }

  private setState(state: RuntimeState) {
    if (this.state === state) return;
    this.state = state;
    this.emit("state", state);
  }
}

/** "copilot/gpt-6-luna" → "gpt-6-luna". */
export function modelId(ref: string): string {
  return ref.startsWith(`${COPILOT_PROVIDER}/`) ? ref.slice(COPILOT_PROVIDER.length + 1) : ref;
}

/** Copilot's session names: at most 100 characters, no double quotes or control characters. */
function sessionName(title: string): string {
  return title.replace(/["\p{Cc}]/gu, "").trim().slice(0, 100) || "Symbio agent";
}

/** Tool names as the chat knows them: Symbio's MCP tools as "symbio_<tool>", ask_user as "question". */
export function toolName(name: unknown, server?: string): string {
  const n = String(name ?? "tool");
  if (server === "symbio") return `symbio_${n.replace(/^symbio-/, "")}`;
  if (n === "ask_user") return "question";
  return n;
}

function resultText(result: any): string {
  if (typeof result === "string") return result;
  return String(result?.content ?? result?.detailedContent ?? "");
}

/** A Copilot permission request as Symbio's rules see it (action + resources); null for ones no rule covers. */
export function permissionCall(request: any): { action: string; resources: string[] } | null {
  switch (request?.kind) {
    case "shell":
      return { action: "shell", resources: [String(request.fullCommandText ?? "")] };
    case "write":
      return { action: "edit", resources: [String(request.fileName ?? request.path ?? "")] };
    case "read":
      return { action: "read", resources: [String(request.path ?? request.fileName ?? "")] };
    default:
      // Symbio's own tools (mcp), web reads (url), memory.
      return null;
  }
}

/**
 * A session's stored events as conversation messages, in the shape the chat reads (OpenCode's):
 * user messages, and one assistant message per turn with its text, reasoning and tool parts.
 */
export function toHistory(events: any[]): any[] {
  const out: any[] = [];
  let assistant: any = null;
  const tools = new Map<string, any>();
  const turn = (id: string) => {
    if (!assistant) {
      assistant = { id, type: "assistant", content: [] };
      out.push(assistant);
    }
    return assistant;
  };
  for (const e of events) {
    const d = e?.data ?? {};
    const id = String(e?.id ?? randomUUID());
    switch (e?.type) {
      case "user.message": {
        assistant = null;
        const messageId = String(d.messageId ?? id);
        const { text, notes } = splitNotes(String(d.content ?? ""));
        notes.forEach((n, i) => out.push({ id: `${messageId}:note${i}`, type: "synthetic", text: n }));
        out.push({ id: messageId, type: "user", text });
        break;
      }
      case "assistant.reasoning":
        if (d.content) turn(id).content.push({ type: "reasoning", text: d.content });
        break;
      case "assistant.message":
        if (d.content) turn(String(d.messageId ?? id)).content.push({ type: "text", text: d.content });
        break;
      case "tool.execution_start": {
        const part = { type: "tool", name: toolName(d.toolName, d.mcpServerName), state: { status: "running", input: d.arguments } as any };
        tools.set(d.toolCallId, part);
        turn(id).content.push(part);
        break;
      }
      case "tool.execution_complete": {
        const part = tools.get(d.toolCallId);
        if (!part) break;
        part.state = d.success
          ? { ...part.state, status: "completed", content: [{ type: "text", text: resultText(d.result) }] }
          : { ...part.state, status: "error", error: { message: d.error?.message ?? "The step failed." } };
        break;
      }
      case "session.error":
        turn(id).error = { message: String(d.message ?? "The turn failed.") };
        break;
      case "session.model_change":
        assistant = null;
        if (d.newModel) out.push({ id, type: "model-switched", model: { providerID: COPILOT_PROVIDER, id: d.newModel } });
        break;
    }
  }
  return out.filter((m) => m.type !== "assistant" || m.content.length || m.error);
}

/** A prompt with Symbio's notes appended (see prompt) → the prompt, and the notes. */
export function splitNotes(text: string): { text: string; notes: string[] } {
  const at = text.lastIndexOf(`\n\n${NOTES_OPEN}\n`);
  const end = text.trimEnd();
  if (at < 0 || !end.endsWith(NOTES_CLOSE)) return { text, notes: [] };
  const body = end.slice(at + 2 + NOTES_OPEN.length + 1, end.length - NOTES_CLOSE.length).trim();
  return { text: text.slice(0, at), notes: body ? body.split("\n\n") : [] };
}

/**
 * A separate COPILOT_HOME starts signed out. The login itself is in the OS credential store, keyed
 * by the user, so pointing the new home's config at the user's login (as `~/.copilot/config.json`
 * does) signs it in without copying any secret (verified with CLI 1.0.112, docs/copilot-api.md).
 */
export function seedLogin(home: string, userHome = path.join(os.homedir(), ".copilot")) {
  const target = path.join(home, "config.json");
  const source = path.join(userHome, "config.json");
  if (!existsSync(source)) return;
  try {
    const ours = existsSync(target) ? parseConfig(readFileSync(target, "utf8")) : {};
    if (ours.loggedInUsers?.length) return;
    const theirs = parseConfig(readFileSync(source, "utf8"));
    if (!theirs.loggedInUsers?.length) return;
    writeFileSync(target, JSON.stringify({ ...ours, loggedInUsers: theirs.loggedInUsers, lastLoggedInUser: theirs.lastLoggedInUser }, null, 2));
  } catch (err) {
    console.warn("[copilot] couldn't reuse the GitHub login:", (err as Error).message);
  }
}

/** Copilot's config.json has `//` comment lines. */
function parseConfig(text: string): any {
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, "").trim() || "{}");
}
