// Project files for the chat: finding a path the way an agent meant it, refusing what mustn't be
// served, serving with ranges, and the record of files agents shared.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { addShared, fileResponse, kindOf, listDir, listShared, refused, resolveFile } from "../src/server/files.js";

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "sym-files-"));
  const projectDir = path.join(root, "project");
  const helperDir = path.join(root, "worktrees", "ia");
  mkdirSync(path.join(projectDir, "docs", "regras"), { recursive: true });
  mkdirSync(path.join(helperDir, "docs", "regras"), { recursive: true });
  writeFileSync(path.join(projectDir, "docs", "regras", "checagem-ia.md"), "# main\n");
  writeFileSync(path.join(helperDir, "docs", "regras", "checagem-ia.md"), "# on the branch\n");
  writeFileSync(path.join(helperDir, "docs", "regras", "novo.md"), "# only on the branch\n");
  writeFileSync(path.join(projectDir, "video.mp4"), Buffer.alloc(1000, 1));
  writeFileSync(path.join(projectDir, ".env"), "SECRET=1\n");
  const helper = { id: "agt_ia", name: "ia", role: "worker", directory: helperDir, branch: "symbio/ia" } as any;
  const core = { id: "agt_core", name: "core", role: "coordinator", directory: projectDir, branch: null } as any;
  const project = { id: "p", directory: projectDir, agents: [core, helper] } as any;
  return { project, helper, core, projectDir, helperDir };
}

test("a path is found where the agent that mentioned it works first, then in the project and helpers' copies", async () => {
  const { project, helper, core, helperDir } = setup();
  const fromHelper = await resolveFile(project, "docs/regras/checagem-ia.md", helper);
  assert.equal(fromHelper?.where, "ia", "the helper's own copy first (its branch's version)");
  const fromCore = await resolveFile(project, "docs/regras/checagem-ia.md", core);
  assert.equal(fromCore?.where, "project");
  const onlyOnBranch = await resolveFile(project, "docs\\regras\\novo.md", core);
  assert.equal(onlyOnBranch?.where, "ia", "a file that's only on a helper's branch is found there");
  assert.equal(onlyOnBranch?.rel, "docs/regras/novo.md");
  assert.equal((await resolveFile(project, path.join(helperDir, "docs", "regras", "novo.md")))?.where, "ia", "absolute paths too");
  assert.equal(await resolveFile(project, "docs/missing.md", core), null);
  assert.equal(await resolveFile(project, path.join(os.tmpdir(), "elsewhere.txt"), core), null, "nothing outside the folders");
  assert.equal(await resolveFile(project, "../../etc/hosts", core), null);
  await assert.rejects(resolveFile(project, ".env", core), /may hold secrets/);
});

test("what isn't served, and what each kind of file is", () => {
  assert.match(refused(".git/config") ?? "", /git/);
  assert.match(refused(".symbio/questions.json") ?? "", /Symbio/);
  assert.equal(refused(".symbio/attachments/a.png"), null);
  assert.match(refused("certs/server.pem") ?? "", /secrets/);
  assert.match(refused("config/.env.production") ?? "", /secrets/);
  assert.equal(refused("src/environment.ts"), null);
  assert.equal(kindOf("a/b/Foo.cs").kind, "text");
  assert.equal(kindOf("clip.MP4").kind, "video");
  assert.equal(kindOf("report.xlsx").kind, "other");
});

test("files stream with ranges, so videos can seek", async () => {
  const { project, core } = setup();
  const f = (await resolveFile(project, "video.mp4", core))!;
  const whole = fileResponse(f, {});
  assert.equal(whole.headers.get("content-type"), "video/mp4");
  assert.equal((await whole.arrayBuffer()).byteLength, 1000);
  const part = fileResponse(f, { range: "bytes=100-199" });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 100-199/1000");
  assert.equal((await part.arrayBuffer()).byteLength, 100);
  assert.equal(fileResponse(f, { range: "bytes=5000-" }).status, 416);
  assert.match(fileResponse(f, { download: true }).headers.get("content-disposition") ?? "", /^attachment/);
});

test("shared files are recorded where they were found", async () => {
  const { project, helper } = setup();
  const s = await addShared(project, helper, "docs/regras/novo.md", "The new rule");
  assert.equal(s.where, "ia");
  assert.equal(s.kind, "markdown");
  assert.deepEqual((await listShared(project)).map((x) => [x.rel, x.caption]), [["docs/regras/novo.md", "The new rule"]]);
  await assert.rejects(addShared(project, helper, "nope.png"), /Not found/);
});

test("the Explorer lists one folder at a time, folders first, without git's internals, Symbio's own files or secrets", async () => {
  const { project, helper, core, projectDir } = setup();
  mkdirSync(path.join(projectDir, ".git", "objects"), { recursive: true });
  mkdirSync(path.join(projectDir, ".symbio", "attachments"), { recursive: true });
  mkdirSync(path.join(projectDir, ".symbio", "sessions"), { recursive: true });
  writeFileSync(path.join(projectDir, ".symbio", "state.json"), "{}");
  writeFileSync(path.join(projectDir, "id_ed25519"), "key");
  writeFileSync(path.join(projectDir, "notes10.txt"), "x");
  writeFileSync(path.join(projectDir, "notes9.txt"), "x");

  const top = await listDir(project, "", core);
  assert.equal(top.where, "project");
  assert.deepEqual(top.entries.map((e) => e.name), [".symbio", "docs", "notes9.txt", "notes10.txt", "video.mp4"]);
  assert.deepEqual(top.entries.find((e) => e.name === "video.mp4"), { name: "video.mp4", dir: false, kind: "video", size: 1000 });
  assert.deepEqual((await listDir(project, ".symbio", core)).entries.map((e) => e.name), ["attachments"]);
  assert.deepEqual((await listDir(project, "docs\\regras/", core)).entries.map((e) => e.name), ["checagem-ia.md"]);

  const branch = await listDir(project, "docs/regras", helper);
  assert.equal(branch.where, "ia", "a helper's own copy");
  assert.deepEqual(branch.entries.map((e) => e.name), ["checagem-ia.md", "novo.md"]);

  await assert.rejects(listDir(project, ".git", core), /git's internal/);
  await assert.rejects(listDir(project, ".symbio/sessions", core), /Symbio's own/);
  await assert.rejects(listDir(project, "../", core), /inside the folder/);
  await assert.rejects(listDir(project, path.join(projectDir, "docs"), core), /inside the folder/);
  await assert.rejects(listDir(project, "missing", core), /not found/);
});
