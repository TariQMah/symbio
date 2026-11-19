// Reading a VS Code color theme file (the JSON in a theme extension's `themes` folder, or what VS Code's
// "Developer: Generate Color Theme From Current Settings" writes) into Symbio's tokens. Only the
// workbench `colors` are used; what a theme doesn't set comes from Dark Modern or Light Modern.

export interface CustomTheme {
  id: string;
  label: string;
  /** The built-in theme it starts from: its tokens fill in what the file doesn't set. */
  base: "dark-modern" | "light-modern";
  /** Token name (without --) → color. */
  vars: Record<string, string>;
}

// Each token from the first of these VS Code colors the theme sets.
const MAP: Record<string, string[]> = {
  bg: ["editor.background"],
  "bg-sunken": ["activityBar.background", "sideBar.background", "editorGroupHeader.tabsBackground"],
  panel: ["sideBar.background", "panel.background", "editor.background"],
  surface: ["editorWidget.background", "input.background", "dropdown.background"],
  "surface-2": ["list.inactiveSelectionBackground", "tab.inactiveBackground", "editorWidget.background"],
  "surface-hover": ["list.hoverBackground", "toolbar.hoverBackground"],
  border: ["panel.border", "sideBar.border", "editorGroup.border", "widget.border", "contrastBorder"],
  "border-strong": ["input.border", "dropdown.border", "editorWidget.border", "panel.border"],
  "border-hover": ["inputOption.activeBorder", "input.border"],
  "border-focus": ["focusBorder"],
  scrollbar: ["scrollbarSlider.background"],
  "scrollbar-hover": ["scrollbarSlider.hoverBackground"],
  text: ["editor.foreground", "foreground"],
  "text-2": ["descriptionForeground", "sideBar.foreground", "foreground"],
  "text-3": ["disabledForeground", "editorLineNumber.foreground", "tab.inactiveForeground"],
  accent: ["button.background", "activityBarBadge.background", "focusBorder"],
  "accent-hover": ["button.hoverBackground", "button.background"],
  "accent-text": ["textLink.foreground", "textLink.activeForeground"],
  "on-accent": ["button.foreground", "activityBarBadge.foreground"],
  purple: ["terminal.ansiMagenta", "terminal.ansiBrightMagenta"],
  green: ["terminal.ansiGreen", "gitDecoration.addedResourceForeground", "editorGutter.addedBackground"],
  amber: ["editorWarning.foreground", "terminal.ansiYellow", "list.warningForeground"],
  red: ["editorError.foreground", "errorForeground", "terminal.ansiRed"],
  blue: ["terminal.ansiBlue", "editorInfo.foreground"],
};

// Only plain hex colors go into the page's style: nothing else from a file is trusted.
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** JSON with comments and trailing commas, as VS Code writes it. */
function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export function parseVsCodeTheme(text: string, fileName = "Imported theme"): CustomTheme {
  let data: any;
  try {
    data = parseJsonc(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("That file isn't a VS Code color theme (it isn't valid JSON).");
  }
  const colors = data && typeof data === "object" ? data.colors : null;
  if (!colors || typeof colors !== "object") {
    throw new Error(
      data?.include
        ? "This theme only includes another file (its colors are there): import that file instead."
        : "That file has no \"colors\": it isn't a VS Code color theme.",
    );
  }
  const vars: Record<string, string> = {};
  for (const [token, keys] of Object.entries(MAP)) {
    const value = keys.map((k) => colors[k]).find((v) => typeof v === "string" && HEX.test(v.trim()));
    if (value) vars[token] = value.trim();
  }
  if (!vars.bg) throw new Error("That theme doesn't set the editor's background color, so there's nothing to go on.");
  const type = String(data.type ?? "").toLowerCase();
  const base = type === "light" || type === "hc-light" || (!type && luminance(vars.bg) > 0.5) ? "light-modern" : "dark-modern";
  const label = (typeof data.name === "string" && data.name.trim()) || fileName.replace(/\.(json|jsonc)$/i, "").replace(/[-_]?color-theme$/i, "") || "Imported theme";
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "theme";
  return { id: `custom-${slug}`, label: label.slice(0, 60), base, vars };
}

/** 0 (black) to 1 (white), from a hex color. */
export function luminance(hex: string): number {
  let h = hex.replace("#", "");
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
