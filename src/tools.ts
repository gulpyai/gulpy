/**
 * The tools of Gulpy, for both ways in: MCP (`/mcp`) and plain HTTP
 * (`GET /v1/tools`, `POST /v1/tools/:name`). Some tools are Gulpy's own, for
 * mail, calendar and files. The others belong to the connectors of the user.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ApiError, type Access } from "./access.ts";
import type { CapabilityId } from "./capabilities.ts";
import { parseNewEmail, parseNewEvent } from "./routes/api.ts";
import { MAX_LIMIT, type Gulpy } from "./service.ts";

type Args = Record<string, unknown>;

/** A tool that Gulpy supplies itself, for a provider that has no MCP server of its own. */
export interface OwnTool {
  /** The agent gets the tool only if the user gave this capability. Null: all agents get it. */
  needs: CapabilityId | null;
  tool: Tool;
  run(access: Access, args: Args): unknown;
}

const text = (description: string) => ({ type: "string", description }) as const;
const connectionId = text("Connection to use. Necessary only if the user shared more than one account. See list_connections.");
const limit = { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: "Maximum number of items. Default 20." } as const;
const optional = (value: unknown) => (typeof value === "string" ? value : undefined);

export function ownTools(gulpy: Gulpy): OwnTool[] {
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
    {
      needs: "files.read",
      tool: {
        name: "files_search",
        title: "Search files",
        description:
          "Searches the files of the user in Google Drive and OneDrive by name and content. Returns names and ids. Use files_read for the text.",
        inputSchema: {
          type: "object",
          properties: {
            query: text("Search words. Omit to get recent files."),
            limit,
            connection_id: connectionId,
          },
        },
        annotations: { readOnlyHint: true },
      },
      run: (access, args) =>
        gulpy.searchFiles(access, {
          connectionId: optional(args.connection_id),
          query: optional(args.query),
          limit: args.limit,
        }),
    },
    {
      needs: "files.read",
      tool: {
        name: "files_read",
        title: "Read one file",
        description:
          "Gets the text of one file. Google Docs, Sheets (first sheet, as CSV), Slides and text files have text. For other types, text is null and the result has a link.",
        inputSchema: {
          type: "object",
          properties: { id: text("File id from files_search"), connection_id: connectionId },
          required: ["id"],
        },
        annotations: { readOnlyHint: true },
      },
      run: (access, args) => {
        if (typeof args.id !== "string") throw new ApiError(400, "invalid_request", '"id" is required');
        return gulpy.readFile(access, { connectionId: optional(args.connection_id), id: args.id });
      },
    },
  ];
}

/** A tool, as an agent sees it on the HTTP API. */
export interface ToolInfo {
  name: string;
  description: string;
  /** JSON Schema of the body. */
  input: Record<string, unknown>;
  read_only: boolean;
}

/** The tools of one agent, with plain HTTP and JSON. */
export class Tools {
  private readonly own: OwnTool[];

  constructor(private readonly gulpy: Gulpy) {
    this.own = ownTools(gulpy);
  }

  async list(access: Access): Promise<ToolInfo[]> {
    const held = new Set(this.gulpy.connections(access).connections.flatMap((item) => item.capabilities));
    const own = this.own
      .filter((item) => item.needs === null || held.has(item.needs))
      .map(({ tool }) => ({
        name: tool.name,
        description: tool.description ?? "",
        input: tool.inputSchema,
        read_only: tool.annotations?.readOnlyHint === true,
      }));
    const upstream = (await this.gulpy.agentTools(access)).map((item) => ({
      name: item.name,
      description: item.description,
      input: { ...item.inputSchema, type: "object" },
      read_only: item.readOnly,
    }));
    return [...own, ...upstream];
  }

  /** Runs one tool. Gulpy's own tools return their JSON; a connector tool returns its MCP result. */
  async call(access: Access, name: string, args: Record<string, unknown>): Promise<unknown> {
    const mine = this.own.find((item) => item.tool.name === name);
    if (mine) {
      const held = new Set(this.gulpy.connections(access).connections.flatMap((item) => item.capabilities));
      if (mine.needs !== null && !held.has(mine.needs)) {
        throw new ApiError(403, "not_granted", `The user did not give access to the tool "${name}"`);
      }
      return mine.run(access, args);
    }
    const result: CallToolResult = await this.gulpy.callAgentTool(access, name, args);
    if (result.isError) {
      const text = result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
      throw new ApiError(502, "tool_error", text || `The tool "${name}" returned an error`);
    }
    return result.structuredContent ?? result.content;
  }
}
