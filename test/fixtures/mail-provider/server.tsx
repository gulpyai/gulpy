/**
 * Acme Mail: a small OAuth 2.0 provider with fake mail and calendar data.
 * It lets the full Gulpy flow run with no real credentials.
 * Do not use it as a model for a production OAuth server.
 */
import { Hono, type Context } from "hono";
import type { FC } from "hono/jsx";
import { hmac, pkceChallenge, randomId, safeEqual } from "../../../src/crypto.ts";
import { ACCOUNTS, MockData, type Account } from "./data.ts";

export const MOCK_SCOPES: Record<string, string> = {
  profile: "See your name and email address",
  "mail.read": "Read your mail",
  "mail.send": "Send mail as you",
  "calendar.read": "See your calendar",
  "calendar.write": "Create and change events",
};

export interface MockProviderOptions {
  /** Signs the codes and tokens. Tokens stay valid across a restart if the key stays the same. */
  signingKey: Buffer;
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  /** Life of an access token in seconds. Tests use a small value to exercise the refresh. */
  accessTtlSeconds?: number;
  now?: () => number;
}

export interface MockProvider {
  app: Hono;
  data: MockData;
  /** Cancels all refresh tokens of the account, as if the user removed the app at the provider. */
  revokeAccount(accountId: string): void;
}

type Claims =
  | { kind: "code"; sub: string; scopes: string[]; challenge: string; redirectUri: string; exp: number; jti: string }
  | { kind: "access"; sub: string; scopes: string[]; exp: number }
  | { kind: "refresh"; sub: string; scopes: string[]; iat: number; jti: string };

const STYLE = `
body{margin:0;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:#f5f1fb;color:#1c1530;display:grid;place-items:center;min-height:100vh;padding:20px;box-sizing:border-box}
main{width:100%;max-width:400px;background:#fff;border:1px solid #e3dcf2;border-radius:18px;padding:28px;display:grid;gap:18px;box-sizing:border-box}
h1{margin:0;font-size:20px}
p{margin:0;color:#5d5674}
.logo{width:44px;height:44px;border-radius:12px;background:#6d3fd1;color:#fff;display:grid;place-items:center;font-weight:700;font-size:20px}
ul{margin:0;padding:0;list-style:none;display:grid;gap:6px}
li{padding:8px 12px;border-radius:9px;background:#f5f1fb;font-size:14px}
.accounts{display:grid;gap:8px}
button{font:inherit;cursor:pointer;border-radius:10px;min-height:46px;padding:0 14px;border:1px solid #d5cbea;background:#fff;text-align:left}
button.account{display:grid}
button.account span{font-size:13px;color:#5d5674}
button.account:hover{border-color:#6d3fd1}
button.deny{text-align:center;border-color:transparent;color:#5d5674;background:transparent}
.tag{font-size:12px;color:#6d3fd1;font-weight:600}
`;

const AuthorizePage: FC<{ params: Record<string, string>; scopes: string[]; hint?: string }> = ({
  params,
  scopes,
  hint,
}) => {
  const accounts = hint ? ACCOUNTS.filter((account) => account.email === hint) : ACCOUNTS;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Sign in · Acme Mail</title>
        <link rel="stylesheet" href="/style.css" />
      </head>
      <body>
        <main>
          <div class="logo">A</div>
          <div>
            <h1>Gulpy wants access to your Acme Mail account</h1>
            <p class="tag">Demo provider. The data is fake.</p>
          </div>
          <ul>
            {scopes.map((scope) => (
              <li>{MOCK_SCOPES[scope]}</li>
            ))}
          </ul>
          <form method="post" action="/oauth/authorize" class="accounts">
            {Object.entries(params).map(([name, value]) => (
              <input type="hidden" name={name} value={value} />
            ))}
            <p>Choose an account to continue</p>
            {(accounts.length ? accounts : ACCOUNTS).map((account) => (
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
};

export function createMockProvider(options: MockProviderOptions): MockProvider {
  const now = options.now ?? Date.now;
  const accessTtl = options.accessTtlSeconds ?? 3600;
  const data = new MockData(now());
  const usedCodes = new Set<string>();
  const revokedTokens = new Set<string>();
  /** Refresh tokens that were made before this time do not work. */
  const revokedBefore = new Map<string, number>();

  const sign = (claims: Claims): string => {
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `acme.${body}.${hmac(options.signingKey, body)}`;
  };

  const verify = <K extends Claims["kind"]>(token: string | undefined, kind: K): Extract<Claims, { kind: K }> | null => {
    const [prefix, body, signature] = (token ?? "").split(".");
    if (prefix !== "acme" || !body || !signature || !safeEqual(signature, hmac(options.signingKey, body))) return null;
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Claims;
    if (claims.kind !== kind) return null;
    if ("exp" in claims && claims.exp <= now()) return null;
    return claims as Extract<Claims, { kind: K }>;
  };

  const issue = (sub: string, scopes: string[], refreshToken?: string) => ({
    token_type: "Bearer",
    access_token: sign({ kind: "access", sub, scopes, exp: now() + accessTtl * 1000 }),
    refresh_token: refreshToken ?? sign({ kind: "refresh", sub, scopes, iat: now(), jti: randomId("rt") }),
    expires_in: accessTtl,
    scope: scopes.join(" "),
  });

  const app = new Hono();

  app.get("/style.css", (c) => {
    c.header("Content-Type", "text/css; charset=utf-8");
    return c.body(STYLE);
  });

  // Authorization endpoint

  const authorizeParams = (source: Record<string, unknown>) => {
    const read = (name: string) => (typeof source[name] === "string" ? (source[name] as string) : "");
    const params = {
      client_id: read("client_id"),
      redirect_uri: read("redirect_uri"),
      response_type: read("response_type"),
      scope: read("scope"),
      state: read("state"),
      code_challenge: read("code_challenge"),
      code_challenge_method: read("code_challenge_method"),
    };
    const scopes = params.scope.split(/\s+/).filter(Boolean);
    // Do not redirect to an address that is not registered.
    const trusted = params.client_id === options.clientId && options.redirectUris.includes(params.redirect_uri);
    const valid =
      params.response_type === "code" &&
      params.code_challenge_method === "S256" &&
      params.code_challenge.length > 0 &&
      scopes.length > 0 &&
      scopes.every((scope) => scope in MOCK_SCOPES);
    return { params, scopes, trusted, valid, hint: read("login_hint") };
  };

  const redirectBack = (c: Context, redirectUri: string, values: Record<string, string>) => {
    const url = new URL(redirectUri);
    for (const [name, value] of Object.entries(values)) if (value) url.searchParams.set(name, value);
    return c.redirect(url.toString(), 303);
  };

  app.get("/oauth/authorize", (c) => {
    const request = authorizeParams(c.req.query());
    if (!request.trusted) return c.text("Acme Mail does not know this app or this redirect address", 400);
    if (!request.valid) {
      return redirectBack(c, request.params.redirect_uri, { error: "invalid_request", state: request.params.state });
    }
    return c.html(
      `<!DOCTYPE html>${String(<AuthorizePage params={request.params} scopes={request.scopes} hint={request.hint} />)}`,
    );
  });

  app.post("/oauth/authorize", async (c) => {
    const form = await c.req.parseBody();
    const request = authorizeParams(form);
    if (!request.trusted) return c.text("Acme Mail does not know this app or this redirect address", 400);
    const { params, scopes } = request;
    const account = ACCOUNTS.find((item) => item.id === form.account);
    if (!request.valid || !account) {
      return redirectBack(c, params.redirect_uri, { error: "access_denied", state: params.state });
    }
    const code = sign({
      kind: "code",
      sub: account.id,
      scopes,
      challenge: params.code_challenge,
      redirectUri: params.redirect_uri,
      exp: now() + 60_000,
      jti: randomId("code"),
    });
    return redirectBack(c, params.redirect_uri, { code, state: params.state });
  });

  // Token endpoint

  app.post("/oauth/token", async (c) => {
    const form = await c.req.parseBody();
    const field = (name: string) => (typeof form[name] === "string" ? (form[name] as string) : "");
    if (field("client_id") !== options.clientId || !safeEqual(field("client_secret"), options.clientSecret)) {
      return c.json({ error: "invalid_client" }, 401);
    }

    if (field("grant_type") === "authorization_code") {
      const code = verify(field("code"), "code");
      if (
        !code ||
        usedCodes.has(code.jti) ||
        code.redirectUri !== field("redirect_uri") ||
        code.challenge !== pkceChallenge(field("code_verifier"))
      ) {
        return c.json({ error: "invalid_grant" }, 400);
      }
      usedCodes.add(code.jti);
      return c.json(issue(code.sub, code.scopes));
    }

    if (field("grant_type") === "refresh_token") {
      const refresh = verify(field("refresh_token"), "refresh");
      if (!refresh || revokedTokens.has(refresh.jti) || refresh.iat < (revokedBefore.get(refresh.sub) ?? 0)) {
        return c.json({ error: "invalid_grant" }, 400);
      }
      return c.json(issue(refresh.sub, refresh.scopes, field("refresh_token")));
    }

    return c.json({ error: "unsupported_grant_type" }, 400);
  });

  app.post("/oauth/revoke", async (c) => {
    const form = await c.req.parseBody();
    const refresh = verify(typeof form.token === "string" ? form.token : "", "refresh");
    if (refresh) revokedTokens.add(refresh.jti);
    return c.body(null, 200);
  });

  // API

  const authorize = (c: Context, scope: string): Account | Response => {
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
    const access = verify(token, "access");
    const account = access && ACCOUNTS.find((item) => item.id === access.sub);
    if (!access || !account || access.exp - accessTtl * 1000 < (revokedBefore.get(access.sub) ?? 0)) {
      return c.json({ error: "invalid_token" }, 401);
    }
    if (!access.scopes.includes(scope)) return c.json({ error: "insufficient_scope", scope }, 403);
    return account;
  };

  const limitOf = (c: Context) => Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 50);

  app.get("/api/me", (c) => {
    const account = authorize(c, "profile");
    return account instanceof Response ? account : c.json(account);
  });

  app.get("/api/messages", (c) => {
    const account = authorize(c, "mail.read");
    if (account instanceof Response) return account;
    const messages = data.listMessages(account.id, c.req.query("q"), limitOf(c));
    return c.json({ messages: messages.map(({ body_text: _body, ...summary }) => summary) });
  });

  app.get("/api/messages/:id", (c) => {
    const account = authorize(c, "mail.read");
    if (account instanceof Response) return account;
    const message = data.message(account.id, c.req.param("id"));
    return message ? c.json(message) : c.json({ error: "not_found" }, 404);
  });

  app.post("/api/messages", async (c) => {
    const account = authorize(c, "mail.send");
    if (account instanceof Response) return account;
    const body = (await c.req.json().catch(() => null)) as { to?: unknown; subject?: unknown; body_text?: unknown } | null;
    const to = Array.isArray(body?.to) ? body.to.map(String) : [];
    if (to.length === 0 || typeof body?.body_text !== "string") return c.json({ error: "invalid_request" }, 400);
    const sent = data.send(account, { to, subject: String(body.subject ?? ""), body_text: body.body_text }, now());
    return c.json({ id: sent.id }, 201);
  });

  const canReadCalendar = (c: Context): Account | Response => {
    const read = authorize(c, "calendar.read");
    return read instanceof Response && read.status === 403 ? authorize(c, "calendar.write") : read;
  };

  app.get("/api/events", (c) => {
    const account = canReadCalendar(c);
    if (account instanceof Response) return account;
    const from = Date.parse(c.req.query("from") ?? "") || now();
    const to = Date.parse(c.req.query("to") ?? "") || from + 7 * 24 * 60 * 60_000;
    return c.json({ events: data.listEvents(account.id, from, to, limitOf(c)) });
  });

  app.post("/api/events", async (c) => {
    const account = authorize(c, "calendar.write");
    if (account instanceof Response) return account;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (typeof body?.title !== "string" || typeof body.start !== "string" || typeof body.end !== "string") {
      return c.json({ error: "invalid_request" }, 400);
    }
    const event = data.createEvent(account.id, {
      title: body.title,
      start: body.start,
      end: body.end,
      location: typeof body.location === "string" ? body.location : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      attendees: Array.isArray(body.attendees) ? body.attendees.map(String) : undefined,
    });
    return c.json(event, 201);
  });

  return {
    app,
    data,
    revokeAccount: (accountId) => revokedBefore.set(accountId, now() + 1),
  };
}
