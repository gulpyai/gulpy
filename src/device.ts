/**
 * "Connect to Gulpy": the sign-in for an agent that runs on the computer of the user,
 * for example Claude Code, Codex or Cursor. It follows RFC 8628 (device authorization grant).
 *
 * 1. The agent asks for a code:      POST /device/code  { client_name }
 * 2. The agent opens the address in the browser. The user signs in and taps Allow.
 * 3. The agent asks for its key:     POST /device/token { device_code }
 *
 * The key reaches each connection of the user, also the ones that the user adds
 * later. It does not expire. The user removes the agent on My tools to stop it.
 *
 * The one tap stays: anyone can ask for a link and send it to a user. With no tap,
 * a click on that link would give the attacker the whole vault. After Allow, Gulpy
 * emails the user ("Not you? Remove it"), so a user who was tricked finds out.
 */
import { cleanName, OAuthProblem } from "./agents.ts";
import { capabilitiesAt } from "./capabilities.ts";
import { randomBytes } from "node:crypto";
import { randomId, randomToken, sha256 } from "./crypto.ts";
import type { Deps } from "./deps.ts";
import { backendOf } from "./access.ts";
import type { App } from "./store.ts";

const CODE_TTL_S = 10 * 60;
/** After Allow, the agent can collect its key for this long. A chat agent asks only when the user says "done". */
const PICKUP_TTL_MS = 60 * 60_000;
/** Seconds between two polls of the agent. */
export const POLL_INTERVAL_S = 5;
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * The secret in the link that the agent opens. The user never reads or types it.
 * RFC 8628 calls it `user_code`. 96 random bits: nobody can guess a pending link.
 */
function linkCode(): string {
  return randomBytes(12).toString("base64url");
}

/** A link code, or null. */
export function normalizeUserCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16}$/.test(value) ? value : null;
}

export function verificationUri(deps: Deps): string {
  return `${deps.config.baseUrl}/device`;
}

/** Step 1. Makes an agent and a code for it. No user is known yet. */
export function startDevice(deps: Deps, body: Record<string, unknown>) {
  const now = deps.now();
  const appId = randomId("app");
  deps.store.createApp({
    id: appId,
    ownerUserId: null,
    name: cleanName(body.client_name),
    clientId: randomId("agent"),
    clientSecretHash: "",
    origins: [],
    kind: "agent",
    redirectUris: [],
    clientUri: null,
    createdAt: now,
  });
  const deviceCode = randomToken("device");
  const code = linkCode();
  deps.store.createDeviceCode(sha256(deviceCode), code, appId, now, now + CODE_TTL_S * 1000);
  return {
    device_code: deviceCode,
    user_code: code,
    verification_uri: verificationUri(deps),
    verification_uri_complete: `${verificationUri(deps)}?code=${code}`,
    expires_in: CODE_TTL_S,
    interval: POLL_INTERVAL_S,
  };
}

/** The agent that waits for this code, if the code is valid now. */
export function pendingAgent(deps: Deps, code: string): App | null {
  const device = deps.store.pendingDeviceCode(code, deps.now());
  return device ? deps.store.appById(device.appId) : null;
}

/**
 * Step 2. The user allows the agent. It gets each connection that works, with read and
 * write access, and later each new connection (see `shareWithAgents`).
 */
export function allowDevice(deps: Deps, code: string, userId: string): boolean {
  const now = deps.now();
  const device = deps.store.pendingDeviceCode(code, now);
  if (!device) return false;
  let allowed = false;
  deps.store.db.transaction(() => {
    if (!deps.store.decideDeviceCode(code, userId, "approved", now, now + PICKUP_TTL_MS)) return;
    allowed = true;
    for (const connection of deps.store.connectionsByUser(userId)) {
      if (connection.status !== "active" || !backendOf(deps, connection)) continue;
      deps.store.upsertGrant({
        id: randomId("grant"),
        userId,
        appId: device.appId,
        connectionId: connection.id,
        capabilities: capabilitiesAt("write", connection.capabilities),
        createdAt: now,
        updatedAt: now,
      });
    }
    deps.store.audit({
      ts: now,
      userId,
      appId: device.appId,
      connectionId: null,
      action: "grant.approve",
      detail: "Read and write · connect to Gulpy",
      status: null,
    });
  })();
  return allowed;
}

/** Tells the user by email that an agent got their tools. A failed email does not undo the Allow. */
export async function tellUser(deps: Deps, email: string, agentName: string): Promise<void> {
  const base = deps.config.baseUrl;
  try {
    await deps.mailer.sendNotice(
      email,
      `${agentName} can now use your Gulpy tools`,
      `${agentName} is now connected to your Gulpy account and can use all your tools.\n\n` +
        `If this was you, you do not need to do anything.\n\n` +
        `Not you? Remove it now: ${base}/#agents`,
    );
  } catch (error) {
    console.error("[gulpy] the connect notice did not go out", error);
  }
}

export function denyDevice(deps: Deps, code: string, userId: string): void {
  deps.store.decideDeviceCode(code, userId, "denied", deps.now());
}

/** Step 3. The agent asks for its key. Errors are the ones of RFC 8628, section 3.5. */
export function pollDevice(deps: Deps, form: Record<string, unknown>) {
  if (form.grant_type !== undefined && form.grant_type !== DEVICE_GRANT) {
    throw new OAuthProblem(400, "unsupported_grant_type", `Use grant_type ${DEVICE_GRANT}`);
  }
  const deviceCode = typeof form.device_code === "string" ? form.device_code : "";
  const now = deps.now();
  const device = deps.store.pollDeviceCode(sha256(deviceCode), now);
  if (!device) throw new OAuthProblem(400, "invalid_grant", "The device_code is not valid");
  if (device.status === "used") throw new OAuthProblem(400, "invalid_grant", "This code already gave a key");
  if (device.expiresAt <= now) throw new OAuthProblem(400, "expired_token", "The code expired. Ask for a new one.");
  if (device.status === "denied") throw new OAuthProblem(400, "access_denied", "The user did not allow the agent");
  if (device.status === "pending") {
    if (device.polledAt !== null && now - device.polledAt < POLL_INTERVAL_S * 1000) {
      throw new OAuthProblem(400, "slow_down", `Wait ${POLL_INTERVAL_S} seconds between two requests`);
    }
    throw new OAuthProblem(400, "authorization_pending", "The user did not allow the agent yet");
  }
  if (!device.userId || !deps.store.useDeviceCode(sha256(deviceCode))) {
    throw new OAuthProblem(400, "invalid_grant", "This code already gave a key");
  }
  const key = randomToken("gulpy");
  deps.store.createAccessToken(sha256(key), device.appId, device.userId, now);
  return {
    access_token: key,
    token_type: "Bearer",
    base_url: deps.config.baseUrl,
    guide: `${deps.config.baseUrl}/agents.md`,
  };
}
