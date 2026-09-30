/**
 * Gulpy as an OAuth 2.1 authorization server for agents. An agent adds the
 * address of the Gulpy MCP server. The agent then registers itself and sends
 * the user to Gulpy, where the user selects what the agent can use.
 *
 * This follows the MCP authorization specification: protected resource
 * metadata (RFC 9728), server metadata (RFC 8414), dynamic client registration
 * (RFC 7591), client ID metadata documents, and PKCE.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { backendOf } from "./access.ts";
import { BRAND } from "./brand.ts";
import { capabilitiesAt, levelOf, type AccessLevel } from "./capabilities.ts";
import { pkceChallenge, randomId, randomToken, safeEqual, sha256 } from "./crypto.ts";
import type { Deps } from "./deps.ts";
import { agentCompany } from "./logos.ts";
import type { App, Connection } from "./store.ts";

const CODE_TTL_MS = 5 * 60_000;
const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_MS = 60 * 24 * 60 * 60_000;
const METADATA_MAX_BYTES = 64 * 1024;
const BLOCKED_SCHEMES = ["javascript:", "data:", "file:", "vbscript:", "blob:", "about:"];

/** An error in the shape that OAuth clients read. */
export class OAuthProblem extends Error {
  constructor(
    readonly status: 400 | 401,
    readonly error: string,
    message: string,
  ) {
    super(message);
    this.name = "OAuthProblem";
  }
}

export function resourceUrl(deps: Deps): string {
  return `${deps.config.baseUrl}/mcp`;
}

export function protectedResourceMetadata(deps: Deps) {
  return {
    resource: resourceUrl(deps),
    authorization_servers: [deps.config.baseUrl],
    bearer_methods_supported: ["header"],
    resource_name: BRAND.name,
  };
}

export function authorizationServerMetadata(deps: Deps) {
  const base = deps.config.baseUrl;
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    device_authorization_endpoint: `${base}/device/code`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * A redirect address is an https page, a page on the computer of the user, or
 * an app address such as `cursor://`. It cannot start a script.
 */
export function isAllowedRedirect(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2000) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return isLoopback(url.hostname);
  return !BLOCKED_SCHEMES.includes(url.protocol);
}

/**
 * A registered address matches the address in the request when the two are equal.
 * A program on the computer of the user listens on a port that it gets at start,
 * so for `http://localhost` and `http://127.0.0.1` the port does not count (RFC 8252, section 7.3).
 * Codex and Claude Code register `http://localhost/callback` and then use `http://localhost:52905/callback`.
 */
export function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  let a: URL;
  let b: URL;
  try {
    a = new URL(registered);
    b = new URL(requested);
  } catch {
    return false;
  }
  if (a.protocol !== "http:" || b.protocol !== "http:" || !isLoopback(a.hostname) || a.hostname !== b.hostname) return false;
  return a.pathname === b.pathname && a.search === b.search && !b.hash;
}

/**
 * True if the code of the request goes to a place that the user can trust: a
 * program on the computer of the user, or the site of an agent company that
 * Gulpy knows. A different site does not pass. With no approval step, one
 * link to that site would give it the tools of each person who is signed in.
 */
export function isTrustedReturn(redirectUri: string): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (url.protocol === "http:") return isLoopback(url.hostname);
  return agentCompany(redirectUri) !== undefined;
}

export function cleanName(value: unknown): string {
  const name = typeof value === "string" ? value.replace(/[\x00-\x1f]/g, "").trim().slice(0, 80) : "";
  return name || "Agent with no name";
}

function cleanUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Dynamic client registration. The agent calls this one time, with no user present. */
export function registerAgent(deps: Deps, body: Record<string, unknown>) {
  const redirects = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (redirects.length === 0 || redirects.length > 10 || !redirects.every(isAllowedRedirect)) {
    throw new OAuthProblem(400, "invalid_redirect_uri", "Send 1 to 10 redirect addresses. Use https, or http on localhost.");
  }
  const method = body.token_endpoint_auth_method ?? "none";
  if (method !== "none" && method !== "client_secret_post" && method !== "client_secret_basic") {
    throw new OAuthProblem(400, "invalid_client_metadata", "This token_endpoint_auth_method is not supported");
  }

  const now = deps.now();
  const clientId = randomId("agent");
  const secret = method === "none" ? null : randomToken("secret");
  const name = cleanName(body.client_name);
  deps.store.createApp({
    id: randomId("app"),
    ownerUserId: null,
    name,
    clientId,
    clientSecretHash: secret ? sha256(secret) : "",
    origins: [],
    kind: "agent",
    redirectUris: redirects,
    clientUri: cleanUrl(body.client_uri),
    createdAt: now,
  });
  return {
    client_id: clientId,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(now / 1000),
    client_name: name,
    redirect_uris: redirects,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: method,
  };
}

function isPrivateAddress(address: string): boolean {
  if (address.includes(":")) {
    const lower = address.toLowerCase();
    return lower === "::1" || lower === "::" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("::ffff:");
  }
  const [a = 0, b = 0] = address.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  );
}

/** A client ID metadata document is on a public https host. This blocks requests to the internal network. */
async function isSafeDocumentUrl(deps: Deps, url: URL): Promise<boolean> {
  const local = deps.config.env !== "production" && url.protocol === "http:" && isLoopback(url.hostname);
  if (local) return true;
  if (url.protocol !== "https:" || url.username || url.password || url.pathname === "/") return false;
  if (isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0 || isLoopback(url.hostname)) return false;
  if (deps.config.env !== "production") return true;
  try {
    const addresses = await lookup(url.hostname, { all: true });
    return addresses.length > 0 && addresses.every((entry) => !isPrivateAddress(entry.address));
  } catch {
    return false;
  }
}

/** Reads the client ID metadata document of an agent. The client id is the address of the document. */
async function fromDocument(deps: Deps, clientId: string): Promise<App | null> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  if (!(await isSafeDocumentUrl(deps, url))) return null;

  let document: Record<string, unknown>;
  try {
    const response = await deps.fetch(url, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > METADATA_MAX_BYTES) return null;
    document = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }

  const redirects = Array.isArray(document.redirect_uris) ? document.redirect_uris : [];
  if (document.client_id !== clientId || redirects.length === 0 || !redirects.every(isAllowedRedirect)) return null;

  const fields = { name: cleanName(document.client_name), redirectUris: redirects, clientUri: cleanUrl(document.client_uri) };
  const known = deps.store.appByClientId(clientId);
  if (known) {
    if (known.kind !== "agent") return null;
    deps.store.updateAgent(known.id, fields);
  } else {
    deps.store.createApp({
      id: randomId("app"),
      ownerUserId: null,
      clientId,
      clientSecretHash: "",
      origins: [],
      kind: "agent",
      createdAt: deps.now(),
      ...fields,
    });
  }
  return deps.store.appByClientId(clientId);
}

export async function findAgent(deps: Deps, clientId: string | undefined): Promise<App | null> {
  if (!clientId) return null;
  if (/^https?:\/\//.test(clientId)) return fromDocument(deps, clientId);
  const app = deps.store.appByClientId(clientId);
  return app?.kind === "agent" ? app : null;
}

export interface AuthorizeRequest {
  app: App;
  redirectUri: string;
  state: string | undefined;
  codeChallenge: string;
  resource: string | null;
}

export type AuthorizeCheck =
  | { ok: true; request: AuthorizeRequest }
  /** The agent is known. Send the error to it. */
  | { ok: false; redirect: string }
  /** The agent or its address is not known. Show the error and do not redirect. */
  | { ok: false; message: string };

export function redirectWith(deps: Deps, redirectUri: string, values: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(values)) if (value) url.searchParams.set(name, value);
  url.searchParams.set("iss", deps.config.baseUrl);
  return url.toString();
}

export async function checkAuthorize(deps: Deps, query: Record<string, string | undefined>): Promise<AuthorizeCheck> {
  const app = await findAgent(deps, query.client_id);
  if (!app) return { ok: false, message: "This agent is not registered." };

  const redirectUri = query.redirect_uri ?? (app.redirectUris.length === 1 ? app.redirectUris[0] : undefined);
  if (!redirectUri || !app.redirectUris.some((registered) => redirectMatches(registered, redirectUri))) {
    return { ok: false, message: "The return address of this agent is not registered." };
  }

  const fail = (error: string, description: string): AuthorizeCheck => ({
    ok: false,
    redirect: redirectWith(deps, redirectUri, { error, error_description: description, state: query.state }),
  });
  if (query.response_type !== "code") return fail("unsupported_response_type", "Use response_type=code");
  if (!query.code_challenge || query.code_challenge_method !== "S256") {
    return fail("invalid_request", "PKCE with S256 is necessary");
  }
  const resource = query.resource?.replace(/\/$/, "") ?? null;
  if (resource !== null && resource !== resourceUrl(deps) && resource !== deps.config.baseUrl) {
    return fail("invalid_target", "The resource is not this server");
  }
  return {
    ok: true,
    request: { app, redirectUri, state: query.state, codeChallenge: query.code_challenge, resource },
  };
}

export interface Selection {
  connectionId: string;
  level: AccessLevel;
}

const levelText = (level: AccessLevel, automatic: boolean): string =>
  `${level === "write" ? "Read and write" : "Read only"}${automatic ? " · automatic" : ""}`;

/**
 * Approves the request with no step for the user, if the rules permit it. A
 * new agent gets each connection that works, with read and write access. An
 * agent that the user approved before keeps what it has. Returns null if the
 * user must see the approval page.
 */
export function approveWithNoTap(
  deps: Deps,
  request: AuthorizeRequest,
  userId: string,
): { to: string; connections: Connection[] } | null {
  if (!deps.config.autoApprove || !isTrustedReturn(request.redirectUri)) return null;
  const usable = (connection: Connection) => connection.status === "active" && backendOf(deps, connection) !== null;
  const mine = deps.store.connectionsByUser(userId);
  const grants = new Map(deps.store.grantsForAppUser(request.app.id, userId).map((grant) => [grant.connectionId, grant]));

  const selections: Selection[] =
    grants.size > 0
      ? mine.flatMap((connection) => {
          const grant = grants.get(connection.id);
          return grant ? [{ connectionId: connection.id, level: levelOf(grant.capabilities) }] : [];
        })
      : mine.filter(usable).map((connection) => ({ connectionId: connection.id, level: "write" }));
  const chosen = new Set(selections.map((selection) => selection.connectionId));
  const connections = mine.filter((connection) => chosen.has(connection.id) && usable(connection));
  // With nothing to give, the user must add a tool or connect one again. The approval page has the buttons.
  if (connections.length === 0) return null;
  return { to: approveAgent(deps, request, userId, selections, true), connections };
}

/**
 * Gives a new connection to each agent that the user approved before, so that
 * a new tool needs no approval. An agent that has read access only gets read access.
 */
export function shareWithAgents(deps: Deps, userId: string, connection: Connection): void {
  if (!deps.config.autoApprove) return;
  const now = deps.now();
  for (const appId of deps.store.agentsOfUser(userId, now)) {
    if (deps.store.grant(appId, connection.id)) continue;
    const held = deps.store.grantsForAppUser(appId, userId);
    const level: AccessLevel =
      held.length > 0 && held.every((grant) => levelOf(grant.capabilities) === "read") ? "read" : "write";
    deps.store.upsertGrant({
      id: randomId("grant"),
      userId,
      appId,
      connectionId: connection.id,
      capabilities: capabilitiesAt(level, connection.capabilities),
      createdAt: now,
      updatedAt: now,
    });
    deps.store.audit({
      ts: now,
      userId,
      appId,
      connectionId: connection.id,
      action: "grant.approve",
      detail: levelText(level, true),
      status: null,
    });
  }
}

/**
 * Stores what the user selected and makes the authorization code. The
 * selection is the full list: a connection that is not in it loses its access.
 * `automatic`: Gulpy made the selection, and the list of calls says so.
 */
export function approveAgent(
  deps: Deps,
  request: AuthorizeRequest,
  userId: string,
  selections: readonly Selection[],
  automatic = false,
): string {
  const now = deps.now();
  const chosen = new Map(selections.map((selection) => [selection.connectionId, selection.level]));
  const code = randomToken("code");

  deps.store.db.transaction(() => {
    for (const connection of deps.store.connectionsByUser(userId)) {
      const level = chosen.get(connection.id);
      const before = deps.store.grant(request.app.id, connection.id);
      if (!level) {
        if (before) deps.store.deleteGrantFor(request.app.id, connection.id);
        continue;
      }
      const capabilities = capabilitiesAt(level, connection.capabilities);
      deps.store.upsertGrant({
        id: before?.id ?? randomId("grant"),
        userId,
        appId: request.app.id,
        connectionId: connection.id,
        capabilities,
        createdAt: before?.createdAt ?? now,
        updatedAt: now,
      });
      deps.store.audit({
        ts: now,
        userId,
        appId: request.app.id,
        connectionId: connection.id,
        action: "grant.approve",
        detail: levelText(level, automatic),
        status: null,
      });
    }
    deps.store.createAuthCode(
      sha256(code),
      {
        appId: request.app.id,
        userId,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        resource: request.resource,
      },
      now,
      now + CODE_TTL_MS,
    );
  })();

  return redirectWith(deps, request.redirectUri, { code, state: request.state });
}

function issueTokens(deps: Deps, appId: string, userId: string, family: string) {
  const now = deps.now();
  const accessToken = randomToken("access");
  const refreshToken = randomToken("refresh");
  deps.store.createAccessToken(sha256(accessToken), appId, userId, now, {
    expiresAt: now + ACCESS_TTL_S * 1000,
    family,
  });
  deps.store.createRefreshToken(sha256(refreshToken), { family, appId, userId }, now, now + REFRESH_TTL_MS);
  return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refreshToken };
}

/** Finds the agent that calls the token endpoint. A client with a secret must send it. */
async function authenticate(deps: Deps, form: Record<string, string>, authorization: string | undefined): Promise<App> {
  let clientId = form.client_id;
  let secret = form.client_secret;
  const basic = /^Basic\s+(\S+)$/i.exec(authorization ?? "");
  if (basic?.[1]) {
    const [id = "", ...rest] = Buffer.from(basic[1], "base64").toString("utf8").split(":");
    clientId = decodeURIComponent(id);
    secret = decodeURIComponent(rest.join(":"));
  }
  const app = clientId && !/^https?:\/\//.test(clientId) ? deps.store.appByClientId(clientId) : await findAgent(deps, clientId);
  if (!app || app.kind !== "agent") throw new OAuthProblem(401, "invalid_client", "The client is not known");
  if (app.clientSecretHash !== "" && !safeEqual(sha256(secret ?? ""), app.clientSecretHash)) {
    throw new OAuthProblem(401, "invalid_client", "The client secret is not correct");
  }
  return app;
}

export async function exchangeToken(deps: Deps, form: Record<string, string>, authorization: string | undefined) {
  const app = await authenticate(deps, form, authorization);
  const now = deps.now();

  if (form.grant_type === "authorization_code") {
    const code = deps.store.takeAuthCode(sha256(form.code ?? ""), now);
    const valid =
      code &&
      code.appId === app.id &&
      code.redirectUri === form.redirect_uri &&
      safeEqual(pkceChallenge(form.code_verifier ?? ""), code.codeChallenge) &&
      (form.resource === undefined || code.resource === null || form.resource.replace(/\/$/, "") === code.resource);
    if (!code || !valid) throw new OAuthProblem(400, "invalid_grant", "The code is not valid, was used before, or expired");
    return issueTokens(deps, app.id, code.userId, randomId("family"));
  }

  if (form.grant_type === "refresh_token") {
    const tokenHash = sha256(form.refresh_token ?? "");
    const token = deps.store.refreshToken(tokenHash);
    if (!token || token.appId !== app.id || token.revokedAt !== null || token.expiresAt <= now) {
      throw new OAuthProblem(400, "invalid_grant", "The refresh token is not valid");
    }
    // A refresh token works one time. A second use means that a copy exists, so cancel all tokens of this sign-in.
    if (token.usedAt !== null || !deps.store.useRefreshToken(tokenHash, now)) {
      deps.store.revokeFamily(token.family, now);
      throw new OAuthProblem(400, "invalid_grant", "The refresh token was used before");
    }
    return issueTokens(deps, app.id, token.userId, token.family);
  }

  throw new OAuthProblem(400, "unsupported_grant_type", "Use authorization_code or refresh_token");
}

/** RFC 7009. The reply is the same if the token is known or not. */
export function revokeToken(deps: Deps, token: string | undefined): void {
  if (!token) return;
  const hash = sha256(token);
  const refresh = deps.store.refreshToken(hash);
  if (refresh) deps.store.revokeFamily(refresh.family, deps.now());
  else deps.store.revokeAccessToken(hash, deps.now());
}
