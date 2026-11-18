// Saving files safely: written to a temporary file next to the target, then moved over it, so a
// crash never leaves half a file.

import path from "node:path";
import { promises as fs } from "node:fs";

// Windows refuses to replace a file another process has open (an antivirus scan, the search
// indexer, a backup tool) with EPERM/EBUSY/EACCES for a moment; seen on CI machines with real-time
// scanning. Retried with growing pauses, about 6 seconds in all.
const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);
const ATTEMPTS = 8;

/** Moves `tmp` over `dest`, retrying while Windows briefly holds `dest`. Removes `tmp` if it gives up. */
export async function replaceFile(tmp: string, dest: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, dest);
      return;
    } catch (err: any) {
      if (attempt + 1 >= ATTEMPTS || !TRANSIENT.has(err?.code)) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      await new Promise((r) => setTimeout(r, 25 * 2 ** attempt));
    }
  }
}

const writes = new Map<string, Promise<void>>();
let tmpCount = 0;

/**
 * Writes a file atomically (a temporary file, then a rename). Writes to the same file run one after
 * the other, in the order asked, each with its own temporary file: two at once (an agent calling
 * several tools in parallel) would otherwise share one, and the second rename would find it gone.
 */
export function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const run = (writes.get(file) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${++tmpCount}.tmp`;
      await fs.writeFile(tmp, data);
      await replaceFile(tmp, file);
    });
  writes.set(file, run);
  void run.finally(() => {
    if (writes.get(file) === run) writes.delete(file);
  }).catch(() => {});
  return run;
}
