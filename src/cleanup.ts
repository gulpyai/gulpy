import { LEGAL } from "./brand.ts";
import type { Deps } from "./deps.ts";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Deletes the data that the Privacy page says Gulpy does not keep: expired codes,
 * sessions and tokens, and calls older than `LEGAL.callLogDays`.
 */
export function cleanUp(deps: Deps): number {
  const now = deps.now();
  return deps.store.prune(now, now - LEGAL.callLogDays * DAY_MS);
}

/** Runs `cleanUp` now and then each hour. The timer does not keep the process alive. */
export function startCleanup(deps: Deps): void {
  const run = () => {
    try {
      const count = cleanUp(deps);
      if (count > 0) console.log(`[gulpy] cleanup: deleted ${count} old rows`);
    } catch (error) {
      console.error("[gulpy] cleanup failed", error);
    }
  };
  run();
  setInterval(run, HOUR_MS).unref();
}
