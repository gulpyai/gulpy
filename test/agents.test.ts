/**
 * Connectors that are MCP servers, and agents that sign in with standard MCP
 * authorization. The test agent uses the MCP SDK, as real agents do.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { isAllowedRedirect, isTrustedReturn, redirectMatches } from "../src/agents.ts";
import {
  addConnector,
  agentRequest,
  ALICE,
  BOB,
  choices,
  CODE,
  GULPY,
  createWorld,
  field,
  leaveAddress,
  NOTES,
  TASKS,
  TestAgent,
  type Browser,
  type World,
} from "./harness.ts";

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

describe("an agent signs in with standard MCP authorization", () => {
  beforeEach(async () => {
    await addConnector(browser, "acme-notes");
    await addConnector(browser, "acme-tasks");
  });

  test("the agent finds Gulpy, registers itself, and gets the tools of all connectors", async () => {
    const orbit = new TestAgent(world, "Orbit");
    const consent = await orbit.start(browser);

    expect(hits(`GET ${GULPY}/.well-known/oauth-protected-resource/mcp`)).toBeGreaterThan(0);
    expect(hits(`POST ${GULPY}/oauth/register`)).toBe(1);
    expect(consent.html).toContain("Let Orbit use your tools?");
    expect(consent.html).toContain("orbit.agent.test");
    expect(consent.html).toContain("did not verify");
    expect(choices(consent.html)).toHaveLength(2);
    expect(choices(consent.html).every((choice) => choice.checked)).toBe(true);

    const back = await orbit.allow(browser, consent);
    expect(back.origin).toBe("https://orbit.agent.test");
    expect(back.searchParams.get("iss")).toBe(GULPY);
    expect(orbit.saved?.refresh_token).toStartWith("refresh_");
    expect(orbit.saved?.expires_in).toBe(3600);

    expect(await orbit.toolNames()).toEqual([
      "acme_notes_create_note",
      "acme_notes_get_note",
      "acme_notes_search_notes",
      "acme_tasks_complete_task",
      "acme_tasks_create_task",
      "acme_tasks_list_tasks",
      "list_connections",
    ]);

    const found = await orbit.call("acme_notes_search_notes", { query: "plan" });
    expect(found.isError).toBe(false);
    expect(JSON.parse(found.text)).toEqual([{ id: "note-1", title: "Q4 plan" }]);

    const created = await orbit.call("acme_tasks_create_task", { title: "Call Dana" });
    expect(JSON.parse(created.text)).toMatchObject({ title: "Call Dana", done: false });
    expect(world.connectors[TASKS]?.calls).toContain("create_task alice@acme.test");
  });

  test("a second agent gets the same tools with one tap, and the connectors are not contacted for sign-in", async () => {
    await new TestAgent(world, "Orbit").connect(browser);
    const authorizeBefore = hits(`GET ${NOTES}/authorize`) + hits(`GET ${TASKS}/authorize`);

    const scout = new TestAgent(world, "Scout");
    const consent = await scout.start(browser);
    expect(consent.html).toContain("Let Scout use your tools?");
    expect(choices(consent.html).filter((choice) => choice.checked)).toHaveLength(2);
    await scout.allow(browser, consent);

    expect(hits(`GET ${NOTES}/authorize`) + hits(`GET ${TASKS}/authorize`)).toBe(authorizeBefore);
    expect(await scout.toolNames()).toHaveLength(7);
  });

  test("read access gives only the tools that read", async () => {
    const notes = connectionId("acme-notes");
    const orbit = new TestAgent(world, "Orbit");
    await orbit.connect(browser, { levels: { [notes]: "read" } });

    const names = await orbit.toolNames();
    expect(names).toContain("acme_notes_search_notes");
    expect(names).not.toContain("acme_notes_create_note");
    expect(names).toContain("acme_tasks_create_task");

    const blocked = await orbit.call("acme_notes_create_note", { title: "Hidden" });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("not_granted");
    expect(world.connectors[NOTES]?.calls).not.toContain("create_note alice@acme.test");
  });

  test("a connector that does not say which tools only read gives nothing for read access", async () => {
    await addConnector(browser, "acme-code");
    const code = connectionId("acme-code");

    const reader = new TestAgent(world, "Reader");
    await reader.connect(browser, { levels: { [code]: "read" } });
    expect((await reader.toolNames()).filter((name) => name.startsWith("acme_code"))).toEqual([]);

    const writer = new TestAgent(world, "Writer");
    await writer.connect(browser);
    expect((await writer.toolNames()).filter((name) => name.startsWith("acme_code"))).toHaveLength(3);
    expect(world.connectors[CODE]?.calls).toEqual([]);
  });

  test("the agent gets only the connections that the user selects", async () => {
    const notes = connectionId("acme-notes");
    const orbit = new TestAgent(world, "Orbit");
    await orbit.connect(browser, { select: [notes] });
    expect((await orbit.toolNames()).some((name) => name.startsWith("acme_tasks"))).toBe(false);

    // The user approves again with a different selection. The new selection replaces the old one.
    const tasks = connectionId("acme-tasks");
    orbit.forget();
    await orbit.connect(browser, { select: [tasks] });
    const names = await orbit.toolNames();
    expect(names.some((name) => name.startsWith("acme_notes"))).toBe(false);
    expect(names).toContain("acme_tasks_list_tasks");
  });

  test("two accounts of one connector get different tool names", async () => {
    await addConnector(browser, "acme-notes", BOB);
    const orbit = new TestAgent(world, "Orbit");
    await orbit.connect(browser);
    const names = await orbit.toolNames();
    expect(names).toContain("acme_notes_search_notes");
    expect(names).toContain("acme_notes2_search_notes");

    const mine = [await orbit.call("acme_notes_search_notes"), await orbit.call("acme_notes2_search_notes")].map(
      (result) => (JSON.parse(result.text) as unknown[]).length,
    );
    expect(mine.sort()).toEqual([1, 3]);
  });

  test("the user adds a connector from the approval page and returns to it", async () => {
    const orbit = new TestAgent(world, "Orbit");
    const consent = await orbit.start(browser);
    expect(consent.html).toContain("Add a tool");

    const here = new URL(consent.url);
    const next = here.pathname + here.search;
    const back = await addConnector(browser, "acme-code", ALICE, next);
    expect(back.url).toContain("/oauth/authorize?");
    expect(back.url).toContain("connected=conn_");
    expect(choices(back.html)).toHaveLength(3);
    await orbit.allow(browser, back);
    expect(await orbit.toolNames()).toHaveLength(10);
  });

  test("the user removes the access. The tokens of the agent stop", async () => {
    const orbit = new TestAgent(world, "Orbit");
    await orbit.connect(browser);
    const appId = (world.gulpy.deps.store.db.query("SELECT id FROM apps WHERE name = 'Orbit'").get() as { id: string }).id;

    const dashboard = await browser.open(`${GULPY}/`);
    expect(dashboard.html).toContain("Orbit");
    expect(dashboard.html).toContain("Read and write");
    await browser.open(`${GULPY}/apps/${appId}/revoke`, { form: { csrf: field(dashboard.html, "csrf") }, from: dashboard.url });

    const refresh = await world.fetch(`${GULPY}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: orbit.saved?.refresh_token ?? "",
        client_id: orbit.client?.client_id ?? "",
      }),
    });
    expect(refresh.status).toBe(400);
    const call = await world.fetch(`${GULPY}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${orbit.saved?.access_token}` },
      body: "{}",
    });
    expect(call.status).toBe(401);
    expect(call.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource");
  });

  test("the dashboard shows each tool call, and not the content", async () => {
    const orbit = new TestAgent(world, "Orbit");
    await orbit.connect(browser);
    await orbit.call("acme_notes_search_notes", { query: "private words" });
    const dashboard = await browser.open(`${GULPY}/`);
    expect(dashboard.html).toContain("</strong> used<code>acme-notes.search_notes</code>");
    expect(dashboard.html).toContain("acme-notes.search_notes");
    expect(dashboard.html).not.toContain("private words");
  });
});

describe("no approval step", () => {
  const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
  const LOCAL = "http://localhost:52905/callback";
  const count = (table: string) => (world.gulpy.deps.store.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  beforeEach(async () => {
    await addConnector(browser, "acme-notes");
    await addConnector(browser, "acme-tasks");
  });

  test("a program on the computer of the user gets the tools with no tap", async () => {
    const codex = new TestAgent(world, "Codex", LOCAL);
    const page = await codex.start(browser);
    expect(page.html).toContain("All set");
    expect(page.html).not.toContain('value="allow"');

    const back = await codex.finish(page);
    expect(back.origin).toBe("http://localhost:52905");
    expect(back.searchParams.get("state")).toBe("state-Codex");
    expect(await codex.toolNames()).toHaveLength(7);

    const created = await codex.call("acme_tasks_create_task", { title: "Call Dana" });
    expect(created.isError).toBe(false);
    const dashboard = await browser.open(`${GULPY}/`);
    expect(dashboard.html).toContain("Read and write · automatic");
  });

  test("an agent on the site of a company that Gulpy knows gets the tools with no tap", async () => {
    const claude = new TestAgent(world, "Claude", CLAUDE);
    const back = await claude.connectWithNoTap(browser);
    expect(back.origin).toBe("https://claude.ai");
    expect(await claude.toolNames()).toHaveLength(7);
  });

  test("an agent on a site that Gulpy does not know needs the approval of the user", async () => {
    const orbit = new TestAgent(world, "Orbit");
    const page = await orbit.start(browser);
    expect(page.html).toContain("Let Orbit use your tools?");
    expect(count("grants")).toBe(0);
    expect(count("auth_codes")).toBe(0);
  });

  test("the name of an agent is not proof. The return address is", async () => {
    const copy = new TestAgent(world, "Claude", "https://claude.ai.evil.test/api/mcp/auth_callback");
    const page = await copy.start(browser);
    expect(page.html).toContain("Let Claude use your tools?");
    expect(page.html).toContain("did not verify");
    expect(count("auth_codes")).toBe(0);

    for (const bad of ["https://evil.test/claude.ai", "https://claude.ai.evil.test/cb", "http://claude.ai/cb", "https://localhost/cb", "evil://cb", "no address"]) {
      expect([bad, isTrustedReturn(bad)]).toEqual([bad, false]);
    }
    for (const good of [CLAUDE, LOCAL, "http://127.0.0.1:4000/cb", "https://chatgpt.com/connector_platform_oauth_redirect", "cursor://anysphere.cursor-mcp/oauth/callback"]) {
      expect([good, isTrustedReturn(good)]).toEqual([good, true]);
    }
  });

  test("a person who is not signed in signs in, and then the agent gets the tools", async () => {
    const fresh = world.browser();
    const claude = new TestAgent(world, "Claude", CLAUDE);
    const signIn = await claude.start(fresh);
    expect(signIn.html).toContain("Then Claude gets your tools.");

    const here = new URL(signIn.url);
    const page = await fresh.signIn(world, EMAIL, here.pathname + here.search);
    expect(page.html).toContain("All set");
    await claude.finish(page);
    expect(await claude.toolNames()).toHaveLength(7);
  });

  test("a new user adds the first tool on the approval page. Then the agent gets it with no tap", async () => {
    const fresh = world.browser();
    await fresh.signIn(world, "new@example.com");
    const claude = new TestAgent(world, "Claude", CLAUDE);
    const empty = await claude.start(fresh);
    expect(empty.html).toContain("You have no tools yet");

    const here = new URL(empty.url);
    const page = await addConnector(fresh, "acme-code", BOB, here.pathname + here.search);
    expect(page.html).toContain("All set");
    await claude.finish(page);
    expect(await claude.toolNames()).toEqual(["acme_code_create_issue", "acme_code_list_issues", "acme_code_list_repositories", "list_connections"]);
  });

  test("a new tool goes to each agent of the user", async () => {
    const codex = new TestAgent(world, "Codex", LOCAL);
    await codex.connectWithNoTap(browser);
    const orbit = new TestAgent(world, "Orbit");
    await orbit.connect(browser);
    expect(await codex.toolNames()).toHaveLength(7);

    await addConnector(browser, "acme-code");
    expect((await codex.toolNames()).filter((name) => name.startsWith("acme_code"))).toHaveLength(3);
    expect((await orbit.toolNames()).filter((name) => name.startsWith("acme_code"))).toHaveLength(3);
  });

  test("a new tool does not go to the agents of a different user, or to an agent that the user removed", async () => {
    const codex = new TestAgent(world, "Codex", LOCAL);
    await codex.connectWithNoTap(browser);
    const other = world.browser();
    await other.signIn(world, "other@example.com");
    await addConnector(other, "acme-notes", BOB);
    const theirs = new TestAgent(world, "Scout", "http://127.0.0.1:7000/callback");
    await theirs.connectWithNoTap(other);

    const dashboard = await browser.open(`${GULPY}/`);
    const appId = (world.gulpy.deps.store.db.query("SELECT id FROM apps WHERE name = 'Codex'").get() as { id: string }).id;
    await browser.open(`${GULPY}/apps/${appId}/revoke`, { form: { csrf: field(dashboard.html, "csrf") }, from: dashboard.url });

    await addConnector(browser, "acme-code");
    expect(count("grants")).toBe(1);
    expect(await theirs.toolNames()).toEqual(["acme_notes_create_note", "acme_notes_get_note", "acme_notes_search_notes", "list_connections"]);
  });

  test("an agent that has read access only gets a new tool with read access", async () => {
    const notes = connectionId("acme-notes");
    const tasks = connectionId("acme-tasks");
    const orbit = new TestAgent(world, "Orbit");
    await orbit.connect(browser, { levels: { [notes]: "read", [tasks]: "read" } });

    await addConnector(browser, "acme-notes", BOB);
    const names = await orbit.toolNames();
    expect(names).toContain("acme_notes2_search_notes");
    expect(names).not.toContain("acme_notes2_create_note");
  });

  test("a second sign-in at a connector does not give back a tool that the user did not select", async () => {
    const notes = connectionId("acme-notes");
    const orbit = new TestAgent(world, "Orbit");
    await orbit.connect(browser, { select: [notes] });

    await addConnector(browser, "acme-tasks");
    expect((await orbit.toolNames()).some((name) => name.startsWith("acme_tasks"))).toBe(false);
  });

  test("an agent that connects again keeps what it has", async () => {
    const codex = new TestAgent(world, "Codex", LOCAL);
    await codex.connectWithNoTap(browser);
    const tasks = connectionId("acme-tasks");
    world.gulpy.deps.store.deleteGrantFor(
      (world.gulpy.deps.store.db.query("SELECT id FROM apps WHERE name = 'Codex'").get() as { id: string }).id,
      tasks,
    );

    codex.forget();
    await codex.connectWithNoTap(browser);
    const names = await codex.toolNames();
    expect(names).toContain("acme_notes_search_notes");
    expect(names.some((name) => name.startsWith("acme_tasks"))).toBe(false);
  });

  test("if no tool works, the user sees the page with the button to connect again", async () => {
    const { store } = world.gulpy.deps;
    store.setConnectionStatus(connectionId("acme-notes"), "needs_reauth");
    store.setConnectionStatus(connectionId("acme-tasks"), "needs_reauth");
    const codex = new TestAgent(world, "Codex", LOCAL);
    const page = await codex.start(browser);
    expect(page.html).toContain("Reconnect");
    expect(count("auth_codes")).toBe(0);
  });

  test("the operator can turn the automatic approval off", async () => {
    world = await createWorld({ autoApprove: false });
    browser = world.browser();
    await browser.signIn(world, EMAIL);
    await addConnector(browser, "acme-notes");

    const claude = new TestAgent(world, "Claude", CLAUDE);
    const page = await claude.start(browser);
    expect(page.html).toContain("Let Claude use your tools?");
    await claude.allow(browser, page);

    await addConnector(browser, "acme-tasks");
    expect((await claude.toolNames()).some((name) => name.startsWith("acme_tasks"))).toBe(false);
  });
});

describe("token life", () => {
  beforeEach(async () => {
    await addConnector(browser, "acme-notes");
  });

  test("an access token of an agent stops after 1 hour. The refresh token gives a new one", async () => {
    const orbit = new TestAgent(world, "Orbit");
    await orbit.connect(browser);
    const first = orbit.saved?.access_token;

    world.advance(61 * 60_000);
    const stale = await world.fetch(`${GULPY}/mcp`, { method: "POST", headers: { authorization: `Bearer ${first}` }, body: "{}" });
    expect(stale.status).toBe(401);

    // The SDK sees the 401 and uses the refresh token.
    expect(await orbit.toolNames()).toContain("acme_notes_search_notes");
    expect(orbit.saved?.access_token).not.toBe(first);
  });

  test("a refresh token works one time. A second use cancels all tokens of that sign-in", async () => {
    const orbit = new TestAgent(world, "Orbit");
    await orbit.connect(browser);
    const stolen = orbit.saved?.refresh_token ?? "";
    const refresh = (token: string) =>
      world.fetch(`${GULPY}/oauth/token`, {
        method: "POST",
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: orbit.client?.client_id ?? "" }),
      });

    const good = await refresh(stolen);
    expect(good.status).toBe(200);
    const next = (await good.json()) as { access_token: string; refresh_token: string };

    expect((await refresh(stolen)).status).toBe(400);
    expect((await refresh(next.refresh_token)).status).toBe(400);
    const call = await world.fetch(`${GULPY}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${next.access_token}` },
      body: "{}",
    });
    expect(call.status).toBe(401);
  });

  test("Gulpy refreshes the token of a connector", async () => {
    const orbit = new TestAgent(world, "Orbit");
    await orbit.connect(browser);
    const before = hits(`POST ${NOTES}/token`);
    world.advance(10 * 60_000);
    expect((await orbit.call("acme_notes_search_notes")).isError).toBe(false);
    expect(hits(`POST ${NOTES}/token`)).toBe(before + 1);
  });

  test("if the connector cancels the token, the tools go away until the user reconnects", async () => {
    const orbit = new TestAgent(world, "Orbit");
    await orbit.connect(browser);
    world.connectors[NOTES]?.revokeAccount(ALICE);
    world.advance(10 * 60_000);

    const broken = await orbit.call("acme_notes_search_notes");
    expect(broken.isError).toBe(true);
    expect(broken.text).toContain("connection_needs_reauth");
    expect(await orbit.toolNames()).toEqual(["list_connections"]);
    expect((await browser.open(`${GULPY}/`)).html).toContain("Sign in again");

    await addConnector(browser, "acme-notes");
    expect(await orbit.toolNames()).toContain("acme_notes_search_notes");
  });
});

describe("rules for agents", () => {
  const register = (body: unknown) =>
    world.fetch(`${GULPY}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("the metadata follows the MCP specification", async () => {
    const resource = (await (await world.fetch(`${GULPY}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    expect(resource).toMatchObject({ resource: `${GULPY}/mcp`, authorization_servers: [GULPY] });

    const server = (await (await world.fetch(`${GULPY}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(server).toMatchObject({
      issuer: GULPY,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    expect(server.registration_endpoint).toBe(`${GULPY}/oauth/register`);

    const unauthorized = await world.fetch(`${GULPY}/mcp`, { method: "POST", body: "{}" });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${GULPY}/.well-known/oauth-protected-resource"`,
    );
  });

  test("a redirect address cannot start a script or go to a plain http site", () => {
    for (const good of ["https://agent.example/callback", "http://localhost:3000/cb", "http://127.0.0.1/cb", "cursor://auth/callback"]) {
      expect([good, isAllowedRedirect(good)]).toEqual([good, true]);
    }
    for (const bad of ["http://agent.example/cb", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "https://a.example/#x", "not a url", 5]) {
      expect([bad, isAllowedRedirect(bad)]).toEqual([bad, false]);
    }
  });

  test("registration refuses a bad redirect address", async () => {
    expect((await register({ client_name: "Bad", redirect_uris: ["javascript:alert(1)"] })).status).toBe(400);
    expect((await register({ client_name: "Bad", redirect_uris: [] })).status).toBe(400);
    expect((await register({ client_name: "Bad" })).status).toBe(400);
    expect((await register("text")).status).toBe(400);
    const good = await register({ client_name: "Good\u0000 agent", redirect_uris: ["https://good.agent.test/cb"] });
    expect(good.status).toBe(201);
    expect(await good.json()).toMatchObject({ client_name: "Good agent", token_endpoint_auth_method: "none" });
  });

  test("Gulpy does not redirect to an address that is not registered", async () => {
    const client = (await (await register({ client_name: "Orbit", redirect_uris: ["https://orbit.agent.test/callback"] })).json()) as {
      client_id: string;
    };
    const query = (extra: Record<string, string>) =>
      `${GULPY}/oauth/authorize?${new URLSearchParams({
        client_id: client.client_id,
        response_type: "code",
        code_challenge: "x".repeat(43),
        code_challenge_method: "S256",
        redirect_uri: "https://orbit.agent.test/callback",
        state: "abc",
        ...extra,
      })}`;

    const wrongAddress = await browser.open(query({ redirect_uri: "https://evil.test/callback" }));
    expect(wrongAddress.status).toBe(400);
    expect(wrongAddress.url).toStartWith(GULPY);

    const unknown = await browser.open(query({ client_id: "agent_unknown" }));
    expect(unknown.status).toBe(400);

    // For an agent that is known, the error goes to the agent.
    const noPkce = await world.fetch(query({ code_challenge_method: "plain" }), { redirect: "manual" });
    const location = new URL(noPkce.headers.get("location") ?? "");
    expect(location.origin).toBe("https://orbit.agent.test");
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.get("state")).toBe("abc");

    const wrongResource = await world.fetch(query({ resource: "https://other.test/mcp" }), { redirect: "manual" });
    expect(new URL(wrongResource.headers.get("location") ?? "").searchParams.get("error")).toBe("invalid_target");
  });

  test("a program on the computer of the user can use any port on localhost (RFC 8252)", async () => {
    // Codex and Claude Code register `http://localhost/callback` and then listen on a port that they get at start.
    expect(redirectMatches("http://localhost/callback", "http://localhost:52905/callback")).toBe(true);
    expect(redirectMatches("http://127.0.0.1/callback", "http://127.0.0.1:60740/callback")).toBe(true);
    expect(redirectMatches("http://localhost/callback", "http://localhost:52905/other")).toBe(false);
    expect(redirectMatches("http://localhost/callback", "http://127.0.0.1:52905/callback")).toBe(false);
    expect(redirectMatches("https://orbit.agent.test/callback", "https://orbit.agent.test:8443/callback")).toBe(false);
    expect(redirectMatches("http://localhost/callback", "http://localhost:52905/callback#x")).toBe(false);

    const client = (await (
      await register({ client_name: "Codex", redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"] })
    ).json()) as { client_id: string };
    const query = (redirectUri: string) =>
      `${GULPY}/oauth/authorize?${new URLSearchParams({
        client_id: client.client_id,
        response_type: "code",
        code_challenge: "x".repeat(43),
        code_challenge_method: "S256",
        redirect_uri: redirectUri,
        state: "abc",
      })}`;

    const withPort = await browser.open(query("http://localhost:52905/callback"));
    expect(withPort.status).not.toBe(400);

    const otherPath = await browser.open(query("http://localhost:52905/other"));
    expect(otherPath.status).toBe(400);
  });

  test("a code works one time, only with the correct verifier", async () => {
    await addConnector(browser, "acme-notes");
    const orbit = new TestAgent(world, "Orbit");
    const consent = await orbit.start(browser);
    const form: Record<string, string | string[]> = {
      ...agentRequest(consent.html),
      csrf: field(consent.html, "csrf"),
      decision: "allow",
      connection: choices(consent.html).map((choice) => choice.id),
    };
    const page = await browser.open(`${GULPY}/oauth/authorize`, { form, from: consent.url });
    const code = new URL(leaveAddress(page.html)).searchParams.get("code") ?? "";

    const exchange = (verifier: string) =>
      world.fetch(`${GULPY}/oauth/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: orbit.redirect,
          client_id: orbit.client?.client_id ?? "",
          code_verifier: verifier,
        }),
      });
    const wrong = await exchange("wrong-verifier-wrong-verifier-wrong-verifier");
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toBe("invalid_grant");
    // The wrong attempt used the code. The correct verifier is too late.
    expect((await exchange(orbit.codeVerifier())).status).toBe(400);
  });

  test("a form on a different site cannot approve an agent", async () => {
    await addConnector(browser, "acme-notes");
    const orbit = new TestAgent(world, "Orbit");
    const consent = await orbit.start(browser);
    const form: Record<string, string | string[]> = {
      ...agentRequest(consent.html),
      decision: "allow",
      connection: choices(consent.html).map((choice) => choice.id),
    };
    const crossSite = await browser.open(`${GULPY}/oauth/authorize`, {
      form: { ...form, csrf: field(consent.html, "csrf") },
      from: "https://evil.test/page",
    });
    expect(crossSite.status).toBe(403);
    const noToken = await browser.open(`${GULPY}/oauth/authorize`, { form: { ...form, csrf: "csrf_guess" }, from: consent.url });
    expect(noToken.status).toBe(403);
    expect(world.gulpy.deps.store.db.query("SELECT COUNT(*) AS n FROM grants").get()).toEqual({ n: 0 });
  });

  test("the user cancels. The agent gets an error and no access", async () => {
    await addConnector(browser, "acme-notes");
    const orbit = new TestAgent(world, "Orbit");
    const consent = await orbit.start(browser);
    const form: Record<string, string> = { ...agentRequest(consent.html), csrf: field(consent.html, "csrf"), decision: "deny" };
    const page = await browser.open(`${GULPY}/oauth/authorize`, { form, from: consent.url });
    const back = new URL(leaveAddress(page.html));
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
    expect(world.gulpy.deps.store.db.query("SELECT COUNT(*) AS n FROM grants").get()).toEqual({ n: 0 });
  });

  test("an agent can use a client ID metadata document and not registration", async () => {
    await addConnector(browser, "acme-notes");
    const address = "https://docs.agent.test/oauth/client.json";
    world.documents.set(address, {
      client_id: address,
      client_name: "Docs Agent",
      redirect_uris: ["https://docs.agent.test/callback"],
      token_endpoint_auth_method: "none",
    });

    const agent = new TestAgent(world, "Docs", "https://docs.agent.test/callback", address);
    const consent = await agent.start(browser);
    expect(hits(`POST ${GULPY}/oauth/register`)).toBe(0);
    expect(consent.html).toContain("Let Docs Agent use your tools?");
    await agent.allow(browser, consent);
    expect(await agent.toolNames()).toContain("acme_notes_search_notes");
  });

  test("a metadata document must name its own address", async () => {
    const address = "https://fake.agent.test/client.json";
    world.documents.set(address, {
      client_id: "https://docs.agent.test/oauth/client.json",
      client_name: "Docs Agent",
      redirect_uris: ["https://fake.agent.test/callback"],
    });
    const query = new URLSearchParams({
      client_id: address,
      response_type: "code",
      code_challenge: "x".repeat(43),
      code_challenge_method: "S256",
      redirect_uri: "https://fake.agent.test/callback",
    });
    expect((await browser.open(`${GULPY}/oauth/authorize?${query}`)).status).toBe(400);

    for (const bad of ["https://10.0.0.5/client.json", "https://localhost/client.json", "http://docs.agent.test/client.json", "https://docs.agent.test/"]) {
      query.set("client_id", bad);
      expect([bad, (await browser.open(`${GULPY}/oauth/authorize?${query}`)).status]).toEqual([bad, 400]);
    }
    expect(world.requests.some((request) => request.includes("10.0.0.5") || request.includes("https://localhost"))).toBe(false);
  });

  test("the endpoints for agents permit other origins. The pages do not", async () => {
    const token = await world.fetch(`${GULPY}/oauth/token`, { method: "POST", headers: { origin: "https://web.agent.test" }, body: "" });
    expect(token.headers.get("access-control-allow-origin")).toBe("*");
    const metadata = await world.fetch(`${GULPY}/.well-known/oauth-authorization-server`, { headers: { origin: "https://web.agent.test" } });
    expect(metadata.headers.get("access-control-allow-origin")).toBe("*");
    const mcp = await world.fetch(`${GULPY}/mcp`, { method: "POST", headers: { origin: "https://web.agent.test" }, body: "{}" });
    expect(mcp.headers.get("access-control-allow-origin")).toBe("*");

    const page = await world.fetch(`${GULPY}/`, { headers: { origin: "https://web.agent.test" } });
    expect(page.headers.get("access-control-allow-origin")).toBeNull();
    const authorize = await world.fetch(`${GULPY}/oauth/authorize`, { headers: { origin: "https://web.agent.test" } });
    expect(authorize.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("a new user with no connections sees the list of connectors on the approval page", async () => {
    const fresh = world.browser();
    const orbit = new TestAgent(world, "Orbit");
    const signIn = await orbit.start(fresh);
    expect(signIn.html).toContain("Orbit wants to use your tools");

    const here = new URL(signIn.url);
    const consent = await fresh.signIn(world, "new@example.com", here.pathname + here.search);
    expect(consent.html).toContain("You have no tools yet");
    expect(consent.html).toContain("Acme Notes");
    expect(consent.html).toMatch(/<button[^>]*value="allow"[^>]*disabled/);
  });
});
