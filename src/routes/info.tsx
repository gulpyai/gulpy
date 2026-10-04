/** The public pages for help, security and the rules, and the files for search engines. */
import { Hono } from "hono";
import type { Context } from "hono";
import type { Child } from "hono/jsx";
import { viewer } from "../auth.ts";
import { CONTACT } from "../brand.ts";
import type { Deps } from "../deps.ts";
import { Privacy, Security, Support, Terms, type InfoModel } from "../views/info.tsx";
import { CSP } from "./pages.tsx";

const PAGES = ["/", "/support", "/security", "/privacy", "/terms"];

/** security.txt must name the date after which it is not valid. One year is the usual maximum. */
function securityText(baseUrl: string, now: number): string {
  const expires = new Date(now + 300 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  return [
    `Contact: mailto:${CONTACT.security}`,
    `Expires: ${expires}T00:00:00.000Z`,
    "Preferred-Languages: en",
    `Canonical: ${baseUrl}/.well-known/security.txt`,
    `Policy: ${baseUrl}/security`,
    "",
  ].join("\n");
}

export function infoRoutes(deps: Deps): Hono {
  const app = new Hono();
  const { baseUrl } = deps.config;
  const real = baseUrl.startsWith("https://");

  const model = (c: Context): InfoModel => ({
    viewer: viewer(deps, c),
    baseUrl,
    meta: real ? (path, description) => ({ description, url: `${baseUrl}${path}`, image: `${baseUrl}/assets/social.png` }) : undefined,
  });

  const page = (c: Context, body: Child): Response => {
    c.header("Content-Security-Policy", CSP);
    c.header("Referrer-Policy", "same-origin");
    c.header("X-Content-Type-Options", "nosniff");
    // The top of the page shows the email address of the person who is signed in.
    c.header("Cache-Control", "no-store");
    return c.html(`<!DOCTYPE html>${String(body)}`);
  };

  app.get("/support", (c) => page(c, <Support model={model(c)} />));
  app.get("/security", (c) => page(c, <Security model={model(c)} />));
  app.get("/privacy", (c) => page(c, <Privacy model={model(c)} />));
  app.get("/terms", (c) => page(c, <Terms model={model(c)} />));

  // Set the type here. With no header set, Hono leaves the type to the runtime, and the HSTS middleware then drops it.
  app.get("/.well-known/security.txt", (c) =>
    c.text(securityText(baseUrl, deps.now()), 200, { "Content-Type": "text/plain; charset=utf-8" }),
  );

  app.get("/robots.txt", (c) =>
    c.text(
      real
        ? ["User-agent: *", "Allow: /", "Disallow: /oauth/", "Disallow: /link", "Disallow: /v1/", `Sitemap: ${baseUrl}/sitemap.xml`, ""].join("\n")
        : "User-agent: *\nDisallow: /\n",
    ),
  );

  app.get("/sitemap.xml", (c) => {
    const urls = PAGES.map((path) => `  <url><loc>${baseUrl}${path}</loc></url>`).join("\n");
    c.header("Content-Type", "application/xml; charset=utf-8");
    return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  });

  return app;
}
