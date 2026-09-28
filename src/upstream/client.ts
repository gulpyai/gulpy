/** Gulpy as an MCP client of an upstream server. It lists the tools and calls them. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BRAND } from "../brand.ts";
import type { Connector } from "../catalog.ts";
import type { Deps } from "../deps.ts";
import type { Connection, UpstreamTool } from "../store.ts";
import type { Vault } from "../vault.ts";
import { upstreamTokens } from "./oauth.ts";

const MAX_TOOLS = 200;
const MAX_DESCRIPTION = 1200;
const CALL_TIMEOUT_MS = 60_000;

async function withClient<T>(
  deps: Deps,
  vault: Vault,
  connection: Connection,
  connector: Connector,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  if (connector.source.kind !== "mcp") throw new Error(`${connector.name} is not an MCP connector`);
  const authorized = vault.fetcher(connection, upstreamTokens(deps, connector));
  const transport = new StreamableHTTPClientTransport(new URL(connector.source.url), {
    fetch: (url, init) => authorized(url, init),
  });
  const client = new Client({ name: BRAND.name.toLowerCase(), version: "0.1.0" });
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Reads the tools of the upstream server. */
export function fetchTools(deps: Deps, vault: Vault, connection: Connection, connector: Connector): Promise<UpstreamTool[]> {
  return withClient(deps, vault, connection, connector, async (client) => {
    const tools: UpstreamTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const tool of page.tools) {
        tools.push({
          name: tool.name,
          title: tool.title ?? tool.annotations?.title,
          // The text comes from a different company and goes to an AI model. Keep it short.
          description: tool.description?.slice(0, MAX_DESCRIPTION),
          inputSchema: tool.inputSchema as Record<string, unknown>,
          // A tool that does not say that it only reads is treated as a tool that writes.
          readOnly: tool.annotations?.readOnlyHint === true,
        });
      }
      cursor = page.nextCursor;
    } while (cursor && tools.length < MAX_TOOLS);
    return tools.slice(0, MAX_TOOLS);
  });
}

export function callTool(
  deps: Deps,
  vault: Vault,
  connection: Connection,
  connector: Connector,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return withClient(deps, vault, connection, connector, async (client) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
    return result as CallToolResult;
  });
}
