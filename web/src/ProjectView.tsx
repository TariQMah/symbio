import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  KanbanSquare,
  Lock,
  LockOpen,
  MessageSquare,
  MessagesSquare,
  Paperclip,
  Pause,
  Play,
  Settings2,
  Users,
  Plus,
  Pin,
  FolderTree,
  FileText,
  X,
  Bot,
} from "lucide-react";
import { UsageLine } from "./Usage";
import { useCostsShown } from "./privacy";
import { api, formatTokens, subscribe, usageTokens, type Agent, type Asset, type Plan, type Project } from "./api";
import { Chat } from "./Chat";
import { Docs } from "./Docs";
import { Explorer, ExplorerPreview, ExplorerTree, type ExplorerPick } from "./Explorer";
import { useLayout, useWide } from "./theme";
import { FilesView } from "./Attachments";
import { InboxDrawer, useInbox } from "./Inbox";
import { Kanban } from "./Kanban";
import { NewHelperDialog } from "./NewHelper";
import { Messages, useProjectLog } from "./Messages";
import { ProjectMenu } from "./ProjectMenu";
import { ProjectSettings } from "./ProjectSettings";
import { Avatar, EmptyState, statusText, waitsForPinnedModel } from "./ui";

type Tab = "chat" | "plan" | "explorer" | "messages" | "docs" | "files" | "settings";
// The Workbench layout keeps the chat on the right and the Explorer in its side bar; its middle has
// tabs, opened from the activity bar or the Explorer and closed like an editor's.
type CenterView = Exclude<Tab, "chat" | "explorer">;
type OpenTab = { view: CenterView } | { file: ExplorerPick };
const tabKey = (t: OpenTab) => ("view" in t ? t.view : `file:${t.file.agentId ?? ""}|${t.file.path}`);
const CENTER_VIEWS: CenterView[] = ["plan", "messages", "docs", "files", "settings"];

// Column widths the human dragged, kept in the browser.
function useWidth(key: string, initial: number): [number, (w: number) => void] {
  const [width, setWidth] = useState(() => Number(localStorage.getItem(key)) || initial);
  return [width, (w) => (localStorage.setItem(key, String(Math.round(w))), setWidth(w))];
}

function useRemembered<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const saved = sessionStorage.getItem(key);
    return saved === null ? initial : (JSON.parse(saved) as T);
  });
  const set = (v: T) => {
    sessionStorage.setItem(key, JSON.stringify(v));
    setValue(v);
  };
  return [value, set];
}

export function ProjectView({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Remembered for the browser session, so coming back (e.g. from Settings) opens the same place.
  const [selected, setSelected] = useRemembered<string | null>(`symbio:agent:${projectId}`, null);
  const [newHelper, setNewHelper] = useState(false);
  const [starting, setStarting] = useState(false);
  const [tab, setTab] = useRemembered<Tab>(`symbio:tab:${projectId}`, "chat");
  const [inboxOpen, setInboxOpen] = useState(false);
  // On phones the team sidebar is a drawer, opened from the button before the tabs.
  const [teamOpen, setTeamOpen] = useState(false);
  const [showStopped, setShowStopped] = useState(false);
  const log = useProjectLog(projectId);
  const inbox = useInbox(project, log, plan);
  const [layout] = useLayout();
  // Three columns need room: narrow windows and phones keep the classic layout.
  const wide = useWide(1100);
  const workbench = layout === "workbench" && wide;
  const [sideView, setSideView] = useRemembered<"team" | "explorer" | null>(`symbio:wb-side:${projectId}`, "team");
  const [openTabs, setOpenTabs] = useRemembered<OpenTab[]>(`symbio:wb-tabs:${projectId}`, [{ view: "plan" }]);
  const [activeKey, setActiveKey] = useRemembered<string | null>(`symbio:wb-active:${projectId}`, "plan");
  const [explorerAgent, setExplorerAgent] = useState<string | null>(null);
  const [sideWidth, setSideWidth] = useWidth("symbio:wb-side-width", 260);
  const [chatWidth, setChatWidth] = useWidth("symbio:wb-chat-width", 420);

  useEffect(() => {
    const load = () =>
      api
        .project(projectId)
        .then((p) => {
          setProject(p);
          setError(null);
        })
        .catch((e) => {
          // Removed (here, in another tab, or a remembered link): back to the list, not a dead page.
          if (/^project not found$/i.test(e.message)) location.replace("#/");
          else setError(e.message);
        });
    const loadAssets = () =>
      api
        .assets(projectId)
        .then(setAssets)
        .catch(() => {});
    const loadPlan = () =>
      api
        .plan(projectId)
        .then(setPlan)
        .catch(() => {});
    load();
    loadAssets();
    loadPlan();
    return subscribe((e) => {
      if (e.type === "project.updated" && e.projectId === projectId) load();
      if (e.type === "assets.updated" && e.projectId === projectId) loadAssets();
      if (e.type === "plan.updated" && e.projectId === projectId) loadPlan();
      if (e.type === "agent.status" && e.projectId === projectId) {
        setProject((p) => p && { ...p, agents: p.agents.map((a) => (a.id === e.agentId ? { ...a, status: e.status } : a)) });
      }
    });
  }, [projectId]);

  if (error) return <div className="page-inner"><div className="error">{error}</div></div>;
  if (!project) return null;

  const agent = project.agents.find((a) => a.id === selected) ?? project.agents.find((a) => a.role === "coordinator");
  // Core first, then whoever is working, so a long team shows at a glance who's still busy: agents
  // that need attention, working, waiting, then idle (each group in its usual order).
  const rank = (a: Agent) => (a.role === "coordinator" ? 0 : a.problem ? 1 : a.status === "busy" ? 2 : a.status === "waiting" ? 3 : 4);
  const activeAgents = project.agents.filter((a) => a.status !== "stopped").sort((x, y) => rank(x) - rank(y));
  const stopped = project.agents.filter((a) => a.status === "stopped");
  // Pinned agents waiting for their model have their own notice (in their chat); the rest can't continue.
  const stuck = activeAgents.filter((a) => a.problem && !waitsForPinnedModel(a));
  const nameOf = (id: string | null) => (id === null ? "core" : (project.agents.find((a) => a.id === id)?.name ?? "?"));
  const done = plan?.tasks.filter((t) => t.status === "done").length ?? 0;

  const select = (a: Agent | string) => {
    setSelected(typeof a === "string" ? a : a.id);
    if (!workbench) setTab("chat");
    setTeamOpen(false);
  };
  // Opens a tab in whichever layout is showing.
  const openTab = (t: Tab) => {
    if (!workbench) return setTab(t);
    if (t === "explorer") setSideView("explorer");
    else if (t !== "chat") openInCenter({ view: t });
  };
  // Opens a tab in the Workbench's middle (or goes to it, if it's open).
  const openInCenter = (t: OpenTab) => {
    const key = tabKey(t);
    if (!openTabs.some((o) => tabKey(o) === key)) setOpenTabs([...openTabs, t]);
    setActiveKey(key);
  };
  const closeTab = (key: string) => {
    const i = openTabs.findIndex((o) => tabKey(o) === key);
    const rest = openTabs.filter((o) => tabKey(o) !== key);
    setOpenTabs(rest);
    if (activeKey === key) setActiveKey(rest.length ? tabKey(rest[Math.max(0, i - 1)]) : null);
  };
  const activeTab = openTabs.find((o) => tabKey(o) === activeKey) ?? null;
  const picked = activeTab && "file" in activeTab ? activeTab.file : null;

  async function start() {
    setStarting(true);
    try {
      setProject((await api.start(project!.id)).project);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  const tabs: { id: Tab; label: string; icon: React.ReactNode; extra?: React.ReactNode }[] = [
    {
      id: "chat",
      label: "Chat",
      icon: <MessageSquare size={14} />,
      // The helper's name; hidden on phones, where the chat header already shows it.
      extra: agent && agent.role !== "coordinator" ? <span className="tab-agent">· {agent.name}</span> : null,
    },
    {
      id: "plan",
      label: "Plan",
      icon: <KanbanSquare size={14} />,
      extra:
        plan?.status === "proposed" ? (
          <motion.span className="tab-alert" initial={{ scale: 0 }} animate={{ scale: 1 }} title="A plan is waiting for your approval">
            <span className="tab-alert-dot" />
            Review
          </motion.span>
        ) : plan && plan.status !== "none" && plan.tasks.length > 0 ? (
          <span className="count">
            {done}/{plan.tasks.length}
          </span>
        ) : null,
    },
    { id: "explorer", label: "Explorer", icon: <FolderTree size={14} /> },
    { id: "messages", label: "Messages", icon: <MessagesSquare size={14} /> },
    { id: "docs", label: "Docs", icon: <BookOpen size={14} /> },
    { id: "files", label: "Files", icon: <Paperclip size={14} /> },
    { id: "settings", label: "Settings", icon: <Settings2 size={14} /> },
  ];

  const isActive = (a: Agent) => (workbench || tab === "chat") && agent?.id === a.id;
  const teamPanel = (
    <>
      <div className="side-scroll">
        <div>
          <div className="side-group-title">
            Team
            <span className="tnum">{activeAgents.length}</span>
            {project.agents.some((a) => a.role === "coordinator" && a.status !== "stopped") && (
              <button className="btn ghost icon xs side-add" title="New helper: one you talk to directly, in its own chat" aria-label="New helper" onClick={() => setNewHelper(true)}>
                <Plus size={13} />
              </button>
            )}
          </div>
          <AnimatePresence initial={false}>
            {activeAgents.map((a) => (
              <AgentRow key={a.id} agent={a} active={isActive(a)} onClick={() => select(a)} />
            ))}
          </AnimatePresence>
          {project.agents.length === 0 && (
            <div style={{ padding: "4px 8px" }}>
              <button className="btn primary block" onClick={start} disabled={starting}>
                {starting ? "Starting…" : "Start core"}
              </button>
            </div>
          )}
          {stopped.length > 0 && (
            <>
              <button className="stopped-toggle" onClick={() => setShowStopped((s) => !s)}>
                {showStopped ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                {stopped.length} stopped
              </button>
              {showStopped && stopped.map((a) => <AgentRow key={a.id} agent={a} active={isActive(a)} onClick={() => select(a)} />)}
            </>
          )}
        </div>

        <div>
          <div className="side-group-title">Shared assets</div>
          {assets.length === 0 ? (
            <div className="subtle small" style={{ padding: "0 8px" }}>
              None declared yet.
            </div>
          ) : (
            assets.map((a) => (
              <div key={a.name} className={`asset-row ${a.holder ? "held" : ""}`} title={a.description}>
                {a.holder ? <Lock size={13} /> : <LockOpen size={13} />}
                <div className="grow">
                  <div className="asset-name ellipsis">{a.name}</div>
                  <div className="asset-sub">
                    {a.holder ? `Held by ${nameOf(a.holder)}` : "Free"}
                    {a.queue.length > 0 && ` · ${a.queue.length} waiting`}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="side-foot">
        <UsageLine
          project={project}
          onOpen={() => {
            openTab("settings");
            setTimeout(() => document.getElementById("usage")?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
          }}
        />
        {project.agents.length > 0 && (
          <button
            className="btn sm block"
            onClick={() => (project.paused ? api.resumeTeam(project.id) : api.pauseTeam(project.id)).then(setProject).catch((e) => alert(e.message))}
            title={project.paused ? "Deliver held messages and let agents continue" : "Interrupt working agents and hold their messages"}
          >
            {project.paused ? <Play size={13} /> : <Pause size={13} />}
            {project.paused ? "Resume team" : "Pause team"}
          </button>
        )}
      </div>
    </>
  );

  const actions = (
    <div className="main-actions">
      {inbox.count > 0 && (
        <motion.button className="needs-you" onClick={() => setInboxOpen(true)} initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
          Needs you
          <span className="count">{inbox.count}</span>
        </motion.button>
      )}
      <ProjectMenu project={project} onRemoved={() => (location.hash = "#/")} />
    </div>
  );

  const banners = (
    <>
      {project.paused && (
        <div className="banner blue">
          <Pause size={15} />
          <div className="grow">
            <strong>The team is paused.</strong>{" "}
            <span className="muted">
              {project.heldMessages?.length
                ? `${project.heldMessages.length} message(s) between agents will be delivered when you resume.`
                : "Agents won't start anything on their own; you can still talk to them."}
            </span>
          </div>
          <button className="btn sm" onClick={() => api.resumeTeam(project.id).then(setProject).catch((e) => alert(e.message))}>
            <Play size={13} />
            Resume
          </button>
        </div>
      )}
      {stuck.length > 0 && (
        <div className="banner red">
          <CircleAlert size={15} />
          <div className="grow ellipsis" title={stuck[0].problem ?? ""}>
            <strong>{stuck.map((a) => a.name).join(", ")} can't continue</strong> <span className="muted">— every allowed model failed.</span>
          </div>
          <button className="btn sm" onClick={() => api.retryModels(project.id).catch((e) => alert(e.message))}>
            Retry now
          </button>
          <button className="btn primary sm" onClick={() => openTab("settings")}>
            Add a model
          </button>
        </div>
      )}
    </>
  );

  const chat = agent ? (
    <Chat key={agent.id} project={project} agent={agent} />
  ) : (
    <EmptyState icon={<MessageSquare size={20} />} title="Start the conversation">
      Start core to begin discussing the project.
    </EmptyState>
  );

  const view = (t: Tab | "file", file?: ExplorerPick | null) =>
    t === "docs" ? (
      <Docs project={project} />
    ) : t === "files" ? (
      <FilesView project={project} />
    ) : t === "explorer" ? (
      <Explorer key={project.id} project={project} />
    ) : t === "plan" ? (
      <Kanban project={project} plan={plan} />
    ) : t === "messages" ? (
      <Messages project={project} log={log} onOpenAgent={(id) => select(id)} />
    ) : t === "settings" ? (
      <ProjectSettings key={project.id} project={project} onChanged={setProject} />
    ) : t === "file" ? (
      <div className="docs-view explorer-view wb-file">
        <ExplorerPreview projectId={project.id} picked={file ?? null} />
      </div>
    ) : (
      chat
    );

  const overlays = (
    <>
      <AnimatePresence>
        {inboxOpen && (
          <InboxDrawer
            project={project}
            plan={plan}
            data={inbox}
            onClose={() => setInboxOpen(false)}
            onOpenAgent={(id) => {
              select(id);
              setInboxOpen(false);
            }}
            onOpenTab={(t) => {
              openTab(t);
              setInboxOpen(false);
            }}
          />
        )}
      </AnimatePresence>
      {newHelper && (
        <NewHelperDialog
          project={project}
          onClose={() => setNewHelper(false)}
          onCreated={(a) => {
            setNewHelper(false);
            select(a);
          }}
        />
      )}
    </>
  );

  if (workbench) {
    const working = activeAgents.filter((a) => a.status === "busy").length;
    const waiting = activeAgents.filter((a) => a.status === "waiting").length;
    const side = (v: "team" | "explorer") => setSideView(sideView === v ? null : v);
    const tabInfo = (v: CenterView) => tabs.find((t) => t.id === v)!;
    const viewIcon: Record<CenterView, React.ReactNode> = {
      plan: <KanbanSquare size={20} />,
      messages: <MessagesSquare size={20} />,
      docs: <BookOpen size={20} />,
      files: <Paperclip size={20} />,
      settings: <Settings2 size={20} />,
    };
    const viewButton = (v: CenterView) => (
      <button
        key={v}
        className={`wb-activity-item ${activeKey === v ? "active" : ""}`}
        onClick={() => openInCenter({ view: v })}
        title={v === "settings" ? "Project settings" : tabInfo(v).label}
        aria-label={v === "settings" ? "Project settings" : tabInfo(v).label}
      >
        {viewIcon[v]}
        {v === "plan" && plan?.status === "proposed" && <span className="wb-activity-badge amber" />}
      </button>
    );
    return (
      <div
        className={`workbench ${sideView ? "" : "no-side"}`}
        style={{ "--wb-side": `${sideWidth}px`, "--wb-chat": `${chatWidth}px` } as React.CSSProperties}
      >
        <nav className="wb-activity" aria-label="Views">
          <button className={`wb-activity-item ${sideView === "team" ? "active" : ""}`} onClick={() => side("team")} title="Team" aria-label="Team" aria-pressed={sideView === "team"}>
            <Users size={20} />
            {stuck.length > 0 && <span className="wb-activity-badge red" />}
          </button>
          <button className={`wb-activity-item ${sideView === "explorer" ? "active" : ""}`} onClick={() => side("explorer")} title="Explorer" aria-label="Explorer" aria-pressed={sideView === "explorer"}>
            <FolderTree size={20} />
          </button>
          <span className="wb-activity-sep" />
          {CENTER_VIEWS.filter((v) => v !== "settings").map(viewButton)}
          <span className="grow" />
          {viewButton("settings")}
        </nav>
        {sideView && (
          <aside className="wb-side" aria-label={sideView === "team" ? "Team" : "Explorer"}>
            {sideView === "team" ? (
              teamPanel
            ) : (
              <div className="wb-side-scroll explorer-tree">
                <div className="wb-side-title">Explorer</div>
                <ExplorerTree project={project} agentId={explorerAgent} onAgent={setExplorerAgent} picked={picked} onPick={(p) => openInCenter({ file: p })} />
              </div>
            )}
            <Resizer side="right" width={sideWidth} min={180} max={Math.min(600, innerWidth - 48 - chatWidth - 320)} initial={260} onResize={setSideWidth} label="Resize the side bar" />
          </aside>
        )}
        <section className="main wb-center">
          <div className="main-head">
            <div className="tabs">
              {openTabs.map((t) => {
                const key = tabKey(t);
                const active = key === activeKey;
                const info = "view" in t ? tabInfo(t.view) : null;
                const name = "view" in t ? info!.label : t.file.path.split("/").pop();
                return (
                  <div key={key} className={`tab wb-tab ${active ? "active" : ""}`} title={"file" in t ? t.file.path : undefined}>
                    <button className="wb-tab-open" onClick={() => setActiveKey(key)}>
                      {info ? info.icon : <FileText size={14} />}
                      <span className="ellipsis">{name}</span>
                      {info?.extra}
                    </button>
                    <button className="wb-tab-close" aria-label={`Close ${name}`} title="Close" onClick={() => closeTab(key)}>
                      <X size={12} />
                    </button>
                    {active && <motion.span layoutId="tab-underline" className="tab-underline" transition={{ duration: 0.15 }} />}
                  </div>
                );
              })}
            </div>
            {actions}
          </div>
          {banners}
          <div className="main-body">
            {activeTab ? (
              view("view" in activeTab ? activeTab.view : "file", picked)
            ) : (
              <EmptyState icon={<FolderTree size={20} />} title="Nothing open">
                Open the plan, messages, docs, files or settings from the bar on the left, or a file from the Explorer.
              </EmptyState>
            )}
          </div>
        </section>
        <section className="wb-chat" aria-label="Chat">
          <Resizer side="left" width={chatWidth} min={300} max={Math.min(1000, innerWidth - 48 - (sideView ? sideWidth : 0) - 320)} initial={420} onResize={setChatWidth} label="Resize the chat" />
          <div className="wb-chat-head">
            <span className="wb-side-title">Chat</span>
            <select value={agent?.id ?? ""} onChange={(e) => select(e.target.value)} aria-label="Talk to" title="Who you're talking to">
              {[...activeAgents, ...stopped].map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.role === "coordinator" ? " (lead)" : a.status === "stopped" ? " (stopped)" : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="wb-chat-body">{chat}</div>
        </section>
        <footer className="wb-status">
          <span className="wb-status-item" title="The agent runtime this project runs on">
            <Bot size={12} />
            {project.runtime === "copilot" ? "GitHub Copilot CLI" : "OpenCode"}
          </span>
          {project.paused ? (
            <span className="wb-status-item">
              <Pause size={12} />
              Paused
            </span>
          ) : (
            <span className="wb-status-item">
              {working} working{waiting > 0 ? ` · ${waiting} waiting` : ""}
            </span>
          )}
          {plan && plan.tasks.length > 0 && (
            <button className="wb-status-item" onClick={() => openInCenter({ view: "plan" })}>
              <KanbanSquare size={12} />
              {done}/{plan.tasks.length} tasks done
            </button>
          )}
          <span className="grow" />
          {inbox.count > 0 && (
            <button className="wb-status-item attention" onClick={() => setInboxOpen(true)}>
              Needs you: {inbox.count}
            </button>
          )}
          {agent && <span className="wb-status-item">{agent.name} · {agent.model.split("/").pop()}</span>}
        </footer>
        {overlays}
      </div>
    );
  }

  return (
    <div className="project-view">
      {teamOpen && <div className="side-backdrop" onClick={() => setTeamOpen(false)} />}
      <aside className={`side ${teamOpen ? "open" : ""}`}>{teamPanel}</aside>

      <section className="main">
        <div className="main-head">
          <button className="btn ghost sm team-toggle" onClick={() => setTeamOpen(true)} title="Team" aria-label="Show the team">
            <Users size={15} />
            <span className="tnum">{activeAgents.length}</span>
          </button>
          <div className="tabs">
            {tabs.map((t) => (
              <button key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
                {t.icon}
                {t.label}
                {t.extra}
                {tab === t.id && <motion.span layoutId="tab-underline" className="tab-underline" transition={{ duration: 0.15 }} />}
              </button>
            ))}
          </div>
          {actions}
        </div>
        {banners}
        <div className="main-body">{view(tab)}</div>
      </section>
      {overlays}
    </div>
  );
}

function AgentRow({ agent: a, active, onClick }: { agent: Agent; active: boolean; onClick: () => void }) {
  const costs = useCostsShown();
  const sub = waitsForPinnedModel(a) ? `Waiting for ${a.model.split("/").pop()}` : a.problem ? "Needs attention" : a.status === "idle" ? (a.purpose ?? (a.role === "coordinator" ? "Coordinates the team" : "Idle")) : statusText(a.status);
  const subClass = waitsForPinnedModel(a) ? "waiting" : a.problem ? "problem" : a.status === "busy" ? "working" : a.status === "waiting" ? "waiting" : "";
  return (
    <motion.button
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className={`agent-row ${active ? "active" : ""}`}
      onClick={onClick}
      title={[a.purpose, a.model, costs && a.usage && `${formatTokens(usageTokens(a.usage))} tokens`].filter(Boolean).join("\n")}
    >
      <Avatar name={a.name} status={waitsForPinnedModel(a) ? "waiting" : a.problem ? "error" : a.status} />
      <span className="grow">
        <span className="agent-name">
          {a.name}
          {a.role === "coordinator" && <span className="tag accent">lead</span>}
          {a.modelPinned && (
            <span className="agent-pin" title={`Pinned to ${a.model}`} aria-label={`Pinned to ${a.model}`}>
              <Pin size={11} />
            </span>
          )}
        </span>
        <span className={`agent-sub ellipsis ${subClass}`} style={{ display: "block" }}>
          {sub}
        </span>
      </span>
    </motion.button>
  );
}

/** A border to drag (or move with the arrow keys) to make a Workbench column wider; double-click resets it. */
function Resizer({ side, width, min, max, initial, onResize, label }: { side: "left" | "right"; width: number; min: number; max: number; initial: number; onResize: (w: number) => void; label: string }) {
  const clamp = (w: number) => Math.min(max, Math.max(min, w));
  return (
    <div
      className={`wb-resizer ${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = width;
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        el.classList.add("dragging");
        document.body.classList.add("resizing");
        const move = (ev: PointerEvent) => onResize(clamp(startWidth + (side === "right" ? ev.clientX - startX : startX - ev.clientX)));
        const up = () => {
          el.classList.remove("dragging");
          document.body.classList.remove("resizing");
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
      }}
      onDoubleClick={() => onResize(initial)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 50 : 10;
        const grow = side === "right" ? "ArrowRight" : "ArrowLeft";
        const shrink = side === "right" ? "ArrowLeft" : "ArrowRight";
        if (e.key === grow) onResize(clamp(width + step));
        else if (e.key === shrink) onResize(clamp(width - step));
        else return;
        e.preventDefault();
      }}
    />
  );
}
