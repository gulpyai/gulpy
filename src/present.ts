/** Builds what the pages show about connections and connectors. */
import { backendOf } from "./access.ts";
import { CATEGORIES, type Availability, type Category, type Connector } from "./catalog.ts";
import type { Deps } from "./deps.ts";
import type { LogoImage } from "./logos.ts";
import type { Connection } from "./store.ts";

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

/** "Gmail, Google Calendar and Google Drive". */
export function connectorNames(view: ConnectionView): string {
  const names = view.connectors.map((connector) => connector.name);
  if (names.length === 0) return view.name;
  if (names.length === 1) return names[0] ?? view.name;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
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
  category: Category | "Popular";
  cards: CatalogCard[];
}

function cardFor(connector: Connector, availability: Availability, connections: readonly Connection[]): CatalogCard {
  const { source } = connector;
  const match = connections.find((connection) =>
    source.kind === "mcp"
      ? connection.provider === connector.id
      : // A card for Gmail, Calendar and Drive is done only when the account gives all three.
        connection.provider === source.provider && source.capabilities.every((c) => connection.capabilities.includes(c)),
  );
  if (match) return { connector, state: "connected", account: match.accountLabel };
  return { connector, state: availability, account: null };
}

const ORDER: Record<CardState, number> = { connected: 0, ready: 1, setup_needed: 2 };

/** The tools that most people add. The dashboard shows them first, in their own group. */
export const POPULAR = ["google", "microsoft", "notion", "slack", "github", "linear", "figma", "stripe"];

/**
 * The catalog, in groups, with the state of each connector for this user.
 * In each group the tools that the user can add now are before the others.
 * `onlyUsable` removes the tools that the user cannot add now.
 * `popularFirst` moves the popular tools to a group of their own, first.
 */
export function viewCatalog(deps: Deps, userId: string, onlyUsable = false, popularFirst = false): CatalogGroup[] {
  const connections = deps.store.connectionsByUser(userId);
  const cards = deps.catalog
    .all()
    .map((connector) => cardFor(connector, deps.catalog.availability(connector), connections))
    .filter((card) => !onlyUsable || card.state !== "setup_needed")
    // The sort keeps the order of the list for cards with the same state.
    .sort((a, b) => ORDER[a.state] - ORDER[b.state]);
  const popular = popularFirst ? cards.filter((card) => POPULAR.includes(card.connector.id)) : [];
  const rest = cards.filter((card) => !popular.includes(card));
  return [
    { category: "Popular" as const, cards: popular },
    ...CATEGORIES.map((category) => ({ category, cards: rest.filter((card) => card.connector.category === category) })),
  ].filter((group) => group.cards.length > 0);
}
