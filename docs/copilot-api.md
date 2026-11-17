# GitHub Copilot CLI notes

Work in progress: Symbio is getting a second agent runtime, GitHub Copilot CLI, next to OpenCode
(see the roadmap). The team logic talks to runtimes through one interface,
`src/server/runtime/types.ts`; this page is what the Copilot side of it relies on.

Symbio drives Copilot through the official **Copilot SDK** (`@github/copilot-sdk`, MIT), a JSON-RPC
client that starts the Copilot runtime (the CLI in headless mode, shipped with the SDK as a
platform package, e.g. `@github/copilot-sdk-win32-x64`) over stdio. Everything below was
**verified live against SDK 1.0.34 / Copilot CLI 1.0.112 on Windows** (2026-11-16) with a throwaway
script, unless marked otherwise. Re-verify when either changes, and update this page.

## The runtime process

- `new CopilotClient({ baseDirectory })` starts one runtime process for any number of sessions.
  `baseDirectory` sets `COPILOT_HOME` (default `~/.copilot`): sessions, config and logs live there.
- **Sign-in.** A runtime with its own empty `COPILOT_HOME` is not signed in. One whose
  `config.json` names the user's login (`loggedInUsers`, `lastLoggedInUser`, copied from
  `~/.copilot/config.json`, which has `//` comment lines) is: the token itself is in the OS credential
  store, keyed by the login. So Symbio can keep its sessions out of the user's own Copilot history
  and still use their login. Other ways in: `gitHubToken` (client or session option; `gho_`, `ghu_`
  or fine-grained `github_pat_` tokens with the Copilot Requests permission, not classic `ghp_`),
  the `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` variables, or `copilot login`.
- `client.getAuthStatus()` → `{ isAuthenticated, authType, login }`. `client.getStatus()` →
  `{ version, protocolVersion }`.
- `client.listModels()` → `[{ id, name, billing: { tokenPrices: { inputPrice, outputPrice,
  cacheReadPrice, cacheWritePrice, contextMax, … } }, capabilities: { supports: { vision,
  reasoningEffort, … } } }]`, plus `auto`. Not available before signing in.

## Sessions

- `client.createSession({ sessionId?, model, workingDirectory, systemMessage, mcpServers,
  onPermissionRequest, onUserInputRequest, streaming, … })`. Each session has its own working
  folder: two sessions in one runtime ran `pwd` in their own folders.
- `client.resumeSession(id, config)` continues a session, also from a new runtime process (it
  remembered a file it created and an answer it got). Handlers and MCP servers are given again.
- `client.listSessions()`, `client.deleteSession(id)` (removes it from disk).
- **New instructions for an open session:** `resumeSession(id, { systemMessage, … })` on a
  session that is already open returns a new session object that uses them from the next turn
  ("Your name is Alpha" → resumed with "Bravo" → it answered Bravo). Symbio reopens a session
  this way before its next turn when its brief or private docs change.
- `session.getEvents()` is the stored conversation: `session.start`, `user.message`,
  `system.message`, `assistant.turn_start`, `assistant.message` (`content`, `toolRequests`),
  `tool.execution_start` / `_complete`, `permission.*`, `assistant.turn_end`, `abort`,
  `system.notification`… Streaming deltas are not stored.

## Turns and messages

- `session.send({ prompt, mode })` returns the user message's id. `mode: "enqueue"` (default)
  waits for the running turn: FIRST then SECOND, in order. `mode: "immediate"` reaches the running
  turn: asked mid-command to reply STEERED, it did, right after the command.
- `session.abort()` stops the turn: an `abort` event (`reason: "user_initiated"`), then
  `session.idle` with `aborted: true`.
- **Long commands go to the background on their own** (`initial_wait`), and their completion starts
  a new turn by itself (a `system.notification`, then the model reads the output). A turn can
  therefore start without Symbio prompting.
- **No "add to the conversation without a turn"** (OpenCode's `synthetic` with `resume: false`) was
  found in the SDK. Symbio keeps such notes and puts them before the next prompt instead.

## Events

`session.on(handler)` (every event) or `session.on(type, handler)`. What a turn looks like:

| Event | Data Symbio uses |
|---|---|
| `user.message` | the prompt as stored |
| `assistant.turn_start` / `assistant.turn_end` | one model step |
| `assistant.message_start`, `assistant.message_delta` (`deltaContent`), `assistant.message` (`content`, `toolRequests`) | text (streamed with `streaming: true`) |
| `assistant.reasoning`, `assistant.reasoning_delta` | reasoning |
| `tool.execution_start` (`toolCallId`, `toolName`, `arguments`, `mcpServerName`), `tool.execution_complete` (`success`, `result.content`, `error.message`) | tool calls; Symbio's MCP tools are named `symbio-<tool>` |
| `permission.requested` / `permission.completed` | see below |
| `user_input.requested` / `user_input.completed` | the agent asks the human (`ask_user`) |
| `assistant.usage` (`model`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `cost`) | per model call |
| `session.idle` (`aborted?`) | the turn ended |
| `session.error` (`errorType`, `message`, `statusCode?`) | the turn failed |

Built-in tools seen on Windows: `powershell` (with `read_powershell` for background shells),
`apply_patch`, `ask_user`; others exist (`view`, `grep`, `glob`, `task`…).

## Symbio's tools

Per-session MCP servers: `mcpServers: { symbio: { type: "http", url, headers, tools: ["*"] } }`.
Tool calls carry `_meta["com.github.copilot/toolCallId"]` but **not the session**, so Symbio gives
each session its own header (or URL) to know who is calling. The headers arrived on every call.

## Permissions and questions

- `onPermissionRequest(request)` is called before each tool runs, with `kind` (`shell`, `write`,
  `read`, `mcp`, `url`, …) and, for shells, `fullCommandText` (and `shellType: "powershell"`); for
  writes, `fileName` (absolute). Returning `{ kind: "approve-once" }` lets it run;
  `{ kind: "reject", feedback }` refuses it, and the model sees the feedback ("The user rejected
  this tool call. User feedback: …") and acts on it. So Symbio applies its own rules (`guard.ts`)
  here and holds "ask" ones for the human.
- `onUserInputRequest({ question, choices, allowFreeform })` → `{ answer, wasFreeform }`.

## Usage and cost

- `session.rpc.usage.getMetrics()` → `{ totalPremiumRequestCost, totalUserRequests, totalNanoAiu,
  tokenDetails: { input, cache_read, cache_write, output }, modelMetrics: { <model>: { requests:
  { count, cost }, usage } }, codeChanges }`. After 7 prompts: `totalUserRequests: 7`,
  `totalPremiumRequestCost: 7`: every prompt Symbio sends counts as a request.

## Changes

`session.rpc.workspaces.diff({ mode: "session" })` gives the files the session changed, with unified
diffs, when the session was created with `enableFileChangeTracking: true` (`isFallback: false`);
without it, it falls back to the folder's uncommitted git diff (`unavailableReason:
"file-change-tracking-disabled"`). There is no diff between two given turns, so a task's changes
are the whole session's.

## Failures

A model that doesn't exist (or isn't enabled) fails the turn at once: `session.error` with
`errorType: "query"`, `message: 'Execution failed: Model "…" is not available.'`, then
`session.idle`, with **no `user.message`: the prompt isn't recorded** (and no request is billed:
`totalPremiumRequests: 0`). Symbio carries such a prompt to the next turn, as OpenCode keeps it in the
conversation. `session.setModel(id)` switches a live session (it then said it was the new model).

MCP servers are connected when a session is opened (`server/discover`, `initialize`,
`tools/list`), each request with the session's headers, again when it's reopened after a restart.

`tests/contract/copilot.test.ts` checks these against the real CLI, with turns on a missing model
only, so it costs nothing.

## How Symbio maps it (`src/server/copilot/runtime.ts`)

| Symbio needs | With Copilot |
|---|---|
| A session per agent, in its folder | `createSession` with a Symbio-made `sessionId`, `workingDirectory`, `enableFileChangeTracking` |
| Symbio's tools | the `symbio` MCP server per session, with an `x-symbio-session` header (`mcp.ts` reads it) |
| Briefs and private docs | `systemMessage` (`append`), reopened before the next turn when they change |
| Permission rules | `onPermissionRequest`: `guard.ts`'s `evaluate` decides; deny → reject with a reason, ask → `permission.asked` for the human |
| Notes without a turn | kept, and appended to the next prompt in `<symbio-notes>`; the history shows them as notes again |
| Queued messages taken back mid-turn | `rpc.queue.pendingItems` / `rpc.queue.withdrawMessage` |
| Questions to the human | `onUserInputRequest` → a form with one `answer` field |
| Events and history | translated into OpenCode's vocabulary (`runtime/types.ts`); a quick turn's events wait until the prompt call has returned |
| A task's changes | the session's diff, kept to the files the task's turns edited (`fileEdits` of edit steps) |
| Signing in | its own `COPILOT_HOME` (given by Symbio) pointed at the user's GitHub login |

Not there yet: background processes (`list_processes` / `stop_process` return nothing), memory
measurement (the SDK doesn't give the process id), prices from Copilot's model list, signing in from
Symbio (today: `copilot login` in a terminal), and briefs worded for Copilot (they describe
OpenCode's code mode).
