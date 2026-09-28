import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  GULPY,
  connectFirstTime,
  createWorld,
  field,
  type Browser,
  type TestApp,
  type World,
} from "./harness.ts";

const EMAIL = "skyler@example.com";

let world: World;
let browser: Browser;
let app: TestApp;

beforeEach(async () => {
  world = await createWorld();
  browser = world.browser();
  app = world.registerApp("Inbox Pilot", "https://inboxpilot.test");
});

/** Connects with the official MCP client, the same client that agent frameworks use. */
async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "gulpy-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${GULPY}/mcp`), {
    fetch: world.fetch,
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as { type: string; text?: string }[];
  return content.map((item) => item.text ?? "").join("");
}

describe("MCP server", () => {
  test("the agent sees only the tools that the user approved", async () => {
    const token = await connectFirstTime(world, browser, app, {
      email: EMAIL,
      capabilities: ["email.read", "calendar.read"],
    });
    const client = await connect(token);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "calendar_list_events",
      "email_read",
      "email_search",
      "list_connections",
    ]);
    await client.close();
  });

  test("the agent searches and reads email", async () => {
    const token = await connectFirstTime(world, browser, app, { email: EMAIL, capabilities: ["email.read"] });
    const client = await connect(token);

    const search = await client.callTool({ name: "email_search", arguments: { query: "1:1", limit: 5 } });
    expect(search.isError).toBeFalsy();
    const { messages } = JSON.parse(text(search)) as { messages: { id: string; subject: string; connection_id: string }[] };
    expect(messages.map((message) => message.subject)).toEqual(["Can we move our 1:1 to Friday?"]);

    const [message] = messages;
    const read = await client.callTool({
      name: "email_read",
      arguments: { id: message?.id, connection_id: message?.connection_id },
    });
    expect(text(read)).toContain("Is Friday at 10:00 OK for you?");
    await client.close();
  });

  test("the agent sends email and creates an event if the user approved that", async () => {
    const token = await connectFirstTime(world, browser, app, {
      email: EMAIL,
      capabilities: ["email.send", "calendar.read", "calendar.write"],
    });
    const client = await connect(token);

    const sent = await client.callTool({
      name: "email_send",
      arguments: { to: ["dana@lakeshore.example"], subject: "Friday", body_text: "See you then. Reference KX-7741." },
    });
    expect(sent.isError).toBeFalsy();
    expect(world.mock.data.listMessages("acme-1001", "KX-7741", 5)).toHaveLength(1);

    const created = await client.callTool({
      name: "calendar_create_event",
      arguments: { title: "1:1 with Dana", start: "2026-10-02T14:00:00Z", end: "2026-10-02T14:30:00Z" },
    });
    expect(JSON.parse(text(created))).toMatchObject({ title: "1:1 with Dana", start: "2026-10-02T14:00:00.000Z" });

    const bad = await client.callTool({
      name: "email_send",
      arguments: { to: ["not-an-address"], subject: "Hi", body_text: "Text" },
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("invalid_request");
    await client.close();
  });

  test("when the user removes the access, the next call fails", async () => {
    const token = await connectFirstTime(world, browser, app, { email: EMAIL, capabilities: ["email.read"] });
    const client = await connect(token);
    expect((await client.callTool({ name: "email_search", arguments: {} })).isError).toBeFalsy();

    const dashboard = await browser.open(`${GULPY}/`);
    await browser.open(`${GULPY}/apps/${app.id}/revoke`, {
      form: { csrf: field(dashboard.html, "csrf") },
      from: dashboard.url,
    });

    await expect(client.callTool({ name: "email_search", arguments: {} })).rejects.toThrow();
  });

  test("a client with no token cannot connect", async () => {
    await expect(connect("access_wrong")).rejects.toThrow();
  });
});
