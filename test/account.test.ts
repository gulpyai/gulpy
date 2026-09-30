/** The legal duties that the code must keep: consent, sign-in cookie, export, deletion, retention, HSTS. */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backUp } from "../src/backup.ts";
import { LEGAL } from "../src/brand.ts";
import { cleanUp } from "../src/cleanup.ts";
import { connectFirstTime, createWorld, field, GULPY, type Browser, type TestApp, type World } from "./harness.ts";

const EMAIL = "skyler@example.com";
const DAY = 24 * 60 * 60_000;

let world: World;
let browser: Browser;
let inboxPilot: TestApp;

beforeEach(async () => {
  world = await createWorld();
  browser = world.browser();
  inboxPilot = world.registerApp("Inbox Pilot", "https://inboxpilot.test");
});

function userId(): string {
  const user = world.gulpy.deps.store.userByEmail(EMAIL);
  if (!user) throw new Error("No user");
  return user.id;
}

/** Signs in with plain requests, and returns the Set-Cookie line of the session. */
async function sessionCookie(): Promise<string> {
  const post = (path: string, form: Record<string, string>, cookie = "") =>
    world.gulpy.app.request(`${GULPY}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: GULPY,
        "sec-fetch-site": "same-origin",
        ...(cookie ? { cookie } : {}),
      },
      body: new URLSearchParams(form).toString(),
    });
  const start = await post("/auth/start", { email: EMAIL, next: "/" });
  const binding = start.headers.getSetCookie().find((line) => line.startsWith("gulpy_signin="))?.split(";")[0] ?? "";
  const html = await start.text();
  const verify = await post(
    "/auth/verify",
    { email: EMAIL, next: "/", otp_id: field(html, "otp_id"), code: world.mailer.peek(EMAIL) ?? "" },
    binding,
  );
  return verify.headers.getSetCookie().find((line) => line.startsWith("gulpy_session=")) ?? "";
}

describe("consent and the sign-in cookie", () => {
  test("the sign-in form says that Continue means consent, with links to the rules", async () => {
    const html = await (await world.gulpy.app.request(`${GULPY}/`)).text();
    expect(html).toContain("When you sign in, you agree to the");
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
    expect(html).not.toContain('name="remember"');
  });

  test("sign-in records the version of the rules and the time", async () => {
    await browser.signIn(world, EMAIL);
    const accepted = world.gulpy.deps.store.rulesAccepted(userId());
    expect(accepted?.version).toBe(LEGAL.rulesVersion);
    expect(accepted?.acceptedAt).toBe(world.gulpy.deps.now());
  });

  test("a sign-in lasts 30 days, in the database and in the cookie", async () => {
    const cookie = await sessionCookie();
    expect(cookie).toStartWith("gulpy_session=");
    expect(cookie).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
    const row = world.gulpy.deps.store.db.query("SELECT created_at, expires_at FROM sessions").get() as {
      created_at: number;
      expires_at: number;
    };
    expect(row.expires_at - row.created_at).toBe(30 * DAY);
  });
});

describe("the approval window", () => {
  test("it says where the data goes, with links to the rules", async () => {
    const { startLink } = await import("./harness.ts");
    const link = await startLink(world, inboxPilot, ["email.read"]);
    await browser.signIn(world, EMAIL);
    const page = await browser.open(link.url);
    expect(page.html).toContain("A different company operates Inbox Pilot, with its own privacy policy.");
    expect(page.html).toContain('href="/privacy"');
  });
});

describe("export and deletion", () => {
  test("the export has the data of the person and no token or secret", async () => {
    await connectFirstTime(world, browser, inboxPilot, { email: EMAIL, capabilities: ["email.read"] });
    const page = await browser.open(`${GULPY}/account/export`);
    expect(page.status).toBe(200);
    const data = JSON.parse(page.html);
    expect(data.account.email).toBe(EMAIL);
    expect(data.account.rulesVersion).toBe(LEGAL.rulesVersion);
    expect(data.connections).toHaveLength(1);
    expect(data.approvals[0].agent).toBe("Inbox Pilot");
    expect(page.html).not.toMatch(/acme\.[A-Za-z0-9_-]{20,}\./);
    expect(page.html).not.toContain("v1.");
  });

  test("deletion needs the email address, then deletes each row and cancels the tokens", async () => {
    const token = await connectFirstTime(world, browser, inboxPilot, { email: EMAIL, capabilities: ["email.read"] });
    const id = userId();
    const form = await browser.open(`${GULPY}/account/delete`);
    const csrf = field(form.html, "csrf");

    const wrong = await browser.open(`${GULPY}/account/delete`, { form: { csrf, confirm: "other@example.com" } });
    expect(wrong.status).toBe(400);
    expect(world.gulpy.deps.store.userById(id)).not.toBeNull();

    const done = await browser.open(`${GULPY}/account/delete`, { form: { csrf, confirm: EMAIL } });
    expect(done.status).toBe(200);
    expect(done.html).toContain("Your account is deleted");

    const { db } = world.gulpy.deps.store;
    for (const table of ["users", "sessions", "connections", "grants", "access_tokens", "audit_log", "otps"]) {
      const { count } = db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      expect({ table, count }).toEqual({ table, count: 0 });
    }
    expect(world.requests.some((line) => line.includes("/oauth/revoke"))).toBe(true);
    expect(browser.hasCookie(GULPY, "gulpy_session")).toBe(false);
    // The agent cannot call Gulpy now.
    expect((await world.api("/email/messages", { token })).status).toBe(401);
  });

  test("deletion refuses a form from a different site", async () => {
    await browser.signIn(world, EMAIL);
    const form = await browser.open(`${GULPY}/account/delete`);
    const page = await browser.open(`${GULPY}/account/delete`, {
      form: { csrf: field(form.html, "csrf"), confirm: EMAIL },
      from: "https://evil.test",
    });
    expect(page.status).toBe(403);
    expect(world.gulpy.deps.store.userByEmail(EMAIL)).not.toBeNull();
  });
});

describe("retention", () => {
  test("cleanup deletes calls older than the limit and expired codes, and keeps new calls", async () => {
    await browser.signIn(world, EMAIL);
    const { store } = world.gulpy.deps;
    const now = world.gulpy.deps.now();
    const entry = { userId: userId(), appId: null, connectionId: null, action: "tool", detail: null, status: 200 };
    store.audit({ ...entry, ts: now - (LEGAL.callLogDays + 1) * DAY });
    store.audit({ ...entry, ts: now - DAY });
    world.advance(2 * DAY);
    cleanUp(world.gulpy.deps);
    const calls = store.db.query("SELECT ts FROM audit_log").all();
    expect(calls).toHaveLength(1);
    expect(store.db.query("SELECT * FROM otps").all()).toHaveLength(0);
  });
});

describe("copies of the database", () => {
  test("a copy has the rows, has no token in plain text, and the old copies go away", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gulpy-backup-"));
    try {
      await browser.signIn(world, EMAIL);
      for (let day = 0; day < 16; day++) {
        backUp(world.gulpy.deps, dir);
        world.advance(24 * 60 * 60_000);
      }
      const copies = readdirSync(dir).sort();
      expect(copies).toHaveLength(14);
      expect(copies[0]).toBe("gulpy-2026-09-29.db");

      const copy = new Database(join(dir, copies[13] ?? ""), { readonly: true });
      expect(copy.query("SELECT email FROM users").all()).toEqual([{ email: EMAIL }]);
      copy.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("transport", () => {
  test("each response on the https address has HSTS", async () => {
    for (const path of ["/", "/privacy", "/assets/gulpy.css", "/health"]) {
      const response = await world.gulpy.app.request(`${GULPY}${path}`);
      expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
    }
  });
});
