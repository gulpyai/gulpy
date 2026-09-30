/**
 * "Connect to Gulpy": an agent on the computer of the user asks for a code, the
 * user taps Allow in the browser, and the agent gets one key for all the tools.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { DEVICE_GRANT } from "../src/device.ts";
import { addConnector, GULPY, createWorld, field, type Browser, type World } from "./harness.ts";

const EMAIL = "skyler@example.com";

let world: World;
let browser: Browser;

beforeEach(async () => {
  world = await createWorld();
  browser = world.browser();
});

/** A request of the agent: a form, as `curl -d` sends it. */
async function agentPost(path: string, form: Record<string, string>): Promise<{ status: number; body: any }> {
  const response = await world.fetch(`${GULPY}${path}`, { method: "POST", body: new URLSearchParams(form) });
  return { status: response.status, body: await response.json() };
}

async function tools(key: string): Promise<{ status: number; body: any }> {
  const response = await world.fetch(`${GULPY}/v1/tools`, { headers: { authorization: `Bearer ${key}` } });
  return { status: response.status, body: await response.json() };
}

async function callTool(key: string, name: string, args: unknown): Promise<{ status: number; body: any }> {
  const response = await world.fetch(`${GULPY}/v1/tools/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  return { status: response.status, body: await response.json() };
}

/** The full flow. Returns the key. */
async function connect(name = "Claude Code"): Promise<string> {
  const start = await agentPost("/device/code", { client_name: name });
  const consent = await browser.open(start.body.verification_uri_complete);
  await browser.open(`${GULPY}/device`, {
    form: { csrf: field(consent.html, "csrf"), code: start.body.user_code, decision: "allow" },
  });
  const token = await agentPost("/device/token", { grant_type: DEVICE_GRANT, device_code: start.body.device_code });
  expect(token.status).toBe(200);
  return token.body.access_token;
}

describe("connect to Gulpy", () => {
  test("the agent gets a code, the user allows it, the agent gets one key for all the tools", async () => {
    await browser.signIn(world, EMAIL);
    await addConnector(browser, "acme-notes");

    const start = await agentPost("/device/code", { client_name: "Claude Code" });
    expect(start.status).toBe(200);
    // The link carries a secret code of 16 characters. The user never reads or types it.
    expect(start.body.user_code).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(start.body.verification_uri_complete).toBe(`${GULPY}/device?code=${start.body.user_code}`);
    expect(start.body.interval).toBe(5);

    const early = await agentPost("/device/token", { device_code: start.body.device_code });
    expect(early.body.error).toBe("authorization_pending");
    const tooFast = await agentPost("/device/token", { device_code: start.body.device_code });
    expect(tooFast.body.error).toBe("slow_down");

    const consent = await browser.open(start.body.verification_uri_complete);
    expect(consent.html).toContain("Connect Claude Code?");
    expect(consent.html).toContain("Only tap Allow if you just asked Claude Code to connect.");
    const done = await browser.open(`${GULPY}/device`, {
      form: { csrf: field(consent.html, "csrf"), code: start.body.user_code, decision: "allow" },
    });
    expect(done.html).toContain("All set");
    // The user gets an email, so a user who was tricked into Allow finds out.
    const notice = world.mailer.notices.at(-1);
    expect(notice?.email).toBe(EMAIL);
    expect(notice?.subject).toBe("Claude Code can now use your Gulpy tools");
    expect(notice?.text).toContain(`Not you? Remove it now: ${GULPY}/#agents`);

    world.advance(6_000);
    const token = await agentPost("/device/token", { device_code: start.body.device_code });
    expect(token.status).toBe(200);
    expect(token.body.access_token).toMatch(/^gulpy_/);
    expect(token.body.expires_in).toBeUndefined();

    // The code gives one key only.
    world.advance(6_000);
    const again = await agentPost("/device/token", { device_code: start.body.device_code });
    expect(again.body.error).toBe("invalid_grant");

    const key = token.body.access_token;
    const list = await tools(key);
    const names = list.body.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("list_connections");
    expect(names).toContain("acme_notes_search_notes");
    expect(list.body.tools.find((tool: { name: string }) => tool.name === "acme_notes_search_notes").read_only).toBe(true);

    const found = await callTool(key, "acme_notes_search_notes", { query: "plan" });
    expect(found.status).toBe(200);
    expect(JSON.stringify(found.body.result)).toContain("plan");

    const own = await callTool(key, "list_connections", {});
    expect(own.body.result.connections).toHaveLength(1);

    const unknown = await callTool(key, "no_such_tool", {});
    expect(unknown.status).toBe(403);
    expect(unknown.body.error.code).toBe("not_granted");
  });

  test("an agent in a web page on another origin can call the tools", async () => {
    await browser.signIn(world, EMAIL);
    const key = await connect();
    const preflight = await world.fetch(`${GULPY}/v1/tools`, {
      method: "OPTIONS",
      headers: { origin: "https://agent.example", "access-control-request-method": "GET" },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect((await tools(key)).status).toBe(200);
  });

  test("the sign-in page comes first for a user who is not signed in, and the code stays", async () => {
    const start = await agentPost("/device/code", { client_name: "Codex" });
    const page = await browser.open(start.body.verification_uri_complete);
    expect(page.html).toContain("Connect Codex");
    const after = await browser.signIn(world, EMAIL, `/device?code=${start.body.user_code}`);
    expect(after.html).toContain("Connect Codex?");
  });

  test("an account with no tools gets a warning and a way to switch email", async () => {
    await browser.signIn(world, EMAIL);
    const start = await agentPost("/device/code", { client_name: "Muse" });
    const consent = await browser.open(start.body.verification_uri_complete);
    expect(consent.html).toContain(`${EMAIL} has no tools yet.`);
    expect(consent.html).toContain("Use a different email");
    await addConnector(browser, "acme-notes");
    const withTools = await browser.open(start.body.verification_uri_complete);
    expect(withTools.html).not.toContain("has no tools yet");
  });

  test("a tool that the user adds later reaches the agent with no new step", async () => {
    await browser.signIn(world, EMAIL);
    const key = await connect();
    expect((await tools(key)).body.tools.map((tool: { name: string }) => tool.name)).not.toContain("acme_notes_search_notes");
    await addConnector(browser, "acme-notes");
    expect((await tools(key)).body.tools.map((tool: { name: string }) => tool.name)).toContain("acme_notes_search_notes");
  });

  test("a chat agent can collect its key up to 1 hour after Allow, when the user says done", async () => {
    await browser.signIn(world, EMAIL);
    const start = await agentPost("/device/code", { client_name: "Muse" });
    world.advance(8 * 60_000);
    const consent = await browser.open(start.body.verification_uri_complete);
    const done = await browser.open(`${GULPY}/device`, {
      form: { csrf: field(consent.html, "csrf"), code: start.body.user_code, decision: "allow" },
    });
    expect(done.html).toContain("say &quot;done&quot;");
    // Past the 10 minutes of the code, but within 1 hour of Allow.
    world.advance(40 * 60_000);
    const token = await agentPost("/device/token", { device_code: start.body.device_code });
    expect(token.status).toBe(200);
    expect(token.body.access_token).toMatch(/^gulpy_/);
  });

  test("each connect gets a new link, and a used link does not work again", async () => {
    await browser.signIn(world, EMAIL);
    const first = await agentPost("/device/code", { client_name: "Muse" });
    const second = await agentPost("/device/code", { client_name: "Muse" });
    expect(first.body.user_code).not.toBe(second.body.user_code);
    const consent = await browser.open(first.body.verification_uri_complete);
    await browser.open(`${GULPY}/device`, { form: { csrf: field(consent.html, "csrf"), code: first.body.user_code, decision: "allow" } });
    const again = await browser.open(first.body.verification_uri_complete);
    expect(again.status).toBe(400);
    expect(again.html).toContain("This link is old or used.");
  });

  test("Cancel refuses the agent", async () => {
    await browser.signIn(world, EMAIL);
    const start = await agentPost("/device/code", { client_name: "Stranger" });
    const consent = await browser.open(start.body.verification_uri_complete);
    const done = await browser.open(`${GULPY}/device`, {
      form: { csrf: field(consent.html, "csrf"), code: start.body.user_code, decision: "deny" },
    });
    expect(done.html).toContain("Nothing was shared");
    world.advance(6_000);
    expect((await agentPost("/device/token", { device_code: start.body.device_code })).body.error).toBe("access_denied");
  });

  test("a form from another site cannot allow an agent", async () => {
    await browser.signIn(world, EMAIL);
    const start = await agentPost("/device/code", { client_name: "Stranger" });
    const consent = await browser.open(start.body.verification_uri_complete);
    const attack = await browser.open(`${GULPY}/device`, {
      form: { csrf: field(consent.html, "csrf"), code: start.body.user_code, decision: "allow" },
      from: "https://evil.example",
    });
    expect(attack.status).toBe(403);
    world.advance(6_000);
    expect((await agentPost("/device/token", { device_code: start.body.device_code })).body.error).toBe("authorization_pending");
  });

  test("a code stops after 10 minutes, and a wrong code shows the form", async () => {
    await browser.signIn(world, EMAIL);
    const start = await agentPost("/device/code", { client_name: "Slow agent" });
    world.advance(11 * 60_000);
    const late = await browser.open(start.body.verification_uri_complete);
    expect(late.status).toBe(400);
    expect(late.html).toContain("This link is old or used.");
    expect((await agentPost("/device/token", { device_code: start.body.device_code })).body.error).toBe("expired_token");
    expect((await browser.open(`${GULPY}/device?code=nonsense`)).status).toBe(400);
  });

  test("removing the agent on My tools stops the key", async () => {
    await browser.signIn(world, EMAIL);
    await addConnector(browser, "acme-notes");
    const key = await connect("Cursor");
    const app = world.gulpy.deps.store.db.query("SELECT id FROM apps WHERE name = 'Cursor'").get() as { id: string };
    const home = await browser.open(`${GULPY}/`);
    await browser.open(`${GULPY}/apps/${app.id}/revoke`, { form: { csrf: field(home.html, "csrf") } });
    const after = await tools(key);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("invalid_token");
  });

  test("the guide and the script name the real address", async () => {
    const guide = await world.fetch(`${GULPY}/agents.md`);
    expect(guide.headers.get("content-type")).toContain("text/markdown");
    const text = await guide.text();
    expect(text).toContain(`curl -fsSL ${GULPY}/connect.sh | sh`);
    expect(text).toContain(`${GULPY}/v1/tools`);
    const script = await (await world.fetch(`${GULPY}/connect.sh`)).text();
    expect(script).toContain(`BASE="${GULPY}"`);
    expect(script.startsWith("#!/bin/sh")).toBe(true);
    const metadata = await (await world.fetch(`${GULPY}/.well-known/oauth-authorization-server`)).json();
    expect(metadata.device_authorization_endpoint).toBe(`${GULPY}/device/code`);
  });
});
