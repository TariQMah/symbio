import { Check } from "lucide-react";
import { THEMES, useTheme } from "./theme";

/** Settings → Appearance: the theme, kept in this browser. */
export function AppearanceSection() {
  const [theme, setTheme] = useTheme();
  return (
    <section className="section" id="appearance">
      <div className="section-head">
        <div>
          <h2>Appearance</h2>
          <p>How Symbio looks in this browser. Each computer keeps its own choice.</p>
        </div>
      </div>
      <div className="section-body">
        <div className="theme-cards" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`theme-card ${theme === t.id ? "on" : ""}`}
              role="radio"
              aria-checked={theme === t.id}
              data-theme-id={t.id}
              onClick={() => setTheme(t.id)}
            >
              <span className="theme-preview" style={{ background: t.swatch[0] }} aria-hidden>
                <span className="theme-preview-side" style={{ background: t.swatch[1] }} />
                <span className="theme-preview-lines">
                  <span style={{ background: t.swatch[2] }} />
                  <span style={{ background: t.swatch[2], width: "60%" }} />
                  <span style={{ background: t.swatch[3], width: "35%" }} />
                </span>
              </span>
              <span className="theme-card-text">
                <span className="list-title">
                  {t.label} {theme === t.id && <Check size={13} />}
                </span>
                <span className="list-sub">{t.description}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
