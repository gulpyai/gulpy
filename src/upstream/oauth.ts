/**
 * Gulpy as an OAuth client of an upstream MCP server, for example Notion.
 * It finds the authorization server, registers itself, and runs the sign-in.
 */
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { BRAND } from "../brand.ts";
import type { Connector } from "../catalog.ts";
import { deriveKey, open, randomId, randomToken, seal, sha256 } from "../crypto.ts";
import type { Deps } from "../deps.ts";
import { OAuthError, type Connected } from "../oauth.ts";
import type { Connection } from "../store.ts";
import type { TokenClient, TokenResult, Vault } from "../vault.ts";
import { fetchTools } from "./client.ts";

const STATE_TTL_MS = 10 * 60_000;

/** What Gulpy knows about one upstream server after discovery and registration. */
export interface Upstream {
  connector: Connector;
  url: string;
  issuer: string;
  resource: string | null;
  metadata: AuthorizationServerMetadata;
  client: OAuthClientInformationMixed;
  redirectUri: string;
  scope: string | undefined;
}

export function mcpRedirectUri(deps: Deps): string {
  return `${deps.config.baseUrl}/oauth/callback/mcp`;
}

function clientKey(deps: Deps): Buffer {
  return deriveKey(deps.config.masterKey, "connecty/upstream-client/v1");
}

function stateKey(deps: Deps): Buffer {
  return deriveKey(deps.config.masterKey, "connecty/upstream-state/v1");
}

function urlOf(connector: Connector): string {
  if (connector.source.kind !== "mcp") throw new Error(`${connector.name} is not an MCP connector`);
  return connector.source.url;
}

/** Asks for the scopes that the server names. Adds offline access if the server has it, to get a refresh token. */
function chooseScope(challenge: string | undefined, resourceScopes: string[] | undefined, metadata: AuthorizationServerMetadata): string | undefined {
  const scopes = new Set((challenge ?? resourceScopes?.join(" ") ?? "").split(/\s+/).filter(Boolean));
  if (scopes.size === 0) return undefined;
  if (metadata.scopes_supported?.includes("offline_access")) scopes.add("offline_access");
  return [...scopes].join(" ");
}

/** Finds the authorization server of an MCP server. Makes no change at the server. */
export async function discover(
  deps: Deps,
  serverUrl: string,
): Promise<{ issuer: string; resource: string | null; metadata: AuthorizationServerMetadata; scope: string | undefined }> {
  const fetchFn = deps.fetch;
  // A request with no token makes the server say where its sign-in metadata is.
  const probe = await fetchFn(serverUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
  });
  const challenge = probe.status === 401 ? extractWWWAuthenticateParams(probe) : {};
  await probe.body?.cancel();

  const resource = await discoverOAuthProtectedResourceMetadata(
    serverUrl,
    { resourceMetadataUrl: challenge.resourceMetadataUrl },
    fetchFn,
  ).catch(() => undefined);

  const issuer = resource?.authorization_servers?.[0] ?? new URL(serverUrl).origin;
  const metadata = await discoverAuthorizationServerMetadata(issuer, { fetchFn });
  if (!metadata) throw new OAuthError("exchange_failed", "The connector did not publish its sign-in metadata");
  return {
    issuer,
    resource: resource?.resource ?? null,
    metadata,
    scope: chooseScope(challenge.scope, resource?.scopes_supported, metadata),
  };
}

/** Loads what Gulpy knows about the upstream server. Registers Gulpy there the first time. */
export async function upstream(deps: Deps, connector: Connector): Promise<Upstream> {
  const url = urlOf(connector);
  const redirectUri = mcpRedirectUri(deps);
  const saved = deps.store.upstreamClient(connector.id);
  const configured = deps.config.connectorClients[connector.id];
  const stored = saved
    ? (JSON.parse(open(clientKey(deps), saved.clientEnc, connector.id)) as { client: OAuthClientInformationMixed; scope?: string })
    : null;
  // An app that the operator registered wins over the stored one: after a change of keys, use the new app.
  const current = !configured || stored?.client.client_id === configured.clientId;
  if (saved && stored && saved.redirectUri === redirectUri && current) {
    return {
      connector,
      url,
      issuer: saved.issuer,
      resource: saved.resource,
      metadata: JSON.parse(saved.metadata) as AuthorizationServerMetadata,
      client: stored.client,
      redirectUri,
      scope: stored.scope,
    };
  }

  const found = await discover(deps, url);
  let client: OAuthClientInformationMixed;
  if (configured) {
    client = { client_id: configured.clientId, client_secret: configured.clientSecret };
  } else if (connector.source.kind === "mcp" && connector.source.registration === "static") {
    throw new OAuthError("exchange_failed", `${connector.name} needs an OAuth app that the operator registers first`);
  } else {
    const secretMethods = ["client_secret_post", "client_secret_basic"];
    const supported = found.metadata.token_endpoint_auth_methods_supported ?? [];
    client = await registerClient(found.issuer, {
      metadata: found.metadata,
      scope: found.scope,
      fetchFn: deps.fetch,
      clientMetadata: {
        client_name: BRAND.name,
        client_uri: deps.config.baseUrl,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        // Gulpy runs on a server and can keep a secret. Use one if the provider gives one.
        token_endpoint_auth_method: secretMethods.find((method) => supported.includes(method)) ?? "none",
      },
    });
  }

  deps.store.saveUpstreamClient(
    {
      connector: connector.id,
      issuer: found.issuer,
      resource: found.resource,
      metadata: JSON.stringify(found.metadata),
      clientEnc: seal(clientKey(deps), JSON.stringify({ client, scope: found.scope }), connector.id),
      redirectUri,
    },
    deps.now(),
  );
  return { connector, url, ...found, client, redirectUri };
}

function toResult(tokens: OAuthTokens): TokenResult {
  return {
    ok: true,
    token: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
      scope: tokens.scope,
      id_token: tokens.id_token,
    },
  };
}

/** How the vault gets new tokens from the upstream server. */
export function upstreamTokens(deps: Deps, connector: Connector): TokenClient {
  return {
    id: connector.id,
    name: connector.name,
    async refresh(refreshToken) {
      const target = await upstream(deps, connector);
      try {
        return toResult(
          await refreshAuthorization(target.issuer, {
            metadata: target.metadata,
            clientInformation: target.client,
            refreshToken,
            resource: target.resource ?? undefined,
            fetchFn: deps.fetch,
          }),
        );
      } catch (error) {
        // The SDK gives an OAuth error, with a code, for a refused token. A network problem has no code.
        const code = error instanceof Error && "errorCode" in error ? String(error.errorCode) : "";
        const refused = ["invalid_grant", "invalid_client", "unauthorized_client"].includes(code);
        return { ok: false, status: refused ? 400 : 502, error: refused ? "invalid_grant" : "server_error" };
      }
    },
    async revoke(token) {
      const target = await upstream(deps, connector);
      const endpoint = "revocation_endpoint" in target.metadata ? target.metadata.revocation_endpoint : undefined;
      if (typeof endpoint !== "string") return;
      const body = new URLSearchParams({ token, client_id: target.client.client_id });
      if (target.client.client_secret) body.set("client_secret", target.client.client_secret);
      await deps.fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
    },
  };
}

/** Returns the address of the sign-in page of the connector. */
export async function beginUpstream(
  deps: Deps,
  input: { connector: Connector; userId: string; returnTo: string },
): Promise<string> {
  const target = await upstream(deps, input.connector);
  const state = randomToken("state");
  const { authorizationUrl, codeVerifier } = await startAuthorization(target.issuer, {
    metadata: target.metadata,
    clientInformation: target.client,
    redirectUrl: target.redirectUri,
    scope: target.scope,
    state,
    resource: target.resource ?? undefined,
  });
  const now = deps.now();
  deps.store.createOAuthState(
    sha256(state),
    {
      userId: input.userId,
      provider: input.connector.id,
      capabilities: ["tools.read", "tools.write"],
      codeVerifierEnc: seal(stateKey(deps), codeVerifier, input.connector.id),
      returnTo: input.returnTo,
      expiresAt: now + STATE_TTL_MS,
    },
    now,
  );
  return authorizationUrl.toString();
}

function claims(jwt: string | undefined): Record<string, unknown> {
  const payload = jwt?.split(".")[1];
  if (!payload) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Finds a name for the account. MCP has no standard for this, so try the
 * usual places. The label is for display only: it gives no access.
 */
async function identify(deps: Deps, target: Upstream, tokens: OAuthTokens): Promise<{ id: string; label: string }> {
  const sources: Record<string, unknown>[] = [claims(tokens.id_token)];
  const userinfo = "userinfo_endpoint" in target.metadata ? target.metadata.userinfo_endpoint : undefined;
  if (typeof userinfo === "string") {
    const response = await deps
      .fetch(userinfo, { headers: { authorization: `Bearer ${tokens.access_token}`, accept: "application/json" } })
      .catch(() => undefined);
    if (response?.ok) sources.push((await response.json().catch(() => ({}))) as Record<string, unknown>);
  }
  sources.push(claims(tokens.access_token));

  const pick = (names: string[]) => {
    for (const source of sources) {
      for (const name of names) {
        const value = source[name];
        if (typeof value === "string" && value.length > 0 && value.length <= 200) return value;
      }
    }
    return undefined;
  };
  const id = pick(["sub", "user_id", "uid"]);
  const label = pick(["email", "preferred_username", "name"]);
  return { id: id ?? "default", label: label ?? `${target.connector.name} account` };
}

/** Completes the sign-in, stores the connection, and reads the list of tools. */
export async function completeUpstream(
  deps: Deps,
  vault: Vault,
  input: { userId: string; state: string; code?: string; error?: string },
): Promise<Connected> {
  const state = deps.store.takeOAuthState(sha256(input.state));
  const connector = state ? deps.catalog.get(state.provider) : undefined;
  // The state must belong to the browser session that started the flow.
  if (!state || !connector || state.userId !== input.userId || state.expiresAt <= deps.now()) {
    throw new OAuthError("bad_state", "The sign-in request is not valid or it expired");
  }
  if (input.error || !input.code) {
    throw new OAuthError("denied", `${connector.name} did not give access`, state.returnTo);
  }

  const target = await upstream(deps, connector);
  let tokens: OAuthTokens;
  try {
    tokens = await exchangeAuthorization(target.issuer, {
      metadata: target.metadata,
      clientInformation: target.client,
      authorizationCode: input.code,
      codeVerifier: open(stateKey(deps), state.codeVerifierEnc, connector.id),
      redirectUri: target.redirectUri,
      resource: target.resource ?? undefined,
      fetchFn: deps.fetch,
    });
  } catch {
    throw new OAuthError("exchange_failed", `${connector.name} did not complete the sign-in`, state.returnTo);
  }

  const account = await identify(deps, target, tokens);
  const now = deps.now();
  const expiresAt = tokens.expires_in ? now + tokens.expires_in * 1000 : null;
  const scopes = (tokens.scope ?? target.scope ?? "").split(/\s+/).filter(Boolean);
  const existing = deps.store.connectionByAccount(input.userId, connector.id, account.id);
  const id = existing?.id ?? randomId("conn");
  const fields = {
    accountLabel: account.label,
    capabilities: state.capabilities,
    scopes,
    accessTokenEnc: vault.seal(input.userId, id, "access", tokens.access_token),
    refreshTokenEnc: tokens.refresh_token
      ? vault.seal(input.userId, id, "refresh", tokens.refresh_token)
      : (existing?.refreshTokenEnc ?? null),
    expiresAt,
    status: "active" as const,
  };
  if (existing) {
    deps.store.updateConnection(id, fields, now);
  } else {
    deps.store.insertConnection({
      id,
      userId: input.userId,
      provider: connector.id,
      accountId: account.id,
      tools: null,
      createdAt: now,
      updatedAt: now,
      ...fields,
    });
  }

  const stored = deps.store.connectionById(id);
  if (!stored) throw new OAuthError("exchange_failed", "The connection was not stored", state.returnTo);
  // A connector with no tool list is of no use, but the sign-in is good. Keep the connection.
  const tools = await fetchTools(deps, vault, stored, connector).catch(() => null);
  if (tools) deps.store.setConnectionTools(id, tools, now);

  deps.store.audit({
    ts: now,
    userId: input.userId,
    appId: null,
    connectionId: id,
    action: existing ? "connection.update" : "connection.create",
    detail: `${connector.name} · ${account.label}`,
    status: null,
  });
  const connection = deps.store.connectionById(id) ?? stored;
  return { connection, returnTo: state.returnTo, created: !existing };
}
