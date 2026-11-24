# What Symbio does

- **Your choice of agent runtime.** OpenCode or GitHub Copilot CLI, per project, each with its own
  models; Symbio's rules, tools, plan and messages work the same on both. Install them from Symbio
  (nothing else on your machine changes), and move a project from one to the other in its settings:
  every agent writes a handoff and continues on the other runtime with its tasks and work.
- **One conversation, a whole team.** You chat with core. It asks what you want, studies an
  existing folder before touching it, and proposes a plan of tasks for you to approve.
- **Helpers that work in parallel without collisions.** Each helper gets its own git worktree and
  branch, and core reviews and merges their work. For step-by-step work (each step using the
  previous one's files), helpers can share the project folder instead, with nothing to merge.
  Helpers are only created when work can really run in parallel; one helper is the default.
- **Agents talk to each other.** Messages go straight from agent to agent through Symbio, and
  delivering a message wakes the recipient. No copy-pasting between terminals.
- **Shared assets with a gatekeeper.** Anything several agents could change (a file pattern, a
  database, a spreadsheet) can be declared a *shared asset*. Agents request it from core, wait for
  the grant and release it when done. Changes to an asset an agent wasn't granted are flagged at
  merge.
- **Review the work your way.** Helpers report each finished task with a guide for checking it:
  where to look, the steps and what you should see. Let core review (the default), or review every
  task yourself from a "To review" list (approve it, or send it back with a note to the helper), or
  only the tasks marked in the plan. Each task's changed files and diffs are a click away.
- **Questions in one list, not lost in the chat.** When the team needs a decision from you, it goes
  to your open questions (numbered, with context and suggested answers). Answer several at once
  when you have a moment; each agent gets its answers, and the same question isn't asked twice.
- **Choose how core takes your message.** A selector in the chat box: *Auto* (core decides),
  *Plan* (discuss and plan only: Symbio blocks starting work and editing files until you switch)
  or *Act* (get it done without a plan to approve).
- **Attach files to a message.** Upload, drag in or paste images and documents into the chat, as in
  other AI chats. Agents get them as files they can open (images as scaled-down copies, PDF, Word,
  Excel and PowerPoint as text), and each project's **Files** tab keeps everything sent, to open,
  resend or delete.
- **One word per thing.** Every project has a glossary core keeps: the project's terms, what each
  means and the words not to use. Every agent gets it, so the work, the reports and what you read
  use the same words; when two words are used for one thing, core asks you which to keep.
- **Skills.** Packaged methods agents load when a task calls for one: Symbio's for leading (a
  briefing, keeping the glossary, a handoff, a review), yours (write one, or add a copy of one from
  another folder after reading it), and the ones other tools keep on this computer, listed to add.
  core gets the skills you choose for it, and gives each helper the ones its work needs (a front-end
  checklist for the helper building pages); you can change a helper's in its chat.
- **Checks Symbio runs itself.** Commands you approve in the project's settings (a build, tests, a
  spellcheck, a link check…) run on a helper's work when it reports a task, and again before it's
  merged if it changed since. A failure goes back to the helper with the output, without taking
  core's or your attention; core can propose checks for you to approve.
- **A reviewer before core.** A fresh helper that didn't do the work checks it against its *Done
  when*, the rules and the glossary, and can't change it: core asks for one on big or risky tasks,
  or you require one for every task. Its findings go back to the helper and show on the task.
- **Documentation you can find your way in.** core keeps the project's docs up to date, and the
  Docs tab shows them as a folder tree with search across every doc, links between docs that open
  in place, an outline of long docs, and plain-text sources (e-mails, transcripts) with line
  numbers.
- **A rules register** (on for new projects; you can turn it off). Agents record the project's rules (requirements, decisions,
  constraints) with where each came from, a literal excerpt, who imposes it, how confirmed it is
  and whether it's met. The Docs tab shows them as an index you can filter and search, with each
  citation opening its source at the cited line.
- **A live plan.** The Plan tab is an animated kanban that moves by itself as helpers pick up
  tasks, ask for review and get merged. Each task says what *done* means (*Done when*): core writes
  it, the helper reports against it, and you can change it on the board.
- **You stay in control.** Questions, plan approvals, permission requests (like installing
  software) and deploy approvals collect in a **Needs you** inbox. Pause one team or everything at
  once.
- **Connections without exposing secrets.** Give agents a GitHub account, an Azure DevOps
  organization, a server (SSH, SFTP) or an FTP account. They ask Symbio to push, open pull requests, call the API or deploy, and Symbio does it with credentials the agents never
  see. Each connection can require your approval for every action; when it does, you can approve
  several at once, let an agent act without asking for a while, or always allow plain server
  commands like one (`systemctl status *`).
- **Resilient.** A supervisor restarts the agent runtime if it crashes, a watchdog unsticks hung agents, and
  when a model fails (quota, outage) the agent switches to the next allowed model and carries on. Want
  an agent to stay on its model (say, to see how that model does)? Pin it in its chat: it then waits and
  retries that model instead.
- **Long-running teams stay healthy.** Agents continue in a fresh session with a handoff note
  (helpers after each finished task, by default for new projects; any agent when you ask, or
  automatically when a conversation grows too large to send). When you ask, the agent can write its
  own handoff first. Each chat shows how big the conversation is, so you can tell when it's time. A daily check backs up Symbio's state and tells you and core about work that exists only
  on this machine and build outputs filling the disk.
- **Explorer.** The project's folders and files in a tab, read-only, to look at what the team wrote
  without leaving the browser (secrets stay hidden).
- **Themes and layouts.** The default look, or the colors of VS Code's Dark Modern and Light Modern
  themes, and a *Workbench* layout like an editor's: tools on the left, the work in the middle, the
  chat on the right (Settings → Appearance, kept per browser). Bring your own by importing a VS Code
  color theme file.
- **Reasoning effort.** How hard each model thinks, per model in a project and per agent from its
  chat (core can set it for its helpers).
- **Costs in view.** Tokens and estimated cost per agent and model, with prices you can set (and
  GitHub Copilot's own prices, in AI credits).
- **Kind to small computers.** Agents' programs run at low priority, so the computer stays usable and
  reachable; the machine view in the top bar lists what they started and which project and agent
  started each (filter by project; Stop works from a phone too),
  and an overloaded machine is reported to you and core, optionally holding new turns until it recovers.
- **Safety rails.** Agents can't kill processes by name (which would take down your terminals and
  editors), can't read your SSH keys or Symbio's secret store, and must ask before installing
  software. They look at images through scaled-down copies, so a few large pictures can't make a
  conversation too big to send.

See also: [usage.md](usage.md) to get started, [configuration.md](configuration.md) for settings and where
data lives, and [security.md](security.md) for the safety rules in detail.
