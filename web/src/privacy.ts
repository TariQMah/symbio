import { useEffect, useState } from "react";

// Costs and token counts are hidden unless the human turns them on (Settings → Costs and tokens),
// so people passing by don't see what projects spend. Kept in this browser: a phone or another
// computer starts hidden too.

const KEY = "symbio:show-costs";
const EVENT = "symbio:show-costs-changed";

/** Shown instead of a hidden amount. */
export const MASK = "•••";

export const costsShown = () => localStorage.getItem(KEY) === "1";

export function setCostsShown(on: boolean) {
  if (on) localStorage.setItem(KEY, "1");
  else localStorage.removeItem(KEY);
  dispatchEvent(new Event(EVENT));
}

/** Whether to show costs and token counts, updated at once when the setting changes (in any tab). */
export function useCostsShown(): boolean {
  const [shown, setShown] = useState(costsShown);
  useEffect(() => {
    const update = () => setShown(costsShown());
    addEventListener(EVENT, update);
    addEventListener("storage", update);
    return () => {
      removeEventListener(EVENT, update);
      removeEventListener("storage", update);
    };
  }, []);
  return shown;
}
