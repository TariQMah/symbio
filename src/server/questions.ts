// The questions the team has for the human, kept in the project (.symbio/questions.json) instead
// of in the chat, where they scroll away. Each gets a number (Q1, Q2…), stays open until the human
// answers or sets it aside, and keeps its answer: the project's record of what the human decided.

import { promises as fs } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./fsutil.js";

export interface Question {
  id: string; // "Q12"
  question: string;
  /** What the human needs to know to answer: the situation, what was found, what each option means. */
  context?: string;
  /** Suggested answers to pick from (the human can still write their own). */
  options?: string[];
  taskId?: string;
  /** Work waits on the answer. */
  blocking: boolean;
  askedBy: string; // agent id
  askedAt: number;
  state: "open" | "answered" | "set-aside";
  answer?: string;
  /** "human" when answered in Symbio; "chat" when the asker recorded an answer given in the chat. */
  answeredIn?: "human" | "chat";
  /** Names of files the human attached to the answer. */
  files?: string[];
  closedAt?: number;
  /** The briefing it belongs to ("B2"): answered with the others about the same feature. */
  briefing?: string;
}

/**
 * The questions about one feature, asked together before work starts (start_briefing). Its
 * answers go to the asker together, once all are answered or set aside, and become the feature's
 * spec (a doc Symbio writes, the asker completes).
 */
export interface Briefing {
  id: string; // "B2"
  feature: string;
  /** Why it's being asked, for the human. */
  why?: string;
  askedBy: string;
  askedAt: number;
  questions: string[];
  state: "open" | "done";
  /** The spec written from its answers, relative to the project folder. */
  spec?: string;
  doneAt?: number;
}

export interface QuestionInput {
  question: string;
  context?: string;
  options?: string[];
  taskId?: string;
  blocking?: boolean;
}

const MAX_TEXT = 4000;
const MAX_BRIEFING = 15;

export class QuestionStore {
  questions: Question[] = [];
  briefings: Briefing[] = [];

  private constructor(
    private readonly file: string,
    private readonly briefingsFile: string,
  ) {}

  static async load(projectDir: string): Promise<QuestionStore> {
    const store = new QuestionStore(path.join(projectDir, ".symbio", "questions.json"), path.join(projectDir, ".symbio", "briefings.json"));
    try {
      store.questions = JSON.parse(await fs.readFile(store.file, "utf8"));
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
    }
    try {
      store.briefings = JSON.parse(await fs.readFile(store.briefingsFile, "utf8"));
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
    }
    return store;
  }

  briefing(id: string): Briefing {
    const key = id.trim().toUpperCase().replace(/^(\d)/, "B$1");
    const b = this.briefings.find((x) => x.id === key);
    if (!b) throw new Error(`No briefing "${id}".`);
    return b;
  }

  /** Several questions about one feature, asked together. */
  async startBriefing(askedBy: string, feature: string, why: string | undefined, inputs: QuestionInput[]): Promise<{ briefing: Briefing; questions: Question[] }> {
    const name = feature.trim().slice(0, 200);
    if (!name) throw new Error("Name the feature (or request) the briefing is about.");
    const valid = inputs.filter((q) => String(q?.question ?? "").trim());
    if (valid.length < 2) throw new Error("A briefing has at least two questions; ask a single one with ask_human.");
    if (valid.length > MAX_BRIEFING) throw new Error(`At most ${MAX_BRIEFING} questions in a briefing: ask the ones that matter most first.`);
    const next = Math.max(0, ...this.briefings.map((b) => Number(b.id.slice(1)) || 0)) + 1;
    const id = `B${next}`;
    const questions: Question[] = [];
    // Blocking by default: a briefing comes before the work on its feature.
    for (const input of valid) questions.push(await this.ask(askedBy, { ...input, blocking: input.blocking ?? true }, id, false));
    const briefing: Briefing = {
      id,
      feature: name,
      ...(why?.trim() ? { why: why.trim().slice(0, MAX_TEXT) } : {}),
      askedBy,
      askedAt: Date.now(),
      questions: questions.map((q) => q.id),
      state: "open",
    };
    this.briefings.push(briefing);
    await this.save();
    return { briefing, questions };
  }

  /** Whether all of a briefing's questions are answered or set aside. */
  briefingAnswered(b: Briefing): boolean {
    return b.questions.every((id) => this.get(id).state !== "open");
  }

  async finishBriefing(id: string, spec: string): Promise<Briefing> {
    const b = this.briefing(id);
    b.state = "done";
    b.spec = spec;
    b.doneAt = Date.now();
    await this.save();
    return b;
  }

  open(): Question[] {
    return this.questions.filter((q) => q.state === "open");
  }

  get(id: string): Question {
    const key = id.trim().toUpperCase().replace(/^(\d)/, "Q$1");
    const q = this.questions.find((x) => x.id === key);
    if (!q) throw new Error(`No question "${id}".`);
    return q;
  }

  /** An open question that asks the same thing, if any. */
  duplicateOf(question: string): Question | undefined {
    const words = keywords(question);
    if (words.size === 0) return undefined;
    return this.open().find((q) => {
      const other = keywords(q.question);
      const shared = [...words].filter((w) => other.has(w)).length;
      // Near-identical wording: most words in common, both ways.
      return shared / Math.max(words.size, other.size) >= 0.75;
    });
  }

  async ask(askedBy: string, input: QuestionInput, briefing?: string, save = true): Promise<Question> {
    const question = input.question.trim();
    if (!question) throw new Error("Give the question.");
    const next = Math.max(0, ...this.questions.map((q) => Number(q.id.slice(1)) || 0)) + 1;
    const options = (input.options ?? []).map((o) => String(o).trim()).filter(Boolean).slice(0, 8);
    const q: Question = {
      id: `Q${next}`,
      question: question.slice(0, MAX_TEXT),
      ...(input.context?.trim() ? { context: input.context.trim().slice(0, MAX_TEXT) } : {}),
      ...(options.length ? { options } : {}),
      ...(input.taskId ? { taskId: input.taskId.trim().toUpperCase() } : {}),
      blocking: !!input.blocking,
      askedBy,
      askedAt: Date.now(),
      state: "open",
      ...(briefing ? { briefing } : {}),
    };
    this.questions.push(q);
    if (save) await this.save();
    return q;
  }

  async close(id: string, how: { answer: string; answeredIn: "human" | "chat"; files?: string[] } | { setAside: true; note?: string }): Promise<Question> {
    const q = this.get(id);
    if (q.state !== "open") throw new Error(`${q.id} was already ${q.state === "answered" ? "answered" : "set aside"}.`);
    if ("setAside" in how) {
      q.state = "set-aside";
      // The human's note, kept for a briefing's spec.
      if (how.note) q.answer = how.note.slice(0, MAX_TEXT);
    }
    else {
      if (!how.answer.trim()) throw new Error(`Give the answer to ${q.id}.`);
      q.state = "answered";
      q.answer = how.answer.trim().slice(0, MAX_TEXT);
      q.answeredIn = how.answeredIn;
      if (how.files?.length) q.files = how.files;
    }
    q.closedAt = Date.now();
    await this.save();
    return q;
  }

  private async save() {
    await writeFileAtomic(this.file, JSON.stringify(this.questions, null, 2));
    if (this.briefings.length) await writeFileAtomic(this.briefingsFile, JSON.stringify(this.briefings, null, 2));
  }
}

/** The words that carry meaning, without accents, case or punctuation (any language). */
function keywords(text: string): Set<string> {
  return new Set(
    text
      .normalize("NFD")
      .replace(/\p{M}/gu, "") // accents, after NFD
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 3),
  );
}
