import { normalizeCapabilities, type CapabilityId } from "./capabilities.ts";
import { deriveKey, open, pkcePair, randomId, randomToken, seal, sha256 } from "./crypto.ts";
import type { Deps } from "./deps.ts";
import { capabilitiesFor, scopesFor, supportedCapabilities, type Provider } from "./providers/types.ts";
import type { Connection } from "./store.ts";
import { requestToken, tokenApi, type Vault } from "./vault.ts";

const STATE_TTL_MS = 10 * 60_000;

export class OAuthError extends Error {
  constructor(
    readonly code: "bad_state" | "denied" | "exchange_failed" | "no_access",
    message: string,
    /** Where to send the user. Known only if the state was valid. */
    readonly returnTo?: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

export function redirectUri(deps: Deps, provider: Provider): string {
  return `${deps.config.baseUrl}/oauth/callback/${provider.id}`;
}

function stateKey(deps: Deps): Buffer {
  return deriveKey(deps.config.masterKey, "connecty/oauth-state/v1");
}

/** Returns the provider URL that starts the consent flow. */
export function beginAuthorization(
  deps: Deps,
  input: {
    provider: Provider;
    userId: string;
    capabilities: readonly CapabilityId[];
    returnTo: string;
    /** Connection to extend. Its current capabilities stay in the request. */
    connection?: Connection;
  },
): string {
  const { provider, connection } = input;
  const supported = new Set(supportedCapabilities(provider));
  const capabilities = normalizeCapabilities([...input.capabilities, ...(connection?.capabilities ?? [])]).filter(
    (capability) => supported.has(capability),
  );

  const state = randomToken("state");
  const pkce = pkcePair();
  const now = deps.now();
  deps.store.createOAuthState(
    sha256(state),
    {
      userId: input.userId,
      provider: provider.id,
      capabilities,
      codeVerifierEnc: seal(stateKey(deps), pkce.verifier, provider.id),
      returnTo: input.returnTo,
      expiresAt: now + STATE_TTL_MS,
    },
    now,
  );

  const url = new URL(provider.authorizeUrl);
  for (const [name, value] of Object.entries(provider.authorizeParams)) url.searchParams.set(name, value);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", provider.clientId);
  url.searchParams.set("redirect_uri", redirectUri(deps, provider));
  url.searchParams.set("scope", scopesFor(provider, capabilities).join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (connection && provider.loginHintParam) url.searchParams.set(provider.loginHintParam, connection.accountLabel);
  return url.toString();
}

/** The result of a sign-in at a provider. `created`: the user did not have this account in Gulpy before. */
export interface Connected {
  connection: Connection;
  returnTo: string;
  created: boolean;
}

/** Completes the flow and stores the connection. Throws OAuthError. */
export async function completeAuthorization(
  deps: Deps,
  vault: Vault,
  input: { provider: Provider; userId: string; state: string; code?: string; error?: string },
): Promise<Connected> {
  const { provider } = input;
  const state = deps.store.takeOAuthState(sha256(input.state));
  // The state must belong to the browser session that started the flow.
  if (!state || state.provider !== provider.id || state.userId !== input.userId || state.expiresAt <= deps.now()) {
    throw new OAuthError("bad_state", "The sign-in request is not valid or it expired");
  }
  if (input.error || !input.code) {
    throw new OAuthError("denied", `${provider.name} did not give access`, state.returnTo);
  }

  const result = await requestToken(deps, provider, {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: redirectUri(deps, provider),
    code_verifier: open(stateKey(deps), state.codeVerifierEnc, provider.id),
  });
  if (!result.ok) {
    throw new OAuthError("exchange_failed", `${provider.name} did not complete the sign-in`, state.returnTo);
  }
  const { token } = result;

  // RFC 6749: the provider can omit `scope` if it granted what was requested.
  const scopes = token.scope ? token.scope.split(/\s+/).filter(Boolean) : scopesFor(provider, state.capabilities);
  const capabilities = capabilitiesFor(provider, scopes);
  if (capabilities.length === 0) {
    throw new OAuthError("no_access", `${provider.name} did not give the requested permissions`, state.returnTo);
  }

  const account = await provider.fetchAccount(tokenApi(deps, provider, token.access_token));
  const now = deps.now();
  const expiresAt = token.expires_in ? now + token.expires_in * 1000 : null;
  const existing = deps.store.connectionByAccount(input.userId, provider.id, account.id);

  if (existing) {
    deps.store.updateConnection(
      existing.id,
      {
        accountLabel: account.label,
        capabilities,
        scopes,
        accessTokenEnc: vault.seal(input.userId, existing.id, "access", token.access_token),
        refreshTokenEnc: token.refresh_token
          ? vault.seal(input.userId, existing.id, "refresh", token.refresh_token)
          : existing.refreshTokenEnc,
        expiresAt,
        status: "active",
      },
      now,
    );
  } else {
    const id = randomId("conn");
    deps.store.insertConnection({
      id,
      userId: input.userId,
      provider: provider.id,
      accountId: account.id,
      accountLabel: account.label,
      capabilities,
      scopes,
      accessTokenEnc: vault.seal(input.userId, id, "access", token.access_token),
      refreshTokenEnc: token.refresh_token ? vault.seal(input.userId, id, "refresh", token.refresh_token) : null,
      expiresAt,
      status: "active",
      tools: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  const connection = deps.store.connectionByAccount(input.userId, provider.id, account.id);
  if (!connection) throw new OAuthError("exchange_failed", "The connection was not stored", state.returnTo);
  deps.store.audit({
    ts: now,
    userId: input.userId,
    appId: null,
    connectionId: connection.id,
    action: existing ? "connection.update" : "connection.create",
    detail: `${provider.name} · ${account.label}`,
    status: null,
  });
  return { connection, returnTo: state.returnTo, created: !existing };
}
