import { Hono, type Context } from "hono";
import { ApiError, appUserId, authenticateApp, authenticateToken, type Access } from "../access.ts";
import type { Deps } from "../deps.ts";
import { createLinkToken, exchangePublicToken } from "../link.ts";
import type { NewEmail, NewEvent } from "../providers/types.ts";
import type { Gulpy } from "../service.ts";
import type { App } from "../store.ts";

type Json = Record<string, unknown>;

async function jsonBody(c: Context): Promise<Json> {
  const text = await c.req.text();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Json;
  } catch {
    // Reported below.
  }
  throw new ApiError(400, "invalid_request", "The body must be a JSON object");
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError(400, "invalid_request", `"${name}" is required`);
  }
  return value;
}

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ApiError(400, "invalid_request", `"${name}" must be a string`);
  return value;
}

function textList(value: unknown, name: string, required: boolean): string[] {
  if (value === undefined && !required) return [];
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || list.some((item) => typeof item !== "string") || (required && list.length === 0)) {
    throw new ApiError(400, "invalid_request", `"${name}" must be a list of strings`);
  }
  return list as string[];
}

export function parseNewEmail(body: Json): NewEmail {
  return {
    to: textList(body.to, "to", true),
    cc: textList(body.cc, "cc", false),
    subject: optionalText(body.subject, "subject") ?? "",
    body_text: text(body.body_text, "body_text"),
  };
}

export function parseNewEvent(body: Json): NewEvent {
  return {
    title: text(body.title, "title"),
    start: text(body.start, "start"),
    end: text(body.end, "end"),
    location: optionalText(body.location, "location"),
    description: optionalText(body.description, "description"),
    attendees: textList(body.attendees, "attendees", false),
  };
}

export function apiRoutes(deps: Deps, gulpy: Gulpy): Hono {
  const api = new Hono();

  api.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  api.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    console.error("[gulpy] API error", error);
    return c.json({ error: { code: "internal_error", message: "Gulpy had an internal error" } }, 500);
  });

  api.notFound((c) => c.json({ error: { code: "not_found", message: "No such endpoint" } }, 404));

  /** The app proves its identity with the client id and secret, in the body or as HTTP Basic. */
  const appFrom = (c: Context, body: Json): App => {
    let clientId = body.client_id;
    let secret = body.secret;
    const basic = /^Basic\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
    if (basic?.[1]) {
      const decoded = Buffer.from(basic[1], "base64").toString("utf8");
      const split = decoded.indexOf(":");
      if (split > 0) {
        clientId = decoded.slice(0, split);
        secret = decoded.slice(split + 1);
      }
    }
    const app = authenticateApp(deps, clientId, secret);
    if (!app) throw new ApiError(401, "invalid_client", "The client id or the secret is not correct");
    return app;
  };

  const accessFrom = (c: Context): Access => {
    const access = authenticateToken(deps, c.req.header("authorization"));
    if (!access) {
      c.header("WWW-Authenticate", "Bearer");
      throw new ApiError(401, "invalid_token", "The access token is not valid");
    }
    return access;
  };

  // Link

  api.post("/link/token/create", async (c) => {
    const body = await jsonBody(c);
    return c.json(createLinkToken(deps, appFrom(c, body), body));
  });

  api.post("/link/public_token/exchange", async (c) => {
    const body = await jsonBody(c);
    const app = appFrom(c, body);
    const { accessToken, userId } = exchangePublicToken(deps, app, body.public_token);
    const access: Access = { app, userId, tokenHash: "" };
    return c.json({
      access_token: accessToken,
      user_id: appUserId(deps, app.id, userId),
      connections: gulpy.connections(access).connections,
    });
  });

  api.post("/access_token/revoke", (c) => {
    const access = accessFrom(c);
    deps.store.revokeAccessToken(access.tokenHash, deps.now());
    return c.json({ revoked: true });
  });

  // Connections

  api.get("/connections", (c) => c.json(gulpy.connections(accessFrom(c))));

  api.delete("/connections/:id", (c) => {
    gulpy.removeConnection(accessFrom(c), c.req.param("id"));
    return c.json({ removed: true });
  });

  // Email

  api.get("/email/messages", async (c) =>
    c.json(
      await gulpy.listMessages(accessFrom(c), {
        connectionId: c.req.query("connection_id"),
        query: c.req.query("q"),
        limit: c.req.query("limit"),
      }),
    ),
  );

  api.get("/email/messages/:id", async (c) =>
    c.json(
      await gulpy.getMessage(accessFrom(c), {
        connectionId: c.req.query("connection_id"),
        id: c.req.param("id"),
      }),
    ),
  );

  api.post("/email/messages", async (c) => {
    const access = accessFrom(c);
    const body = await jsonBody(c);
    return c.json(
      await gulpy.sendMessage(access, {
        connectionId: optionalText(body.connection_id, "connection_id"),
        message: parseNewEmail(body),
      }),
      201,
    );
  });

  // Calendar

  api.get("/calendar/events", async (c) =>
    c.json(
      await gulpy.listEvents(accessFrom(c), {
        connectionId: c.req.query("connection_id"),
        from: c.req.query("from"),
        to: c.req.query("to"),
        limit: c.req.query("limit"),
      }),
    ),
  );

  api.post("/calendar/events", async (c) => {
    const access = accessFrom(c);
    const body = await jsonBody(c);
    return c.json(
      await gulpy.createEvent(access, {
        connectionId: optionalText(body.connection_id, "connection_id"),
        event: parseNewEvent(body),
      }),
      201,
    );
  });

  // Files

  api.get("/files", async (c) =>
    c.json(
      await gulpy.searchFiles(accessFrom(c), {
        connectionId: c.req.query("connection_id"),
        query: c.req.query("q"),
        limit: c.req.query("limit"),
      }),
    ),
  );

  api.get("/files/:id", async (c) =>
    c.json(
      await gulpy.readFile(accessFrom(c), {
        connectionId: c.req.query("connection_id"),
        id: c.req.param("id"),
      }),
    ),
  );

  // Proxy: a raw request to the provider API, limited by the permissions of the user

  api.all("/proxy/:connection/:service/*", async (c) => {
    const access = accessFrom(c);
    const connectionId = c.req.param("connection");
    const service = c.req.param("service");
    const url = new URL(c.req.url);
    // Use the raw path. A decoded path can hide an encoded separator from the rule check.
    const marker = `/proxy/${connectionId}/${service}`;
    const path = url.pathname.slice(url.pathname.indexOf(marker) + marker.length);
    const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";
    return gulpy.proxy(access, {
      connectionId,
      service,
      path,
      search: url.search,
      method: c.req.method,
      headers: c.req.raw.headers,
      body: hasBody ? await c.req.arrayBuffer() : null,
    });
  });

  return api;
}
