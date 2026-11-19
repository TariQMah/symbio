// Importing a VS Code color theme: which of its colors become Symbio's tokens, and what's refused.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseVsCodeTheme } from "../web/src/vscodeTheme.js";

test("a VS Code theme file (comments, trailing commas) becomes a theme over Dark or Light Modern", () => {
  const text = readFileSync(new URL("./e2e/fixtures/night-harbor-color-theme.json", import.meta.url), "utf8");
  const theme = parseVsCodeTheme(text, "night-harbor-color-theme.json");
  assert.equal(theme.id, "custom-night-harbor");
  assert.equal(theme.label, "Night Harbor");
  assert.equal(theme.base, "dark-modern");
  assert.equal(theme.vars.bg, "#10141c");
  assert.equal(theme.vars.panel, "#0b0e14");
  assert.equal(theme.vars["bg-sunken"], "#080a0f");
  assert.equal(theme.vars.accent, "#e07a5f");
  assert.equal(theme.vars["on-accent"], "#10141c");
  assert.equal(theme.vars["border-focus"], "#e07a5f80");
  assert.equal(theme.vars.red, "#ff5c5c");
  assert.equal(theme.vars["surface-hover"], undefined, "only plain hex colors are taken");
  assert.equal(theme.vars.green, undefined, "what the file doesn't set comes from the base theme");
});

test("light themes start from Light Modern, by type or by how light the background is", () => {
  assert.equal(parseVsCodeTheme(JSON.stringify({ type: "light", colors: { "editor.background": "#202020" } })).base, "light-modern");
  assert.equal(parseVsCodeTheme(JSON.stringify({ colors: { "editor.background": "#fafafa" } }), "paper.json").base, "light-modern");
  assert.equal(parseVsCodeTheme(JSON.stringify({ colors: { "editor.background": "#fafafa" } }), "paper.json").label, "paper");
});

test("files that aren't color themes are refused with a reason", () => {
  assert.throws(() => parseVsCodeTheme("not json"), /isn't valid JSON/);
  assert.throws(() => parseVsCodeTheme(JSON.stringify({ name: "x", include: "./base.json" })), /includes another file/);
  assert.throws(() => parseVsCodeTheme(JSON.stringify({ name: "x", tokenColors: [] })), /no "colors"/);
  assert.throws(() => parseVsCodeTheme(JSON.stringify({ colors: { foreground: "#fff" } })), /background/);
});
