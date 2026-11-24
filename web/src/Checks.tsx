import { useState } from "react";
import { AnimatePresence } from "motion/react";
import { Check as CheckIcon, CircleAlert, CircleCheck, LoaderCircle, Pencil, Plus, ShieldCheck, Trash2, UserCheck } from "lucide-react";
import { api, type Check, type CheckRun, type Project, type Task } from "./api";
import { Dialog, timeAgo } from "./ui";
import { useI18n } from "./i18n";

/**
 * Project settings → Checks: the commands Symbio runs itself when a helper reports a task and
 * before its work is merged, core's proposals waiting for approval, and whether every task gets a
 * reviewer. Changes apply at once.
 */
export function ChecksSection({ project, onChanged }: { project: Project; onChanged: (p: Project) => void }) {
  const { t } = useI18n();
  const checks = project.checks ?? [];
  const [editing, setEditing] = useState<Check | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(next: Partial<Check>[], extra: { requireReviewer?: boolean } = {}) {
    setBusy(true);
    try {
      onChanged(await api.updateProject(project.id, { checks: next as Check[], ...extra }));
      return true;
    } catch (e) {
      alert((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function reviewer(on: boolean) {
    if (on === !!project.requireReviewer) return;
    setBusy(true);
    try {
      onChanged(await api.updateProject(project.id, { requireReviewer: on }));
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="section" id="checks">
      <div className="section-head">
        <div>
          <h2>{t("checks.title")}</h2>
          <p>{t("checks.desc")}</p>
        </div>
        <button className="btn sm" onClick={() => setEditing("new")}>
          <Plus size={13} />
          {t("checks.add")}
        </button>
      </div>
      {checks.length === 0 ? (
        <div className="section-empty">{t("checks.empty")}</div>
      ) : (
        <div className="section-body">
          {checks.map((c) => (
            <div key={c.id} className={`list-row check-row${c.approved ? "" : " proposed"}`}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="list-title">
                  {c.name}
                  {!c.approved && <span className="tag amber">{t("checks.proposed")}</span>}
                </div>
                <code className="list-sub">{c.command}</code>
                {(c.folder || c.timeout) && (
                  <div className="subtle small">
                    {[c.folder && t("checks.in", { folder: c.folder }), c.timeout && t("checks.limit", { s: c.timeout })].filter(Boolean).join(" · ")}
                  </div>
                )}
              </div>
              {!c.approved && (
                <button className="btn primary sm" disabled={busy} onClick={() => save(checks.map((x) => (x.id === c.id ? { ...x, approved: true } : x)))}>
                  <CheckIcon size={13} />
                  {t("checks.approve")}
                </button>
              )}
              <button className="btn ghost sm" title={t("common.edit")} onClick={() => setEditing(c)}>
                <Pencil size={13} />
              </button>
              <button className="btn ghost sm" title={t("common.remove")} disabled={busy} onClick={() => save(checks.filter((x) => x.id !== c.id))}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="stack" style={{ padding: 16, gap: 14 }}>
        <div className="field">
          <span>{t("checks.reviewer.title")}</span>
          <div className="seg">
            <button className={!project.requireReviewer ? "on" : ""} disabled={busy} onClick={() => reviewer(false)}>
              {t("checks.reviewer.core")}
            </button>
            <button className={project.requireReviewer ? "on" : ""} disabled={busy} onClick={() => reviewer(true)}>
              {t("checks.reviewer.every")}
            </button>
          </div>
          <span className="hint">{project.requireReviewer ? t("checks.reviewer.hint.every") : t("checks.reviewer.hint.core")}</span>
        </div>
      </div>
      <AnimatePresence>
        {editing && (
          <CheckDialog
            check={editing === "new" ? null : editing}
            busy={busy}
            onClose={() => setEditing(null)}
            onSave={async (c) => {
              const next = editing === "new" ? [...checks, { ...c, approved: true }] : checks.map((x) => (x.id === editing.id ? { ...x, ...c, approved: true } : x));
              if (await save(next)) setEditing(null);
            }}
          />
        )}
      </AnimatePresence>
    </section>
  );
}

function CheckDialog({ check, busy, onClose, onSave }: { check: Check | null; busy: boolean; onClose: () => void; onSave: (c: Partial<Check>) => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(check?.name ?? "");
  const [command, setCommand] = useState(check?.command ?? "");
  const [folder, setFolder] = useState(check?.folder ?? "");
  const [timeout, setTimeout] = useState(check?.timeout ? String(check.timeout) : "");
  return (
    <Dialog
      title={check ? t("checks.editTitle") : t("checks.newTitle")}
      subtitle={t("checks.dialogDesc")}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className="btn primary"
            disabled={busy || !name.trim() || !command.trim()}
            onClick={() => onSave({ name: name.trim(), command: command.trim(), folder: folder.trim() || undefined, timeout: timeout.trim() ? Number(timeout) : undefined })}
          >
            {check?.approved === false ? t("checks.approve") : t("common.save")}
          </button>
        </>
      }
    >
      <label className="field">
        <span>{t("checks.name")}</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("checks.name.placeholder")} />
      </label>
      <label className="field">
        <span>{t("checks.command")}</span>
        <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder={t("checks.command.placeholder")} />
        <span className="hint">{t("checks.command.hint")}</span>
      </label>
      <label className="field">
        <span>{t("checks.folder")}</span>
        <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={t("checks.folder.placeholder")} />
      </label>
      <label className="field">
        <span>{t("checks.timeout")}</span>
        <input type="number" min={1} value={timeout} onChange={(e) => setTimeout(e.target.value)} placeholder="600" style={{ maxWidth: 140 }} />
      </label>
    </Dialog>
  );
}

/** On a task: the latest run of the project's checks, each failure's output a click away. */
export function TaskChecks({ run }: { run: CheckRun }) {
  const { t } = useI18n();
  return (
    <div className="task-checks">
      <h3>
        <ShieldCheck size={14} /> {t("checks.onTask")}
        {run.state !== "running" && (
          <span className="subtle small">
            {run.when === "merge" ? t("checks.beforeMerge") : t("checks.onReport")} · {timeAgo(run.at)}
          </span>
        )}
      </h3>
      {run.state === "running" ? (
        <div className="row subtle small">
          <LoaderCircle size={13} className="spin" /> {t("checks.running")}
        </div>
      ) : (
        run.results.map((r) => (
          <details key={r.name} className={`check-result ${r.ok ? "ok" : "failed"}`} open={!r.ok}>
            <summary>
              {r.ok ? <CircleCheck size={13} /> : <CircleAlert size={13} />}
              <strong>{r.name}</strong>
              <span className="subtle small">
                {r.ok ? t("checks.passed") : r.timedOut ? t("checks.timedOut") : t("checks.failed", { code: r.exitCode ?? "?" })} · {r.seconds} s
              </span>
            </summary>
            {r.output.trim() && <pre className="check-output">{r.output.trim().slice(-8000)}</pre>}
          </details>
        ))
      )}
    </div>
  );
}

/** On a task: reviewers' verdicts, newest first. */
export function TaskReviews({ task, reviewerName }: { task: Task; reviewerName?: string }) {
  const { t } = useI18n();
  const reviews = [...(task.reviews ?? [])].reverse();
  if (!reviews.length && !reviewerName) return null;
  return (
    <div className="task-reviews">
      <h3>
        <UserCheck size={14} /> {t("reviews.title")}
      </h3>
      {reviewerName && (
        <div className="row subtle small">
          <LoaderCircle size={13} className="spin" /> {t("reviews.inProgress", { name: reviewerName })}
        </div>
      )}
      {reviews.map((r) => (
        <div key={r.at} className={`review-verdict ${r.verdict}`}>
          <div className="row small">
            {r.verdict === "pass" ? <CircleCheck size={13} /> : <CircleAlert size={13} />}
            <strong>{r.verdict === "pass" ? t("reviews.pass") : t("reviews.changes")}</strong>
            <span className="subtle">
              {r.by} · {timeAgo(r.at)}
            </span>
          </div>
          <div className="review-findings">{r.findings}</div>
        </div>
      ))}
    </div>
  );
}
