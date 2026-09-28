import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApiError, appUserId, grantedConnections, type Access, type GrantedConnection } from "./access.ts";
import { CAPABILITIES, type CapabilityId } from "./capabilities.ts";
import type { Connector } from "./catalog.ts";
import { sha256 } from "./crypto.ts";
import type { Deps } from "./deps.ts";
import { checkNewEmail } from "./providers/mime.ts";
import {
  InputError,
  ProviderError,
  type CalendarEvent,
  type EmailMessage,
  type EmailSummary,
  type NewEmail,
  type NewEvent,
  type Provider,
} from "./providers/types.ts";
import type { Connection, Grant, UpstreamTool } from "./store.ts";
import { callTool, fetchTools } from "./upstream/client.ts";
import { providerTokens, ReauthRequired, type Vault } from "./vault.ts";

export const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const DAY_MS = 24 * 60 * 60_000;

/** Request headers that the proxy passes to the provider. */
const FORWARD_REQUEST_HEADERS = ["accept", "content-type", "if-match", "if-none-match", "prefer"];
/** Response headers that the proxy passes to the app. */
const FORWARD_RESPONSE_HEADERS = ["content-type", "etag", "retry-after"];

const TOOLS_MAX_AGE_MS = 6 * 60 * 60_000;
const TOOL_NAME_MAX = 64;

export interface ConnectionInfo {
  id: string;
  provider: string;
  provider_name: string;
  account: string;
  capabilities: CapabilityId[];
  status: "active" | "needs_reauth";
}

/** A connection for which Gulpy supplies the tools. */
interface Native {
  grant: Grant;
  connection: Connection;
  provider: Provider;
  capabilities: CapabilityId[];
}

/** A tool of an upstream connector, under the name that the agent sees. */
export interface AgentTool {
  name: string;
  title: string | undefined;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  connector: Connector;
  connection: Connection;
  upstream: UpstreamTool;
}

/** Tool names have letters, digits, `_` and `-` only, and 64 characters at most. */
function toolName(prefix: string, name: string, taken: Set<string>): string {
  const clean = `${prefix}_${name}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  let result = clean.slice(0, TOOL_NAME_MAX);
  if (clean.length > TOOL_NAME_MAX || taken.has(result)) {
    result = `${clean.slice(0, TOOL_NAME_MAX - 7)}_${sha256(clean).slice(0, 6)}`;
  }
  taken.add(result);
  return result;
}

/** Marks each item with the account that it came from. */
export type Tagged<T> = T & { connection_id: string; account: string };

export interface PartialFailure {
  connection_id: string;
  code: string;
  message: string;
}

export interface ProxyRequest {
  connectionId: string;
  service: string;
  path: string;
  search: string;
  method: string;
  headers: Headers;
  body: ArrayBuffer | null;
}

export function clampLimit(value: unknown): number {
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

function isoTime(value: unknown, fallback: number, name: string): string {
  if (value === undefined || value === null || value === "") return new Date(fallback).toISOString();
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(time)) throw new ApiError(400, "invalid_request", `"${name}" must be an ISO 8601 time`);
  return new Date(time).toISOString();
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof InputError) return new ApiError(400, "invalid_request", error.message);
  if (error instanceof ReauthRequired) {
    return new ApiError(409, "connection_needs_reauth", "The user must connect this account again. Open Link to fix it.");
  }
  if (error instanceof ProviderError) {
    if (error.status === 404) return new ApiError(404, "not_found", "The provider did not find the item");
    return new ApiError(502, "provider_error", error.message);
  }
  throw error;
}

/** The operations that the REST API and the MCP server share. */
export class Gulpy {
  constructor(
    private readonly deps: Deps,
    private readonly vault: Vault,
  ) {}

  private audit(access: Access, connectionId: string | null, action: string, detail: string | null, status: number): void {
    this.deps.store.audit({
      ts: this.deps.now(),
      userId: access.userId,
      appId: access.app.id,
      connectionId,
      action,
      detail,
      status,
    });
  }

  private granted(access: Access): GrantedConnection[] {
    return grantedConnections(this.deps, access.app.id, access.userId);
  }

  private natives(access: Access): Native[] {
    return this.granted(access).flatMap(({ grant, connection, backend, capabilities }) =>
      backend.kind === "native" ? [{ grant, connection, provider: backend.provider, capabilities }] : [],
    );
  }

  private api(target: Native) {
    return this.vault.api(target.connection, providerTokens(this.deps, target.provider));
  }

  /** Connections that the app can use for the capability. */
  private candidates(access: Access, capability: CapabilityId, connectionId?: string): Native[] {
    const all = this.natives(access).filter((item) => item.capabilities.includes(capability));
    if (connectionId === undefined) return all;
    const chosen = all.filter((item) => item.connection.id === connectionId);
    if (chosen.length === 0) {
      throw new ApiError(403, "not_granted", `The user did not give "${capability}" for connection ${connectionId}`);
    }
    return chosen;
  }

  private single(access: Access, capability: CapabilityId, connectionId?: string): Native {
    const found = this.candidates(access, capability, connectionId);
    const [first] = found;
    if (!first) {
      throw new ApiError(403, "not_granted", `The user did not give "${capability}" (${CAPABILITIES[capability].label})`);
    }
    if (found.length > 1) {
      throw new ApiError(400, "connection_required", "More than one account matches. Send connection_id.");
    }
    return first;
  }

  /** Runs one call for each connection. One failed account does not fail the others. */
  private async fanOut<T>(
    access: Access,
    action: CapabilityId,
    targets: Native[],
    call: (target: Native) => Promise<T[]>,
  ): Promise<{ items: Tagged<T>[]; errors: PartialFailure[] }> {
    const items: Tagged<T>[] = [];
    const errors: PartialFailure[] = [];
    await Promise.all(
      targets.map(async (target) => {
        const { connection } = target;
        try {
          for (const item of await call(target)) {
            items.push({ ...item, connection_id: connection.id, account: connection.accountLabel });
          }
          this.audit(access, connection.id, action, null, 200);
        } catch (error) {
          const failure = toApiError(error);
          errors.push({ connection_id: connection.id, code: failure.code, message: failure.message });
          this.audit(access, connection.id, action, failure.code, failure.status);
        }
      }),
    );
    return { items, errors };
  }

  private async one<T>(
    access: Access,
    action: string,
    target: Native,
    call: (target: Native) => Promise<T>,
  ): Promise<Tagged<T>> {
    const { connection } = target;
    try {
      const result = await call(target);
      this.audit(access, connection.id, action, null, 200);
      return { ...result, connection_id: connection.id, account: connection.accountLabel };
    } catch (error) {
      const failure = toApiError(error);
      this.audit(access, connection.id, action, failure.code, failure.status);
      throw failure;
    }
  }

  connections(access: Access): { user_id: string; connections: ConnectionInfo[] } {
    return {
      user_id: appUserId(this.deps, access.app.id, access.userId),
      connections: this.granted(access).map(({ connection, name, capabilities }) => ({
        id: connection.id,
        provider: connection.provider,
        provider_name: name,
        account: connection.accountLabel,
        capabilities,
        status: connection.status,
      })),
    };
  }

  /** The app gives up its access to one account. */
  removeConnection(access: Access, connectionId: string): void {
    const target = this.granted(access).find((item) => item.connection.id === connectionId);
    if (!target) throw new ApiError(404, "not_found", "No connection with this id");
    this.deps.store.deleteGrant(target.grant.id, access.userId);
    this.audit(access, connectionId, "grant.remove", "Removed by the app", 200);
  }

  async listMessages(
    access: Access,
    input: { connectionId?: string; query?: string; limit?: unknown },
  ): Promise<{ messages: Tagged<EmailSummary>[]; errors: PartialFailure[] }> {
    const limit = clampLimit(input.limit);
    const targets = this.candidates(access, "email.read", input.connectionId);
    if (targets.length === 0) throw new ApiError(403, "not_granted", 'The user did not give "email.read"');
    const { items, errors } = await this.fanOut(access, "email.read", targets, (target) =>
      target.provider.unified.listMessages(this.api(target), { query: input.query, limit }),
    );
    items.sort((a, b) => b.date.localeCompare(a.date));
    return { messages: items.slice(0, limit), errors };
  }

  getMessage(access: Access, input: { connectionId?: string; id: string }): Promise<Tagged<EmailMessage>> {
    const target = this.single(access, "email.read", input.connectionId);
    return this.one(access, "email.read", target, (native) =>
      native.provider.unified.getMessage(this.api(native), input.id),
    );
  }

  sendMessage(
    access: Access,
    input: { connectionId?: string; message: NewEmail },
  ): Promise<Tagged<{ id: string | null }>> {
    const target = this.single(access, "email.send", input.connectionId);
    // Check here, not in each provider, so that all providers get the same check.
    return this.one(access, "email.send", target, (native) => {
      checkNewEmail(input.message);
      return native.provider.unified.sendMessage(this.api(native), input.message);
    });
  }

  async listEvents(
    access: Access,
    input: { connectionId?: string; from?: unknown; to?: unknown; limit?: unknown },
  ): Promise<{ events: Tagged<CalendarEvent>[]; errors: PartialFailure[] }> {
    const limit = clampLimit(input.limit);
    const now = this.deps.now();
    const from = isoTime(input.from, now, "from");
    const to = isoTime(input.to, Date.parse(from) + 7 * DAY_MS, "to");
    const targets = this.candidates(access, "calendar.read", input.connectionId);
    if (targets.length === 0) throw new ApiError(403, "not_granted", 'The user did not give "calendar.read"');
    const { items, errors } = await this.fanOut(access, "calendar.read", targets, (target) =>
      target.provider.unified.listEvents(this.api(target), { from, to, limit }),
    );
    items.sort((a, b) => a.start.localeCompare(b.start));
    return { events: items.slice(0, limit), errors };
  }

  createEvent(access: Access, input: { connectionId?: string; event: NewEvent }): Promise<Tagged<CalendarEvent>> {
    const event: NewEvent = {
      ...input.event,
      start: isoTime(input.event.start, Number.NaN, "start"),
      end: isoTime(input.event.end, Number.NaN, "end"),
    };
    if (event.end <= event.start) throw new ApiError(400, "invalid_request", '"end" must be after "start"');
    const target = this.single(access, "calendar.write", input.connectionId);
    return this.one(access, "calendar.write", target, (native) =>
      native.provider.unified.createEvent(this.api(native), event),
    );
  }

  /**
   * The tools of the upstream connectors that the user shared with this app.
   * A connection with read access gives only the tools that say that they only read.
   */
  async agentTools(access: Access): Promise<AgentTool[]> {
    const tools: AgentTool[] = [];
    const taken = new Set<string>();
    const seen = new Map<string, number>();
    for (const { connection, backend, capabilities } of this.granted(access)) {
      if (backend.kind !== "mcp" || connection.status !== "active") continue;
      const canRead = capabilities.includes("tools.read");
      const canWrite = capabilities.includes("tools.write");
      if (!canRead && !canWrite) continue;

      const { connector } = backend;
      // The second account of one connector gets a number: notion_search, notion2_search.
      const count = (seen.get(connector.id) ?? 0) + 1;
      seen.set(connector.id, count);
      const prefix = (count === 1 ? connector.id : `${connector.id}${count}`).replace(/-/g, "_");

      for (const upstream of await this.upstreamTools(connection, connector)) {
        if (upstream.readOnly ? !canRead : !canWrite) continue;
        tools.push({
          name: toolName(prefix, upstream.name, taken),
          title: upstream.title,
          description: `${connector.name} (${connection.accountLabel}). ${upstream.description ?? ""}`.trim(),
          inputSchema: upstream.inputSchema,
          readOnly: upstream.readOnly,
          connector,
          connection,
          upstream,
        });
      }
    }
    return tools;
  }

  /** The stored tool list. Reads it again from the connector if it is old. */
  private async upstreamTools(connection: Connection, connector: Connector): Promise<UpstreamTool[]> {
    const age = this.deps.now() - (connection.toolsFetchedAt ?? 0);
    if (connection.tools && age < TOOLS_MAX_AGE_MS) return connection.tools;
    try {
      const tools = await fetchTools(this.deps, this.vault, connection, connector);
      this.deps.store.setConnectionTools(connection.id, tools, this.deps.now());
      return tools;
    } catch {
      // The connector is down or the sign-in stopped. Use the list that Gulpy has.
      return connection.tools ?? [];
    }
  }

  /** Calls a tool of an upstream connector with the token of the user. */
  async callAgentTool(access: Access, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const tool = (await this.agentTools(access)).find((item) => item.name === name);
    if (!tool) throw new ApiError(403, "not_granted", `The user did not give access to the tool "${name}"`);
    const label = `${tool.connector.id}.${tool.upstream.name}`;
    try {
      const result = await callTool(this.deps, this.vault, tool.connection, tool.connector, tool.upstream.name, args);
      this.audit(access, tool.connection.id, "tool", label, result.isError ? 502 : 200);
      return result;
    } catch (error) {
      // The MCP client can put the error of the vault inside an error of its own. The stored status is sure.
      const stopped = this.deps.store.connectionById(tool.connection.id)?.status === "needs_reauth";
      const failure =
        stopped || error instanceof ReauthRequired
          ? toApiError(new ReauthRequired(tool.connection.id))
          : new ApiError(502, "provider_error", `${tool.connector.name} did not complete the call`);
      this.audit(access, tool.connection.id, "tool", label, failure.status);
      throw failure;
    }
  }

  /**
   * Sends a raw request to the provider API. The path must match a rule for a
   * capability that the user gave to this app.
   */
  async proxy(access: Access, request: ProxyRequest): Promise<Response> {
    const target = this.natives(access).find((item) => item.connection.id === request.connectionId);
    if (!target) throw new ApiError(404, "not_found", "No connection with this id");
    const { connection, provider, capabilities } = target;
    if (!this.deps.config.rawProxy.includes(provider.id)) {
      throw new ApiError(403, "proxy_disabled", `The proxy is off for ${provider.name}. Use the email and calendar endpoints.`);
    }

    const service = Object.hasOwn(provider.services, request.service) ? provider.services[request.service] : undefined;
    if (!service) {
      const names = Object.keys(provider.services).join(", ");
      throw new ApiError(404, "unknown_service", `${provider.name} has these services: ${names}`);
    }
    // Encoded separators and dot segments can make the provider read a different path than the rule matched.
    if (!request.path.startsWith("/") || /\/\.{1,2}(\/|$)|\/\/|\\|%2f|%5c|%2e|[\x00-\x20]/i.test(request.path)) {
      throw new ApiError(400, "invalid_path", "The path is not valid");
    }
    const method = request.method.toUpperCase();
    const rule = service.rules.find(
      (item) => capabilities.includes(item.capability) && item.methods.includes(method) && item.path.test(request.path),
    );
    const label = `${method} ${request.service}${request.path}`;
    if (!rule) {
      this.audit(access, connection.id, "proxy", label, 403);
      throw new ApiError(403, "not_allowed", "The permissions that the user gave do not allow this request");
    }

    const url = new URL(service.baseUrl + request.path + request.search);
    if (url.origin !== new URL(service.baseUrl).origin) throw new ApiError(400, "invalid_path", "The path is not valid");

    const headers = new Headers();
    for (const name of FORWARD_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    try {
      const response = await this.api(target).fetch(url.toString(), {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : request.body,
      });
      this.audit(access, connection.id, "proxy", label, response.status);
      const passed = new Headers();
      for (const name of FORWARD_RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value) passed.set(name, value);
      }
      return new Response(response.body, { status: response.status, headers: passed });
    } catch (error) {
      const failure = toApiError(error);
      this.audit(access, connection.id, "proxy", label, failure.status);
      throw failure;
    }
  }
}
