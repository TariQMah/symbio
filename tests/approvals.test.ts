// Connection approvals beyond "once": which commands count as "like" an always-allowed one, and when a
// grant to act without asking applies.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.SYMBIO_HOME = mkdtempSync(path.join(os.tmpdir(), "sym-approvals-"));
const { activeGrant, commandAllowed, plainCommand, suggestPattern, validCommandPattern } = await import("../src/server/remote.js");

test("only plain commands can be always allowed, and chaining never rides along", () => {
  assert.ok(plainCommand("systemctl status nginx"));
  assert.ok(plainCommand('grep -i "error" /var/log/syslog'));
  for (const c of ["a; b", "a && b", "a | b", "a `b`", "a $(b)", "a > f", "a < f", "a\nb", "a & b", "echo ${HOME}"]) assert.ok(!plainCommand(c), c);

  assert.equal(suggestPattern("systemctl status nginx"), "systemctl status *");
  assert.equal(suggestPattern("docker ps -a"), "docker ps *");
  assert.equal(suggestPattern("cat /etc/nginx/nginx.conf"), "cat *");
  assert.equal(suggestPattern("uptime"), "uptime");
  assert.equal(suggestPattern("ls; rm x"), null);

  assert.equal(validCommandPattern("  systemctl   status * "), "systemctl status *");
  for (const p of ["*", "* status", "", "ls; *", "a && b *"]) assert.equal(validCommandPattern(p), null, p);

  const link = { allowedCommands: ["systemctl status *", "uptime"] };
  assert.ok(commandAllowed(link, "systemctl status ssh"));
  assert.ok(commandAllowed(link, "systemctl  status"), "the bare command too");
  assert.ok(commandAllowed(link, "uptime"));
  assert.ok(!commandAllowed(link, "systemctl restart ssh"));
  assert.ok(!commandAllowed(link, "systemctl status ssh; rm -rf /"));
  assert.ok(!commandAllowed(link, "systemctl status ssh && reboot"));
  assert.ok(!commandAllowed({}, "uptime"));
});

test("a grant applies to its agent and connection, until it ends, and not while the team is paused", () => {
  const now = 1_000_000;
  const project: any = { paused: false, connectionGrants: [{ connectionId: "vps", agentId: "a1", until: now + 60_000, at: now }, { connectionId: "gh", agentId: "a1", until: null, at: now }] };
  assert.ok(activeGrant(project, "a1", "vps", now));
  assert.equal(activeGrant(project, "a2", "vps", now), null, "another agent");
  assert.equal(activeGrant(project, "a1", "ftp", now), null, "another connection");
  assert.equal(activeGrant(project, "a1", "vps", now + 61_000), null, "ended");
  assert.ok(activeGrant(project, "a1", "gh", now + 10 ** 9), "until stopped");
  project.paused = true;
  assert.equal(activeGrant(project, "a1", "gh", now), null, "paused");
});
