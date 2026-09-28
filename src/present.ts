/** Builds what the pages show about connections and connectors. */
import { backendOf } from "./access.ts";
import { levelOf, type AccessLevel } from "./capabilities.ts";
import { CATEGORIES, type Availability, type Category, type Connector } from "./catalog.ts";
import type { Deps } from "./deps.ts";
import type { LogoImage } from "./logos.ts";
import type { Connection, Grant } from "./store.ts";

export interface ConnectionView {
  connection: Connection;
  /** "Google", or "Notion". */
  name: string;
  /** The logo to show. */
  logo: Connector | { name: string; color: string; image?: LogoImage; icon?: string };
  /** The catalog entries that this connection supplies. A Google account can supply Gmail and Google Calendar. */
  connectors: Connector[];
  /** Number of tools, for a connector that is an MCP server. */
  tools: { total: number; readOnly: number } | null;
}

export function viewConnection(deps: Deps, connection: Connection): ConnectionView | null {
  const backend = backendOf(deps, connection);
  if (!backend) return null;
  if (backend.kind === "mcp") {
    const tools = connection.tools ?? [];
    return {
      connection,
      name: backend.connector.name,
      logo: backend.connector,
      connectors: [backend.connector],
      tools: { total: tools.length, readOnly: tools.filter((tool) => tool.readOnly).length },
    };
  }
  const held = new Set(connection.capabilities);
  const connectors = deps.catalog
    .forConnection(connection.provider)
    .filter((connector) => connector.source.kind === "native" && connector.source.capabilities.some((c) => held.has(c)));
  return {
    connection,
    name: backend.provider.name,
    logo: connectors[0] ?? { name: backend.provider.name, color: "5B6470" },
    connectors,
    tools: null,
  };
}

export function viewConnections(deps: Deps, userId: string): ConnectionView[] {
  return deps.store.connectionsByUser(userId).flatMap((connection) => viewConnection(deps, connection) ?? []);
}

export type CardState = "connected" | "ready" | "setup_needed";

export interface CatalogCard {
  connector: Connector;
  state: CardState;
  /** The account, if the user connected this connector. */
  account: string | null;
}

export interface CatalogGroup {
  category: Category;
  cards: CatalogCard[];
}

function cardFor(connector: Connector, availability: Availability, connections: readonly Connection[]): CatalogCard {
  const { source } = connector;
  const match = connections.find((connection) =>
    source.kind === "mcp"
      ? connection.provider === connector.id
      : connection.provider === source.provider && source.capabilities.some((c) => connection.capabilities.includes(c)),
  );
  if (match) return { connector, state: "connected", account: match.accountLabel };
  return { connector, state: availability, account: null };
}

const ORDER: Record<CardState, number> = { connected: 0, ready: 1, setup_needed: 2 };

/**
 * The catalog, in groups, with the state of each connector for this user.
 * In each group the tools that the user can add now are before the others.
 * `onlyUsable` removes the tools that the user cannot add now.
 */
export function viewCatalog(deps: Deps, userId: string, onlyUsable = false): CatalogGroup[] {
  const connections = deps.store.connectionsByUser(userId);
  const cards = deps.catalog
    .all()
    .map((connector) => cardFor(connector, deps.catalog.availability(connector), connections))
    .filter((card) => !onlyUsable || card.state !== "setup_needed")
    // The sort keeps the order of the list for cards with the same state.
    .sort((a, b) => ORDER[a.state] - ORDER[b.state]);
  return CATEGORIES.map((category) => ({
    category,
    cards: cards.filter((card) => card.connector.category === category),
  })).filter((group) => group.cards.length > 0);
}

export interface AgentChoice {
  view: ConnectionView;
  selected: boolean;
  level: AccessLevel;
  /** False if the connection needs a new sign-in. */
  usable: boolean;
}

/**
 * What the approval page shows for one agent. An agent that the user approved
 * before keeps its selection. A new agent gets all connections, with read and
 * write access, so that one tap is enough.
 */
export function agentChoices(deps: Deps, userId: string, grants: readonly Grant[], justConnected?: string): AgentChoice[] {
  const byConnection = new Map(grants.map((grant) => [grant.connectionId, grant]));
  const isNew = grants.length === 0;
  return viewConnections(deps, userId).map((view) => {
    const grant = byConnection.get(view.connection.id);
    const usable = view.connection.status === "active";
    return {
      view,
      usable,
      selected: usable && (isNew || grant !== undefined || view.connection.id === justConnected),
      level: grant ? levelOf(grant.capabilities) : "write",
    };
  });
}
