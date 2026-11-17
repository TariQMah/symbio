// The GitHub Copilot CLI runtime against a stand-in for the Copilot SDK (the real one is checked
// by hand, docs/copilot-api.md): how Symbio's sessions, rules, notes, questions and events map onto it.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CopilotRuntime, editedBetween, priceOf, seedLogin, splitNotes, toHistory, type SdkClient, type SdkSession } from "../src/server/copilot/runtime.js";
import { AGENT_PERMISSIONS } from "../src/server/guard.js";

/** A fake SDK: records the configs sessions are created and opened with, and lets the test play events. */
function fakeSdk() {
  const created: any[] = [];
  const resumed: any[] = [];
  const sent: { sessionId: string; prompt: string; mode?: string }[] = [];
  const handlers = new Map<string, (e: any) => void>();
  const configs = new Map<string, any>();
  /** Runs inside `send`, before it returns (events can arrive before the caller gets the id). */
  const hooks: { onSend?: (sessionId: string, id: string) => void } = {};
  const cancelled: string[] = [];
  const session = (sessionId: string, config: any): SdkSession => {
    configs.set(sessionId, config);
    return {
      sessionId,
      send: async (o) => {
        sent.push({ sessionId, ...o });
        const id = `msg_${sent.length}`;
        hooks.onSend?.(sessionId, id);
        return id;
      },
      abort: async () => {},
      setModel: async () => {},
      getEvents: async () => [],
      on: (h) => {
        handlers.set(sessionId, h);
        return () => handlers.delete(sessionId);
      },
      disconnect: async () => {},
      rpc: {
        tasks: {
          list: async () => ({
            tasks: [
              { type: "shell", id: "0", command: "npm run dev", status: "running", startedAt: "2026-11-17T02:34:09.766Z", pid: 4242 },
              { type: "shell", id: "1", command: "npm test", status: "completed", startedAt: "2026-11-17T02:30:00.000Z" },
              { type: "agent", id: "2", description: "a sub-agent" },
            ],
          }),
          cancel: async ({ id }: { id: string }) => {
            cancelled.push(`${sessionId}:${id}`);
            return { cancelled: true };
          },
        },
        queue: {
          pendingItems: async () => ({ items: [] }),
          withdrawMessage: async ({ messageId }: { messageId: string }) => ({ removed: messageId.startsWith("msg_"), interrupted: false }),
        },
      },
    };
  };
  const client: SdkClient = {
    start: async () => {},
    stop: async () => {},
    getStatus: async () => ({ version: "1.0.112" }),
    getAuthStatus: async () => ({ isAuthenticated: true, login: "someone" }),
    listModels: async () => [{ id: "auto" }, { id: "gpt-6-luna", name: "GPT-6 Luna", capabilities: { supports: { vision: true } } }],
    createSession: async (config) => {
      created.push(config);
      return session(config.sessionId, config);
    },
    resumeSession: async (id, config) => {
      resumed.push({ id, config });
      return session(id, config);
    },
    deleteSession: async () => {},
    getSessionMetadata: async () => null,
  };
  const play = (sessionId: string, type: string, data: any = {}) => handlers.get(sessionId)!({ id: `ev_${Math.random()}`, type, data });
  return { client, created, resumed, sent, configs, play, hooks, cancelled };
}

async function setup() {
  const sdk = fakeSdk();
  const runtime = new CopilotRuntime(mkdtempSync(path.join(os.tmpdir(), "sym-cp-test-")), async () => sdk.client);
  await runtime.start();
  const events: any[] = [];
  runtime.on("event", (e) => events.push(e));
  const sessionId = await runtime.createSession({
    title: 'Book · "core"',
    directory: "C:/work/book",
    model: "copilot/gpt-6-luna",
    permissions: AGENT_PERMISSIONS,
    toolsUrl: "http://127.0.0.1:4310/mcp/tok",
  });
  return { sdk, runtime, events, sessionId };
}

test("a session works in its folder, with Symbio's tools identified by a header and the model's own id", async () => {
  const { sdk, runtime, sessionId } = await setup();
  const config = sdk.created[0];
  assert.equal(config.sessionId, sessionId);
  assert.equal(config.workingDirectory, "C:/work/book");
  assert.equal(config.model, "gpt-6-luna");
  assert.equal(config.name, "Book · core", "no double quotes in Copilot session names");
  assert.deepEqual(config.mcpServers.symbio, { type: "http", url: "http://127.0.0.1:4310/mcp/tok", headers: { "x-symbio-session": sessionId }, tools: ["*"] });
  const models = await runtime.listModels();
  assert.deepEqual(models.map((m) => `${m.providerID}/${m.id}`), ["copilot/gpt-6-luna"], "auto is not offered");
});

test("instructions set on an open session apply from its next turn; notes go with the next prompt", async () => {
  const { sdk, runtime, sessionId } = await setup();
  await runtime.setInstruction(sessionId, "symbio-role", "You are core.");
  await runtime.setInstruction(sessionId, "symbio-docs", "Docs.");
  await runtime.note(sessionId, "Symbio: writer was renamed.");
  await runtime.prompt(sessionId, "[from: human · chat]\nHello", "queue");

  assert.equal(sdk.resumed.length, 1, "reopened with the new instructions");
  assert.deepEqual(sdk.resumed[0].config.systemMessage, { mode: "append", content: "You are core.\n\nDocs." });
  const prompt = sdk.sent.at(-1)!.prompt;
  assert.match(prompt, /^\[from: human · chat\]\nHello\n\n<symbio-notes>\nSymbio: writer was renamed\.\n<\/symbio-notes>$/);
  assert.deepEqual(splitNotes(prompt), { text: "[from: human · chat]\nHello", notes: ["Symbio: writer was renamed."] });

  await runtime.prompt(sessionId, "Next", "steer");
  assert.equal(sdk.resumed.length, 1, "unchanged instructions: not reopened");
  assert.deepEqual(sdk.sent.at(-1), { sessionId, prompt: "Next", mode: "immediate" }, "notes are sent once; steer is immediate");
});

test("Symbio's rules decide tool calls: denied with a reason, asked of the human, or allowed", async () => {
  const { sdk, runtime, events, sessionId } = await setup();
  const ask = sdk.configs.get(sessionId).onPermissionRequest;

  const killed = await ask({ kind: "shell", fullCommandText: "npm test; taskkill /F /IM node.exe" });
  assert.equal(killed.kind, "reject", "a blocked command can't hide behind another");
  assert.match(killed.feedback, /Symbio blocks this/);
  assert.equal((await ask({ kind: "write", fileName: "C:\\Users\\me\\.ssh\\id_rsa" })).kind, "reject");
  assert.equal((await ask({ kind: "shell", fullCommandText: "git status" })).kind, "approve-once");
  assert.equal((await ask({ kind: "mcp", toolName: "symbio-send_message" })).kind, "approve-once");

  const pending = ask({ kind: "shell", fullCommandText: "pip install requests" });
  const asked = events.find((e) => e.type === "permission.asked");
  assert.deepEqual(asked.data, { sessionID: sessionId, id: asked.data.id, action: "shell", resources: ["pip install requests"], save: [] });
  await runtime.answerPermission(sessionId, asked.data.id, "reject", "Not now.");
  assert.deepEqual(await pending, { kind: "reject", feedback: "Not now." });
  assert.ok(events.some((e) => e.type === "permission.replied" && e.data.requestID === asked.data.id));
});

test("the agent's questions become forms the human answers", async () => {
  const { sdk, runtime, sessionId } = await setup();
  const answer = sdk.configs.get(sessionId).onUserInputRequest({ question: "Which colour?", choices: ["blue", "red"], allowFreeform: true, requestId: "req_1" });
  const [form] = await runtime.forms(sessionId);
  assert.equal(form.id, "req_1");
  assert.deepEqual(form.fields[0].options, [
    { value: "blue", label: "blue" },
    { value: "red", label: "red" },
  ]);
  await runtime.answerForm(sessionId, "req_1", { answer: "green" });
  assert.deepEqual(await answer, { answer: "green", wasFreeform: true });
  assert.deepEqual(await runtime.forms(sessionId), []);
});

test("Copilot's events become the turn, text, tool and inbox events the team and the chat use", async () => {
  const { sdk, events, sessionId } = await setup();
  const types = () => events.map((e) => e.type);
  sdk.play(sessionId, "user.message", { messageId: "msg_1", content: "hi" });
  sdk.play(sessionId, "assistant.turn_start", {});
  sdk.play(sessionId, "tool.execution_start", { toolCallId: "c1", toolName: "symbio-send_message", mcpServerName: "symbio", arguments: { to: "core" } });
  sdk.play(sessionId, "tool.execution_complete", { toolCallId: "c1", success: true, result: { content: "Sent." } });
  sdk.play(sessionId, "tool.execution_start", { toolCallId: "c2", toolName: "ask_user", arguments: { question: "?" } });
  sdk.play(sessionId, "assistant.message_delta", { messageId: "a1", deltaContent: "Do" });
  sdk.play(sessionId, "assistant.message", { messageId: "a1", content: "Done." });
  sdk.play(sessionId, "session.idle", {});
  assert.deepEqual(types(), [
    "session.inbox.delivered",
    "session.execution.started",
    "session.tool.input.started",
    "session.tool.called",
    "session.tool.success",
    "session.tool.input.started",
    "session.tool.called",
    "session.text.delta",
    "session.text.ended",
    "session.execution.succeeded",
  ]);
  assert.equal(events[2].data.name, "symbio_send_message", "Symbio's tools named as with OpenCode");
  assert.equal(events[5].data.name, "question", "ask_user is the question tool");

  // A model that isn't available: the turn fails with the provider's message (model fallback reads it).
  events.length = 0;
  sdk.play(sessionId, "session.error", { errorType: "query", message: 'Execution failed: Model "x" is not available.' });
  sdk.play(sessionId, "session.idle", {});
  assert.deepEqual(events.at(-1).data.error, { type: "query", message: 'Execution failed: Model "x" is not available.', status: undefined });
  sdk.play(sessionId, "session.idle", { aborted: true });
  assert.equal(events.at(-1).type, "session.execution.failed");
  assert.equal(events.at(-1).data.error.type, "aborted", "interrupts aren't model failures");
});

test("stored events read back as the chat's history: notes apart, one assistant message per turn", () => {
  const history = toHistory([
    { id: "e1", type: "user.message", data: { messageId: "u1", content: "Go\n\n<symbio-notes>\nSymbio: a note\n</symbio-notes>" } },
    { id: "e2", type: "assistant.message", data: { messageId: "a1", content: "", toolRequests: [] } },
    { id: "e3", type: "tool.execution_start", data: { toolCallId: "t1", toolName: "powershell", arguments: { command: "git status" } } },
    { id: "e4", type: "tool.execution_complete", data: { toolCallId: "t1", success: true, result: { content: "clean" } } },
    { id: "e5", type: "assistant.message", data: { messageId: "a2", content: "All clean." } },
    { id: "e6", type: "session.model_change", data: { newModel: "claude-haiku-4.5" } },
  ]);
  assert.deepEqual(
    history.map((m) => m.type),
    ["synthetic", "user", "assistant", "model-switched"],
  );
  assert.equal(history[0].text, "Symbio: a note");
  assert.equal(history[1].text, "Go");
  assert.deepEqual(history[2].content, [
    { type: "tool", name: "powershell", state: { status: "completed", input: { command: "git status" }, content: [{ type: "text", text: "clean" }] } },
    { type: "text", text: "All clean." },
  ]);
  assert.deepEqual(history[3].model, { providerID: "copilot", id: "claude-haiku-4.5" });
});

test("Symbio's own Copilot folder reuses the user's GitHub login without copying secrets", () => {
  const userHome = mkdtempSync(path.join(os.tmpdir(), "sym-cp-user-"));
  const home = mkdtempSync(path.join(os.tmpdir(), "sym-cp-home-"));
  writeFileSync(
    path.join(userHome, "config.json"),
    '// User settings belong in settings.json.\n{"loggedInUsers":[{"host":"https://github.com","login":"me"}],"lastLoggedInUser":{"host":"https://github.com","login":"me"},"trustedFolders":["C:/x"]}',
  );
  seedLogin(home, userHome);
  const config = JSON.parse(readFileSync(path.join(home, "config.json"), "utf8"));
  assert.deepEqual(Object.keys(config).sort(), ["lastLoggedInUser", "loggedInUsers"]);
  assert.equal(config.lastLoggedInUser.login, "me");
});

test("a turn that ends before the prompt call returns still reaches the team after it (the agent isn't left busy)", async () => {
  const { sdk, runtime, events, sessionId } = await setup();
  sdk.hooks.onSend = (id, messageId) => {
    sdk.play(id, "user.message", { messageId, content: "hi" });
    sdk.play(id, "session.idle", {});
  };
  let seenWhenReturned = -1;
  await runtime.prompt(sessionId, "hi", "queue").then(() => (seenWhenReturned = events.length));
  assert.equal(seenWhenReturned, 0, "nothing yet when the caller marks the agent busy");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    events.map((e) => e.type),
    ["session.inbox.delivered", "session.execution.started", "session.execution.succeeded"],
  );
});

test("a prompt a failing model never took (and its notes) goes with the next one", async () => {
  const { sdk, runtime, sessionId } = await setup();
  await runtime.note(sessionId, "Symbio: a note.");
  await runtime.prompt(sessionId, "[from: writer · request]\nPlease review.", "queue");
  await new Promise((r) => setImmediate(r));
  sdk.play(sessionId, "session.error", { errorType: "query", message: 'Model "x" is not available.' });
  sdk.play(sessionId, "session.idle", {});
  await runtime.prompt(sessionId, "Symbio: your model failed; you were switched. Continue.", "queue");
  assert.deepEqual(splitNotes(sdk.sent.at(-1)!.prompt), {
    text: "Symbio: your model failed; you were switched. Continue.",
    notes: ["Symbio: a note.", "[from: writer · request]\nPlease review."],
  });
});

test("a task's changes are the files its turns edited", () => {
  const events = [
    { type: "user.message", data: { messageId: "u1" } },
    { type: "tool.execution_complete", data: { success: true, fileEdits: [{ path: "C:\\work\\script.md" }] } },
    { type: "user.message", data: { messageId: "u2" } },
    { type: "tool.execution_complete", data: { success: true, fileEdits: [{ path: "C:\\work\\frames.txt" }] } },
    { type: "user.message", data: { messageId: "u3" } },
    { type: "tool.execution_complete", data: { success: true, fileEdits: [{ path: "C:\\work\\final.mp4" }] } },
  ];
  assert.deepEqual([...editedBetween(events, "u2", "u2", "C:\\work")!], ["frames.txt"]);
  assert.deepEqual([...editedBetween(events, "u1", "u2", "C:\\work")!], ["script.md", "frames.txt"]);
  assert.equal(editedBetween([{ type: "user.message", data: { messageId: "u1" } }], "u1", "u1", "C:\\work"), null, "unknown: no filter");
});

test("a queued prompt taken back mid-turn leaves its notes for the next prompt", async () => {
  const { sdk, runtime, sessionId } = await setup();
  await runtime.note(sessionId, "Symbio: the human answered writer's question.");
  const id = await runtime.prompt(sessionId, "[from: writer · info]\nDone.", "queue");
  await new Promise((r) => setImmediate(r));
  assert.equal(await runtime.cancelQueued(sessionId, id!), true, "handed to the agent in a tool result instead");
  await runtime.prompt(sessionId, "@core say noted", "queue");
  assert.deepEqual(splitNotes(sdk.sent.at(-1)!.prompt).notes, ["Symbio: the human answered writer's question."]);
});

test("file reads (which Copilot doesn't ask about inside the folder) go through Symbio's read rules", async () => {
  const { sdk, runtime, events, sessionId } = await setup();
  const pre = sdk.configs.get(sessionId).hooks.onPreToolUse;
  assert.equal(await pre({ toolName: "view", toolArgs: { path: "C:\\work\\book\\notes.md" }, toolCallId: "t1" }), undefined, "allowed");
  const secret = await pre({ toolName: "view", toolArgs: { path: "C:\\Users\\me\\.ssh\\id_rsa" }, toolCallId: "t2" });
  assert.equal(secret.permissionDecision, "deny");
  assert.match(secret.permissionDecisionReason, /Symbio blocks this/);
  // An image is an "ask" rule: Symbio answers it (permissions.ts refuses it with a pointer to view_image).
  const image = pre({ toolName: "view", toolArgs: { path: "C:\\work\\book\\cover.png" }, toolCallId: "t3" });
  const asked = events.find((e) => e.type === "permission.asked");
  assert.deepEqual(asked.data.resources, ["C:\\work\\book\\cover.png"]);
  assert.equal(asked.data.action, "read");
  await runtime.answerPermission(sessionId, asked.data.id, "reject", "Use view_image.");
  assert.deepEqual(await image, { permissionDecision: "deny", permissionDecisionReason: "Use view_image." });
  assert.equal(await pre({ toolName: "powershell", toolArgs: { command: "ls" } }), undefined, "other tools aren't reads");
});

test("an agent's background processes are its session's shell tasks, and stopping one cancels it", async () => {
  const { sdk, runtime, sessionId } = await setup();
  const shells = await runtime.shells("C:/work/book");
  assert.deepEqual(
    shells.map((s) => [s.id, s.command, s.running, s.pid, s.sessionId]),
    [
      [`${sessionId}:0`, "npm run dev", true, 4242, sessionId],
      [`${sessionId}:1`, "npm test", false, undefined, sessionId],
    ],
  );
  assert.deepEqual(await runtime.shells("C:/elsewhere"), [], "only the folder's");
  await runtime.stopShell("C:/work/book", `${sessionId}:0`);
  assert.deepEqual(sdk.cancelled, [`${sessionId}:0`]);
});

test("Copilot's prices (AI credits per million tokens) in dollars", () => {
  assert.deepEqual(priceOf({ billing: { tokenPrices: { inputPrice: 10, outputPrice: 50, cacheReadPrice: 1, cacheWritePrice: 12.5 } } }), {
    input: 0.1,
    output: 0.5,
    cache: { read: 0.01, write: 0.125 },
  });
  assert.equal(priceOf({ id: "auto" }), null);
});

