import { ApiError } from "./access.ts";
import { CAPABILITY_IDS, isCapability, normalizeCapabilities, type CapabilityId } from "./capabilities.ts";
import { deriveKey, open, randomId, randomToken, seal, sha256 } from "./crypto.ts";
import type { Deps } from "./deps.ts";
import type { LogoImage } from "./logos.ts";
import { supportedCapabilities, type Provider } from "./providers/types.ts";
import type { App, Connection, LinkedAccount, LinkSession } from "./store.ts";

const LINK_TTL_MS = 30 * 60_000;
const PUBLIC_TOKEN_TTL_MS = 10 * 60_000;

function resultKey(deps: Deps): Buffer {
  return deriveKey(deps.config.masterKey, "connecty/link-result/v1");
}

/** `https://app.example` from user input, or null. Rejects paths, so `https://app.example/x` is not an origin. */
export function parseOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin === value.trim().replace(/\/$/, "") ? url.origin : null;
  } catch {
    return null;
  }
}

export function createLinkToken(
  deps: Deps,
  app: App,
  input: { capabilities?: unknown; origin?: unknown; client_user_id?: unknown },
): { link_token: string; link_url: string; expiration: string } {
  const requested = Array.isArray(input.capabilities) ? input.capabilities : [];
  const unknown = requested.filter((item) => !isCapability(item));
  const capabilities = normalizeCapabilities(requested);
  if (capabilities.length === 0 || unknown.length > 0) {
    throw new ApiError(400, "invalid_request", `"capabilities" must be a list of: ${CAPABILITY_IDS.join(", ")}`);
  }

  const origin = input.origin === undefined ? app.origins[0] : input.origin;
  if (typeof origin !== "string" || !app.origins.includes(origin)) {
    throw new ApiError(400, "invalid_origin", "The origin is not in the list of allowed origins for this app");
  }
  if (input.client_user_id !== undefined && typeof input.client_user_id !== "string") {
    throw new ApiError(400, "invalid_request", '"client_user_id" must be a string');
  }

  const token = randomToken("link");
  const now = deps.now();
  const expiresAt = now + LINK_TTL_MS;
  deps.store.createLinkSession(
    {
      id: randomId("ls"),
      appId: app.id,
      capabilities,
      origin,
      clientUserId: input.client_user_id?.slice(0, 200) ?? null,
      status: "open",
      publicTokenEnc: null,
      accounts: [],
      expiresAt,
    },
    sha256(token),
    now,
  );
  return {
    link_token: token,
    link_url: `${deps.config.baseUrl}/link?token=${encodeURIComponent(token)}`,
    expiration: new Date(expiresAt).toISOString(),
  };
}

export interface OpenLink {
  session: LinkSession;
  app: App;
}

/** Finds the session for a link token. Returns null if the token is unknown or expired. */
export function findLink(deps: Deps, token: string | undefined): OpenLink | null {
  if (!token) return null;
  const session = deps.store.linkSession(sha256(token));
  if (!session || session.expiresAt <= deps.now()) return null;
  const app = deps.store.appById(session.appId);
  return app ? { session, app } : null;
}

export interface ProviderLogo {
  name: string;
  color: string;
  image?: LogoImage;
  icon?: string;
}

/** The logo of a provider is the logo of its first connector in the catalog. */
export function providerLogo(deps: Deps, provider: Provider): ProviderLogo {
  return deps.catalog.forConnection(provider.id)[0] ?? { name: provider.name, color: "5B6470" };
}

export interface AccountChoice {
  connection: Connection;
  provider: Provider;
  logo: ProviderLogo;
  /** Requested capabilities that this account supplies now. */
  covers: CapabilityId[];
  /** Requested capabilities that the provider has, but the user did not give yet. */
  missing: CapabilityId[];
  usable: boolean;
  preselected: boolean;
}

export interface LinkChoices {
  accounts: AccountChoice[];
  /** Providers that can supply one or more of the requested capabilities. */
  addable: { provider: Provider; logo: ProviderLogo }[];
  /** Requested capabilities that no usable account supplies. */
  uncovered: CapabilityId[];
}

export function linkChoices(deps: Deps, link: OpenLink, userId: string, justConnected?: string): LinkChoices {
  const requested = link.session.capabilities;
  const alreadyGranted = new Set(
    deps.store.grantsForAppUser(link.app.id, userId).map((grant) => grant.connectionId),
  );

  const accounts: AccountChoice[] = [];
  for (const connection of deps.store.connectionsByUser(userId)) {
    const provider = deps.providers.get(connection.provider);
    if (!provider) continue;
    const supported = new Set(supportedCapabilities(provider));
    const held = new Set(connection.capabilities);
    const covers = requested.filter((capability) => held.has(capability));
    const missing = requested.filter((capability) => supported.has(capability) && !held.has(capability));
    if (covers.length === 0 && missing.length === 0) continue;
    accounts.push({
      connection,
      provider,
      logo: providerLogo(deps, provider),
      covers,
      missing,
      usable: connection.status === "active" && covers.length > 0,
      preselected: false,
    });
  }

  // Select the smallest obvious set: the account that the user added a moment ago,
  // then accounts that this app has already, then the most recent account for each open capability.
  const open = new Set(requested);
  const select = (choice: AccountChoice) => {
    choice.preselected = true;
    for (const capability of choice.covers) open.delete(capability);
  };
  const usable = accounts.filter((choice) => choice.usable);
  for (const choice of usable) if (choice.connection.id === justConnected) select(choice);
  for (const choice of usable) if (!choice.preselected && alreadyGranted.has(choice.connection.id)) select(choice);
  for (const choice of usable) {
    if (!choice.preselected && choice.covers.some((capability) => open.has(capability))) select(choice);
  }

  const covered = new Set(usable.flatMap((choice) => choice.covers));
  return {
    accounts,
    addable: [...deps.providers.values()]
      .filter((provider) => supportedCapabilities(provider).some((capability) => requested.includes(capability)))
      .map((provider) => ({ provider, logo: providerLogo(deps, provider) })),
    uncovered: requested.filter((capability) => !covered.has(capability)),
  };
}

export type Approval =
  | { ok: true; publicToken: string; accounts: LinkedAccount[] }
  | { ok: false; reason: "nothing_selected" | "not_open" };

/** Stores the grants and makes the public token. */
export function approveLink(deps: Deps, link: OpenLink, userId: string, connectionIds: readonly string[]): Approval {
  if (link.session.status !== "open") return { ok: false, reason: "not_open" };
  const wanted = new Set(connectionIds);
  const chosen = linkChoices(deps, link, userId).accounts.filter(
    (choice) => choice.usable && wanted.has(choice.connection.id),
  );
  if (chosen.length === 0) return { ok: false, reason: "nothing_selected" };

  const now = deps.now();
  const publicToken = randomToken("public");
  const accounts: LinkedAccount[] = [];
  const save = deps.store.db.transaction(() => {
    for (const { connection, provider, covers } of chosen) {
      // A new approval adds to what the app has. It does not remove an earlier permission.
      const before = deps.store.grant(link.app.id, connection.id);
      const capabilities = normalizeCapabilities([...(before?.capabilities ?? []), ...covers]);
      deps.store.upsertGrant({
        id: before?.id ?? randomId("grant"),
        userId,
        appId: link.app.id,
        connectionId: connection.id,
        capabilities,
        createdAt: before?.createdAt ?? now,
        updatedAt: now,
      });
      deps.store.audit({
        ts: now,
        userId,
        appId: link.app.id,
        connectionId: connection.id,
        action: "grant.approve",
        detail: covers.join(", "),
        status: null,
      });
      accounts.push({
        connection_id: connection.id,
        provider: provider.id,
        account: connection.accountLabel,
        capabilities,
      });
    }
    const sealed = seal(resultKey(deps), publicToken, link.session.id);
    if (!deps.store.completeLinkSession(link.session.id, sealed, accounts)) return false;
    deps.store.createPublicToken(sha256(publicToken), link.app.id, userId, now, now + PUBLIC_TOKEN_TTL_MS);
    return true;
  });
  return save() ? { ok: true, publicToken, accounts } : { ok: false, reason: "not_open" };
}

export interface LinkStatusReply {
  status: "open" | "completed" | "exited" | "expired";
  public_token?: string;
  accounts?: LinkedAccount[];
}

/** What the page that opened Link gets when it asks for the result. */
export function linkStatus(deps: Deps, token: string | undefined): LinkStatusReply {
  const link = findLink(deps, token);
  if (!link) return { status: "expired" };
  const { session } = link;
  if (session.status !== "completed" || !session.publicTokenEnc) return { status: session.status };
  return {
    status: "completed",
    public_token: open(resultKey(deps), session.publicTokenEnc, session.id),
    accounts: session.accounts,
  };
}

export function exchangePublicToken(deps: Deps, app: App, publicToken: unknown): { accessToken: string; userId: string } {
  if (typeof publicToken !== "string") {
    throw new ApiError(400, "invalid_request", '"public_token" is required');
  }
  const now = deps.now();
  const owner = deps.store.takePublicToken(sha256(publicToken), app.id, now);
  if (!owner) {
    throw new ApiError(400, "invalid_public_token", "The public token is not valid, was used before, or expired");
  }
  const accessToken = randomToken("access");
  deps.store.createAccessToken(sha256(accessToken), app.id, owner.userId, now);
  return { accessToken, userId: owner.userId };
}
