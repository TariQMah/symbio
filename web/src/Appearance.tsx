import { useRef, useState } from "react";
import { Check, Upload, X } from "lucide-react";
import { addCustomTheme, allThemes, LAYOUTS, removeCustomTheme, useLayout, useTheme } from "./theme";
import { parseVsCodeTheme } from "./vscodeTheme";

/** Settings → Appearance: the theme, kept in this browser. */
export function AppearanceSection() {
  const [theme, setTheme] = useTheme();
  const [layout, setLayout] = useLayout();
  const developer = theme === "dark-modern" && layout === "workbench";
  const [, refresh] = useState(0);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function importTheme(file: File) {
    setImportError(null);
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error("That file is too large for a color theme.");
      addCustomTheme(parseVsCodeTheme(await file.text(), file.name));
      refresh((n) => n + 1);
    } catch (e) {
      setImportError((e as Error).message);
    }
  }
  return (
    <section className="section" id="appearance">
      <div className="section-head">
        <div>
          <h2>Appearance</h2>
          <p>How Symbio looks in this browser: the colors and the layout of a project. Each computer keeps its own choice.</p>
        </div>
      </div>
      <div className="section-body">
        <div className="appearance-label">Colors</div>
        <div className="theme-cards" role="radiogroup" aria-label="Theme">
          {allThemes().map((t) => (
            <div key={t.id} className="theme-card-wrap">
              <button
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
              {t.custom && (
                <button
                  className="theme-card-remove"
                  title={`Remove ${t.label}`}
                  aria-label={`Remove ${t.label}`}
                  onClick={() => {
                    removeCustomTheme(t.id);
                    refresh((n) => n + 1);
                  }}
                >
                  <X size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="appearance-preset">
          <button className="btn sm" onClick={() => fileInput.current?.click()}>
            <Upload size={13} />
            Import a VS Code theme…
          </button>
          <span className="small subtle">
            A color theme's <code>.json</code> file (in a theme extension's <code>themes</code> folder, or from VS Code's <em>Developer: Generate Color Theme From Current Settings</em>).
          </span>
          <input
            ref={fileInput}
            type="file"
            accept=".json,.jsonc,application/json"
            hidden
            data-testid="theme-file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) importTheme(f);
            }}
          />
        </div>
        {importError && <div className="error" style={{ marginTop: 10 }}>{importError}</div>}
        <div className="appearance-label">Layout of a project</div>
        <div className="theme-cards" role="radiogroup" aria-label="Layout">
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
