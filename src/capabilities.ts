/**
 * A capability is what an agent can do with one connection, in plain terms.
 * The user gives capabilities to each agent. Each connector maps a
 * capability to its own scopes or tools.
 */
export const CAPABILITIES = {
  "email.read": {
    label: "Read your email",
    detail: "Search and read messages. It cannot send or delete.",
    icon: "mail",
    write: false,
  },
  "email.send": {
    label: "Send email as you",
    detail: "Send new messages from your address.",
    icon: "send",
    write: true,
  },
  "calendar.read": {
    label: "See your calendar",
    detail: "Read events and their details.",
    icon: "calendar",
    write: false,
  },
  "calendar.write": {
    label: "Change your calendar",
    detail: "Create and edit events.",
    icon: "calendar-plus",
    write: true,
  },
  "files.read": {
    label: "See your files",
    detail: "Search files and read their text. It cannot change or delete.",
    icon: "file",
    write: false,
  },
  "tools.read": {
    label: "Look up information",
    detail: "Use the tools that only read data.",
    icon: "search",
    write: false,
  },
  "tools.write": {
    label: "Make changes",
    detail: "Use the tools that create, change or delete data.",
    icon: "edit",
    write: true,
  },
} as const;

export type CapabilityId = keyof typeof CAPABILITIES;

export const CAPABILITY_IDS = Object.keys(CAPABILITIES) as CapabilityId[];

/** How much an agent can do with one connection. */
export type AccessLevel = "read" | "write";

export function isCapability(value: unknown): value is CapabilityId {
  return typeof value === "string" && value in CAPABILITIES;
}

/** Keeps known capabilities, drops duplicates, and keeps catalog order. */
export function normalizeCapabilities(values: readonly unknown[]): CapabilityId[] {
  const wanted = new Set(values.filter(isCapability));
  return CAPABILITY_IDS.filter((id) => wanted.has(id));
}

/** The capabilities of a connection that the access level permits. */
export function capabilitiesAt(level: AccessLevel, held: readonly CapabilityId[]): CapabilityId[] {
  return held.filter((capability) => level === "write" || !CAPABILITIES[capability].write);
}

export function levelOf(capabilities: readonly CapabilityId[]): AccessLevel {
  return capabilities.some((capability) => CAPABILITIES[capability].write) ? "write" : "read";
}

/**
 * The parts of a connection that the user turns on or off for each agent: the email, the calendar,
 * the files of a Google or Microsoft account, or the tools of an MCP server. The id of an area is
 * the start of the id of its capabilities.
 */
export type AreaId = "email" | "calendar" | "files" | "tools";

export const AREAS: readonly AreaId[] = ["email", "calendar", "files", "tools"];

export function areaOf(capability: CapabilityId): AreaId {
  return capability.split(".")[0] as AreaId;
}

/** The areas that a connection has, in a fixed order. */
export function areasOf(held: readonly CapabilityId[]): AreaId[] {
  return AREAS.filter((area) => held.some((capability) => areaOf(capability) === area));
}

/** True if the area of this connection has a capability that changes data. */
export function areaWrites(area: AreaId, held: readonly CapabilityId[]): boolean {
  return held.some((capability) => areaOf(capability) === area && CAPABILITIES[capability].write);
}

/** What an agent can do in one area: nothing, read, or read and write. */
export function areaLevel(area: AreaId, capabilities: readonly CapabilityId[]): AccessLevel | "off" {
  const mine = capabilities.filter((capability) => areaOf(capability) === area);
  if (mine.length === 0) return "off";
  return levelOf(mine);
}

/** The capabilities of a connection for a level in each area. An area with no level is off. */
export function capabilitiesForAreas(
  levels: ReadonlyMap<AreaId, AccessLevel | "off">,
  held: readonly CapabilityId[],
): CapabilityId[] {
  return held.filter((capability) => {
    const level = levels.get(areaOf(capability)) ?? "off";
    return level === "write" || (level === "read" && !CAPABILITIES[capability].write);
  });
}
