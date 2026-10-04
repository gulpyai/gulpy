/**
 * Agents that the user connected with "connect to Gulpy" (src/device.ts). An
 * agent calls the tools with its key over plain HTTP: GET /v1/tools and
 * POST /v1/tools/:name. Gulpy has no MCP server and no OAuth server for agents.
 */
import { capabilitiesAt, capabilitiesForAreas, levelOf, type AccessLevel, type AreaId } from "./capabilities.ts";
import { randomId } from "./crypto.ts";
import type { Deps } from "./deps.ts";
import type { Connection } from "./store.ts";

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

export function cleanName(value: unknown): string {
  const name = typeof value === "string" ? value.replace(/[\x00-\x1f]/g, "").trim().slice(0, 80) : "";
  return name || "Agent with no name";
}

const levelText = (level: AccessLevel, automatic: boolean): string =>
  `${level === "write" ? "Read and write" : "Read only"}${automatic ? " · automatic" : ""}`;

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
 * The user changes the access of an agent on the dashboard. `levels` has, for each connection
 * in the form, a level for each area (Gmail, Calendar, Drive, or the tools). A connection with
 * every area off loses its grant. With no grant left, the agent loses access, as with Remove access.
 * Returns false if the agent had no access.
 */
export function setAgentAccess(
  deps: Deps,
  appId: string,
  userId: string,
  levels: ReadonlyMap<string, ReadonlyMap<AreaId, AccessLevel | "off">>,
): boolean {
  const before = new Map(deps.store.grantsForAppUser(appId, userId).map((grant) => [grant.connectionId, grant]));
  if (before.size === 0) return false;
  const now = deps.now();
  deps.store.db.transaction(() => {
    for (const connection of deps.store.connectionsByUser(userId)) {
      const areas = levels.get(connection.id);
      const grant = before.get(connection.id);
      if (!areas) continue;
      const capabilities = capabilitiesForAreas(areas, connection.capabilities);
      if ((grant?.capabilities ?? []).join() === capabilities.join()) continue;
      // A connection that needs a new sign-in gets no new grant. It can still lose one.
      if (!grant && capabilities.length > 0 && connection.status !== "active") continue;
      if (capabilities.length === 0) {
        deps.store.deleteGrantFor(appId, connection.id);
      } else {
        deps.store.upsertGrant({
          id: grant?.id ?? randomId("grant"),
          userId,
          appId,
          connectionId: connection.id,
          capabilities,
          createdAt: grant?.createdAt ?? now,
          updatedAt: now,
        });
      }
      deps.store.audit({
        ts: now,
        userId,
        appId,
        connectionId: connection.id,
        action: capabilities.length === 0 ? "grant.remove" : "grant.approve",
        detail: capabilities.length === 0 ? "Removed by the user" : capabilities.join(", "),
        status: null,
      });
    }
    if (deps.store.grantsForAppUser(appId, userId).length === 0) {
      deps.store.revokeAccessTokensForAppUser(appId, userId, now);
    }
  })();
  return true;
}
