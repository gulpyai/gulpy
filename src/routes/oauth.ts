/**
 * The endpoints that an agent calls with no user present: discovery,
 * registration and tokens. The page where the user approves is in pages.tsx.
 */
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import {
  authorizationServerMetadata,
  exchangeToken,
  OAuthProblem,
  protectedResourceMetadata,
  registerAgent,
  revokeToken,
} from "../agents.ts";
import type { Deps } from "../deps.ts";

async function formOf(c: Context): Promise<Record<string, string>> {
  const body = await c.req.parseBody();
  const form: Record<string, string> = {};
  for (const [name, value] of Object.entries(body)) if (typeof value === "string") form[name] = value;
  return form;
}

export function oauthRoutes(deps: Deps): Hono {
  const oauth = new Hono();

  // These endpoints use no cookie. An agent that runs in a browser calls them from its own origin.
  // The rule is for these paths only. The pages of Gulpy must not get it.
  const open = cors({ origin: "*", allowHeaders: ["authorization", "content-type", "mcp-protocol-version"] });
  for (const path of ["/.well-known/*", "/oauth/register", "/oauth/token", "/oauth/revoke"]) {
    oauth.use(path, open);
    oauth.use(path, async (c, next) => {
      await next();
      c.header("Cache-Control", "no-store");
    });
  }

  oauth.onError((error, c) => {
    if (error instanceof OAuthProblem) {
      if (error.status === 401) c.header("WWW-Authenticate", "Basic");
      return c.json({ error: error.error, error_description: error.message }, error.status);
    }
    console.error("[gulpy] OAuth error", error);
    return c.json({ error: "server_error" }, 500);
  });

  const resource = (c: Context) => c.json(protectedResourceMetadata(deps));
  oauth.get("/.well-known/oauth-protected-resource", resource);
  oauth.get("/.well-known/oauth-protected-resource/mcp", resource);

  const server = (c: Context) => c.json(authorizationServerMetadata(deps));
  oauth.get("/.well-known/oauth-authorization-server", server);
  oauth.get("/.well-known/openid-configuration", server);

  oauth.post("/oauth/register", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new OAuthProblem(400, "invalid_client_metadata", "The body must be a JSON object");
    }
    return c.json(registerAgent(deps, body as Record<string, unknown>), 201);
  });

  oauth.post("/oauth/token", async (c) => {
    c.header("Pragma", "no-cache");
    return c.json(await exchangeToken(deps, await formOf(c), c.req.header("authorization")));
  });

  oauth.post("/oauth/revoke", async (c) => {
    revokeToken(deps, (await formOf(c)).token);
    return c.body(null, 200);
  });

  return oauth;
}
