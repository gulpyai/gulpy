import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ApiError, authenticateToken, type Access } from "../access.ts";
import { BRAND } from "../brand.ts";
import type { Deps } from "../deps.ts";
import type { Gulpy } from "../service.ts";
import { ownTools } from "../tools.ts";

function failure(error: ApiError): CallToolResult {
  return { isError: true, content: [{ type: "text", text: `${error.code}: ${error.message}` }] };
}

/**
 * One MCP server for all the connections of the user. It has the tools of
 * Gulpy and the tools of each upstream connector. It lists only what the
 * user approved for this agent.
 */
function buildServer(gulpy: Gulpy, access: Access): Server {
  const server = new Server({ name: BRAND.name.toLowerCase(), version: "0.2.0" }, { capabilities: { tools: {} } });
  const own = ownTools(gulpy);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const held = new Set(gulpy.connections(access).connections.flatMap((item) => item.capabilities));
    const upstream = await gulpy.agentTools(access);
    return {
      tools: [
        ...own.filter((item) => item.needs === null || held.has(item.needs)).map((item) => item.tool),
        ...upstream.map((item) => ({
          name: item.name,
          title: item.title,
          description: item.description,
          inputSchema: { ...item.inputSchema, type: "object" as const },
          annotations: { readOnlyHint: item.readOnly },
        })),
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args = {} } = request.params;
    try {
      const mine = own.find((item) => item.tool.name === name);
      if (!mine) return await gulpy.callAgentTool(access, name, args);
      return { content: [{ type: "text", text: JSON.stringify(await mine.run(access, args), null, 2) }] };
    } catch (error) {
      if (error instanceof ApiError) return failure(error);
      throw error;
    }
  });

  return server;
}

/**
 * MCP over Streamable HTTP. The server has no session state: each request
 * reads the grants again, so a change by the user applies to the next call.
 */
export function mcpRoutes(deps: Deps, gulpy: Gulpy): Hono {
  const mcp = new Hono();
  const challenge = `Bearer resource_metadata="${deps.config.baseUrl}/.well-known/oauth-protected-resource"`;

  // An agent that runs in a browser calls this from a different origin. It sends a token, not a cookie.
  mcp.use(
    "*",
    cors({
      origin: "*",
      allowHeaders: ["authorization", "content-type", "mcp-protocol-version", "mcp-session-id", "last-event-id"],
      exposeHeaders: ["www-authenticate", "mcp-session-id"],
    }),
  );

  mcp.all("/", async (c) => {
    const access = authenticateToken(deps, c.req.header("authorization"));
    if (!access) {
      c.header("WWW-Authenticate", challenge);
      return c.json({ jsonrpc: "2.0", error: { code: -32001, message: "The access token is not valid" }, id: null }, 401);
    }
    if (c.req.method !== "POST") {
      c.header("Allow", "POST");
      return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Use POST" }, id: null }, 405);
    }
    const server = buildServer(gulpy, access);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });

  return mcp;
}
