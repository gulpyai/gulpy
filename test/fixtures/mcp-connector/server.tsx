/**
 * A mock connector: an MCP server with OAuth, as Notion or Linear operate one.
 * It has fake data. It lets the full flow run with no real accounts.
 * Do not use it as a model for a production OAuth server.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Hono, type Context } from "hono";
import type { FC } from "hono/jsx";
import { hmac, pkceChallenge, randomId, safeEqual } from "../../../src/crypto.ts";
import { ACCOUNTS, type Account } from "../mail-provider/data.ts";

export interface MockTool {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
  properties?: Record<string, { type: string; description?: string }>;
  required?: string[];
  run(args: Record<string, unknown>, account: Account): unknown;
}

export interface MockMcpOptions {
  name: string;
  /** Its own origin, for example http://localhost:4401 */
  baseUrl: string;
  signingKey: Buffer;
  /** `dynamic`: a client registers itself. `static`: only the client below can sign in. */
  registration: "dynamic" | "static";
  staticClient?: { clientId: string; clientSecret: string; redirectUris: string[] };
  tools: MockTool[];
  /** Life of an access token in seconds. */
  accessTtlSeconds?: number;
  /** False: the server gives no `readOnlyHint`, as some real servers do. */
  annotate?: boolean;
  /** True: the user is not signed in, so the authorize page asks for a password. */
  signedOut?: boolean;
  now?: () => number;
}

export interface MockMcp {
  app: Hono;
  /** Cancels all tokens of the account, as if the user removed the app at the provider. */
  revokeAccount(accountId: string): void;
  /** Each tool call that the server got, as "tool account". */
  calls: string[];
}

type Claims =
  | { kind: "client"; redirects: string[]; name: string; jti: string }
  | { kind: "code"; sub: string; client: string; challenge: string; redirectUri: string; scope: string; exp: number; jti: string }
  | { kind: "access"; sub: string; email: string; scope: string; iat: number; exp: number }
  | { kind: "refresh"; sub: string; client: string; scope: string; iat: number; jti: string };

const STYLE = `
body{margin:0;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:#f4f6f3;color:#16201a;display:grid;place-items:center;min-height:100vh;padding:20px;box-sizing:border-box}
main{width:100%;max-width:400px;background:#fff;border:1px solid #dfe5dd;border-radius:18px;padding:28px;display:grid;gap:18px;box-sizing:border-box}
h1{margin:0;font-size:20px}
p{margin:0;color:#5a6b60}
.logo{width:44px;height:44px;border-radius:12px;background:#1f7a4d;color:#fff;display:grid;place-items:center;font-weight:700;font-size:20px}
.accounts{display:grid;gap:8px}
button{font:inherit;cursor:pointer;border-radius:10px;min-height:46px;padding:0 14px;border:1px solid #cfd8cd;background:#fff;text-align:left}
button.account{display:grid}
button.account span{font-size:13px;color:#5a6b60}
button.account:hover{border-color:#1f7a4d}
button.deny{text-align:center;border-color:transparent;color:#5a6b60;background:transparent}
.tag{font-size:12px;color:#1f7a4d;font-weight:600}
`;

const AuthorizePage: FC<{ name: string; client: string; params: Record<string, string> }> = ({ name, client, params }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Sign in · {name}</title>
      <link rel="stylesheet" href="/style.css" />
    </head>
    <body>
      <main>
        <div class="logo">{name.replace(/^Acme /, "").charAt(0)}</div>
        <div>
          <h1>
            {client} wants access to your {name} account
          </h1>
          <p class="tag">Demo connector. The data is fake.</p>
        </div>
        <form method="post" action="/authorize" class="accounts">
          {Object.entries(params).map(([key, value]) => (
            <input type="hidden" name={key} value={value} />
          ))}
          <p>Choose an account to continue</p>
          {ACCOUNTS.map((account) => (
            <button class="account" type="submit" name="account" value={account.id}>
              <strong>{account.name}</strong>
              <span>{account.email}</span>
            </button>
          ))}
          <button class="deny" type="submit" name="account" value="">
            Cancel
          </button>
        </form>
      </main>
    </body>
  </html>
);

export function createMockMcp(options: MockMcpOptions): MockMcp {
  const now = options.now ?? Date.now;
  const accessTtl = options.accessTtlSeconds ?? 3600;
  const base = options.baseUrl;
  const usedCodes = new Set<string>();
  const revokedBefore = new Map<string, number>();
  const calls: string[] = [];

  const sign = (claims: Claims): string => {
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `mock.${body}.${hmac(options.signingKey, body)}`;
  };

  const verify = <K extends Claims["kind"]>(token: string | undefined, kind: K): Extract<Claims, { kind: K }> | null => {
    const [prefix, body, signature] = (token ?? "").split(".");
    if (prefix !== "mock" || !body || !signature || !safeEqual(signature, hmac(options.signingKey, body))) return null;
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Claims;
    if (claims.kind !== kind) return null;
    if ("exp" in claims && claims.exp <= now()) return null;
    return claims as Extract<Claims, { kind: K }>;
  };

  /** The redirect addresses and the name of a client, or null if the client is not known. */
  const clientOf = (clientId: string): { redirects: string[]; name: string; secret?: string } | null => {
    if (options.staticClient && clientId === options.staticClient.clientId) {
      return { redirects: options.staticClient.redirectUris, name: "Gulpy", secret: options.staticClient.clientSecret };
    }
    if (options.registration !== "dynamic") return null;
    const registered = verify(clientId, "client");
    return registered ? { redirects: registered.redirects, name: registered.name } : null;
  };

  const issue = (sub: string, client: string, scope: string, refreshToken?: string) => {
    const account = ACCOUNTS.find((item) => item.id === sub);
    return {
      token_type: "Bearer",
      access_token: sign({ kind: "access", sub, email: account?.email ?? sub, scope, iat: now(), exp: now() + accessTtl * 1000 }),
      refresh_token: refreshToken ?? sign({ kind: "refresh", sub, client, scope, iat: now(), jti: randomId("rt") }),
      expires_in: accessTtl,
      scope,
    };
  };

  const app = new Hono();

  app.get("/style.css", (c) => {
    c.header("Content-Type", "text/css; charset=utf-8");
    return c.body(STYLE);
  });

  // Discovery

  const resourceMetadata = (c: Context) =>
    c.json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["read", "write"] });
  app.get("/.well-known/oauth-protected-resource", resourceMetadata);
  app.get("/.well-known/oauth-protected-resource/mcp", resourceMetadata);

  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      ...(options.registration === "dynamic" ? { registration_endpoint: `${base}/register` } : {}),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      scopes_supported: ["read", "write"],
    }),
  );

  // Registration. The client id holds the registration, so the server keeps no list.

  app.post("/register", async (c) => {
    if (options.registration !== "dynamic") return c.json({ error: "registration_not_supported" }, 404);
    const body = (await c.req.json().catch(() => null)) as { redirect_uris?: unknown; client_name?: unknown } | null;
    const redirects = Array.isArray(body?.redirect_uris) ? body.redirect_uris.map(String) : [];
    if (redirects.length === 0) return c.json({ error: "invalid_redirect_uri" }, 400);
    const name = typeof body?.client_name === "string" ? body.client_name.slice(0, 60) : "App";
    return c.json(
      {
        client_id: sign({ kind: "client", redirects, name, jti: randomId("client") }),
        client_name: name,
        redirect_uris: redirects,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201,
    );
  });

  // Authorization

  const PARAMS = ["client_id", "redirect_uri", "response_type", "scope", "state", "code_challenge", "code_challenge_method", "resource"];

  const read = (source: Record<string, unknown>) => {
    const params: Record<string, string> = {};
    for (const name of PARAMS) if (typeof source[name] === "string") params[name] = source[name];
    const client = clientOf(params.client_id ?? "");
    const trusted = client !== null && client.redirects.includes(params.redirect_uri ?? "");
    const valid = params.response_type === "code" && params.code_challenge_method === "S256" && Boolean(params.code_challenge);
    return { params, client, trusted, valid };
  };

  const back = (c: Context, redirectUri: string, values: Record<string, string | undefined>) => {
    const url = new URL(redirectUri);
    for (const [name, value] of Object.entries(values)) if (value) url.searchParams.set(name, value);
    return c.redirect(url.toString(), 303);
  };

  app.get("/authorize", (c) => {
    const request = read(c.req.query());
    if (!request.trusted || !request.client) return c.text(`${options.name} does not know this app or this redirect address`, 400);
    const { params } = request;
    if (!request.valid) return back(c, params.redirect_uri ?? "", { error: "invalid_request", state: params.state });
    if (options.signedOut) {
      return c.html(
        `<!DOCTYPE html><title>Sign in · ${options.name}</title><h1>Sign in to ${options.name}</h1><form><input type="email" name="email"><input type="password" name="password"><button>Continue</button></form>`,
      );
    }
    return c.html(
      `<!DOCTYPE html>${String(<AuthorizePage name={options.name} client={request.client.name} params={params} />)}`,
    );
  });

  app.post("/authorize", async (c) => {
    const form = await c.req.parseBody();
    const request = read(form);
    if (!request.trusted) return c.text(`${options.name} does not know this app or this redirect address`, 400);
    const { params } = request;
    const redirectUri = params.redirect_uri ?? "";
    const account = ACCOUNTS.find((item) => item.id === form.account);
    if (!request.valid || !account) return back(c, redirectUri, { error: "access_denied", state: params.state });
    const code = sign({
      kind: "code",
      sub: account.id,
      client: params.client_id ?? "",
      challenge: params.code_challenge ?? "",
      redirectUri,
      scope: params.scope ?? "read write",
      exp: now() + 60_000,
      jti: randomId("code"),
    });
    return back(c, redirectUri, { code, state: params.state });
  });

  // Tokens

  app.post("/token", async (c) => {
    const form = await c.req.parseBody();
    const field = (name: string) => (typeof form[name] === "string" ? form[name] : "");
    const client = clientOf(field("client_id"));
    if (!client || (client.secret !== undefined && !safeEqual(field("client_secret"), client.secret))) {
      return c.json({ error: "invalid_client" }, 401);
    }

    if (field("grant_type") === "authorization_code") {
      const code = verify(field("code"), "code");
      if (
        !code ||
        usedCodes.has(code.jti) ||
        code.client !== field("client_id") ||
        code.redirectUri !== field("redirect_uri") ||
        code.challenge !== pkceChallenge(field("code_verifier"))
      ) {
        return c.json({ error: "invalid_grant" }, 400);
      }
      usedCodes.add(code.jti);
      return c.json(issue(code.sub, code.client, code.scope));
    }

    if (field("grant_type") === "refresh_token") {
      const refresh = verify(field("refresh_token"), "refresh");
      if (!refresh || refresh.client !== field("client_id") || refresh.iat < (revokedBefore.get(refresh.sub) ?? 0)) {
        return c.json({ error: "invalid_grant" }, 400);
      }
      return c.json(issue(refresh.sub, refresh.client, refresh.scope, field("refresh_token")));
    }
    return c.json({ error: "unsupported_grant_type" }, 400);
  });

  // The MCP server

  app.all("/mcp", async (c) => {
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
    const access = verify(token, "access");
    const account = access && ACCOUNTS.find((item) => item.id === access.sub);
    if (!access || !account || access.iat < (revokedBefore.get(access.sub) ?? 0)) {
      c.header("WWW-Authenticate", `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="read write"`);
      return c.json({ error: "invalid_token" }, 401);
    }
    if (c.req.method !== "POST") return c.json({ error: "method_not_allowed" }, 405);

    const server = new Server({ name: options.name, version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: options.tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: { type: "object" as const, properties: tool.properties ?? {}, required: tool.required ?? [] },
        ...(options.annotate === false ? {} : { annotations: { readOnlyHint: tool.readOnly } }),
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, (request) => {
      const tool = options.tools.find((item) => item.name === request.params.name);
      if (!tool) return { isError: true, content: [{ type: "text", text: "Unknown tool" }] };
      calls.push(`${tool.name} ${account.email}`);
      const result = tool.run(request.params.arguments ?? {}, account);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    });

    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });

  return { app, calls, revokeAccount: (accountId) => revokedBefore.set(accountId, now() + 1) };
}
