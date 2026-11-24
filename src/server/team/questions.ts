// The team's open questions for the human (questions.ts keeps them). Agents ask with ask_human;
// the human answers from Needs you, several at once, and each asker gets its answers in one message
// (a helper's go to the helper, and core is told). Asking what's already open is refused, so the
// same question doesn't come back again and again. A briefing (start_briefing) asks the questions
// about one feature together: the human sees them grouped, and the asker gets the answers together,
// once all are in, written down as the feature's spec.

import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { bus } from "../bus.js";
import { attachmentNote, getAttachments, markSent, type Attachment } from "../attachments.js";
import { docsPaths } from "../docs.js";
import { QuestionStore, type Briefing, type Question, type QuestionInput } from "../questions.js";
import type { Agent, Project } from "../store.js";
import { active, type TeamCore } from "./core.js";

/** When a question may stop the work in a project that lets the team decide. */
export const WAIT_REASONS = ["irreversible", "cost", "legal-or-safety", "contradiction", "needs-information"] as const;

export class Questions {
  private stores = new Map<string, Promise<QuestionStore>>();

  constructor(private readonly team: TeamCore) {}

  store(project: Project): Promise<QuestionStore> {
    let store = this.stores.get(project.id);
    if (!store) {
      store = QuestionStore.load(project.directory);
      this.stores.set(project.id, store);
    }
    return store;
  }

  forget(projectId: string) {
    this.stores.delete(projectId);
  }

  async ask(project: Project, agent: Agent, input: QuestionInput & { waitReason?: string }): Promise<string> {
    // The human lets the team decide: a question doesn't stop the work unless it must.
    if (project.autonomy === "decide") {
      if (input.blocking && !WAIT_REASONS.includes(input.waitReason as any)) {
        throw new Error(
          "The human lets the team decide what can be undone: don't wait. Decide (decided: what you'll do meanwhile, your recommended " +
            `option) and go on; they keep it or change it. Wait only when it can't be undone, costs more than they allow, is a legal or ` +
            `safety matter, the requirements contradict each other, or only they have what's needed (an account, a credential, a file): ` +
            `then give wait_reason (${WAIT_REASONS.join(", ")}).`,
        );
      }
      if (!input.blocking && !input.decided?.trim()) {
        throw new Error("The human lets the team decide: give decided (what you'll do meanwhile, your recommended option), then go on with it.");
      }
    }
    const store = await this.store(project);
    const same = store.duplicateOf(input.question);
    if (same) {
      return (
        `Already open as ${same.id} (asked ${same.askedBy === agent.id ? "by you" : `by ${this.team.agentName(project, same.askedBy) ?? "another agent"}`}): "${same.question}". ` +
        "Don't ask it again; the answer arrives as a message. If it has changed, close it with close_question and ask the new one."
      );
    }
    if (input.taskId) (await this.team.plan(project)).task(input.taskId); // a wrong task id fails here
    const q = await store.ask(agent.id, input);
    await this.team.log(project, { from: agent.id, to: "human", kind: "question", text: `${q.id}: ${q.question}` });
    this.changed(project);
    if (q.decided) {
      return (
        `Recorded as ${q.id} in the human's Needs you, as decided: "${q.decided}". Go on with it now. If they change it, you'll get a ` +
        "message with what they want instead; if they keep it, a note. Don't repeat it in the chat."
      );
    }
    return (
      `Recorded as ${q.id} in the human's open questions (Needs you), with its context${q.options ? " and options" : ""}. ` +
      "Their answer arrives as a message. Don't repeat it or list open questions in the chat: Symbio shows them. " +
      (q.blocking ? "Meanwhile, continue with work that doesn't depend on it, or end your turn." : "Continue meanwhile.")
    );
  }

  /** A briefing: the questions about one feature, asked together (core's start_briefing). */
  async brief(project: Project, agent: Agent, feature: string, why: string | undefined, inputs: QuestionInput[]): Promise<string> {
    const store = await this.store(project);
    const repeated = inputs.map((q) => store.duplicateOf(String(q?.question ?? ""))).filter((q): q is Question => !!q);
    if (repeated.length) {
      throw new Error(
        `Already open: ${repeated.map((q) => `${q.id} ("${q.question}")`).join(", ")}. Leave those out of the briefing (their answers arrive as messages), ` +
          "or close them with close_question first.",
      );
    }
    for (const q of inputs) if (q?.taskId) (await this.team.plan(project)).task(q.taskId);
    const { briefing, questions } = await store.startBriefing(agent.id, feature, why, inputs);
    await this.team.log(project, {
      from: agent.id,
      to: "human",
      kind: "question",
      text: `${briefing.id}: a briefing about ${briefing.feature} (${questions.length} questions, ${questions[0].id}–${questions.at(-1)!.id}).`,
    });
    this.changed(project);
    return (
      `Briefing ${briefing.id} recorded: ${questions.map((q) => q.id).join(", ")}, grouped in the human's Needs you. The answers arrive ` +
      "together, once all are answered or set aside, with the spec Symbio writes from them. Don't repeat the questions in the chat. " +
      "Meanwhile, continue with work that doesn't depend on it, or end your turn."
    );
  }

  /** The human's answers, several at once (each may bring files): one message per agent that asked. */
  async answer(project: Project, answers: { id: string; answer: string; attachments?: string[] }[]): Promise<Question[]> {
    const store = await this.store(project);
    const given = answers.filter((a) => a.answer?.trim() || a.attachments?.length);
    if (given.length === 0) throw new Error("Write at least one answer.");
    for (const a of given) if (store.get(a.id).state !== "open") throw new Error(`${store.get(a.id).id} is no longer open.`);
    // Check every file before closing anything, so a missing one doesn't leave answers half sent.
    const filesOf = new Map<string, Attachment[]>();
    for (const a of given) filesOf.set(a.id, a.attachments?.length ? await getAttachments(project, a.attachments) : []);
    const closed: Question[] = [];
    for (const a of given) {
      const files = filesOf.get(a.id)!;
      const answer = a.answer?.trim() || (files.length === 1 ? "(see the attached file)" : "(see the attached files)");
      closed.push(await store.close(a.id, { answer, answeredIn: "human", files: files.map((f) => f.name) }));
    }
    this.changed(project);

    // A briefing's answers go together, once all of its questions are closed.
    const briefings = new Set(closed.filter((q) => q.briefing).map((q) => q.briefing!));
    for (const id of briefings) await this.finishIfAnswered(project, id, filesOf);
    // Decisions the human kept: the asker is told without being woken.
    const kept = closed.filter((q) => !q.briefing && q.decided && q.answer === q.decided && !filesOf.get(q.id)?.length);
    for (const q of kept) {
      const asker = project.agents.find((x) => x.id === q.askedBy);
      if (asker && active(asker)) await this.team.system(project, asker, `Symbio: the human kept your decision on ${q.id} ("${q.question}"): ${q.decided}.`, false);
    }
    const byAsker = new Map<string, Question[]>();
    for (const q of closed.filter((x) => !x.briefing && !kept.includes(x))) byAsker.set(q.askedBy, [...(byAsker.get(q.askedBy) ?? []), q]);
    const core = this.team.coordinator(project);
    for (const [askerId, qs] of byAsker) {
      const asker = project.agents.find((x) => x.id === askerId);
      const list = qs
        .map((q) => `${q.id}: ${q.question}${q.decided ? `\n(you had decided: ${q.decided}; change the work that depends on it, with a follow-up task if needed)` : ""}\n→ ${q.answer}${q.files?.length ? ` (attached: ${q.files.join(", ")})` : ""}`)
        .join("\n\n");
      const files = qs.flatMap((q) => filesOf.get(q.id) ?? []);
      if (asker && active(asker)) {
        await this.team.sendFromHuman(project, asker, `My answer${qs.length > 1 ? "s" : ""} to your question${qs.length > 1 ? "s" : ""}:\n\n${list}` + attachmentNote(files));
        if (files.length) await markSent(project, files.map((f) => f.id), asker.id);
        if (asker.role === "worker" && core && active(core)) {
          await this.team.system(project, core, `Symbio: the human answered ${asker.name}'s question${qs.length > 1 ? "s" : ""} (it has the answer):\n\n${list}`, false);
        }
      } else if (core && active(core)) {
        await this.team.system(project, core, `Symbio: the human answered question${qs.length > 1 ? "s" : ""} asked by ${this.team.agentName(project, askerId) ?? "a helper"}, who is no longer active:\n\n${list}`);
      }
    }
    return closed;
  }

  /** The human doesn't want to answer it (no longer relevant, or decided elsewhere). */
  async setAside(project: Project, id: string, note?: string): Promise<Question> {
    const store = await this.store(project);
    const q = await store.close(id, { setAside: true, ...(note?.trim() ? { note: note.trim() } : {}) });
    this.changed(project);
    if (q.briefing) {
      await this.finishIfAnswered(project, q.briefing, new Map());
      return q;
    }
    const asker = project.agents.find((x) => x.id === q.askedBy);
    const target = asker && active(asker) ? asker : this.team.coordinator(project);
    if (target && active(target)) {
      await this.team.system(
        project,
        target,
        `Symbio: the human set aside ${q.id} ("${q.question}")${note?.trim() ? ` with this note: ${note.trim()}` : ", without an answer"}. Don't ask it again; go on without it, or ask them in a different way if the work really needs it.`,
        q.blocking,
      );
    }
    return q;
  }

  /** An agent closes its own question (or core any): answered in the chat, or no longer needed. */
  async closeByAgent(project: Project, agent: Agent, id: string, answer?: string): Promise<string> {
    const store = await this.store(project);
    const q = store.get(id);
    if (agent.role !== "coordinator" && q.askedBy !== agent.id) throw new Error(`${q.id} was asked by someone else; only they or the coordinator can close it.`);
    await store.close(q.id, answer?.trim() ? { answer, answeredIn: "chat" } : { setAside: true });
    this.changed(project);
    if (q.briefing) await this.finishIfAnswered(project, q.briefing, new Map());
    return answer?.trim() ? `${q.id} closed with the answer the human gave in the chat.` : `${q.id} closed: no longer needed.`;
  }

  /**
   * A briefing whose questions are all closed: its answers are written as the feature's spec, and
   * the asker gets them together (from the human), with where the spec is.
   */
  private async finishIfAnswered(project: Project, id: string, filesOf: Map<string, Attachment[]>) {
    const store = await this.store(project);
    const briefing = store.briefing(id);
    if (briefing.state !== "open" || !store.briefingAnswered(briefing)) return;
    const questions = briefing.questions.map((q) => store.get(q));
    const spec = await writeSpec(project, briefing, questions);
    await store.finishBriefing(briefing.id, spec);
    this.changed(project);
    await this.team.log(project, { from: "symbio", to: "human", kind: "system", text: `${briefing.id} (${briefing.feature}) is answered; its spec is ${spec}.` });

    const list = questions
      .map((q) => `${q.id}: ${q.question}\n→ ${q.state === "answered" ? q.answer : `set aside${q.answer ? ` (${q.answer})` : ""}`}${q.files?.length ? ` (attached: ${q.files.join(", ")})` : ""}`)
      .join("\n\n");
    const files = questions.flatMap((q) => filesOf.get(q.id) ?? []);
    const asker = project.agents.find((a) => a.id === briefing.askedBy);
    const target = asker && active(asker) ? asker : this.team.coordinator(project);
    if (!target || !active(target)) return;
    await this.team.system(
      project,
      target,
      `Symbio: the answers to briefing ${briefing.id} (${briefing.feature}) are written to ${spec}. Complete that spec (your briefing skill ` +
        "says how: the goal, the decisions and their reasons, what's out of scope, the Done when checks), summarize it to the human, " +
        `and give the feature's tasks spec "${spec}" (submit_plan, add_task or update_task).`,
      false,
    );
    await this.team.sendFromHuman(project, target, `My answers to briefing ${briefing.id} (${briefing.feature}):\n\n${list}` + attachmentNote(files));
    if (files.length) await markSent(project, files.map((f) => f.id), target.id);
  }

  async describe(project: Project): Promise<string> {
    const store = await this.store(project);
    const open = store.open();
    const recent = store.questions.filter((q) => q.state !== "open").slice(-10);
    const who = (id: string) => this.team.agentName(project, id) ?? "?";
    const lines = [
      open.length ? "Open (waiting for the human):" : "No open questions.",
      ...open.map((q) => `- ${q.id}${q.briefing ? ` [${q.briefing}]` : ""}${q.blocking ? " [blocking]" : ""}${q.taskId ? ` (${q.taskId})` : ""} by ${who(q.askedBy)}: ${q.question}`),
    ];
    const briefings = store.briefings.filter((b) => b.state === "open");
    if (briefings.length) lines.push("", "Open briefings:", ...briefings.map((b) => `- ${b.id}: ${b.feature} (${b.questions.join(", ")})`));
    const specs = store.briefings.filter((b) => b.state === "done").slice(-5);
    if (specs.length) lines.push("", "Answered briefings:", ...specs.map((b) => `- ${b.id}: ${b.feature} → ${b.spec}`));
    if (recent.length) {
      lines.push("", "Recently closed:");
      for (const q of recent) lines.push(`- ${q.id}: ${q.question} → ${q.state === "answered" ? q.answer : "set aside"}`);
    }
    return lines.join("\n");
  }

  private changed(project: Project) {
    bus.publish({ type: "questions.updated", projectId: project.id });
  }
}

/** The briefing's answers as the start of its feature's spec (docs/specs/<feature>.md), for its asker to complete. */
async function writeSpec(project: Project, briefing: Briefing, questions: Question[]): Promise<string> {
  const folder = path.join(docsPaths(project).folder, "specs");
  const slug =
    briefing.feature
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || briefing.id.toLowerCase();
  let file = path.join(folder, `${slug}.md`);
  for (let n = 2; existsSync(file); n++) file = path.join(folder, `${slug}-${n}.md`);
  const day = new Date().toISOString().slice(0, 10);
  const answers = questions
    .map((q) => {
      const answer = q.state === "answered" ? q.answer! : `*Set aside${q.answer ? `: ${q.answer}` : ""}.*`;
      return `### ${q.question}\n\n${answer}${q.files?.length ? `\n\nAttached: ${q.files.join(", ")}` : ""}`;
    })
    .join("\n\n");
  const text =
    `# ${briefing.feature}\n\n` +
    `*From briefing ${briefing.id}, answered by the human on ${day}.*${briefing.why ? ` ${briefing.why}` : ""}\n\n` +
    "<!-- To complete: the goal, the decisions and their reasons, what's out of scope, and the Done when checks, above the answers. -->\n\n" +
    `## The human's answers\n\n${answers}\n`;
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(file, text);
  return path.relative(project.directory, file).split(path.sep).join("/");
}
