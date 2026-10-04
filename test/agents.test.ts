/**
 * Connectors, and agents that use a key. Gulpy talks to each connector for the
 * user. The agent sees plain HTTP and JSON only.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { addConnector, ALICE, BOB, CODE, GULPY, createWorld, field, keyIn, NOTES, TASKS, TestAgent, type Browser, type World } from "./harness.ts";

const EMAIL = "skyler@example.com";

let world: World;
let browser: Browser;

beforeEach(async () => {
  world = await createWorld();
  browser = world.browser();
  await browser.signIn(world, EMAIL);
});

const hits = (needle: string) => world.requests.filter((request) => request === needle).length;
const connectionId = (provider: string) =>
  (world.gulpy.deps.store.db.query("SELECT id FROM connections WHERE provider = ?").get(provider) as { id: string }).id;

describe("connectors", () => {
  test("the user adds a connector. Gulpy registers itself at the connector with no setup", async () => {
    const catalog = await browser.open(`${GULPY}/`);
    expect(catalog.html).toContain("Acme Notes");
    expect(catalog.html).toContain("Notion");
    expect(catalog.html).toContain('href="/connect/acme-notes?next=%2F"');

    const consent = await browser.open(`${GULPY}/connect/acme-notes?next=%2F`);
    expect(consent.url).toStartWith(`${NOTES}/authorize`);
    expect(hits(`POST ${NOTES}/register`)).toBe(1);
    const sent = new URL(consent.url).searchParams;
    expect(sent.get("redirect_uri")).toBe(`${GULPY}/oauth/callback/mcp`);
    expect(sent.get("code_challenge_method")).toBe("S256");
    expect(sent.get("resource")).toBe(`${NOTES}/mcp`);
    expect(sent.get("scope")).toBe("read write");
    expect(consent.html).toContain("Gulpy wants access to your Acme Notes account");

    const done = await addConnector(browser, "acme-notes");
    expect(done.html).toContain("The connection is added.");
    expect(done.html).toContain("alice@acme.test");
    expect(done.html).toContain("alice@acme.test · 3 tools");
    // The second user of the connector uses the registration that Gulpy has.
    expect(hits(`POST ${NOTES}/register`)).toBe(1);
  });

  test("the tokens and the client registration are encrypted", async () => {
    await addConnector(browser, "acme-notes");
    const { db } = world.gulpy.deps.store;
    const dump = JSON.stringify([db.query("SELECT * FROM connections").all(), db.query("SELECT * FROM upstream_clients").all()]);
    expect(dump).toContain("v1.");
    expect(dump).not.toMatch(/mock\.[A-Za-z0-9_-]{20,}\./);
  });

  test("a connector that needs a registered app is off until the operator sets it up", async () => {
    const page = await browser.open(`${GULPY}/`);
    // GitHub does not permit automatic registration.
    expect(page.html).toMatch(/GitHub[\s\S]{0,400}Soon/);
    const refused = await browser.open(`${GULPY}/connect/github?next=%2F`);
    expect(refused.url).toBe(`${GULPY}/?notice=setup_needed`);
    expect(world.requests.some((request) => request.includes("githubcopilot"))).toBe(false);
  });

  test("the user denies access at the connector. Nothing is stored", async () => {
    const consent = await browser.open(`${GULPY}/connect/acme-notes?next=%2F`);
    const form: Record<string, string> = { account: "" };
    for (const name of ["client_id", "redirect_uri", "response_type", "scope", "state", "code_challenge", "code_challenge_method"]) {
      form[name] = field(consent.html, name);
    }
    const back = await browser.open(`${NOTES}/authorize`, { form, from: consent.url });
    expect(back.url).toBe(`${GULPY}/?notice=denied`);
    expect(world.gulpy.deps.store.db.query("SELECT COUNT(*) AS n FROM connections").get()).toEqual({ n: 0 });
  });

  test("a callback works only in the session that started it", async () => {
    const consent = await browser.open(`${GULPY}/connect/acme-notes?next=%2F`);
    const form: Record<string, string> = { account: ALICE };
    for (const name of ["client_id", "redirect_uri", "response_type", "scope", "state", "code_challenge", "code_challenge_method"]) {
      form[name] = field(consent.html, name);
    }
    const response = await world.fetch(`${NOTES}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      redirect: "manual",
    });
    const callback = response.headers.get("location") ?? "";
    expect(callback).toStartWith(`${GULPY}/oauth/callback/mcp?code=`);

    const other = world.browser();
    await other.signIn(world, "other@example.com");
    expect((await other.open(callback)).status).toBe(400);
    expect(world.gulpy.deps.store.db.query("SELECT COUNT(*) AS n FROM connections").get()).toEqual({ n: 0 });
  });
});

describe("an agent with a key", () => {
  beforeEach(async () => {
    await addConnector(browser, "acme-notes");
    await addConnector(browser, "acme-tasks");
  });

  test("the user makes a key. The page shows a message to paste one time, and Gulpy keeps only a hash", async () => {
    const orbit = new TestAgent(world, "Orbit");
    const page = await orbit.connect(browser);
    expect(page.html).toContain("Paste this into Orbit");
    expect(page.html).toContain(`${GULPY}/agents.md`);
    expect(page.html).toContain("Save these two lines in your memory");
    expect(orbit.key).toStartWith("gulpy_");

    const { db } = world.gulpy.deps.store;
    expect(JSON.stringify(db.query("SELECT * FROM access_tokens").all())).not.toContain(orbit.key);
    expect(db.query("SELECT kind, owner_user_id IS NOT NULL AS owned FROM apps WHERE name = 'Orbit'").get()).toEqual({
      kind: "key",
      owned: 1,
    });

    const later = await browser.open(`${GULPY}/`);
    expect(later.html).not.toContain(orbit.key);
    expect(later.html).toContain("Orbit");
  });

  test("the key gets the tools of all connectors, with no approval step", async () => {
    const orbit = new TestAgent(world, "Orbit");
    await orbit.connect(browser);

    expect(await orbit.toolNames()).toEqual([
      "acme_notes_create_note",
      "acme_notes_get_note",
      "acme_notes_search_notes",
      "acme_tasks_complete_task",
      "acme_tasks_create_task",
      "acme_tasks_list_tasks",
      "list_connections",
    ]);

    const list = (await (await orbit.request("/v1/tools")).json()) as { tools: Record<string, unknown>[] };
    expect(list.tools.find((tool) => tool.name === "acme_notes_search_notes")).toMatchObject({
      read_only: true,
      input: { type: "object" },
    });

    const found = await orbit.call("acme_notes_search_notes", { query: "plan" });
    expect(found.status).toBe(200);
    expect(found.result).toEqual([{ id: "note-1", title: "Q4 plan" }]);

    const created = await orbit.call("acme_tasks_create_task", { title: "Call Dana" });
    expect(created.result).toMatchObject({ title: "Call Dana", done: false });
    expect(world.connectors[TASKS]?.calls).toContain("create_task alice@acme.test");

    const connections = await orbit.call("list_connections");
    expect(connections.result.connections).toHaveLength(2);
  });

  test("a connector that the user adds later is in the key too", async () => {
    const orbit = new TestAgent(world, "Orbit");
    await orbit.connect(browser);
    expect((await orbit.toolNames()).some((name) => name.startsWith("acme_code"))).toBe(false);

    await addConnector(browser, "acme-code");
    expect((await orbit.toolNames()).filter((name) => name.startsWith("acme_code"))).toHaveLength(3);
    expect(world.connectors[CODE]?.calls).toEqual([]);
  });

  test("a second agent gets its own key, and the connectors are not contacted for sign-in", async () => {
    await new TestAgent(world, "Orbit").connect(browser);
    const authorizeBefore = hits(`GET ${NOTES}/authorize`) + hits(`GET ${TASKS}/authorize`);

    const scout = new TestAgent(world, "Scout");
    await scout.connect(browser);
    expect(hits(`GET ${NOTES}/authorize`) + hits(`GET ${TASKS}/authorize`)).toBe(authorizeBefore);
    expect(await scout.toolNames()).toHaveLength(7);
  });

  test("two accounts of one connector get different tool names", async () => {
    await addConnector(browser, "acme-notes", BOB);
    const orbit = new TestAgent(world, "Orbit");
    await orbit.connect(browser);
    const names = await orbit.toolNames();
    expect(names).toContain("acme_notes_search_notes");
    expect(names).toContain("acme_notes2_search_notes");

    const mine = [await orbit.call("acme_notes_search_notes"), await orbit.call("acme_notes2_search_notes")].map(
      (call) => (call.result as unknown[]).length,
    );
    expect(mine.sort()).toEqual([1, 3]);
  });

  test("a tool that does not exist, or a body that is not an object, gets a clear error", async () => {
    const orbit = new TestAgent(world, "Orbit");
    await orbit.connect(browser);
    const missing = await orbit.call("acme_notes_delete_everything");
    expect(missing.status).toBe(403);
    expect(missing.error?.code).toBe("not_granted");

    const bad = await orbit.request("/v1/tools/acme_notes_search_notes", { method: "POST", body: ["not", "an", "object"] });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
  });

  test("the user removes the agent. Its key stops at once", async () => {
    const orbit = new TestAgent(world, "Orbit");
    await orbit.connect(browser);
    const appId = (world.gulpy.deps.store.db.query("SELECT id FROM apps WHERE name = 'Orbit'").get() as { id: string }).id;

    const dashboard = await browser.open(`${GULPY}/`);
    expect(dashboard.html).toContain("Read and write");
    const after = await browser.open(`${GULPY}/apps/${appId}/revoke`, {
      form: { csrf: field(dashboard.html, "csrf") },
      from: dashboard.url,
    });
    expect(after.html).toContain("Its key does not work");
    expect(after.html).toContain("removed a key");

    const call = await orbit.request("/v1/tools");
    expect(call.status).toBe(401);
    expect(((await call.json()) as { error: { code: string } }).error.code).toBe("invalid_token");
  });

  test("the user cannot remove a key of a different user", async () => {
    const orbit = new TestAgent(world, "Orbit");
    await orbit.connect(browser);
    const appId = (world.gulpy.deps.store.db.query("SELECT id FROM apps WHERE name = 'Orbit'").get() as { id: string }).id;

    const other = world.browser();
    const page = await other.signIn(world, "other@example.com");
    await other.open(`${GULPY}/apps/${appId}/revoke`, { form: { csrf: field(page.html, "csrf") }, from: page.url });
    expect((await orbit.request("/v1/tools")).status).toBe(200);
  });

  test("a key reaches only the connections of its own user", async () => {
    const other = world.browser();
    await other.signIn(world, "other@example.com");
    const stranger = new TestAgent(world, "Stranger");
    await stranger.connect(other);
    expect(await stranger.toolNames()).toEqual(["list_connections"]);
    expect((await stranger.call("acme_notes_search_notes")).status).toBe(403);
  });

  test("a form on a different site cannot make a key", async () => {
    const dashboard = await browser.open(`${GULPY}/`);
    const page = await browser.open(`${GULPY}/keys`, {
      form: { csrf: field(dashboard.html, "csrf"), name: "Evil" },
      from: "https://evil.test",
    });
    expect(page.status).toBe(403);
    expect(() => keyIn(page.html)).toThrow();
  });

  test("the dashboard shows each tool call, and not the content", async () => {
    const orbit = new TestAgent(world, "Orbit");
    await orbit.connect(browser);
    await orbit.call("acme_notes_search_notes", { query: "private words" });
    const dashboard = await browser.open(`${GULPY}/`);
    expect(dashboard.html).toContain("</strong> used<code>acme-notes.search_notes</code>");
    expect(dashboard.html).not.toContain("private words");
  });
});

describe("token life", () => {
  beforeEach(async () => {
    await addConnector(browser, "acme-notes");
  });

  test("a key does not expire", async () => {
    const orbit = new TestAgent(world, "Orbit");
    await orbit.connect(browser);
    world.advance(400 * 24 * 60 * 60_000);
    expect((await orbit.request("/v1/tools")).status).toBe(200);
  });

  test("Gulpy refreshes the token of a connector", async () => {
    const orbit = new TestAgent(world, "Orbit");
    await orbit.connect(browser);
    const before = hits(`POST ${NOTES}/token`);
    world.advance(10 * 60_000);
    expect((await orbit.call("acme_notes_search_notes")).status).toBe(200);
    expect(hits(`POST ${NOTES}/token`)).toBe(before + 1);
  });

  test("if the connector cancels the token, the tools go away until the user reconnects", async () => {
    const orbit = new TestAgent(world, "Orbit");
    await orbit.connect(browser);
    world.connectors[NOTES]?.revokeAccount(ALICE);
    world.advance(10 * 60_000);

    const broken = await orbit.call("acme_notes_search_notes");
    expect(broken.status).toBe(409);
    expect(broken.error?.code).toBe("connection_needs_reauth");
    expect(await orbit.toolNames()).toEqual(["list_connections"]);
    expect((await browser.open(`${GULPY}/`)).html).toContain("Sign in again");

    await addConnector(browser, "acme-notes");
    expect(await orbit.toolNames()).toContain("acme_notes_search_notes");
  });
});

describe("the surface for agents", () => {
  test("the guide is plain Markdown at /agents.md, with the address of this Gulpy", async () => {
    const guide = await world.fetch(`${GULPY}/agents.md`);
    expect(guide.status).toBe(200);
    expect(guide.headers.get("content-type")).toContain("text/markdown");
    const text = await guide.text();
    expect(text).toContain(`curl ${GULPY}/v1/tools`);
    expect(text).toContain("Authorization: Bearer");
  });

  test("Gulpy has no MCP server and no OAuth server for agents", async () => {
    for (const path of ["/mcp", "/oauth/register", "/oauth/token", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"]) {
      const response = await world.fetch(`${GULPY}${path}`);
      expect([path, response.status]).toEqual([path, 404]);
    }
  });

  test("the API permits other origins. The pages do not", async () => {
    const api = await world.fetch(`${GULPY}/v1/tools`, { headers: { origin: "https://web.agent.test" } });
    expect(api.headers.get("access-control-allow-origin")).toBe("*");
    const guide = await world.fetch(`${GULPY}/agents.md`, { headers: { origin: "https://web.agent.test" } });
    expect(guide.headers.get("access-control-allow-origin")).toBe("*");
    const page = await world.fetch(`${GULPY}/`, { headers: { origin: "https://web.agent.test" } });
    expect(page.headers.get("access-control-allow-origin")).toBeNull();
  });
});
