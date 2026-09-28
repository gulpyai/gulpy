import type { CapabilityId } from "../capabilities.ts";

export interface EmailSummary {
  id: string;
  thread_id: string | null;
  from: string;
  to: string[];
  subject: string;
  snippet: string;
  /** ISO 8601 */
  date: string;
  unread: boolean;
}

export interface EmailMessage extends EmailSummary {
  body_text: string;
}

export interface NewEmail {
  to: string[];
  cc?: string[];
  subject: string;
  body_text: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO 8601. For an all-day event this is a date, for example 2026-09-27. */
  start: string;
  end: string;
  all_day: boolean;
  location: string | null;
  description: string | null;
  attendees: string[];
  link: string | null;
}

export interface NewEvent {
  title: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  attendees?: string[];
}

/** The provider returned an error. `status` is the HTTP status that the provider sent. */
export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** The caller sent a value that Gulpy cannot use. Maps to HTTP 400. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

/** HTTP client that is bound to one connection. It adds the token and refreshes it. */
export interface ProviderApi {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Throws ProviderError if the status is not 2xx. */
  json<T>(url: string, init?: RequestInit): Promise<T>;
}

export interface UnifiedAdapter {
  listMessages(api: ProviderApi, options: { query?: string; limit: number }): Promise<EmailSummary[]>;
  getMessage(api: ProviderApi, id: string): Promise<EmailMessage>;
  sendMessage(api: ProviderApi, message: NewEmail): Promise<{ id: string | null }>;
  listEvents(api: ProviderApi, options: { from: string; to: string; limit: number }): Promise<CalendarEvent[]>;
  createEvent(api: ProviderApi, event: NewEvent): Promise<CalendarEvent>;
}

export interface CapabilityScopes {
  /** Scopes that Gulpy requests for this capability. */
  request: string[];
  /** The capability is available if the provider granted one or more of these. Defaults to all of `request`. */
  anyOf?: string[];
}

export interface ProxyRule {
  capability: CapabilityId;
  methods: string[];
  /** Matched against the full path on the service host. */
  path: RegExp;
}

export interface ProxyService {
  /** Origin plus optional path prefix, for example https://gmail.googleapis.com */
  baseUrl: string;
  rules: ProxyRule[];
}

export interface ProviderAccount {
  /** Stable id of the account at the provider. */
  id: string;
  /** What the user sees, usually the email address. */
  label: string;
}

export interface Provider {
  id: string;
  name: string;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  /** Identity scopes. Gulpy requests these each time. */
  baseScopes: string[];
  capabilities: Partial<Record<CapabilityId, CapabilityScopes>>;
  /** Extra query parameters for the authorize request. */
  authorizeParams: Record<string, string>;
  /** Name of the authorize parameter that pre-selects an account, if the provider has one. */
  loginHintParam?: string;
  /** Makes scope strings comparable, for example strips a resource prefix. */
  normalizeScope(scope: string): string;
  fetchAccount(api: ProviderApi): Promise<ProviderAccount>;
  services: Record<string, ProxyService>;
  unified: UnifiedAdapter;
}

export function supportedCapabilities(provider: Provider): CapabilityId[] {
  return Object.keys(provider.capabilities) as CapabilityId[];
}

/** Scopes to request so that the token covers all the given capabilities. */
export function scopesFor(provider: Provider, capabilities: readonly CapabilityId[]): string[] {
  const scopes = new Set(provider.baseScopes);
  for (const capability of capabilities) {
    for (const scope of provider.capabilities[capability]?.request ?? []) scopes.add(scope);
  }
  return [...scopes];
}

/** Capabilities that the granted scopes cover. The user can refuse single scopes, so check each one. */
export function capabilitiesFor(provider: Provider, grantedScopes: readonly string[]): CapabilityId[] {
  const granted = new Set(grantedScopes.map((scope) => provider.normalizeScope(scope)));
  return supportedCapabilities(provider).filter((capability) => {
    const mapping = provider.capabilities[capability];
    if (!mapping) return false;
    if (mapping.anyOf) return mapping.anyOf.some((scope) => granted.has(provider.normalizeScope(scope)));
    return mapping.request.every((scope) => granted.has(provider.normalizeScope(scope)));
  });
}
