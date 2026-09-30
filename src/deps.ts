import type { Catalog } from "./catalog.ts";
import type { Config } from "./config.ts";
import type { Providers } from "./providers/index.ts";
import type { Store } from "./store.ts";

export interface Mailer {
  sendCode(email: string, code: string): Promise<void>;
  /** A short security notice, for example "Muse can now use your tools". */
  sendNotice(email: string, subject: string, text: string): Promise<void>;
  /** Development only. Returns the last code for the address so that the page can show it. */
  peek?(email: string): string | undefined;
}

/** Everything that the routes need. Tests replace `fetch`, `now` and `mailer`. */
export interface Deps {
  config: Config;
  store: Store;
  /** Providers that have their own API, for which Gulpy supplies the tools. */
  providers: Providers;
  /** All connectors that a user can add. */
  catalog: Catalog;
  fetch: typeof fetch;
  mailer: Mailer;
  now: () => number;
}
