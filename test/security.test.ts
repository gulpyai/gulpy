import { beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { safeNext } from "../src/auth.ts";
import { deriveKey, open, seal } from "../src/crypto.ts";
import { parseOrigin } from "../src/link.ts";
import { buildMimeMessage } from "../src/providers/mime.ts";
import type { TokenClient } from "../src/vault.ts";
import {
  ACME,
  ALICE,
  allow,
  GULPY,
  connectFirstTime,
  createWorld,
  exchange,
  field,
  startLink,
  type Browser,
  type TestApp,
  type World,
} from "./harness.ts";

const EMAIL = "skyler@example.com";

let world: World;
let browser: Browser;
let inboxPilot: TestApp;
let calBuddy: TestApp;

beforeEach(async () => {
  world = await createWorld();
  browser = world.browser();
  inboxPilot = world.registerApp("Inbox Pilot", "https://inboxpilot.test");
  calBuddy = world.registerApp("Cal Buddy", "https://calbuddy.test");
});

/** Goes through Link up to the public token. */
async function publicTokenFor(app: TestApp): Promise<string> {
  const link = await startLink(world, app, ["email.read"]);
  await browser.signIn(world, EMAIL);
  const acme = await browser.open(`${GULPY}/link/connect/demo?token=${link.token}`);
  return (await allow(browser, await browser.approveAtAcme(acme, ALICE))).publicToken;
}

describe("tokens at rest", () => {
  test("the database does not contain a provider token in plain text", async () => {
    await connectFirstTime(world, browser, inboxPilot, { email: EMAIL, capabilities: ["email.read"] });
    const rows = world.gulpy.deps.store.db.query("SELECT * FROM connections").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    const row = rows[0] ?? {};
    expect(String(row.access_token_enc)).toStartWith("u1.v1.");
    expect(String(row.refresh_token_enc)).toStartWith("u1.v1.");
    // An Acme Mail token looks like "acme.<payload>.<signature>".
    expect(JSON.stringify(row)).not.toMatch(/acme\.[A-Za-z0-9_-]{20,}\./);
  });

  test("the database does not contain an app secret, an access token, or a session id in plain text", async () => {
    const token = await connectFirstTime(world, browser, inboxPilot, { email: EMAIL, capabilities: ["email.read"] });
    const { db } = world.gulpy.deps.store;
    const dump = JSON.stringify(
      ["apps", "access_tokens", "public_tokens", "link_sessions", "sessions", "otps", "oauth_states"].map((table) =>
        db.query(`SELECT * FROM ${table}`).all(),
      ),
    );
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(inboxPilot.secret);
    expect(dump).not.toMatch(/"(access|public|link|sess|secret)_[A-Za-z0-9_-]{30,}"/);
  });

  test("a sealed value does not open in a different row or with a different key", () => {
    const key = randomBytes(32);
    const sealed = seal(key, "refresh-token-value", "conn_1:refresh");
    expect(open(key, sealed, "conn_1:refresh")).toBe("refresh-token-value");
    expect(() => open(key, sealed, "conn_2:refresh")).toThrow();
    expect(() => open(randomBytes(32), sealed, "conn_1:refresh")).toThrow();
    expect(seal(key, "refresh-token-value", "conn_1:refresh")).not.toBe(sealed);
  });
});

describe("the vault of each user", () => {
  /** The vault does not call the provider for a token that did not expire. */
  const noCalls: TokenClient = {
    id: "demo",
    name: "Acme Mail",
    refresh: () => Promise.reject(new Error("The vault called the provider")),
  };
  const stored = () => {
    const { store } = world.gulpy.deps;
    const row = store.db.query("SELECT id FROM connections").get() as { id: string };
    const connection = store.connectionById(row.id);
    if (!connection) throw new Error("No connection");
    return connection;
  };

  test("the token of one user does not open with the key of a different user", async () => {
    await connectFirstTime(world, browser, inboxPilot, { email: EMAIL, capabilities: ["email.read"] });
    const { store } = world.gulpy.deps;
    const mine = stored();
    expect(await world.gulpy.vault.accessToken(mine, noCalls)).toStartWith("acme.");

    // The row moves to a different user, as a fault in the code or in the database can do.
    const other = store.createUser("usr_other", "other@example.com", 0);
    store.db.query("UPDATE connections SET user_id = ? WHERE id = ?").run(other.id, mine.id);
    expect(stored().userId).toBe(other.id);
    expect(world.gulpy.vault.accessToken(stored(), noCalls)).rejects.toThrow();
  });

  test("a token from before the user keys opens, and the next refresh seals it with the key of the user", async () => {
    await connectFirstTime(world, browser, inboxPilot, { email: EMAIL, capabilities: ["email.read"] });
    const { store, config } = world.gulpy.deps;
    const mine = stored();
    const token = await world.gulpy.vault.accessToken(mine, noCalls);

    const before = deriveKey(config.masterKey, "connecty/vault/v1");
    store.db.query("UPDATE connections SET access_token_enc = ? WHERE id = ?").run(seal(before, token, `${mine.id}:access`), mine.id);
    expect(stored().accessTokenEnc).toStartWith("v1.");
    expect(await world.gulpy.vault.accessToken(stored(), noCalls)).toBe(token);

    const renew: TokenClient = { ...noCalls, refresh: async () => ({ ok: true, token: { access_token: "acme.new-token" } }) };
    expect(await world.gulpy.vault.accessToken(stored(), renew, true)).toBe("acme.new-token");
    expect(stored().accessTokenEnc).toStartWith("u1.v1.");
  });
});

describe("app credentials", () => {
  test("a wrong secret gets no link token", async () => {
    for (const body of [
      { client_id: inboxPilot.clientId, secret: "secret_wrong", capabilities: ["email.read"] },
      { client_id: "cid_unknown", secret: inboxPilot.secret, capabilities: ["email.read"] },
      { capabilities: ["email.read"] },
    ]) {
      const reply = await world.api("/link/token/create", { body });
      expect(reply.status).toBe(401);
      expect(reply.body.error.code).toBe("invalid_client");
    }
  });

  test("a link token is only for a registered origin and known capabilities", async () => {
    const credentials = { client_id: inboxPilot.clientId, secret: inboxPilot.secret };
    const origin = await world.api("/link/token/create", {
      body: { ...credentials, capabilities: ["email.read"], origin: "https://evil.test" },
    });
    expect(origin.status).toBe(400);
    expect(origin.body.error.code).toBe("invalid_origin");

    for (const capabilities of [[], ["email.read", "everything"], "email.read", undefined]) {
      const reply = await world.api("/link/token/create", { body: { ...credentials, capabilities } });
      expect(reply.status).toBe(400);
    }
  });

  test("a public token works one time, and only for the app that started Link", async () => {
    const publicToken = await publicTokenFor(inboxPilot);

    const thief = await world.api("/link/public_token/exchange", {
      body: { client_id: calBuddy.clientId, secret: calBuddy.secret, public_token: publicToken },
    });
    expect(thief.status).toBe(400);

    await exchange(world, inboxPilot, publicToken);
    const again = await world.api("/link/public_token/exchange", {
      body: { client_id: inboxPilot.clientId, secret: inboxPilot.secret, public_token: publicToken },
    });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("invalid_public_token");
  });

  test("a public token stops working after 10 minutes", async () => {
    const publicToken = await publicTokenFor(inboxPilot);
    world.advance(11 * 60_000);
    const reply = await world.api("/link/public_token/exchange", {
      body: { client_id: inboxPilot.clientId, secret: inboxPilot.secret, public_token: publicToken },
    });
    expect(reply.status).toBe(400);
  });

  test("a link token stops working after 30 minutes, and completes one time", async () => {
    const expired = await startLink(world, inboxPilot, ["email.read"]);
    world.advance(31 * 60_000);
    expect((await browser.open(expired.url)).status).toBe(404);

    const link = await startLink(world, inboxPilot, ["email.read"]);
    await browser.signIn(world, EMAIL);
    const acme = await browser.open(`${GULPY}/link/connect/demo?token=${link.token}`);
    const consent = await browser.approveAtAcme(acme, ALICE);
    await allow(browser, consent);
    await expect(allow(browser, consent)).rejects.toThrow();
  });

  test("a key or an access token is necessary for the API", async () => {
    for (const token of [undefined, "access_wrong", "gulpy_wrong", ""]) {
      expect((await world.api("/connections", { token })).status).toBe(401);
      expect((await world.api("/email/messages", { token })).status).toBe(401);
      expect((await world.api("/tools", { token })).status).toBe(401);
    }
  });
});

describe("requests from other sites", () => {
  test("a form on a different site cannot approve access", async () => {
    await connectFirstTime(world, browser, inboxPilot, { email: EMAIL, capabilities: ["email.read"] });
    const link = await startLink(world, calBuddy, ["email.read"]);
    const consent = await browser.open(link.url);
    const form = { csrf: field(consent.html, "csrf"), token: link.token, connection: "x" };

    const crossSite = await browser.open(`${GULPY}/link/approve`, { form, from: "https://evil.test/page" });
    expect(crossSite.status).toBe(403);

    const badCsrf = await browser.open(`${GULPY}/link/approve`, {
      form: { ...form, csrf: "csrf_guess" },
      from: consent.url,
    });
    expect(badCsrf.status).toBe(403);

    const status = await world.fetch(`${GULPY}/link/status?token=${link.token}`);
    expect(await status.json()).toEqual({ status: "open" });
  });

  test("the cross-site check reads the headers as real browsers send them", async () => {
    const post = (headers: Record<string, string>) =>
      world.fetch(`${GULPY}/auth/start`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: "email=skyler%40example.com&next=%2F",
      });
    const cases: [Record<string, string>, number][] = [
      [{ "sec-fetch-site": "same-origin", origin: GULPY }, 200],
      // Chrome sends "Origin: null" if the page has a strict referrer policy.
      [{ "sec-fetch-site": "same-origin", origin: "null" }, 200],
      [{ "sec-fetch-site": "cross-site", origin: "https://evil.test" }, 403],
      [{ "sec-fetch-site": "same-site", origin: "https://evil.gulpy.test" }, 403],
      // A script cannot set Sec-Fetch-Site, so a false Origin does not help the attacker.
      [{ "sec-fetch-site": "cross-site", origin: GULPY }, 403],
      // A browser from before 2023 sends only Origin.
      [{ origin: GULPY }, 200],
      [{ origin: "https://evil.test" }, 403],
      [{ origin: "null" }, 403],
    ];
    for (const [headers, status] of cases) {
      expect([JSON.stringify(headers), (await post(headers)).status]).toEqual([JSON.stringify(headers), status]);
    }
  });

  test("the user cannot approve an account of a different user", async () => {
    await connectFirstTime(world, browser, inboxPilot, { email: EMAIL, capabilities: ["email.read"] });
    const victim = world.gulpy.deps.store.db.query("SELECT id FROM connections").get() as { id: string };

    const attacker = world.browser();
    const link = await startLink(world, calBuddy, ["email.read"]);
    const consent = await attacker.signIn(world, "attacker@example.com", link.url.slice(GULPY.length));
    expect(consent.html).not.toContain("alice@acme.test");
    await expect(allow(attacker, consent, [victim.id])).rejects.toThrow();
    expect(world.gulpy.deps.store.grantsByUser(victim.id)).toEqual([]);
  });

  test("a sign-in code works only in the browser that asked for it", async () => {
    const attacker = world.browser();
    const start = await attacker.open(`${GULPY}/auth/start`, { form: { email: "attacker@example.com", next: "/" } });
    const form = {
      email: "attacker@example.com",
      next: "/",
      otp_id: field(start.html, "otp_id"),
      code: world.mailer.peek("attacker@example.com") ?? "",
    };

    // The attacker makes the browser of the victim send the code of the attacker.
    const victim = world.browser();
    const forced = await victim.open(`${GULPY}/auth/verify`, { form });
    expect(forced.status).toBe(400);
    expect(victim.hasCookie(GULPY, "gulpy_session")).toBe(false);

    const own = await attacker.open(`${GULPY}/auth/verify`, { form });
    expect(own.status).toBe(200);
    expect(attacker.hasCookie(GULPY, "gulpy_session")).toBe(true);
  });

  test("an OAuth callback works only in the session that started it", async () => {
    const link = await startLink(world, inboxPilot, ["email.read"]);
    await browser.signIn(world, EMAIL);
    const acme = await browser.open(`${GULPY}/link/connect/demo?token=${link.token}`);

    // The attacker completes the provider step and gets a callback address with a code for the attacker's account.
    let callback = "";
    const spy = world.browser();
    const original = spy.open.bind(spy);
    spy.open = async (target, options) => {
      if (target.startsWith(`${GULPY}/oauth/callback`)) callback = target;
      return original(target, options);
    };
    const form: Record<string, string> = { account: ALICE };
    for (const name of ["client_id", "redirect_uri", "response_type", "scope", "state", "code_challenge", "code_challenge_method"]) {
      form[name] = field(acme.html, name);
    }
    const response = await world.fetch(`${ACME}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      redirect: "manual",
    });
    callback = response.headers.get("location") ?? "";
    expect(callback).toStartWith(`${GULPY}/oauth/callback/demo?code=`);

    // A different signed-in user opens that address. Gulpy refuses it.
    const other = world.browser();
    await other.signIn(world, "other@example.com");
    const refused = await other.open(callback);
    expect(refused.status).toBe(400);
    expect(world.gulpy.deps.store.db.query("SELECT COUNT(*) AS n FROM connections").get()).toEqual({ n: 0 });

    // The state is used. The correct user cannot use the address a second time.
    const replay = await browser.open(callback);
    expect(replay.status).toBe(400);
  });
});

describe("sign-in codes", () => {
  test("five wrong codes cancel the code", async () => {
    const start = await browser.open(`${GULPY}/auth/start`, { form: { email: EMAIL, next: "/" } });
    const otpId = field(start.html, "otp_id");
    const correct = world.mailer.peek(EMAIL) ?? "";
    const wrong = correct === "000000" ? "000001" : "000000";
    for (let attempt = 0; attempt < 5; attempt++) {
      const page = await browser.open(`${GULPY}/auth/verify`, {
        form: { email: EMAIL, next: "/", otp_id: otpId, code: wrong },
      });
      expect(page.status).toBe(400);
    }
    const late = await browser.open(`${GULPY}/auth/verify`, {
      form: { email: EMAIL, next: "/", otp_id: otpId, code: correct },
    });
    expect(late.status).toBe(400);
    expect(browser.hasCookie(GULPY, "gulpy_session")).toBe(false);
  });

  test("a code works one time and stops working after 10 minutes", async () => {
    const start = await browser.open(`${GULPY}/auth/start`, { form: { email: EMAIL, next: "/" } });
    const form = { email: EMAIL, next: "/", otp_id: field(start.html, "otp_id"), code: world.mailer.peek(EMAIL) ?? "" };
    world.advance(11 * 60_000);
    expect((await browser.open(`${GULPY}/auth/verify`, { form })).status).toBe(400);
  });

  test("one address gets five codes in 10 minutes at most", async () => {
    for (let count = 0; count < 5; count++) {
      const page = await browser.open(`${GULPY}/auth/start`, { form: { email: EMAIL, next: "/" } });
      expect(page.status).toBe(200);
    }
    const blocked = await browser.open(`${GULPY}/auth/start`, { form: { email: EMAIL, next: "/" } });
    expect(blocked.status).toBe(400);
    expect(blocked.html).toContain("Too many codes");
  });

  test("the page shows the code on the computer of the developer only, and never in production", async () => {
    // The test world has a public address. A person could type the email address of a different person.
    const publicAddress = await browser.open(`${GULPY}/auth/start`, { form: { email: EMAIL, next: "/" } });
    expect(publicAddress.html).not.toContain("No mail goes out on this computer");
    expect(publicAddress.html).not.toContain(world.mailer.peek(EMAIL) ?? "no-code");

    const config = world.gulpy.deps.config;
    config.baseUrl = "http://localhost:4000";
    const local = await browser.open(`${GULPY}/auth/start`, { form: { email: EMAIL, next: "/" } });
    expect(local.html).toContain("No mail goes out on this computer");

    config.env = "production";
    const production = await browser.open(`${GULPY}/auth/start`, { form: { email: EMAIL, next: "/" } });
    expect(production.html).not.toContain("No mail goes out on this computer");
    expect(production.html).not.toContain(world.mailer.peek(EMAIL) ?? "no-code");
  });
});

describe("input checks", () => {
  test("after sign-in the user goes only to a path on Gulpy", () => {
    expect(safeNext("/link?token=abc")).toBe("/link?token=abc");
    for (const value of ["//evil.test", "https://evil.test", "/\\evil.test", "javascript:alert(1)", "", undefined, "/a\nb"]) {
      expect(safeNext(value)).toBe("/");
    }
  });

  test("an origin has a scheme and a host, and no path", () => {
    expect(parseOrigin("https://app.example.com")).toBe("https://app.example.com");
    expect(parseOrigin("http://localhost:4100/")).toBe("http://localhost:4100");
    for (const value of ["https://app.example.com/path", "app.example.com", "javascript:alert(1)", "*", ""]) {
      expect(parseOrigin(value)).toBeNull();
    }
  });

  test("an email cannot add a header", () => {
    const message = { to: ["dana@lakeshore.example"], subject: "Hello", body_text: "Text" };
    expect(buildMimeMessage(message)).toContain("To: dana@lakeshore.example\r\nSubject: Hello\r\n");
    expect(() => buildMimeMessage({ ...message, subject: "Hi\r\nBcc: spy@evil.test" })).toThrow();
    expect(() => buildMimeMessage({ ...message, to: ["dana@lakeshore.example\r\nBcc: spy@evil.test"] })).toThrow();
    expect(() => buildMimeMessage({ ...message, to: [] })).toThrow();
    expect(buildMimeMessage({ ...message, subject: "Café ☕" })).toContain("Subject: =?UTF-8?B?");
  });

  test("bad input gets a clear error, not a crash", async () => {
    const token = await connectFirstTime(world, browser, inboxPilot, {
      email: EMAIL,
      capabilities: ["email.read", "email.send", "calendar.read", "calendar.write"],
    });
    const cases: [string, unknown][] = [
      ["/email/messages", { to: ["not-an-address"], subject: "Hi", body_text: "Text" }],
      ["/email/messages", { to: [], subject: "Hi", body_text: "Text" }],
      ["/email/messages", { to: ["dana@lakeshore.example"], subject: "Hi" }],
      ["/calendar/events", { title: "Focus", start: "tomorrow", end: "2026-09-28T16:00:00Z" }],
      ["/calendar/events", { title: "Focus", start: "2026-09-28T16:00:00Z", end: "2026-09-28T15:00:00Z" }],
      ["/calendar/events", { start: "2026-09-28T15:00:00Z", end: "2026-09-28T16:00:00Z" }],
    ];
    for (const [path, body] of cases) {
      const reply = await world.api(path, { token, body });
      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe("invalid_request");
    }
    const notJson = await world.fetch(`${GULPY}/v1/email/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "{broken",
    });
    expect(notJson.status).toBe(400);

    expect((await world.api("/calendar/events?from=yesterday", { token })).status).toBe(400);
    expect((await world.api("/email/messages/msg-unknown", { token })).status).toBe(404);
    expect((await world.api("/nothing", { token })).status).toBe(404);
  });

  test("pages forbid frames and do not send the link token in the Referer header", async () => {
    const link = await startLink(world, inboxPilot, ["email.read"]);
    const response = await world.fetch(link.url);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toMatch(/<script(?![^>]*\bsrc=)/);
  });
});

describe("old address", () => {
  test("a request on an old host name goes to the real address, with the method kept", async () => {
    const response = await world.gulpy.app.fetch(
      new Request("https://old.gulpy.test/v1/tools?x=1", { method: "POST", headers: { host: "old.gulpy.test" } }),
    );
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`${GULPY}/v1/tools?x=1`);
    const normal = await world.gulpy.app.fetch(new Request(`${GULPY}/health`, { headers: { host: "gulpy.test" } }));
    expect(normal.status).toBe(200);
  });
});

describe("moving a connection to another account", () => {
  test("a plain change of owner makes the tokens unreadable; moveConnection seals them again", async () => {
    const { addConnector } = await import("./harness.ts");
    const { Vault } = await import("../src/vault.ts");
    const { backendOf, tokensFor } = await import("../src/access.ts");
    const { deps } = world.gulpy;
    await browser.signIn(world, EMAIL);
    await addConnector(browser, "acme-notes");
    const [connection] = deps.store.db.query("SELECT id FROM connections").all() as { id: string }[];
    const before = deps.store.connectionById(connection?.id ?? "");
    if (!before) throw new Error("no connection");
    const client = tokensFor(deps, backendOf(deps, before)!);
    const token = await new Vault(deps).accessToken(before, client);
    const other = deps.store.createUser("usr_other", "other@example.com", deps.now());

    // The mistake of 2026-09-30: only the owner changes, the tokens keep the key of the first owner.
    deps.store.db.query("UPDATE connections SET user_id = ? WHERE id = ?").run(other.id, before.id);
    const broken = deps.store.connectionById(before.id)!;
    await expect(new Vault(deps).accessToken(broken, client)).rejects.toThrow();

    // The fix: move it back, then move it with the vault.
    deps.store.db.query("UPDATE connections SET user_id = ? WHERE id = ?").run(before.userId, before.id);
    new Vault(deps).moveConnection(before, other.id);
    const moved = deps.store.connectionById(before.id)!;
    expect(moved.userId).toBe(other.id);
    expect(await new Vault(deps).accessToken(moved, client)).toBe(token);
  });
});
