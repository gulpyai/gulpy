import { beforeEach, describe, expect, test } from "bun:test";
import {
  ACME,
  ALICE,
  allow,
  BOB,
  checked,
  GULPY,
  connectFirstTime,
  createWorld,
  dataAttribute,
  exchange,
  field,
  links,
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

const hits = (needle: string) => world.requests.filter((request) => request === needle).length;

describe("first connection", () => {
  test("a new user signs in, connects an account, and the app reads data", async () => {
    const link = await startLink(world, inboxPilot, ["email.read", "calendar.read"]);

    const signIn = await browser.open(link.url);
    expect(signIn.html).toContain("Inbox Pilot uses Gulpy");

    const consent = await browser.signIn(world, EMAIL, link.url.slice(GULPY.length));
    expect(consent.html).toContain("Inbox Pilot wants access");
    expect(consent.html).toContain("Connect an account");
    expect(consent.html).toContain("Add Acme Mail");

    const acme = await browser.open(`${GULPY}${links(consent.html).find((href) => href.includes("/link/connect/demo"))}`);
    expect(acme.url).toStartWith(`${ACME}/oauth/authorize`);
    // Gulpy asks the provider only for what the app needs.
    expect(new URL(acme.url).searchParams.get("scope")).toBe("profile mail.read calendar.read");

    const back = await browser.approveAtAcme(acme, ALICE);
    expect(back.url).toContain("connected=conn_");
    expect(back.html).toContain("alice@acme.test");
    expect(checked(back.html)).toHaveLength(1);

    const { page, publicToken } = await allow(browser, back);
    expect(page.html).toContain("Connected");
    expect(dataAttribute(page.html, "origin")).toBe(inboxPilot.origin);

    const reply = await world.api("/link/public_token/exchange", {
      body: { client_id: inboxPilot.clientId, secret: inboxPilot.secret, public_token: publicToken },
    });
    expect(reply.status).toBe(200);
    expect(reply.body.user_id).toStartWith("user_");
    expect(reply.body.connections).toEqual([
      {
        id: expect.stringMatching(/^conn_/),
        provider: "demo",
        provider_name: "Acme Mail",
        account: "alice@acme.test",
        capabilities: ["email.read", "calendar.read"],
        status: "active",
      },
    ]);

    const token = reply.body.access_token;
    const mail = await world.api("/email/messages?limit=3", { token });
    expect(mail.status).toBe(200);
    expect(mail.body.errors).toEqual([]);
    expect(mail.body.messages).toHaveLength(3);
    expect(mail.body.messages[0]).toMatchObject({
      subject: "Q4 planning: agenda for Thursday",
      account: "alice@acme.test",
      unread: true,
    });

    const one = await world.api(`/email/messages/${mail.body.messages[0].id}`, { token });
    expect(one.body.body_text).toContain("Hiring plan");

    const search = await world.api("/email/messages?q=flight", { token });
    expect(search.body.messages.map((message: { subject: string }) => message.subject)).toEqual([
      "Your flight to San Francisco is confirmed",
    ]);

    const events = await world.api("/calendar/events", { token });
    expect(events.body.events.map((event: { title: string }) => event.title)).toEqual([
      "Standup",
      "1:1 with Dana",
      "Q4 planning",
      "Flight to San Francisco",
    ]);
  });

  test("the page that opened Link can ask the server for the result", async () => {
    const link = await startLink(world, inboxPilot, ["email.read"]);
    const status = () =>
      world.fetch(`${GULPY}/link/status?token=${link.token}`, { headers: { origin: inboxPilot.origin } });

    const before = await status();
    expect(before.headers.get("access-control-allow-origin")).toBe(inboxPilot.origin);
    expect(await before.json()).toEqual({ status: "open" });

    await browser.signIn(world, EMAIL);
    const acme = await browser.open(`${GULPY}/link/connect/demo?token=${link.token}`);
    const { publicToken } = await allow(browser, await browser.approveAtAcme(acme, ALICE));

    const after = await (await status()).json();
    expect(after).toMatchObject({ status: "completed", public_token: publicToken });
    expect(after.accounts[0]).toMatchObject({ account: "alice@acme.test", capabilities: ["email.read"] });

    // A page on a different origin gets no permission to read the reply.
    const other = await world.fetch(`${GULPY}/link/status?token=${link.token}`, {
      headers: { origin: "https://evil.test" },
    });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("second app", () => {
  test("the user allows a new app with one tap and no provider sign-in", async () => {
    await connectFirstTime(world, browser, inboxPilot, {
      email: EMAIL,
      capabilities: ["email.read", "email.send", "calendar.read"],
    });
    const authorizeBefore = hits(`GET ${ACME}/oauth/authorize`);

    // Same browser, new app. The user is signed in to Gulpy already.
    const link = await startLink(world, calBuddy, ["calendar.read", "email.read"]);
    const consent = await browser.open(link.url);
    expect(consent.html).toContain("Cal Buddy wants access");
    expect(consent.html).toContain("alice@acme.test");
    expect(checked(consent.html)).toHaveLength(1);

    const { publicToken } = await allow(browser, consent);
    const token = await exchange(world, calBuddy, publicToken);

    expect(hits(`GET ${ACME}/oauth/authorize`)).toBe(authorizeBefore);
    const events = await world.api("/calendar/events", { token });
    expect(events.body.events).toHaveLength(4);
  });

  test("each app sees a different user id", async () => {
    await connectFirstTime(world, browser, inboxPilot, { email: EMAIL, capabilities: ["email.read"] });
    const first = await startLink(world, inboxPilot, ["email.read"]);
    const second = await startLink(world, calBuddy, ["email.read"]);
    const tokenA = await exchange(world, inboxPilot, (await allow(browser, await browser.open(first.url))).publicToken);
    const tokenB = await exchange(world, calBuddy, (await allow(browser, await browser.open(second.url))).publicToken);

    const a = await world.api("/connections", { token: tokenA });
    const b = await world.api("/connections", { token: tokenB });
    expect(a.body.user_id).not.toBe(b.body.user_id);
    expect(a.body.connections[0].id).toBe(b.body.connections[0].id);
  });
});

describe("permissions", () => {
  let token: string;
  let connection: string;

  beforeEach(async () => {
    token = await connectFirstTime(world, browser, calBuddy, {
      email: EMAIL,
      capabilities: ["calendar.read", "email.read"],
    });
    connection = (await world.api("/connections", { token })).body.connections[0].id;
  });

  test("the app cannot use a capability that the user did not give", async () => {
    const send = await world.api("/email/messages", {
      token,
      body: { to: ["dana@lakeshore.example"], subject: "Hi", body_text: "Hello" },
    });
    expect(send.status).toBe(403);
    expect(send.body.error.code).toBe("not_granted");

    const create = await world.api("/calendar/events", {
      token,
      body: { title: "Focus", start: "2026-09-28T15:00:00Z", end: "2026-09-28T16:00:00Z" },
    });
    expect(create.status).toBe(403);
  });

  test("the grant limits the app, not only the provider token", async () => {
    // Inbox Pilot makes the provider token wider: it adds mail.send.
    const link = await startLink(world, inboxPilot, ["email.read", "email.send"]);
    const consent = await browser.open(link.url);
    const upgrade = links(consent.html).find((href) => href.includes("connection=conn_"));
    expect(upgrade).toBeDefined();
    const back = await browser.approveAtAcme(await browser.open(`${GULPY}${upgrade}`), ALICE);
    const pilotToken = await exchange(world, inboxPilot, (await allow(browser, back)).publicToken);

    const allowed = await world.api("/email/messages", {
      token: pilotToken,
      body: { to: ["dana@lakeshore.example"], subject: "Friday", body_text: "Friday at 10:00 is OK." },
    });
    expect(allowed.status).toBe(201);

    // Cal Buddy uses the same connection, and did not get email.send.
    const blocked = await world.api("/email/messages", {
      token,
      body: { to: ["dana@lakeshore.example"], subject: "Hi", body_text: "Hello" },
    });
    expect(blocked.status).toBe(403);
    const proxied = await world.api(`/proxy/${connection}/api/api/messages`, {
      token,
      body: { to: ["dana@lakeshore.example"], subject: "Hi", body_text: "Hello" },
    });
    expect(proxied.status).toBe(403);
    expect(proxied.body.error.code).toBe("not_allowed");
  });

  test("the proxy passes a request that the grant allows", async () => {
    const reply = await world.api(`/proxy/${connection}/api/api/messages?limit=2`, { token });
    expect(reply.status).toBe(200);
    expect(reply.body.messages).toHaveLength(2);
  });

  test("the proxy is off for a provider unless the operator turns it on", async () => {
    const strict = await createWorld({ rawProxy: [] });
    const app = strict.registerApp("Cal Buddy", "https://calbuddy.test");
    const access = await connectFirstTime(strict, strict.browser(), app, { email: EMAIL, capabilities: ["email.read"] });
    const id = (await strict.api("/connections", { token: access })).body.connections[0].id;

    const reply = await strict.api(`/proxy/${id}/api/api/messages`, { token: access });
    expect(reply.status).toBe(403);
    expect(reply.body.error.code).toBe("proxy_disabled");
    // The unified endpoints continue to work.
    expect((await strict.api("/email/messages", { token: access })).status).toBe(200);
  });

  test("the proxy refuses a path outside the rules", async () => {
    for (const path of ["/api/me", "/oauth/token", "/api/messages/../me", "/api/messages/%2e%2e/me", "/api//messages"]) {
      const reply = await world.api(`/proxy/${connection}/api${path}`, { token });
      expect([400, 403, 404]).toContain(reply.status);
      expect(reply.body.messages).toBeUndefined();
      expect(reply.body.email).toBeUndefined();
    }
    const service = await world.api(`/proxy/${connection}/constructor/api/messages`, { token });
    expect(service.status).toBe(404);
  });

  test("an app asks for more at a later time, and the user adds the permission", async () => {
    const link = await startLink(world, calBuddy, ["calendar.read", "email.read", "calendar.write"]);
    const consent = await browser.open(link.url);
    expect(consent.html).toContain("Add permission");

    const upgrade = links(consent.html).find((href) => href.includes("connection=conn_"));
    const acme = await browser.open(`${GULPY}${upgrade}`);
    const url = new URL(acme.url);
    expect(url.searchParams.get("scope")).toBe("profile mail.read calendar.read calendar.write");
    expect(url.searchParams.get("login_hint")).toBe("alice@acme.test");

    const { publicToken } = await allow(browser, await browser.approveAtAcme(acme, ALICE));
    const upgraded = await exchange(world, calBuddy, publicToken);

    const created = await world.api("/calendar/events", {
      token: upgraded,
      body: { title: "Focus time", start: "2026-09-28T15:00:00Z", end: "2026-09-28T16:00:00Z" },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: "Focus time", account: "alice@acme.test" });
    // The first access token is for the same app and user, so it has the new permission too.
    expect((await world.api("/connections", { token })).body.connections[0].capabilities).toContain("calendar.write");
  });

  test("two accounts: lists merge, and a write needs connection_id", async () => {
    const link = await startLink(world, calBuddy, ["calendar.read", "email.read"]);
    await browser.open(link.url);
    const acme = await browser.open(`${GULPY}/link/connect/demo?token=${link.token}`);
    const consent = await browser.approveAtAcme(acme, BOB);
    expect(checked(consent.html)).toHaveLength(2);
    await allow(browser, consent);

    const mail = await world.api("/email/messages?limit=50", { token });
    const accounts = new Set(mail.body.messages.map((message: { account: string }) => message.account));
    expect(accounts).toEqual(new Set(["alice@acme.test", "bob@acme.test"]));
    const dates = mail.body.messages.map((message: { date: string }) => message.date);
    expect(dates).toEqual([...dates].sort().reverse());

    const ambiguous = await world.api(`/email/messages/${mail.body.messages[0].id}`, { token });
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.error.code).toBe("connection_required");

    const first = mail.body.messages[0];
    const exact = await world.api(`/email/messages/${first.id}?connection_id=${first.connection_id}`, { token });
    expect(exact.status).toBe(200);
  });
});

describe("token life", () => {
  test("Gulpy refreshes an expired provider token", async () => {
    const token = await connectFirstTime(world, browser, inboxPilot, { email: EMAIL, capabilities: ["email.read"] });
    const before = hits(`POST ${ACME}/oauth/token`);

    world.advance(10 * 60_000);
    const mail = await world.api("/email/messages", { token });
    expect(mail.status).toBe(200);
    expect(mail.body.messages.length).toBeGreaterThan(0);
    expect(hits(`POST ${ACME}/oauth/token`)).toBe(before + 1);
  });

  test("many calls at the same time cause one refresh", async () => {
    const token = await connectFirstTime(world, browser, inboxPilot, { email: EMAIL, capabilities: ["email.read"] });
    const before = hits(`POST ${ACME}/oauth/token`);
    world.advance(10 * 60_000);
    const replies = await Promise.all(Array.from({ length: 5 }, () => world.api("/email/messages", { token })));
    expect(replies.map((reply) => reply.status)).toEqual([200, 200, 200, 200, 200]);
    expect(hits(`POST ${ACME}/oauth/token`)).toBe(before + 1);
  });

  test("if the provider cancels the token, the connection needs a new sign-in, and Link repairs it", async () => {
    const token = await connectFirstTime(world, browser, inboxPilot, { email: EMAIL, capabilities: ["email.read"] });
    world.mock.revokeAccount(ALICE);
    world.advance(10 * 60_000);

    const broken = await world.api("/email/messages", { token });
    expect(broken.status).toBe(200);
    expect(broken.body.messages).toEqual([]);
    expect(broken.body.errors[0].code).toBe("connection_needs_reauth");
    expect((await world.api("/connections", { token })).body.connections[0].status).toBe("needs_reauth");

    const link = await startLink(world, inboxPilot, ["email.read"]);
    const consent = await browser.open(link.url);
    expect(consent.html).toContain("Reconnect");
    expect(checked(consent.html)).toHaveLength(0);

    const repair = links(consent.html).find((href) => href.includes("connection=conn_"));
    const back = await browser.approveAtAcme(await browser.open(`${GULPY}${repair}`), ALICE);
    await allow(browser, back);

    const fixed = await world.api("/email/messages", { token });
    expect(fixed.body.errors).toEqual([]);
    expect(fixed.body.messages.length).toBeGreaterThan(0);
  });
});

describe("the user is in control", () => {
  test("the user removes the access of one app. The other app continues to work", async () => {
    const pilot = await connectFirstTime(world, browser, inboxPilot, { email: EMAIL, capabilities: ["email.read"] });
    const link = await startLink(world, calBuddy, ["email.read"]);
    const buddy = await exchange(world, calBuddy, (await allow(browser, await browser.open(link.url))).publicToken);

    const dashboard = await browser.open(`${GULPY}/`);
    expect(dashboard.html).toContain("Inbox Pilot");
    expect(dashboard.html).toContain("Cal Buddy");

    const after = await browser.open(`${GULPY}/apps/${inboxPilot.id}/revoke`, {
      form: { csrf: field(dashboard.html, "csrf") },
      from: dashboard.url,
    });

    expect((await world.api("/email/messages", { token: pilot })).status).toBe(401);
    expect((await world.api("/email/messages", { token: buddy })).status).toBe(200);
  });

  test("the user removes an account. Gulpy deletes the tokens and tells the provider", async () => {
    const token = await connectFirstTime(world, browser, inboxPilot, { email: EMAIL, capabilities: ["email.read"] });
    const connection = (await world.api("/connections", { token })).body.connections[0].id;

    const dashboard = await browser.open(`${GULPY}/`);
    await browser.open(`${GULPY}/connections/${connection}/remove`, {
      form: { csrf: field(dashboard.html, "csrf") },
      from: dashboard.url,
    });

    expect(hits(`POST ${ACME}/oauth/revoke`)).toBe(1);
    expect(world.gulpy.deps.store.connectionById(connection)).toBeNull();
    expect((await world.api("/connections", { token })).body.connections).toEqual([]);
    expect((await world.api("/email/messages", { token })).status).toBe(403);
  });

  test("the log records what each app did", async () => {
    const token = await connectFirstTime(world, browser, inboxPilot, { email: EMAIL, capabilities: ["email.read"] });
    const connection = (await world.api("/connections", { token })).body.connections[0].id;
    await world.api("/email/messages?q=private+search+words", { token });
    await world.api(`/proxy/${connection}/api/api/events`, { token });

    const log = JSON.stringify(world.gulpy.deps.store.db.query("SELECT action, detail, status FROM audit_log").all());
    expect(log).toContain('"action":"email.read"');
    expect(log).toContain('"status":403');
    expect(log).toContain("GET api/api/events");
    // The log records the action, not the content.
    expect(log).not.toContain("private");
  });

  test("an app gives up its access", async () => {
    const token = await connectFirstTime(world, browser, inboxPilot, { email: EMAIL, capabilities: ["email.read"] });
    const connection = (await world.api("/connections", { token })).body.connections[0].id;
    expect((await world.api(`/connections/${connection}`, { token, method: "DELETE" })).status).toBe(200);
    expect((await world.api("/connections", { token })).body.connections).toEqual([]);
    expect((await world.api("/access_token/revoke", { token, method: "POST" })).status).toBe(200);
    expect((await world.api("/connections", { token })).status).toBe(401);
  });

  test("the user cancels. The app gets nothing", async () => {
    const link = await startLink(world, inboxPilot, ["email.read"]);
    const consent = await browser.signIn(world, EMAIL, link.url.slice(GULPY.length));
    const page = await browser.open(`${GULPY}/link/cancel`, {
      form: { csrf: field(consent.html, "csrf"), token: link.token },
      from: consent.url,
    });
    expect(dataAttribute(page.html, "type")).toBe("exit");
    expect(dataAttribute(page.html, "public-token")).toBeUndefined();

    const status = await world.fetch(`${GULPY}/link/status?token=${link.token}`);
    expect(await status.json()).toEqual({ status: "exited" });
  });

  test("the user denies access at the provider. Nothing is stored", async () => {
    const link = await startLink(world, inboxPilot, ["email.read"]);
    await browser.signIn(world, EMAIL);
    const acme = await browser.open(`${GULPY}/link/connect/demo?token=${link.token}`);
    const back = await browser.approveAtAcme(acme, "");
    expect(back.url).toContain("notice=denied");
    expect(back.html).toContain("did not give access");
    expect(checked(back.html)).toHaveLength(0);
  });
});
