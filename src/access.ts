import type { CapabilityId } from "./capabilities.ts";
import type { Connector } from "./catalog.ts";
import { deriveKey, hmac, safeEqual, sha256 } from "./crypto.ts";
import type { Deps } from "./deps.ts";
import type { Provider } from "./providers/types.ts";
import type { App, Connection, Grant } from "./store.ts";
import { upstreamTokens } from "./upstream/oauth.ts";
import { providerTokens, type TokenClient } from "./vault.ts";

/** An error that the API returns to the agent app. */
export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 502,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The app and the user that an access token stands for. */
export interface Access {
  app: App;
  userId: string;
  tokenHash: string;
}

/** What supplies the tools of a connection. */
export type Backend =
  /** Gulpy calls the provider API. */
  | { kind: "native"; provider: Provider }
  /** The provider operates an MCP server and Gulpy passes the calls on. */
  | { kind: "mcp"; connector: Connector };

export interface GrantedConnection {
  grant: Grant;
  connection: Connection;
  backend: Backend;
  /** Name of the provider or the connector, for people. */
  name: string;
  /** What the app can do now: the grant, limited to what the provider token covers. */
  capabilities: CapabilityId[];
}

export function authenticateApp(deps: Deps, clientId: unknown, secret: unknown): App | null {
  if (typeof clientId !== "string" || typeof secret !== "string") return null;
  const app = deps.store.appByClientId(clientId);
  // Compare in each case, so an unknown client id takes the same time as a wrong secret.
  const matches = safeEqual(sha256(secret), app?.clientSecretHash || sha256(""));
  // A public client has no secret. It cannot use the endpoints that need one.
  return app && app.clientSecretHash !== "" && matches ? app : null;
}

export function authenticateToken(deps: Deps, authorization: string | undefined): Access | null {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!match?.[1]) return null;
  const tokenHash = sha256(match[1]);
  const token = deps.store.accessToken(tokenHash);
  if (!token || token.revokedAt !== null) return null;
  if (token.expiresAt !== null && token.expiresAt <= deps.now()) return null;
  const app = deps.store.appById(token.appId);
  if (!app) return null;
  deps.store.touchAccessToken(tokenHash, deps.now());
  return { app, userId: token.userId, tokenHash };
}

/**
 * The user id that one app sees. It is different for each app, so two apps
 * cannot match their users against each other.
 */
export function appUserId(deps: Deps, appId: string, userId: string): string {
  const key = deriveKey(deps.config.masterKey, "connecty/app-user-id/v1");
  return `user_${hmac(key, `${appId}:${userId}`).slice(0, 22)}`;
}

export function backendOf(deps: Deps, connection: Connection): Backend | null {
  const provider = deps.providers.get(connection.provider);
  if (provider) return { kind: "native", provider };
  const connector = deps.catalog.get(connection.provider);
  return connector?.source.kind === "mcp" ? { kind: "mcp", connector } : null;
}

export function backendName(backend: Backend): string {
  return backend.kind === "native" ? backend.provider.name : backend.connector.name;
}

export function tokensFor(deps: Deps, backend: Backend): TokenClient {
  return backend.kind === "native" ? providerTokens(deps, backend.provider) : upstreamTokens(deps, backend.connector);
}

/** Grants are read on each call, so a change by the user applies immediately. */
export function grantedConnections(deps: Deps, appId: string, userId: string): GrantedConnection[] {
  const granted: GrantedConnection[] = [];
  for (const grant of deps.store.grantsForAppUser(appId, userId)) {
    const connection = deps.store.connectionById(grant.connectionId);
    const backend = connection ? backendOf(deps, connection) : null;
    if (!connection || !backend) continue;
    const covered = new Set(connection.capabilities);
    granted.push({
      grant,
      connection,
      backend,
      name: backendName(backend),
      capabilities: grant.capabilities.filter((capability) => covered.has(capability)),
    });
  }
  return granted;
}
