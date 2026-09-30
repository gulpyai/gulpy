import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "./deps.ts";

const DAY_MS = 24 * 60 * 60_000;
/** The number of daily copies that stay. */
const KEEP = 14;
const COPY = /^gulpy-\d{4}-\d{2}-\d{2}\.db$/;

/**
 * Writes a copy of the database to `dir`, one file for each day, and deletes
 * the copies that are older than the last 14. The tokens in a copy are
 * encrypted, as in the database: a copy is of no use without the master key.
 */
export function backUp(deps: Deps, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `gulpy-${new Date(deps.now()).toISOString().slice(0, 10)}.db`);
  // VACUUM INTO does not write to a file that exists.
  rmSync(file, { force: true });
  deps.store.db.query("VACUUM INTO ?").run(file);
  const copies = readdirSync(dir)
    .filter((name) => COPY.test(name))
    .sort();
  for (const name of copies.slice(0, -KEEP)) rmSync(join(dir, name), { force: true });
  return file;
}

/** Runs `backUp` now and then each day. The timer does not keep the process alive. */
export function startBackups(deps: Deps, dir: string): void {
  const run = () => {
    try {
      console.log(`[gulpy] backup: ${backUp(deps, dir)}`);
    } catch (error) {
      console.error("[gulpy] backup failed", error);
    }
  };
  run();
  setInterval(run, DAY_MS).unref();
}
