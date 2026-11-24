---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

> **In Symbio.** This note is Symbio's; the method below is Matt Pocock's, adapted: without another tool's config file (agents/openai.yaml).
> - "The user" (or "your human partner") is whoever gave you this work: the human, for core; core, for a
>   helper. core asks the human through Symbio's question tools (`start_briefing`, `ask_human`), not in
>   the chat; a helper asks core (`send_message`).
> - Where it mentions skills you don't have, apply the idea without them. "Sub-agents" are your
>   runtime's own, for read-only lookups; Symbio's helpers are created by core.
> - Skip any step that needs a tool you don't have.
> - Each round is one briefing (`start_briefing`): the round's questions, each with your recommended
>   answer as its first option. The answers come back together, written to the feature's spec; then
>   the next round. When nothing is open, complete the spec (the goal, the decisions and their
>   reasons, what's out of scope, the *Done when* checks) and summarize it to the human.

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Word each question so "yes" accepts your recommended answer.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent with a fresh context window to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
