// What Symbio needs from an agent runtime (the program that runs the agents' sessions: OpenCode,
// GitHub Copilot CLI…). The team logic and the API use only this, so each runtime is one adapter.
//
// Sessions are identified by the runtime's own ids. Events and conversation history use one
// vocabulary for every runtime: the one OpenCode v2 uses (docs/opencode-api.md), which the team
// logic and the chat were first built on. Other adapters translate into it (docs/copilot-api.md).

import type { EventEmitter } from "node:events";
import type { Usage } from "../costs.js";
import type { PermissionRule } from "../guard.js";

export type RuntimeKind = "opencode" | "copilot";
export type RuntimeState = "stopped" | "starting" | "running" | "crashed";

/**
 * Something that happened in a session; `data.sessionID` says which. The types Symbio reacts to:
 * - `session.execution.started` / `.succeeded` / `.failed` (`data.error`): a turn began / ended
 * - `session.text.*`, `session.reasoning.*`, `session.tool.*`, `session.step.*`: live output
 *   (forwarded to the chat as they are)
 * - `session.usage.updated`: token totals changed
 * - `session.context.updated` (`data`: {tokens, limit}): how big the conversation is now (what the
 *   model reads on its next step), and the model's limit when the runtime says it
 * - `permission.asked` (`data`: {id, action, resources, save}) / `permission.replied` ({requestID})
 * - `session.inbox.delivered` / `.cancelled` ({inboxID}): a queued prompt joined the conversation
 * - anything with "retr" in its type: the provider is being retried ({attempt, error})
 */
export interface RuntimeEvent {
  id: string;
  type: string;
  data: any;
}

export interface RuntimeEvents {
  state: [RuntimeState];
  event: [RuntimeEvent];
  restarted: [];
}

/** A model as the runtime lists it. Symbio stores models as "<providerID>/<id>". */
export interface RuntimeModel {
  providerID: string;
  id: string;
  name: string;
  /**
   * The reasoning effort levels the model takes ("low", "high"…), in the runtime's order; empty when
   * it has none to choose (docs/opencode-api.md: variants; docs/copilot-api.md: reasoningEffort).
   */
  efforts: string[];
  /** The runtime's own record, for price and capability lookups (costs.ts, api.ts). */
  raw: any;
}

/** One file a session's turns changed. */
export interface FileChange {
  file: string;
  status: "added" | "deleted" | "modified";
  additions: number;
  deletions: number;
  patch: string;
}

/** A background process an agent started in a folder. */
export interface BackgroundShell {
  id: string;
  command: string;
  pid?: number;
  started: number;
  running: boolean;
  /** The session that started it, when the runtime records it. */
  sessionId?: string;
}

/** A session an agent's session started (a sub-agent), with its usage. */
export interface ChildSession {
  id: string;
  /** "<providerID>/<id>", when known. */
  model: string | null;
  usage: Usage | null;
}

export interface NewSession {
  title: string;
  directory: string;
  /** "<providerID>/<id>" */
  model: string;
  permissions: PermissionRule[];
  /** Symbio's MCP tool server for the session's folder. */
  toolsUrl: string;
  /** A reasoning effort level the model takes (one of its `efforts`); unset: the model's default. */
  effort?: string;
  /** The skills (names, from skills.ts) the session may use; unset: whatever the runtime finds. */
  skills?: string[];
}

export interface AgentRuntime extends EventEmitter<RuntimeEvents> {
  readonly kind: RuntimeKind;
  /** For people: "OpenCode", "GitHub Copilot CLI". */
  readonly label: string;
  readonly state: RuntimeState;
  readonly version: string | null;
  readonly lastError: string | null;
  readonly restarts: number;
  readonly lastMemory: number | null;
  /** The runtime's process while it runs (the programs agents start run under it); null when unknown. */
  readonly pid: number | null;
  /**
   * Whether agents working in a folder may add a `Co-authored-by` line naming the AI to their commits
   * (a project setting; off unless the project allows it). Set by the team; read when a session opens.
   */
  commitCoauthors?: (directory: string) => boolean;

  start(): Promise<void>;
  stop(): Promise<void>;
  /** Restart on purpose (memory recycling, the human's Restart). */
  restart(): Promise<void>;
  /** Memory of the runtime's process tree, in bytes. */
  memoryUsage(): Promise<number | null>;

  listModels(): Promise<RuntimeModel[]>;

  /** Creates a session and returns its id. */
  createSession(opts: NewSession): Promise<string>;
  /** Deletes a session and its stored conversation. */
  deleteSession(sessionId: string): Promise<void>;
  setPermissions(sessionId: string, rules: PermissionRule[]): Promise<void>;
  /** The skills (names) the session may use, from Symbio's library; no others. */
  setSkills(sessionId: string, skills: string[]): Promise<void>;
  /** The skill library changed (a skill added or removed): sessions must still have exactly their own. */
  skillsChanged(): void;
  /** A named part of the session's instructions (the brief, private docs, a handoff note); null removes it. */
  setInstruction(sessionId: string, key: string, value: string | null): Promise<void>;
  /**
   * Starts a turn with the text, or queues it while one runs ("steer": hand it to the running turn
   * now). Returns the id of the queued item, which is also the id of the user message it becomes.
   */
  prompt(sessionId: string, text: string, delivery: "queue" | "steer"): Promise<string | undefined>;
  /** Adds text to the conversation without starting a turn; the agent sees it on its next turn. */
  note(sessionId: string, text: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  /** Changes the session's model and reasoning effort (null: the model's default). */
  switchModel(sessionId: string, model: string, effort?: string | null): Promise<void>;

  /** Ids of queued prompts not yet in the conversation. */
  queued(sessionId: string): Promise<string[]>;
  /** Takes a queued prompt back so it won't be delivered; false when that was no longer possible. */
  cancelQueued(sessionId: string, id: string): Promise<boolean>;

  /** Open questions the agent asked the human with the runtime's own question tool. */
  forms(sessionId: string): Promise<any[]>;
  answerForm(sessionId: string, formId: string, answer: Record<string, unknown>): Promise<void>;
  /** Answers a `permission.asked` event. */
  answerPermission(sessionId: string, requestId: string, decision: "once" | "reject", message?: string | null): Promise<void>;

  /** The whole conversation, oldest first. */
  history(sessionId: string): Promise<any[]>;
  /** The `limit` messages before `before` (a message id), or the latest; oldest first. */
  historyPage(sessionId: string, limit: number, before?: string): Promise<{ messages: any[]; hasMore: boolean }>;
  /** Cumulative usage of the session (not its sub-agents). */
  sessionUsage(sessionId: string): Promise<Usage | null>;
  /** Sessions the session started (sub-agents). */
  childSessions(sessionId: string): Promise<ChildSession[]>;
  /** Files the session's turns changed, from one of its user messages to another. */
  changes(sessionId: string, from: string, to: string): Promise<FileChange[]>;

  /**
   * Makes sure sessions in the folder have Symbio's tool server. `force` registers it again even
   * if it looks connected (after a restart).
   */
  ensureTools(directory: string, url: string, force?: boolean): Promise<void>;
  /** Background processes in a folder. */
  shells(directory: string): Promise<BackgroundShell[]>;
  stopShell(directory: string, id: string): Promise<void>;
}

/** The runtime an agent runs on; agents created before there was a choice run on OpenCode. */
export const runtimeOf = (agent: { runtime?: RuntimeKind }): RuntimeKind => agent.runtime ?? "opencode";
