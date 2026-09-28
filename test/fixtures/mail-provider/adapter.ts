import type { CalendarEvent, EmailMessage, EmailSummary, Provider } from "../../../src/providers/types.ts";

export interface MailProviderConfig {
  clientId: string;
  clientSecret: string;
  /** Origin of the test mail provider */
  baseUrl: string;
}

/**
 * Acme Mail is a provider for the tests only. It is a real OAuth 2.0 server,
 * so the tests run the full flow with no network and no real account.
 */
export function demoProvider(config: MailProviderConfig): Provider {
  const api = `${config.baseUrl}/api`;
  return {
    id: "demo",
    name: "Acme Mail",
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    authorizeUrl: `${config.baseUrl}/oauth/authorize`,
    tokenUrl: `${config.baseUrl}/oauth/token`,
    revokeUrl: `${config.baseUrl}/oauth/revoke`,
    baseScopes: ["profile"],
    capabilities: {
      "email.read": { request: ["mail.read"] },
      "email.send": { request: ["mail.send"] },
      "calendar.read": { request: ["calendar.read"], anyOf: ["calendar.read", "calendar.write"] },
      "calendar.write": { request: ["calendar.write"] },
    },
    authorizeParams: {},
    loginHintParam: "login_hint",
    normalizeScope: (scope) => scope,

    async fetchAccount(client) {
      const me = await client.json<{ id: string; email: string }>(`${api}/me`);
      return { id: me.id, label: me.email };
    },

    services: {
      api: {
        baseUrl: config.baseUrl,
        rules: [
          { capability: "email.read", methods: ["GET"], path: /^\/api\/messages(\/[\w-]+)?$/ },
          { capability: "email.send", methods: ["POST"], path: /^\/api\/messages$/ },
          { capability: "calendar.read", methods: ["GET"], path: /^\/api\/events(\/[\w-]+)?$/ },
          { capability: "calendar.write", methods: ["GET", "POST"], path: /^\/api\/events(\/[\w-]+)?$/ },
        ],
      },
    },

    unified: {
      async listMessages(client, { query, limit }) {
        const url = new URL(`${api}/messages`);
        url.searchParams.set("limit", String(limit));
        if (query) url.searchParams.set("q", query);
        return (await client.json<{ messages: EmailSummary[] }>(url.toString())).messages;
      },

      getMessage(client, id) {
        return client.json<EmailMessage>(`${api}/messages/${encodeURIComponent(id)}`);
      },

      sendMessage(client, message) {
        return client.json<{ id: string }>(`${api}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(message),
        });
      },

      async listEvents(client, { from, to, limit }) {
        const url = new URL(`${api}/events`);
        url.searchParams.set("from", from);
        url.searchParams.set("to", to);
        url.searchParams.set("limit", String(limit));
        return (await client.json<{ events: CalendarEvent[] }>(url.toString())).events;
      },

      createEvent(client, event) {
        return client.json<CalendarEvent>(`${api}/events`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event),
        });
      },
    },
  };
}
