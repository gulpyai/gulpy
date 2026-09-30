import { deriveKey, open, seal } from "./crypto.ts";
import type { Deps } from "./deps.ts";
import { ProviderError, type Provider, type ProviderApi } from "./providers/types.ts";
import type { Connection } from "./store.ts";

/** Refresh the token if it expires in less than this. */
const REFRESH_MARGIN_MS = 60_000;

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}

export type TokenResult = { ok: true; token: TokenResponse } | { ok: false; status: number; error: string };

/**
 * How to get new tokens for one connection. A provider with its own API and an
 * upstream MCP server have different OAuth clients, so each supplies this.
 */
export interface TokenClient {
  /** Provider id or connector id. */
  id: string;
  name: string;
  refresh(refreshToken: string): Promise<TokenResult>;
  /** Tells the provider to cancel the token. Optional: not all providers have this. */
  revoke?(token: string): Promise<void>;
}

/** The user must connect the account again. Maps to HTTP 409 `connection_needs_reauth`. */
export class ReauthRequired extends Error {
  constructor(readonly connectionId: string) {
    super("The connection needs the user to sign in again");
    this.name = "ReauthRequired";
  }
}

export async function requestToken(deps: Deps, provider: Provider, params: Record<string, string>): Promise<TokenResult> {
  const response = await deps.fetch(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ ...params, client_id: provider.clientId, client_secret: provider.clientSecret }),
  });
  const body = (await response.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string };
  if (!response.ok || typeof body.access_token !== "string") {
    return { ok: false, status: response.status, error: body.error ?? "invalid_response" };
  }
  return { ok: true, token: { ...body, access_token: body.access_token } };
}

/** The token client of a provider that has its own API, for example Google. */
export function providerTokens(deps: Deps, provider: Provider): TokenClient {
  return {
    id: provider.id,
    name: provider.name,
    refresh: (refreshToken) => requestToken(deps, provider, { grant_type: "refresh_token", refresh_token: refreshToken }),
    revoke: provider.revokeUrl
      ? async (token) => {
          await deps.fetch(provider.revokeUrl ?? "", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token, client_id: provider.clientId, client_secret: provider.clientSecret }),
          });
        }
      : undefined,
  };
}

/** Adds the bearer token to a request. Never follows a redirect, so the token stays on the provider host. */
export function bearerFetch(deps: Deps, token: string, url: string | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  return deps.fetch(url, { ...init, headers, redirect: "manual" });
}

/** A GET with no token. The provider signs the address, so the token must not go to that host. */
export async function plainDownload(deps: Deps, url: string): Promise<Response> {
  if (!url.startsWith("https://")) throw new ProviderError("download", 400, "The download address is not https");
  return deps.fetch(url, { redirect: "follow" });
}

async function readJson<T>(client: { id: string; name: string }, response: Response): Promise<T> {
  if (!response.ok) {
    throw new ProviderError(client.id, response.status, `${client.name} returned HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

/** API client for a token that is not in the vault yet. Used during the OAuth callback. */
export function tokenApi(deps: Deps, provider: { id: string; name: string }, token: string): ProviderApi {
  const call = (url: string, init?: RequestInit) => bearerFetch(deps, token, url, init);
  return {
    fetch: call,
    json: async <T>(url: string, init?: RequestInit) => readJson<T>(provider, await call(url, init)),
    download: (url: string) => plainDownload(deps, url),
  };
}

/** A value that starts with this was sealed with the key of its user. */
const USER_KEY_MARK = "u1.";

/**
 * Holds provider tokens. Tokens are encrypted at rest and the plain values
 * never leave this module except inside a request to the provider.
 *
 * Each user has a vault key of their own, which comes from the master key and
 * the id of the user. The token of one user does not open with the key of a
 * different user.
 */
export class Vault {
  /** The one key of the first version. It opens the values from before the user keys. */
  private readonly shared: Buffer;
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(private readonly deps: Deps) {
    this.shared = deriveKey(deps.config.masterKey, "connecty/vault/v1");
  }

  /** Do not change the label: the stored tokens become unreadable. */
  private userKey(userId: string): Buffer {
    return deriveKey(this.deps.config.masterKey, `gulpy/vault/user/v1:${userId}`);
  }

  seal(userId: string, connectionId: string, kind: "access" | "refresh", token: string): string {
    return USER_KEY_MARK + seal(this.userKey(userId), token, `${connectionId}:${kind}`);
  }

  private open(connection: Connection, kind: "access" | "refresh", sealed: string): string {
    const aad = `${connection.id}:${kind}`;
    if (!sealed.startsWith(USER_KEY_MARK)) return open(this.shared, sealed, aad);
    return open(this.userKey(connection.userId), sealed.slice(USER_KEY_MARK.length), aad);
  }

  /**
   * Gives a connection to another user, for example when two accounts of one person merge.
   * The tokens are sealed with the key of the owner, so they are sealed again for the new
   * owner. A plain UPDATE of user_id makes them unreadable.
   */
  moveConnection(connection: Connection, toUserId: string): void {
    const reseal = (kind: "access" | "refresh", sealed: string) =>
      this.seal(toUserId, connection.id, kind, this.open(connection, kind, sealed));
    this.deps.store.moveConnection(
      connection.id,
      toUserId,
      reseal("access", connection.accessTokenEnc),
      connection.refreshTokenEnc ? reseal("refresh", connection.refreshTokenEnc) : null,
    );
  }

  /** Returns a token that is valid now. Refreshes it if necessary. */
  async accessToken(given: Connection, client: TokenClient, force = false): Promise<string> {
    // Read the row again. The caller can hold a copy from before a refresh.
    const connection = this.deps.store.connectionById(given.id) ?? given;
    const fresh = connection.expiresAt === null || connection.expiresAt - this.deps.now() > REFRESH_MARGIN_MS;
    if (fresh && !force) return this.open(connection, "access", connection.accessTokenEnc);

    // One refresh at a time for each connection. Some providers rotate the refresh token.
    const running = this.refreshing.get(connection.id);
    if (running) return running;
    const refresh = this.refresh(connection, client).finally(() => this.refreshing.delete(connection.id));
    this.refreshing.set(connection.id, refresh);
    return refresh;
  }

  private async refresh(stale: Connection, client: TokenClient): Promise<string> {
    // Read the row again. A different request can have stored a new refresh token.
    const connection = this.deps.store.connectionById(stale.id) ?? stale;
    if (!connection.refreshTokenEnc) {
      this.deps.store.setConnectionStatus(connection.id, "needs_reauth");
      throw new ReauthRequired(connection.id);
    }
    const result = await client.refresh(this.open(connection, "refresh", connection.refreshTokenEnc));
    if (!result.ok) {
      if (result.status === 400 || result.status === 401) {
        this.deps.store.setConnectionStatus(connection.id, "needs_reauth");
        throw new ReauthRequired(connection.id);
      }
      throw new ProviderError(client.id, result.status, `${client.name} did not refresh the token`);
    }
    const { token } = result;
    this.deps.store.updateConnectionTokens(
      connection.id,
      this.seal(connection.userId, connection.id, "access", token.access_token),
      token.refresh_token
        ? this.seal(connection.userId, connection.id, "refresh", token.refresh_token)
        : connection.refreshTokenEnc,
      token.expires_in ? this.deps.now() + token.expires_in * 1000 : null,
    );
    return token.access_token;
  }

  /**
   * A fetch that adds the token of the connection. If the provider answers
   * 401, it refreshes the token and sends the request one more time.
   */
  fetcher(connection: Connection, client: TokenClient): (url: string | URL, init?: RequestInit) => Promise<Response> {
    return async (url, init) => {
      const token = await this.accessToken(connection, client);
      const response = await bearerFetch(this.deps, token, url, init);
      if (response.status !== 401) return response;
      const renewed = await this.accessToken(connection, client, true);
      return bearerFetch(this.deps, renewed, url, init);
    };
  }

  /** API client for a stored connection. */
  api(connection: Connection, client: TokenClient): ProviderApi {
    const call = this.fetcher(connection, client);
    return {
      fetch: call,
      json: async <T>(url: string, init?: RequestInit) => readJson<T>(client, await call(url, init)),
      download: (url: string) => plainDownload(this.deps, url),
    };
  }

  /** Tells the provider to cancel the tokens. Best effort: a failure does not stop the delete. */
  async revoke(connection: Connection, client: TokenClient): Promise<void> {
    if (!client.revoke) return;
    const sealed = connection.refreshTokenEnc ?? connection.accessTokenEnc;
    const kind = connection.refreshTokenEnc ? "refresh" : "access";
    try {
      await client.revoke(this.open(connection, kind, sealed));
    } catch {
      // The connection is deleted locally in each case.
    }
  }
}
