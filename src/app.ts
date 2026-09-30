import { Hono } from "hono";
import { Catalog } from "./catalog.ts";
import { loadConfig, type Config } from "./config.ts";
import type { Deps, Mailer } from "./deps.ts";
import { logoFiles } from "./logos.ts";
import { ConsoleMailer } from "./mailer.ts";
import { loadProviders } from "./providers/index.ts";
import type { Provider } from "./providers/types.ts";
import { apiRoutes } from "./routes/api.ts";
import { billingRoutes } from "./routes/billing.ts";
import { infoRoutes } from "./routes/info.tsx";
import { mcpRoutes } from "./routes/mcp.ts";
import { oauthRoutes } from "./routes/oauth.ts";
import { pageRoutes } from "./routes/pages.tsx";
import { Gulpy } from "./service.ts";
import { openDatabase, Store } from "./store.ts";
import { Vault } from "./vault.ts";

const ASSETS = {
  "/assets/gulpy.css": { file: "gulpy.css", type: "text/css; charset=utf-8" },
  "/assets/pages.css": { file: "pages.css", type: "text/css; charset=utf-8" },
  "/assets/icon.svg": { file: "icon.svg", type: "image/svg+xml" },
  "/assets/link-done.js": { file: "link-done.js", type: "text/javascript; charset=utf-8" },
  "/assets/catalog.js": { file: "catalog.js", type: "text/javascript; charset=utf-8" },
  "/assets/leave.js": { file: "leave.js", type: "text/javascript; charset=utf-8" },
  "/assets/hero.js": { file: "hero.js", type: "text/javascript; charset=utf-8" },
  "/assets/nunito.woff2": { file: "nunito.woff2", type: "font/woff2" },
  "/link.js": { file: "link.js", type: "text/javascript; charset=utf-8" },
  // `scripts/make-social.py` makes these two pictures.
  "/assets/social.png": { file: "social.png", type: "image/png" },
  "/assets/touch-icon.png": { file: "touch-icon.png", type: "image/png" },
} as const;

export interface GulpyApp {
  app: Hono;
  deps: Deps;
  vault: Vault;
  gulpy: Gulpy;
}

export function createDeps(options: {
  config?: Config;
  fetch?: typeof fetch;
  mailer?: Mailer;
  now?: () => number;
  /** Providers that are not built in. The tests use it. */
  providers?: Provider[];
}): Deps {
  const config = options.config ?? loadConfig();
  return {
    config,
    store: new Store(openDatabase(config.dbPath)),
    providers: loadProviders(config, options.providers),
    catalog: new Catalog(config),
    fetch: options.fetch ?? fetch,
    mailer: options.mailer ?? new ConsoleMailer(),
    now: options.now ?? Date.now,
  };
}

export async function createApp(deps: Deps): Promise<GulpyApp> {
  const vault = new Vault(deps);
  const gulpy = new Gulpy(deps, vault);
  const app = new Hono();

  // An old address of this server. 308 keeps the method and the body, so an agent that POSTs to /mcp follows it.
  if (deps.config.redirectHosts.length > 0) {
    const old = new Set(deps.config.redirectHosts);
    app.use("*", async (c, next) => {
      const host = (c.req.header("host") ?? "").toLowerCase();
      if (!old.has(host)) return next();
      const url = new URL(c.req.url);
      return c.redirect(`${deps.config.baseUrl}${url.pathname}${url.search}`, 308);
    });
  }

  // On the real address, the browser must use https for one year, also when a person types http.
  if (deps.config.baseUrl.startsWith("https://")) {
    app.use("*", async (c, next) => {
      await next();
      c.header("Strict-Transport-Security", "max-age=31536000");
    });
  }

  for (const [path, asset] of Object.entries(ASSETS)) {
    const body = await Bun.file(new URL(`./assets/${asset.file}`, import.meta.url)).arrayBuffer();
    app.get(path, (c) => {
      c.header("Content-Type", asset.type);
      c.header("X-Content-Type-Options", "nosniff");
      // Agent apps on other origins load link.js.
      c.header("Cross-Origin-Resource-Policy", "cross-origin");
      c.header("Cache-Control", deps.config.env === "production" ? "public, max-age=300" : "no-store");
      return c.body(body);
    });
  }

  for (const logo of logoFiles()) {
    app.get(logo.path, (c) => {
      c.header("Content-Type", "image/png");
      c.header("X-Content-Type-Options", "nosniff");
      // The address of a logo has the version of the image in it.
      c.header("Cache-Control", "public, max-age=31536000, immutable");
      return c.body(logo.body);
    });
  }

  app.get("/health", (c) =>
    c.json({ ok: true, providers: [...deps.providers.keys()], connectors: deps.catalog.all().length }),
  );
  app.route("/v1", apiRoutes(deps, gulpy));
  app.route("/mcp", mcpRoutes(deps, gulpy));
  // Before the pages: agents call these endpoints from other origins, with no cookie. Stripe too.
  app.route("/", billingRoutes(deps));
  app.route("/", oauthRoutes(deps));
  app.route("/", infoRoutes(deps));
  app.route("/", pageRoutes(deps, vault));

  app.onError((error, c) => {
    console.error("[gulpy] error", error);
    return c.text("Gulpy had an internal error", 500);
  });

  return { app, deps, vault, gulpy };
}
