/**
 * The endpoints that an agent calls to connect: the device flow (src/device.ts),
 * the guide and the connect script. The page where the user taps Allow is in pages.tsx.
 */
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { OAuthProblem } from "../agents.ts";
import type { Deps } from "../deps.ts";
import { pollDevice, startDevice } from "../device.ts";
import { agentGuide, connectScript } from "../guide.ts";

async function formOf(c: Context): Promise<Record<string, string>> {
  const body = await c.req.parseBody();
  const form: Record<string, string> = {};
  for (const [name, value] of Object.entries(body)) if (typeof value === "string") form[name] = value;
  return form;
}

/** A form, or a JSON object. `curl -d` sends a form; many agents send JSON. */
async function bodyOf(c: Context): Promise<Record<string, unknown>> {
  if ((c.req.header("content-type") ?? "").includes("application/json")) {
    const body: unknown = await c.req.json().catch(() => null);
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  }
  return formOf(c);
}

export function connectRoutes(deps: Deps): Hono {
  const oauth = new Hono();

  // These endpoints use no cookie. An agent that runs in a browser calls them from its own origin.
  // The rule is for these paths only. The pages of Gulpy must not get it.
  const open = cors({ origin: "*", allowHeaders: ["authorization", "content-type"] });
  for (const path of ["/device/code", "/device/token", "/agents.md", "/connect.sh"]) {
    oauth.use(path, open);
    oauth.use(path, async (c, next) => {
      await next();
      c.header("Cache-Control", "no-store");
    });
  }

  oauth.onError((error, c) => {
    if (error instanceof OAuthProblem) {
      return c.json({ error: error.error, error_description: error.message }, error.status);
    }
    console.error("[gulpy] connect error", error);
    return c.json({ error: "server_error" }, 500);
  });

  // Connect to Gulpy: the sign-in for an agent on the computer of the user (RFC 8628)

  oauth.post("/device/code", async (c) => c.json(startDevice(deps, await bodyOf(c))));

  oauth.post("/device/token", async (c) => {
    c.header("Pragma", "no-cache");
    return c.json(pollDevice(deps, await bodyOf(c)));
  });

  // What an agent reads to connect and to use the tools
  oauth.get("/agents.md", (c) => {
    c.header("Content-Type", "text/markdown; charset=utf-8");
    return c.body(agentGuide(deps.config.baseUrl));
  });
  oauth.get("/connect.sh", (c) => {
    c.header("Content-Type", "text/x-shellscript; charset=utf-8");
    return c.body(connectScript(deps.config.baseUrl));
  });

  return oauth;
}
