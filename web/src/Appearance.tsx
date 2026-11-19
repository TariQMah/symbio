import { Check } from "lucide-react";
import { LAYOUTS, THEMES, useLayout, useTheme } from "./theme";

/** Settings → Appearance: the theme, kept in this browser. */
export function AppearanceSection() {
  const [theme, setTheme] = useTheme();
  const [layout, setLayout] = useLayout();
  const developer = theme === "dark-modern" && layout === "workbench";
  return (
    <section className="section" id="appearance">
      <div className="section-head">
        <div>
          <h2>Appearance</h2>
          <p>How Symbio looks in this browser: the colors and the layout of a project. Each computer keeps its own choice.</p>
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
        <div className="theme-cards" role="radiogroup" aria-label="Layout" style={{ marginTop: 14 }}>
          {LAYOUTS.map((l) => (
            <button key={l.id} className={`theme-card ${layout === l.id ? "on" : ""}`} role="radio" aria-checked={layout === l.id} data-layout-id={l.id} onClick={() => setLayout(l.id)}>
              <span className={`layout-preview ${l.id}`} aria-hidden>
                {l.id === "classic" ? (
                  <>
                    <span />
                    <span className="accent" />
                  </>
                ) : (
                  <>
                    <span />
                    <span />
                    <span />
                    <span className="accent" />
                  </>
                )}
              </span>
              <span className="theme-card-text">
                <span className="list-title">
                  {l.label} {layout === l.id && <Check size={13} />}
                </span>
                <span className="list-sub">{l.description}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="appearance-preset">
          <button
            className="btn sm"
            disabled={developer}
            onClick={() => {
              setTheme("dark-modern");
              setLayout("workbench");
            }}
          >
            {developer ? <Check size={13} /> : null}
            Developer look
          </button>
          <span className="small subtle">Dark Modern with the Workbench layout. Small windows and phones always use the classic layout.</span>
        </div>
      </div>
    </section>
  );
}
