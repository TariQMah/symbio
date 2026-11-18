// Contract test: GitHub Copilot CLI as Symbio uses it (src/server/copilot/runtime.ts), against the
// real Copilot runtime the SDK starts. Turns run on a model that doesn't exist, which fails at once
// without reaching a provider, so nothing here is billed. Copilot's data goes to a temporary folder.
//
// It needs a GitHub login with Copilot: the user's own (`copilot login`, reused without copying it),
// or a COPILOT_GITHUB_TOKEN. Without one it's skipped. npm run test:contract

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";

const root = mkdtempSync(path.join(os.tmpdir(), "sym-contract-cp-"));
process.env.SYMBIO_HOME = path.join(root, "symbio");
delete process.env.SYMBIO_COPILOT_SDK; // the real SDK

const { CopilotRuntime } = await import("../../src/server/copilot/runtime.js");
const { AGENT_PERMISSIONS } = await import("../../src/server/guard.js");
const { handleMcp } = await import("../../src/server/mcp.js");

const runtime = new CopilotRuntime(path.join(root, "copilot"));
const work = path.join(root, "work");
mkdirSync(work, { recursive: true });
const events: any[] = [];
runtime.on("event", (e) => events.push(e));
const sessions: string[] = [];
/** The session on a model that doesn't exist: its turns fail at once, so they cost nothing. */
let missingModelSession = "";

// A tool server like Symbio's, recording who calls it.
const mcpCalls: { session?: string; method: string; token?: string }[] = [];
const mcpApp = new Hono();
mcpApp.all("/mcp/:token", async (c) => {
  const body = await c.req.raw.clone().json().catch(() => null);
  mcpCalls.push({ session: c.req.header("x-symbio-session"), method: body?.method ?? c.req.method, token: c.req.param("token") });
  return handleMcp(c, (token) =>
    token === "contract" || token === "after-symbio-restart" ? { ctx: {}, tools: [{ name: "ping", description: "Answers pong", inputSchema: { type: "object", properties: {} }, run: () => "pong" }] } : null,
  );
});
const mcpServer = createServer(getRequestListener(mcpApp.fetch));
let toolsUrl = "";

let skip: string | false = false;
before(async () => {
  await new Promise<void>((resolve) => mcpServer.listen(0, "127.0.0.1", resolve));
  toolsUrl = `http://127.0.0.1:${(mcpServer.address() as any).port}/mcp/contract`;
  await runtime.start();
  if (!runtime.login) skip = "no GitHub Copilot login (copilot login, or COPILOT_GITHUB_TOKEN)";
});

after(async () => {
  for (const id of sessions) await runtime.deleteSession(id).catch(() => {});
  await runtime.stop();
  mcpServer.close();
  rmSync(root, { recursive: true, force: true });
});

const until = async (what: string, check: () => boolean, ms = 60_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
};
const ofSession = (id: string, type: string) => events.filter((e) => e.data.sessionID === id && e.type === type);

test("the runtime starts, signed in, and lists models with their prices", async (t) => {
  if (skip) return t.skip(skip);
  assert.equal(runtime.state, "running");
  assert.match(runtime.version ?? "", /^\d+\.\d+\.\d+/);
  const models = await runtime.listModels();
  assert.ok(models.length > 0);
  const copilots = models.filter((m) => m.providerID === "copilot");
  assert.ok(copilots.length > 0 && copilots.every((m) => m.id && m.id !== "auto"));
  assert.ok(models.some((m) => m.raw?.billing?.tokenPrices), "models carry token prices");
  const priced = models.find((m) => m.raw?.cost);
  assert.ok(priced && priced.raw.cost.input > 0 && priced.raw.cost.input < 100, "prices in dollars per million tokens");
});

test("the user's own providers (providers.json in their Copilot folder) are offered and selectable", async (t) => {
  if (skip) return t.skip(skip);
  const { userProviders } = await import("../../src/server/copilot/runtime.js");
  const own = userProviders().models;
  if (!own.length) return t.skip("no providers.json with models in the user's Copilot folder");
  const ref = `${own[0].provider}/${own[0].id}`;
  const models = await runtime.listModels();
  assert.ok(models.some((m) => `${m.providerID}/${m.id}` === ref), `${ref} is offered`);
  assert.ok(!JSON.stringify(models).match(/apiKey|bearerToken/), "no credentials in the list");
  const id = await runtime.createSession({ title: "Contract · byok", directory: work, model: ref, permissions: AGENT_PERMISSIONS, toolsUrl });
  sessions.push(id);
  const current = await (runtime as any).open.get(id).session.rpc.model.getCurrent();
  assert.equal(current.modelId, ref, "the session runs on it (no turn: that would bill the user's provider)");
});

test("signing in starts a GitHub device-code flow, and can be cancelled", async (t) => {
  if (skip) return t.skip(skip);
  const code = await runtime.beginSignIn();
  assert.match(code.userCode, /^\w{4}-\w{4}$/);
  assert.match(code.verificationUri, /^https:\/\/github\.com\/login\/device/);
  assert.equal(runtime.pendingSignIn?.userCode, code.userCode);
  await runtime.cancelSignIn();
  assert.equal(runtime.pendingSignIn, null);
  assert.ok(await runtime.checkLogin(), "still signed in");
});

test("a session in its folder: a turn on a missing model fails at once, as Symbio expects", async (t) => {
  if (skip) return t.skip(skip);
  const id = await runtime.createSession({ title: "Contract · core", directory: work, model: "copilot/no-such-model", permissions: AGENT_PERMISSIONS, toolsUrl });
  sessions.push(id);
  missingModelSession = id;
  await runtime.setInstruction(id, "symbio-role", "You are a contract test.");
  await runtime.note(id, "Symbio: a note for the next turn.");
  const promptId = await runtime.prompt(id, "Hello", "queue");
  assert.ok(promptId, "the prompt's id");
  await until("the turn to end", () => ofSession(id, "session.execution.failed").length > 0);
  const failed = ofSession(id, "session.execution.failed")[0].data.error;
  assert.match(failed.message, /not available/i, "model fallback recognises it");
  // Such a turn fails before it starts: the prompt isn't recorded (Symbio carries it to the next turn).
  assert.deepEqual(ofSession(id, "session.inbox.delivered"), []);
  assert.deepEqual((await runtime.history(id)).filter((m) => m.type === "user"), [], "nothing recorded");
  const page = await runtime.historyPage(id, 10);
  assert.ok(Array.isArray(page.messages) && page.hasMore === false);
});

test("queue, changes, usage and model switches answer on a live session", async (t) => {
  if (skip) return t.skip(skip);
  const id = await runtime.createSession({ title: "Contract · helper", directory: work, model: "copilot/no-such-model", permissions: AGENT_PERMISSIONS, toolsUrl });
  sessions.push(id);
  const promptId = await runtime.prompt(id, "Hi", "queue");
  await until("the turn to end", () => ofSession(id, "session.execution.failed").length > 0);
  assert.deepEqual(await runtime.queued(id), []);
  assert.equal(await runtime.cancelQueued(id, promptId!), false, "already delivered");
  assert.ok(Array.isArray(await runtime.changes(id, promptId!, promptId!)));
  assert.deepEqual(await runtime.shells(work), [], "background processes (none here)");
  const usage = await runtime.sessionUsage(id);
  assert.ok(usage && typeof usage.input === "number");
  const [model] = await runtime.listModels();
  await runtime.switchModel(id, `copilot/${model.id}`);
  assert.ok((await runtime.history(id)).some((m) => m.type === "model-switched" && m.model.id === model.id), "the switch is in the history");
});

test("after a restart, a session opens again with its folder and Symbio's tools (identified per session)", async (t) => {
  if (skip) return t.skip(skip);
  const id = missingModelSession;
  assert.ok(id, "needs the missing-model session");
  await runtime.restart();
  await runtime.ensureTools(work, toolsUrl);
  const callsBefore = mcpCalls.length;
  const before = ofSession(id, "session.execution.failed").length;
  await runtime.prompt(id, "Again", "queue");
  await until("the turn to end", () => ofSession(id, "session.execution.failed").length > before);
  // Copilot connects to MCP servers when a session opens (again after a restart); every call names the session.
  const reopened = mcpCalls.slice(callsBefore);
  assert.ok(reopened.some((c) => c.method === "tools/list" && c.session === id), "the reopened session lists Symbio's tools");
  for (const call of mcpCalls) assert.ok(sessions.includes(call.session ?? ""), `MCP ${call.method} without a session header`);
});

test("after Symbio restarts, a session opens with the tools URL of the new run", async (t) => {
  if (skip) return t.skip(skip);
  const id = missingModelSession;
  assert.ok(id, "needs the missing-model session");
  // A new Symbio: a new runtime object on the same Copilot folder, and a new tools URL (tokens are per run).
  await runtime.stop();
  const again = new CopilotRuntime(path.join(root, "copilot"));
  const seen: any[] = [];
  again.on("event", (e) => seen.push(e));
  await again.start();
  try {
    const url = toolsUrl.replace("/mcp/contract", "/mcp/after-symbio-restart");
    await again.ensureTools(work, url);
    const callsBefore = mcpCalls.length;
    await again.prompt(id, "After a restart", "queue");
    await until("the turn to end", () => seen.some((e) => e.data.sessionID === id && e.type === "session.execution.failed"));
    const calls = mcpCalls.slice(callsBefore);
    assert.ok(calls.some((c) => c.method === "tools/list" && c.token === "after-symbio-restart"), `tools listed from the new URL (calls: ${JSON.stringify(calls)})`);
  } finally {
    await again.stop();
    await runtime.start();
  }
});
