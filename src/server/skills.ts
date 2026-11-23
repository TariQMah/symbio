// Skills: packaged methods (a folder with a SKILL.md: a name, a description, instructions, and any
// files it uses) that agents load when a task calls for them. Every runtime reads the same format.
//
// Symbio's library has two parts: the skills Symbio ships (in the package, read-only) and the
// human's own (~/.symbio/skills, written only by Symbio: agents can't edit them, guard.ts). An
// agent gets exactly the skills it was given (core's from the project's settings, a helper's from
// core or the human); the runtimes are told which (opencode/runtime.ts, copilot/runtime.ts).
// Skills found elsewhere on this computer (other tools' folders) are listed so the human can add
// a copy; agents never see them directly.

import { existsSync, promises as fs, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globalDir } from "./store.js";

export interface SkillInfo {
  name: string;
  description: string;
  /** builtin: ships with Symbio · library: the human's · computer: another tool's folder (add a copy to use it) */
  source: "builtin" | "library" | "computer";
  /** The skill's folder. */
  dir: string;
  /** Files besides SKILL.md (relative), at most a few dozen. */
  files: string[];
}

/** Skills Symbio ships: `skills/` next to the server (src/ in development, dist/ when installed). */
export function builtinSkillsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const dir of [path.resolve(here, "../../skills"), path.resolve(here, "../skills")]) if (existsSync(dir)) return dir;
  return path.resolve(here, "../../skills");
}

/** The human's skills. */
export const librarySkillsDir = () => path.join(globalDir, "skills");

/** Folders the runtimes load skills from: Symbio's and the human's library. */
export const skillRoots = () => [builtinSkillsDir(), librarySkillsDir()];

/** Other tools' skill folders on this computer, offered to the human as copies. */
const computerSkillDirs = () =>
  [path.join(os.homedir(), ".agents", "skills"), path.join(os.homedir(), ".claude", "skills"), path.join(os.homedir(), ".copilot", "skills")];

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const validSkillName = (name: string) => NAME.test(name);

/** `name` and `description` from a SKILL.md's frontmatter (simple `key: value` lines). */
export function parseSkill(text: string): { name: string; description: string; body: string } | null {
  const m = text.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  if (!meta.name || !meta.description) return null;
  return { name: meta.name, description: meta.description, body: m[2] };
}

function filesOf(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (out.length >= 50) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (r !== "SKILL.md") out.push(r);
    }
  };
  try {
    walk(dir, "");
  } catch {
    // unreadable: listed without files
  }
  return out;
}

function readRoot(root: string, source: SkillInfo["source"]): SkillInfo[] {
  if (!existsSync(root)) return [];
  const out: SkillInfo[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const file = path.join(dir, "SKILL.md");
    if (!existsSync(file)) continue;
    const parsed = parseSkill(readFileSync(file, "utf8"));
    if (!parsed || !validSkillName(parsed.name)) continue;
    out.push({ name: parsed.name, description: parsed.description, source, dir, files: filesOf(dir) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Symbio's skills and the human's (a name Symbio ships can't be taken by the library). */
export function listSkills(): SkillInfo[] {
  const builtin = readRoot(builtinSkillsDir(), "builtin");
  const taken = new Set(builtin.map((s) => s.name));
  return [...builtin, ...readRoot(librarySkillsDir(), "library").filter((s) => !taken.has(s.name))];
}

/** Skills in other tools' folders on this computer that aren't in the library yet. */
export function computerSkills(): SkillInfo[] {
  const have = new Set(listSkills().map((s) => s.name));
  const seen = new Set<string>();
  const out: SkillInfo[] = [];
  for (const root of computerSkillDirs()) {
    for (const s of readRoot(root, "computer")) {
      if (have.has(s.name) || seen.has(s.name)) continue;
      seen.add(s.name);
      out.push(s);
    }
  }
  return out;
}

/** Every skill name an agent could otherwise be offered (for runtimes that need the ones to turn off). */
export const knownSkillNames = () => [...new Set([...listSkills(), ...computerSkills()].map((s) => s.name))];

/** A skill's SKILL.md, for the human to read before adding or giving it. */
export function skillText(name: string): string {
  const s = [...listSkills(), ...computerSkills()].find((x) => x.name === name);
  if (!s) throw new Error(`No skill named "${name}".`);
  return readFileSync(path.join(s.dir, "SKILL.md"), "utf8");
}

const MAX_SKILL_BYTES = 2_000_000;

/** A new skill in the library, written by the human. */
export async function createSkill(input: { name: string; description: string; instructions: string }): Promise<SkillInfo> {
  const name = input.name.trim().toLowerCase();
  if (!validSkillName(name)) throw new Error("A skill's name is lowercase letters, digits and dashes (e.g. front-end-review).");
  const description = input.description.replace(/\s+/g, " ").trim();
  if (!description) throw new Error("Say what the skill is for and when to use it (its description).");
  if (listSkills().some((s) => s.name === name)) throw new Error(`There is already a skill named "${name}".`);
  const dir = path.join(librarySkillsDir(), name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${input.instructions.trim()}\n`);
  return listSkills().find((s) => s.name === name)!;
}

/**
 * Copies a skill folder into the library: the copy is what agents use, so it doesn't change when
 * the original does (no silent updates). From another tool's folder on this computer, or any folder.
 */
export async function importSkill(from: string): Promise<SkillInfo> {
  const dir = path.resolve(from);
  const file = path.join(dir, "SKILL.md");
  if (!existsSync(file)) throw new Error(`No SKILL.md in ${dir}.`);
  const parsed = parseSkill(readFileSync(file, "utf8"));
  if (!parsed) throw new Error("Its SKILL.md has no name and description (frontmatter between --- lines).");
  if (!validSkillName(parsed.name)) throw new Error(`"${parsed.name}" isn't a valid skill name (lowercase letters, digits and dashes).`);
  if (listSkills().some((s) => s.name === parsed.name)) throw new Error(`There is already a skill named "${parsed.name}".`);
  let size = 0;
  const count = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isSymbolicLink()) throw new Error(`The skill's folder has a link (${e.name}); copy it without links.`);
      const p = path.join(d, e.name);
      if (e.isDirectory()) count(p);
      else size += statSync(p).size;
    }
  };
  count(dir);
  if (size > MAX_SKILL_BYTES) throw new Error("The skill's folder is over 2 MB; a skill is instructions and a few small files.");
  const dest = path.join(librarySkillsDir(), parsed.name);
  await fs.mkdir(librarySkillsDir(), { recursive: true });
  await fs.cp(dir, dest, { recursive: true, errorOnExist: true, force: false });
  return listSkills().find((s) => s.name === parsed.name)!;
}

/** Removes one of the human's skills (Symbio's can't be removed). */
export async function removeSkill(name: string): Promise<void> {
  const s = listSkills().find((x) => x.name === name);
  if (!s) throw new Error(`No skill named "${name}".`);
  if (s.source !== "library") throw new Error(`"${name}" comes with Symbio and can't be removed.`);
  await fs.rm(s.dir, { recursive: true, force: true });
}

/** The skills Symbio gives core in a new project. */
export const DEFAULT_CORE_SKILLS = ["briefing", "glossary", "handoff", "review"];
