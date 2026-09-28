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
import type { CapabilityId } from "../capabilities.ts";
import type { Deps } from "../deps.ts";
import { MAX_LIMIT, type Gulpy } from "../service.ts";
import { parseNewEmail, parseNewEvent } from "./api.ts";

type Args = Record<string, unknown>;

/** A tool that Gulpy supplies itself, for a provider that has no MCP server of its own. */
interface OwnTool {
  /** The agent gets the tool only if the user gave this capability. Null: all agents get it. */
  needs: CapabilityId | null;
  tool: Tool;
  run(access: Access, args: Args): unknown;
}

const text = (description: string) => ({ type: "string", description }) as const;
const connectionId = text("Connection to use. Necessary only if the user shared more than one account. See list_connections.");
const limit = { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: "Maximum number of items. Default 20." } as const;
const optional = (value: unknown) => (typeof value === "string" ? value : undefined);

function ownTools(gulpy: Gulpy): OwnTool[] {
  return [
    {
      needs: null,
      tool: {
        name: "list_connections",
        title: "List connected accounts",
        description: "Lists the accounts that the user shared with this agent, and the permissions for each account.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
      run: (access) => gulpy.connections(access),
    },
    {
      needs: "email.read",
      tool: {
        name: "email_search",
        title: "Search email",
        description:
          "Lists email messages, newest first, from the accounts that the user shared. Returns summaries. Use email_read for the full text.",
        inputSchema: {
          type: "object",
          properties: { query: text("Search words. Omit to get the newest messages."), limit, connection_id: connectionId },
        },
        annotations: { readOnlyHint: true },
      },
      run: (access, args) =>
        gulpy.listMessages(access, {
          connectionId: optional(args.connection_id),
          query: optional(args.query),
          limit: args.limit,
        }),
    },
    {
      needs: "email.read",
      tool: {
        name: "email_read",
        title: "Read one email",
        description: "Gets the full text of one message. Send the id and the connection_id from email_search.",
        inputSchema: {
          type: "object",
          properties: { id: text("Message id from email_search"), connection_id: connectionId },
          required: ["id"],
        },
        annotations: { readOnlyHint: true },
      },
      run: (access, args) => {
        if (typeof args.id !== "string") throw new ApiError(400, "invalid_request", '"id" is required');
        return gulpy.getMessage(access, { connectionId: optional(args.connection_id), id: args.id });
      },
    },
    {
      needs: "email.send",
      tool: {
        name: "email_send",
        title: "Send email",
        description: "Sends a plain-text email from the address of the user. The message goes out immediately.",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "array", items: { type: "string" }, minItems: 1, description: "Recipient email addresses" },
            cc: { type: "array", items: { type: "string" } },
            subject: { type: "string" },
            body_text: text("Plain text body"),
            connection_id: connectionId,
          },
          required: ["to", "subject", "body_text"],
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      run: (access, args) =>
        gulpy.sendMessage(access, { connectionId: optional(args.connection_id), message: parseNewEmail(args) }),
    },
    {
      needs: "calendar.read",
      tool: {
        name: "calendar_list_events",
        title: "List calendar events",
        description: "Lists calendar events in a time range, earliest first. The default range is the next 7 days.",
        inputSchema: {
          type: "object",
          properties: {
            from: text("Start of the range, ISO 8601. Default: now."),
            to: text("End of the range, ISO 8601. Default: 7 days after the start."),
            limit,
            connection_id: connectionId,
          },
        },
        annotations: { readOnlyHint: true },
      },
      run: (access, args) =>
        gulpy.listEvents(access, {
          connectionId: optional(args.connection_id),
          from: args.from,
          to: args.to,
          limit: args.limit,
        }),
    },
    {
      needs: "calendar.write",
      tool: {
        name: "calendar_create_event",
        title: "Create calendar event",
        description: "Creates an event in the primary calendar of the user.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            start: text("ISO 8601 time with a zone, for example 2026-10-01T15:00:00-04:00"),
            end: text("ISO 8601 time with a zone"),
            location: { type: "string" },
            description: { type: "string" },
            attendees: { type: "array", items: { type: "string" }, description: "Email addresses to invite" },
            connection_id: connectionId,
          },
          required: ["title", "start", "end"],
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      run: (access, args) =>
        gulpy.createEvent(access, { connectionId: optional(args.connection_id), event: parseNewEvent(args) }),
    },
  ];
}

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
