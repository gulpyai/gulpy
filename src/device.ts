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
 * The one tap stays: anyone can ask for a code and send the link to a user. With
 * no tap, a click on that link would give the attacker the whole vault.
 */
import { cleanName, OAuthProblem } from "./agents.ts";
import { capabilitiesAt } from "./capabilities.ts";
import { randomBytes } from "node:crypto";
import { randomId, randomToken, sha256 } from "./crypto.ts";
import type { Deps } from "./deps.ts";
import { backendOf } from "./access.ts";
import type { App } from "./store.ts";

const CODE_TTL_S = 10 * 60;
/** Seconds between two polls of the agent. */
export const POLL_INTERVAL_S = 5;
/** No vowels and no letters that look like digits, so a code cannot spell a word. RFC 8628, section 6.1. */
const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** For example `WDJB-MJHT`. */
function userCode(): string {
  const bytes = randomBytes(8);
  const letters = [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join("");
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

/** The form of a code that a person types: capitals, and a dash in the middle. */
export function normalizeUserCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const letters = value.toUpperCase().replace(/[^A-Z]/g, "");
  if (letters.length !== 8 || [...letters].some((letter) => !ALPHABET.includes(letter))) return null;
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
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
  const code = userCode();
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
    if (!deps.store.decideDeviceCode(code, userId, "approved", now)) return;
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
