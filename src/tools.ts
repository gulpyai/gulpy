/**
 * The tools that an agent calls with plain HTTP: GET /v1/tools lists them, and
 * POST /v1/tools/:name runs one with a JSON body. Some tools are Gulpy's own,
 * for mail and calendar. The others belong to the connectors of the user.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApiError, type Access } from "./access.ts";
import type { CapabilityId } from "./capabilities.ts";
import { parseNewEmail, parseNewEvent } from "./routes/api.ts";
import { MAX_LIMIT, type Gulpy } from "./service.ts";

type Args = Record<string, unknown>;

/** A tool, as the agent sees it. */
export interface ToolInfo {
  name: string;
  description: string;
  /** JSON Schema of the body. */
  input: Record<string, unknown>;
  read_only: boolean;
}

/** A tool that Gulpy supplies itself, for a provider that has no tools of its own. */
interface OwnTool {
  /** The agent gets the tool only if the connection has this capability. Null: each agent gets it. */
  needs: CapabilityId | null;
  info: ToolInfo;
  run(access: Access, args: Args): unknown;
}

const text = (description: string) => ({ type: "string", description }) as const;
const connectionId = text("Connection to use. Necessary only if two or more accounts match. See list_connections.");
const limit = { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: "Maximum number of items. Default 20." } as const;
const optional = (value: unknown) => (typeof value === "string" ? value : undefined);

function ownTools(gulpy: Gulpy): OwnTool[] {
  return [
    {
      needs: null,
      info: {
        name: "list_connections",
        description: "Lists the connected accounts, and what you can do with each one.",
        input: { type: "object", properties: {} },
        read_only: true,
      },
      run: (access) => gulpy.connections(access),
    },
    {
      needs: "email.read",
      info: {
        name: "email_search",
        description: "Lists email messages, newest first. Returns summaries. Use email_read for the full text.",
        input: {
          type: "object",
          properties: { query: text("Search words. Omit to get the newest messages."), limit, connection_id: connectionId },
        },
        read_only: true,
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
      info: {
        name: "email_read",
        description: "Gets the full text of one message. Send the id and the connection_id from email_search.",
        input: {
          type: "object",
          properties: { id: text("Message id from email_search"), connection_id: connectionId },
          required: ["id"],
        },
        read_only: true,
      },
      run: (access, args) => {
        if (typeof args.id !== "string") throw new ApiError(400, "invalid_request", '"id" is required');
        return gulpy.getMessage(access, { connectionId: optional(args.connection_id), id: args.id });
      },
    },
    {
      needs: "email.send",
      info: {
        name: "email_send",
        description: "Sends a plain-text email from the address of the user. The message goes out immediately.",
        input: {
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
        read_only: false,
      },
      run: (access, args) =>
        gulpy.sendMessage(access, { connectionId: optional(args.connection_id), message: parseNewEmail(args) }),
    },
    {
      needs: "calendar.read",
      info: {
        name: "calendar_list_events",
        description: "Lists calendar events in a time range, earliest first. The default range is the next 7 days.",
        input: {
          type: "object",
          properties: {
            from: text("Start of the range, ISO 8601. Default: now."),
            to: text("End of the range, ISO 8601. Default: 7 days after the start."),
            limit,
            connection_id: connectionId,
          },
        },
        read_only: true,
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
      info: {
        name: "calendar_create_event",
        description: "Creates an event in the primary calendar of the user.",
        input: {
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
        read_only: false,
      },
      run: (access, args) =>
        gulpy.createEvent(access, { connectionId: optional(args.connection_id), event: parseNewEvent(args) }),
    },
  ];
}

/**
 * The result of a connector tool, as plain JSON. A connector answers with
 * blocks of text. When the text is JSON, the agent gets the parsed value.
 */
function plain(result: CallToolResult): unknown {
  if (result.structuredContent) return result.structuredContent;
  const texts = result.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
  const joined = texts.join("\n");
  if (texts.length === 1) {
    try {
      return JSON.parse(joined);
    } catch {
      // Plain text.
    }
  }
  return texts.length === result.content.length ? { text: joined } : { content: result.content };
}

export class Tools {
  private readonly own: OwnTool[];

  constructor(private readonly gulpy: Gulpy) {
    this.own = ownTools(gulpy);
  }

  /** Lists only what this key or app can use now. */
  async list(access: Access): Promise<ToolInfo[]> {
    const held = new Set(this.gulpy.connections(access).connections.flatMap((item) => item.capabilities));
    const upstream = await this.gulpy.agentTools(access);
    return [
      ...this.own.filter((item) => item.needs === null || held.has(item.needs)).map((item) => item.info),
      ...upstream.map((item) => ({
        name: item.name,
        description: item.description,
        input: { ...item.inputSchema, type: "object" },
        read_only: item.readOnly,
      })),
    ];
  }

  async call(access: Access, name: string, args: Args): Promise<unknown> {
    const mine = this.own.find((item) => item.info.name === name);
    if (mine) {
      const held = new Set(this.gulpy.connections(access).connections.flatMap((item) => item.capabilities));
      if (mine.needs !== null && !held.has(mine.needs)) {
        throw new ApiError(403, "not_granted", `No connection gives the tool "${name}"`);
      }
      return mine.run(access, args);
    }
    const result = await this.gulpy.callAgentTool(access, name, args);
    const value = plain(result);
    if (result.isError) {
      const message = typeof value === "object" && value && "text" in value ? String(value.text) : JSON.stringify(value);
      throw new ApiError(502, "tool_error", message.slice(0, 2000));
    }
    return value;
  }
}
