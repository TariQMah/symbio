import { MessageSquare } from "lucide-react";

const DISCUSSIONS = "https://github.com/linkzy/symbio/discussions";

/** Settings → Feedback: opens the repository's Discussions, so people can share what they think without filing a bug. */
export function FeedbackSection() {
  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>Feedback</h2>
          <p>
            Ideas, questions or just what you think of Symbio: share them in the project's Discussions on GitHub. They open in a new
            tab, and nothing from your projects is sent.
          </p>
        </div>
      </div>
      <div className="section-body" style={{ padding: "10px 16px 14px", display: "flex", gap: 8, flexWrap: "wrap" }}>
        <a className="btn sm" href={`${DISCUSSIONS}/new?category=ideas`} target="_blank" rel="noreferrer">
          <MessageSquare size={14} />
          Give feedback
        </a>
        <a className="btn ghost sm" href={`${DISCUSSIONS}/new?category=q-a`} target="_blank" rel="noreferrer">
          Ask a question
        </a>
      </div>
    </section>
  );
}
