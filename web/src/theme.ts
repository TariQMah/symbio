// The look of the app: a theme is a set of the color and shape tokens in styles.css (themes.css
// has the built-in ones). The choice is kept in this browser, so each computer can have its own.

import { useEffect, useState } from "react";

export interface ThemeInfo {
  id: string;
  label: string;
  description: string;
  /** Colors for the preview in Settings: background, panel, text, accent. */
  swatch: [string, string, string, string];
}

export const THEMES: ThemeInfo[] = [
  { id: "symbio", label: "Symbio", description: "Graphite, with Symbio's violet. The default.", swatch: ["#0b0c0e", "#15161a", "#ededef", "#6d6af5"] },
  { id: "dark-modern", label: "Dark Modern", description: "The colors of VS Code's default dark theme.", swatch: ["#1f1f1f", "#181818", "#cccccc", "#0078d4"] },
  { id: "light-modern", label: "Light Modern", description: "The colors of VS Code's default light theme.", swatch: ["#ffffff", "#f8f8f8", "#3b3b3b", "#005fb8"] },
];

const KEY = "symbio:theme";
const EVENT = "symbio:theme-changed";

export function currentTheme(): string {
  const saved = localStorage.getItem(KEY);
  return THEMES.some((t) => t.id === saved) ? saved! : "symbio";
}

/** Puts the theme on the page (the default needs no attribute: it's :root). */
export function applyTheme(id = currentTheme()) {
  if (id === "symbio") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;
}

export function setTheme(id: string) {
  localStorage.setItem(KEY, id);
  applyTheme(id);
  dispatchEvent(new Event(EVENT));
}

export function useTheme(): [string, (id: string) => void] {
  const [theme, set] = useState(currentTheme);
  useEffect(() => {
    const update = () => set(currentTheme());
    addEventListener(EVENT, update);
    // Another tab changed it.
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) {
        applyTheme();
        update();
      }
    };
    addEventListener("storage", onStorage);
    return () => {
      removeEventListener(EVENT, update);
      removeEventListener("storage", onStorage);
    };
  }, []);
  return [theme, setTheme];
}
