#!/usr/bin/env node
// The notes of a release: its section of CHANGELOG.md, and how to install it.
//   node scripts/release-notes.mjs 0.15.0-beta.1
import { readFileSync } from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("Usage: node scripts/release-notes.mjs <version>");
  process.exit(1);
}
const lines = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").split(/\r?\n/);
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
const end = start < 0 ? -1 : lines.findIndex((l, i) => i > start && l.startsWith("## ["));
const section = start < 0 ? "See CHANGELOG.md." : lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
console.log(`${section}\n\nInstall or update: \`npm install -g symbio@${version}\``);
