/** Paid plans: the Stripe checkout, the webhook, the customer portal, and what a plan changes. */
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createHmac } from "node:crypto";
import { agentAllowed, FREE_AGENTS, FREE_HISTORY_DAYS } from "../src/billing.ts";
import { LEGAL } from "../src/brand.ts";
import { cleanUp } from "../src/cleanup.ts";
import { createWorld, field, GULPY, type Browser, type World } from "./harness.ts";

const EMAIL = "skyler@example.com";
const STRIPE = "https://api.stripe.com";
const SECRET = "whsec_test_secret";
const DAY = 24 * 60 * 60_000;

/** A Stripe for the tests: the objects that Gulpy reads, and the portal sessions it makes. */
function createStripe() {
  const subscriptions: Record<string, unknown> = {};
  const customers: Record<string, { id: string; email: string | null }> = {};
  const sessions: Record<string, unknown> = {};
  const portalRequests: Record<string, string>[] = [];
  const app = new Hono();
  app.get("/v1/payment_links", (c) =>
    c.json({
      data: [
        { id: "plink_1", url: "https://buy.stripe.com/test_personal_yearly", active: true, metadata: { lookup_key: "personal_yearly" } },
        { id: "plink_2", url: "https://buy.stripe.com/test_business_monthly", active: true, metadata: { lookup_key: "business_monthly" } },
        { id: "plink_3", url: "https://buy.stripe.com/test_pro_monthly", active: true, metadata: { lookup_key: "pro_monthly" } },
      ],
      has_more: false,
    }),
  );
  app.get("/v1/subscriptions/:id", (c) => {
    const found = subscriptions[c.req.param("id")];
    return found ? c.json(found) : c.json({ error: { message: "No such subscription" } }, 404);
  });
  app.get("/v1/customers/:id", (c) => {
    const found = customers[c.req.param("id")];
    return found ? c.json(found) : c.json({ error: { message: "No such customer" } }, 404);
  });
  app.get("/v1/checkout/sessions/:id", (c) => {
    const found = sessions[c.req.param("id")];
    return found ? c.json(found) : c.json({ error: { message: "No such session" } }, 404);
  });
  app.post("/v1/billing_portal/sessions", async (c) => {
    const form = Object.fromEntries(new URLSearchParams(await c.req.text()));
    if (!c.req.header("authorization")?.startsWith("Basic ")) return c.json({ error: { message: "No key" } }, 401);
    portalRequests.push(form);
    return c.json({ url: "https://billing.stripe.com/p/session/test_portal" });
  });
  return { app, subscriptions, customers, sessions, portalRequests };
}

function subscription(fields: {
  id?: string;
  customer?: string;
  plan?: string;
  interval?: "month" | "year";
  status?: string;
  quantity?: number;
  cancel?: boolean;
  /** Seconds. The customer portal cancels with this and leaves cancel_at_period_end false. */
  cancelAt?: number;
}) {
  const plan = fields.plan ?? "personal";
  const interval = fields.interval ?? "year";
  return {
    id: fields.id ?? "sub_1",
    object: "subscription",
    customer: fields.customer ?? "cus_1",
    status: fields.status ?? "active",
    cancel_at_period_end: fields.cancel ?? false,
    cancel_at: fields.cancelAt ?? null,
    metadata: { plan, interval: interval === "month" ? "monthly" : "yearly" },
    items: {
      data: [
        {
          quantity: fields.quantity ?? 1,
          current_period_end: 1_790_000_000,
          price: { id: `price_${plan}_${interval}`, lookup_key: `${plan}_${interval === "month" ? "monthly" : "yearly"}`, recurring: { interval } },
        },
      ],
    },
  };
}

function signed(payload: string, secret: string, atMs: number): string {
  const t = Math.floor(atMs / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
}

let world: World;
let browser: Browser;
let stripe: ReturnType<typeof createStripe>;

beforeEach(async () => {
  stripe = createStripe();
  world = await createWorld({
    stripe: { secretKey: "sk_test_123", webhookSecret: SECRET },
    origins: { [STRIPE]: stripe.app },
  });
  browser = world.browser();
});

function userId(): string {
  const user = world.gulpy.deps.store.userByEmail(EMAIL);
  if (!user) throw new Error("No user");
  return user.id;
}

async function webhook(event: Record<string, unknown>, options: { secret?: string; at?: number } = {}) {
  const payload = JSON.stringify({ id: "evt_1", ...event });
  return world.gulpy.app.request(`${GULPY}/stripe/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": signed(payload, options.secret ?? SECRET, options.at ?? world.gulpy.deps.now()),
    },
    body: payload,
  });
}

describe("the webhook", () => {
  test("refuses a wrong signature, an old signature and bad JSON", async () => {
    const event = { type: "customer.subscription.updated", data: { object: subscription({}) } };
    expect((await webhook(event, { secret: "whsec_other" })).status).toBe(400);
    expect((await webhook(event, { at: world.gulpy.deps.now() - 10 * 60_000 })).status).toBe(400);
    const noHeader = await world.gulpy.app.request(`${GULPY}/stripe/webhook`, { method: "POST", body: "{}" });
    expect(noHeader.status).toBe(400);
    const badJson = await world.gulpy.app.request(`${GULPY}/stripe/webhook`, {
      method: "POST",
      headers: { "stripe-signature": signed("{", SECRET, world.gulpy.deps.now()) },
      body: "{",
    });
    expect(badJson.status).toBe(400);
  });

  test("checkout.session.completed with the user id gives the person the plan", async () => {
    await browser.signIn(world, EMAIL);
    stripe.subscriptions.sub_1 = subscription({ plan: "personal", interval: "year" });
    const response = await webhook({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          mode: "subscription",
          status: "complete",
          client_reference_id: userId(),
          customer: "cus_1",
          customer_details: { email: "other@example.com" },
          subscription: "sub_1",
        },
      },
    });
    expect(response.status).toBe(200);
    const row = world.gulpy.deps.store.subscription(userId());
    expect(row).toMatchObject({ plan: "personal", status: "active", interval: "yearly", customerId: "cus_1", quantity: 1 });
    expect(row?.periodEnd).toBe(1_790_000_000_000);

    const home = await browser.open(`${GULPY}/`);
    expect(home.html).toContain("Plan: <strong>Personal</strong>");
    expect(home.html).toContain("Billed yearly");
    expect(home.html).toContain("Manage plan");
    expect(JSON.stringify(world.gulpy.deps.store.db.query("SELECT action, detail FROM audit_log").all())).toContain("plan.change");

    const exported = await (await browser.open(`${GULPY}/account/export`)).html;
    expect(JSON.parse(exported).plan).toMatchObject({ plan: "personal", status: "active", users: 1 });
  });

  test("a subscription event for a customer that Gulpy does not know finds the person by email", async () => {
    await browser.signIn(world, EMAIL);
    stripe.customers.cus_9 = { id: "cus_9", email: "Skyler@Example.com" };
    const response = await webhook({
      type: "customer.subscription.created",
      data: { object: subscription({ id: "sub_9", customer: "cus_9", plan: "business", interval: "month", quantity: 4 }) },
    });
    expect(response.status).toBe(200);
    expect(world.gulpy.deps.store.subscription(userId())).toMatchObject({ plan: "business", interval: "monthly", quantity: 4, customerId: "cus_9" });
    const home = await browser.open(`${GULPY}/`);
    expect(home.html).toContain("Plan: <strong>Business</strong>");
    expect(home.html).toContain("4 users");
  });

  test("a customer with no Gulpy account changes nothing", async () => {
    stripe.customers.cus_x = { id: "cus_x", email: "nobody@example.com" };
    const response = await webhook({ type: "customer.subscription.created", data: { object: subscription({ customer: "cus_x" }) } });
    expect(response.status).toBe(200);
    expect(world.gulpy.deps.store.db.query("SELECT * FROM subscriptions").all()).toHaveLength(0);
  });

  test("customer.subscription.deleted puts the person on Free, and the portal stays for the invoices", async () => {
    await browser.signIn(world, EMAIL);
    stripe.customers.cus_1 = { id: "cus_1", email: EMAIL };
    await webhook({ type: "customer.subscription.created", data: { object: subscription({}) } });
    expect((await browser.open(`${GULPY}/`)).html).toContain("Plan: <strong>Personal</strong>");

    await webhook({ type: "customer.subscription.updated", data: { object: subscription({ cancel: true }) } });
    expect((await browser.open(`${GULPY}/`)).html).toContain("Ends");

    await webhook({ type: "customer.subscription.deleted", data: { object: subscription({ status: "canceled" }) } });
    const home = await browser.open(`${GULPY}/`);
    expect(home.html).toContain("Plan: <strong>Free</strong>");
    expect(home.html).toContain("Invoices");
    expect(world.gulpy.deps.store.subscription(userId())?.status).toBe("canceled");
  });

  test("a cancel in the customer portal (cancel_at, with cancel_at_period_end false) shows the end date", async () => {
    await browser.signIn(world, EMAIL);
    stripe.customers.cus_1 = { id: "cus_1", email: EMAIL };
    await webhook({ type: "customer.subscription.created", data: { object: subscription({}) } });
    expect((await browser.open(`${GULPY}/`)).html).toContain("Renews");

    await webhook({ type: "customer.subscription.updated", data: { object: subscription({ cancelAt: 1_793_335_552 }) } });
    const home = await browser.open(`${GULPY}/`);
    expect(home.html).toContain("Ends");
    expect(home.html).not.toContain("Renews");
    expect(world.gulpy.deps.store.subscription(userId())?.periodEnd).toBe(1_793_335_552_000);
  });
});

describe("checkout and the portal", () => {
  test("a signed-in person goes to the payment link with the user id and the email", async () => {
    await browser.signIn(world, EMAIL);
    const response = await world.gulpy.app.request(`${GULPY}/billing/checkout?plan=pro&interval=monthly`, {
      headers: { cookie: await cookie() },
    });
    expect(response.status).toBe(303);
    const target = new URL(response.headers.get("location") ?? "");
    expect(target.origin + target.pathname).toBe("https://buy.stripe.com/test_pro_monthly");
    expect(target.searchParams.get("client_reference_id")).toBe(userId());
    expect(target.searchParams.get("prefilled_email")).toBe(EMAIL);
  });

  test("a signed-out person sees the sign-in page and lands on the checkout after it", async () => {
    const page = await browser.open(`${GULPY}/billing/checkout?plan=pro&interval=monthly`);
    expect(page.status).toBe(200);
    expect(page.html).toContain('name="next" value="/billing/checkout?plan=pro&amp;interval=monthly"');
    const after = await world.gulpy.app.request(`${GULPY}/billing/checkout?plan=pro&interval=monthly`, {
      headers: { cookie: await cookie("/billing/checkout?plan=pro&interval=monthly") },
    });
    expect(after.headers.get("location")).toStartWith("https://buy.stripe.com/test_pro_monthly?");
  });

  test("a plan with no payment link, and a plan that does not exist", async () => {
    await browser.signIn(world, EMAIL);
    const missing = await world.gulpy.app.request(`${GULPY}/billing/checkout?plan=pro&interval=yearly`, { headers: { cookie: await cookie() } });
    expect(missing.headers.get("location")).toBe("/?notice=no_plan#account");
    const unknown = await world.gulpy.app.request(`${GULPY}/billing/checkout?plan=gold`, { headers: { cookie: await cookie() } });
    expect(unknown.status).toBe(400);
    // The older plans are not for sale.
    const old = await world.gulpy.app.request(`${GULPY}/billing/checkout?plan=personal`, { headers: { cookie: await cookie() } });
    expect(old.status).toBe(400);
  });

  test("the portal opens for the customer of the person, with the way back", async () => {
    await browser.signIn(world, EMAIL);
    stripe.customers.cus_1 = { id: "cus_1", email: EMAIL };
    await webhook({ type: "customer.subscription.created", data: { object: subscription({}) } });
    const session = await cookie();
    const home = await (await world.gulpy.app.request(`${GULPY}/`, { headers: { cookie: session } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(home)?.[1] ?? "";
    const response = await world.gulpy.app.request(`${GULPY}/billing/portal`, {
      method: "POST",
      headers: { cookie: session, "content-type": "application/x-www-form-urlencoded", origin: GULPY, "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ csrf }).toString(),
    });
    // A form from a different site, or without the hidden field, is refused.
    const forged = await world.gulpy.app.request(`${GULPY}/billing/portal`, {
      method: "POST",
      headers: { cookie: session, "content-type": "application/x-www-form-urlencoded", origin: GULPY, "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ csrf: "wrong" }).toString(),
    });
    expect(forged.status).toBe(403);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://billing.stripe.com/p/session/test_portal");
    expect(stripe.portalRequests).toEqual([{ customer: "cus_1", return_url: `${GULPY}/#account` }]);
  });

  test("back from the checkout page, the plan shows before the webhook arrives", async () => {
    await browser.signIn(world, EMAIL);
    stripe.sessions.cs_done = {
      id: "cs_done",
      mode: "subscription",
      status: "complete",
      client_reference_id: userId(),
      customer: "cus_1",
      customer_details: { email: EMAIL },
      subscription: subscription({ plan: "family" }),
    };
    const page = await browser.open(`${GULPY}/?checkout=cs_done`);
    expect(page.url).toBe(`${GULPY}/#account`);
    expect(page.html).toContain("Plan: <strong>Family</strong>");

    // The session of a different person, or a session that is not paid, changes nothing.
    stripe.sessions.cs_other = { ...(stripe.sessions.cs_done as object), client_reference_id: "usr_other", customer_details: { email: "other@example.com" } };
    const other = await browser.open(`${GULPY}/?checkout=cs_other`);
    expect(other.url).toBe(`${GULPY}/?notice=payment_pending`);
    expect(page.html).toContain("Plan: <strong>Family</strong>");
    const bad = await browser.open(`${GULPY}/?checkout=../secret`);
    expect(bad.url).toBe(`${GULPY}/?notice=payment_pending`);
  });
});

describe("what a plan changes", () => {
  /** An agent that the person approved: it has a grant on a tool of the person. */
  function approvedAgent(name: string): string {
    const store = world.gulpy.deps.store;
    const now = world.gulpy.deps.now();
    const id = `app_${name}`;
    store.createApp({ id, ownerUserId: null, name, clientId: id, clientSecretHash: "", origins: [], kind: "agent", createdAt: now });
    let connection = store.connectionsByUser(userId())[0];
    if (!connection) {
      store.insertConnection({
        id: "conn_1", userId: userId(), provider: "notion", accountId: "a", accountLabel: "Notion", capabilities: ["tools.read"],
        scopes: [], accessTokenEnc: "x", refreshTokenEnc: null, expiresAt: null, status: "active", tools: null, createdAt: now, updatedAt: now,
      });
      connection = store.connectionsByUser(userId())[0]!;
    }
    store.upsertGrant({ id: `grant_${name}`, userId: userId(), appId: id, connectionId: connection.id, capabilities: ["tools.read"], createdAt: now, updatedAt: now });
    return id;
  }

  test(`Free has ${FREE_AGENTS} agents; an agent approved before can sign in again; Pro has no limit`, async () => {
    await browser.signIn(world, EMAIL);
    const deps = world.gulpy.deps;
    const first = approvedAgent("One");
    approvedAgent("Two");
    expect(agentAllowed(deps, userId(), "app_Three")).toBe(true);
    approvedAgent("Three");
    expect(agentAllowed(deps, userId(), "app_Four")).toBe(false);
    expect(agentAllowed(deps, userId(), first)).toBe(true);
    const home = await browser.open(`${GULPY}/`);
    expect(home.html).toContain(`3 of ${FREE_AGENTS} agents`);
    expect(home.html).toContain("Upgrade to Pro");
    expect(home.html).not.toContain('data-tab-link="activity"');

    stripe.customers.cus_1 = { id: "cus_1", email: EMAIL };
    await webhook({ type: "customer.subscription.created", data: { object: subscription({ plan: "pro", interval: "month" }) } });
    expect(agentAllowed(deps, userId(), "app_Four")).toBe(true);
    const pro = await browser.open(`${GULPY}/`);
    expect(pro.html).toContain("Plan: <strong>Pro</strong>");
    expect(pro.html).not.toContain("Upgrade to Pro");
    expect(pro.html).toContain('data-tab-link="activity"');
  });

  test("the approval page of a fourth agent on Free offers Pro", async () => {
    await browser.signIn(world, EMAIL);
    for (const name of ["One", "Two", "Three"]) approvedAgent(name);
    const store = world.gulpy.deps.store;
    const now = world.gulpy.deps.now();
    store.createApp({ id: "app_Four", ownerUserId: null, name: "Four", clientId: "app_Four", clientSecretHash: "", origins: [], kind: "agent", createdAt: now });
    const code = "FourthAgentCode1";
    store.createDeviceCode("hash_four", code, "app_Four", now, now + 10 * 60_000);

    const page = await browser.open(`${GULPY}/device?code=${code}`);
    expect(page.html).toContain(`Free has ${FREE_AGENTS} agents`);
    expect(page.html).toContain("/billing/checkout?plan=pro");
    // The form of an older page cannot go around the limit.
    const home = await browser.open(`${GULPY}/`);
    await browser.open(`${GULPY}/device`, { form: { csrf: field(home.html, "csrf"), code, decision: "allow" }, from: `${GULPY}/device?code=${code}` });
    expect(store.grantsForAppUser("app_Four", userId())).toHaveLength(0);
  });

  test(`Free keeps ${FREE_HISTORY_DAYS} days of calls; a paid plan keeps ${LEGAL.callLogDays} days`, async () => {
    await browser.signIn(world, EMAIL);
    const { store } = world.gulpy.deps;
    const now = world.gulpy.deps.now();
    const entry = { userId: userId(), appId: null, connectionId: null, action: "tool", detail: null, status: 200 };
    store.audit({ ...entry, ts: now - (FREE_HISTORY_DAYS + 1) * DAY });
    store.audit({ ...entry, ts: now - DAY });
    cleanUp(world.gulpy.deps);
    expect(store.auditByUser(userId(), 10)).toHaveLength(1);

    stripe.customers.cus_1 = { id: "cus_1", email: EMAIL };
    await webhook({ type: "customer.subscription.created", data: { object: subscription({}) } });
    store.audit({ ...entry, ts: now - (FREE_HISTORY_DAYS + 1) * DAY });
    store.audit({ ...entry, ts: now - (LEGAL.callLogDays + 1) * DAY });
    cleanUp(world.gulpy.deps);
    const kept = store.auditByUser(userId(), 10).filter((row) => row.action === "tool");
    expect(kept).toHaveLength(2);
  });

  test("with no Stripe settings, the plan routes are off and the dashboard shows no plan", async () => {
    const plain = await createWorld();
    const b = plain.browser();
    await b.signIn(plain, EMAIL);
    expect((await b.open(`${GULPY}/`)).html).not.toContain("Plan:");
    expect((await plain.gulpy.app.request(`${GULPY}/billing/checkout?plan=personal`)).status).toBe(404);
    expect((await plain.gulpy.app.request(`${GULPY}/stripe/webhook`, { method: "POST", body: "{}" })).status).toBe(404);
  });
});

/** The session cookie of the browser, after a sign-in. */
async function cookie(next = "/"): Promise<string> {
  const start = await world.gulpy.app.request(`${GULPY}/auth/start`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: GULPY, "sec-fetch-site": "same-origin" },
    body: new URLSearchParams({ email: EMAIL, next }).toString(),
  });
  const binding = start.headers.getSetCookie().find((line) => line.startsWith("gulpy_signin="))?.split(";")[0] ?? "";
  const html = await start.text();
  const otpId = /name="otp_id" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const verify = await world.gulpy.app.request(`${GULPY}/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: GULPY, "sec-fetch-site": "same-origin", cookie: binding },
    body: new URLSearchParams({ email: EMAIL, next, otp_id: otpId, code: world.mailer.peek(EMAIL) ?? "" }).toString(),
  });
  return verify.headers.getSetCookie().find((line) => line.startsWith("gulpy_session="))?.split(";")[0] ?? "";
}
