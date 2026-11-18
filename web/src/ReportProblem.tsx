import { useEffect, useState } from "react";
import { Bug } from "lucide-react";
import { api } from "./api";

const NEW_BUG = "https://github.com/linkzy/symbio/issues/new";

/** The OS and browser as the browser reports them (the UI runs in the same browser the person uses). */
function osName(): string {
  const data = (navigator as any).userAgentData;
  return data?.platform || navigator.platform || "unknown";
}

/**
 * The link to a new bug report with the bug template and what helps to reproduce: Symbio's version, the agent runtimes
 * installed (with their versions) and the OS. Nothing about the person's projects (names, paths, logs, keys) is added;
 * they write what they choose.
 */
export function reportProblemUrl(env: { symbio: string | null; runtimes: string | null; os: string }): string {
  const body = `**What happened**
<!-- What you did, what you expected, and what happened instead. Screenshots help. -->

**Steps to reproduce**
1.
2.
3.

**Environment**
- OS: ${env.os}
- Node.js (\`node --version\`):
- Symbio version or commit: ${env.symbio ?? ""}
- Agent runtime (OpenCode or GitHub Copilot CLI) and its version (\`sym doctor\` lists them): ${env.runtimes ?? ""}

**Logs**
<!-- Errors from the browser console or the terminal running Symbio. Remove API keys, tokens and private content. -->
`;
  return `${NEW_BUG}?template=bug_report.md&body=${encodeURIComponent(body)}`;
}

/** The "Report a problem" link, with the versions filled in once Symbio has told us (it works without them). */
export function useReportProblemUrl(): string {
  const [symbio, setSymbio] = useState<string | null>(null);
  const [runtimes, setRuntimes] = useState<string | null>(null);
  useEffect(() => {
    api.update().then((u) => setSymbio(u.current)).catch(() => {});
    api
      .runtimes()
      .then((list) => {
        const installed = list.filter((r) => r.installed).map((r) => `${r.label} ${r.installedVersion ?? r.version ?? ""}`.trim());
        setRuntimes(installed.length ? installed.join(", ") : "none installed");
      })
      .catch(() => {});
  }, []);
  return reportProblemUrl({ symbio, runtimes, os: osName() });
}

/** Top bar: opens a new bug report in a new tab. */
export function ReportProblemLink() {
  const href = useReportProblemUrl();
  return (
    <a className="btn ghost sm" href={href} target="_blank" rel="noreferrer" title="Report a problem on GitHub">
      <Bug size={15} />
      <span className="btn-label">Report a problem</span>
    </a>
  );
}

/** Settings → Report a problem. */
export function ReportProblemSection() {
  const href = useReportProblemUrl();
  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>Report a problem</h2>
          <p>
            Opens a new bug report on GitHub in a new tab, with Symbio's version, the agent runtimes installed and your operating
            system filled in. Nothing about your projects is added (no names, paths, logs or keys); you add what you choose before sending.
          </p>
        </div>
      </div>
      <div className="section-body" style={{ padding: "10px 16px 14px" }}>
        <a className="btn sm" href={href} target="_blank" rel="noreferrer">
          <Bug size={14} />
          Report a problem
        </a>
      </div>
    </section>
  );
}
