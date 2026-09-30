import type { ProviderCredentials } from "../config.ts";
import { isEmailAddress } from "./mime.ts";
import {
  InputError,
  isTextType,
  ProviderError,
  readText,
  type CalendarEvent,
  type EmailSummary,
  type FileSummary,
  type Provider,
} from "./types.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";
const MESSAGE_FIELDS = "id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead";
const EVENT_FIELDS = "id,subject,start,end,isAllDay,location,attendees,bodyPreview,webLink";
const FILE_FIELDS = "id,name,file,folder,size,lastModifiedDateTime,webUrl";

interface GraphAddress {
  emailAddress?: { name?: string; address?: string };
}

interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  from?: GraphAddress;
  toRecipients?: GraphAddress[];
  receivedDateTime?: string;
  bodyPreview?: string;
  isRead?: boolean;
  body?: { content?: string };
}

interface GraphEvent {
  id: string;
  subject?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  isAllDay?: boolean;
  location?: { displayName?: string };
  attendees?: GraphAddress[];
  bodyPreview?: string;
  webLink?: string;
}

interface GraphDriveItem {
  id: string;
  name?: string;
  file?: { mimeType?: string };
  folder?: unknown;
  size?: number;
  lastModifiedDateTime?: string;
  webUrl?: string;
  "@microsoft.graph.downloadUrl"?: string;
}

function toFile(item: GraphDriveItem): FileSummary {
  return {
    id: item.id,
    name: item.name ?? "",
    mime_type: item.file?.mimeType ?? null,
    size: item.size ?? null,
    modified: item.lastModifiedDateTime ?? "",
    link: item.webUrl ?? null,
  };
}

function display(address: GraphAddress | undefined): string {
  const name = address?.emailAddress?.name;
  const email = address?.emailAddress?.address ?? "";
  return name && name !== email ? `${name} <${email}>` : email;
}

function toSummary(message: GraphMessage): EmailSummary {
  return {
    id: message.id,
    thread_id: message.conversationId ?? null,
    from: display(message.from),
    to: (message.toRecipients ?? []).map(display).filter(Boolean),
    subject: message.subject ?? "",
    snippet: message.bodyPreview ?? "",
    date: message.receivedDateTime ?? "",
    unread: message.isRead === false,
  };
}

/** Graph returns UTC times without a zone, for example 2026-09-27T10:00:00.0000000 */
function utc(value: string | undefined, allDay: boolean): string {
  if (!value) return "";
  if (allDay) return value.slice(0, 10);
  return `${value.replace(/(\.\d{3})\d*$/, "$1")}Z`;
}

function toEvent(event: GraphEvent): CalendarEvent {
  const allDay = event.isAllDay ?? false;
  return {
    id: event.id,
    title: event.subject ?? "",
    start: utc(event.start?.dateTime, allDay),
    end: utc(event.end?.dateTime, allDay),
    all_day: allDay,
    location: event.location?.displayName || null,
    description: event.bodyPreview || null,
    attendees: (event.attendees ?? []).flatMap((item) => (item.emailAddress?.address ? [item.emailAddress.address] : [])),
    link: event.webLink ?? null,
  };
}

function recipients(list: readonly string[]): GraphAddress[] {
  return list.map((address) => {
    if (!isEmailAddress(address)) throw new InputError(`Not a valid email address: ${address}`);
    return { emailAddress: { address } };
  });
}

function graphTime(iso: string): { dateTime: string; timeZone: string } {
  return { dateTime: new Date(iso).toISOString().replace(/Z$/, ""), timeZone: "UTC" };
}

export function microsoftProvider(credentials: ProviderCredentials): Provider {
  return {
    id: "microsoft",
    name: "Microsoft",
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    baseScopes: ["openid", "email", "profile", "offline_access", "User.Read"],
    capabilities: {
      "email.read": { request: ["Mail.Read"], anyOf: ["Mail.Read", "Mail.ReadWrite"] },
      "email.send": { request: ["Mail.Send"] },
      "calendar.read": { request: ["Calendars.Read"], anyOf: ["Calendars.Read", "Calendars.ReadWrite"] },
      "calendar.write": { request: ["Calendars.ReadWrite"] },
      "files.read": { request: ["Files.Read"], anyOf: ["Files.Read", "Files.ReadWrite", "Files.Read.All", "Files.ReadWrite.All"] },
    },
    authorizeParams: { prompt: "select_account" },
    loginHintParam: "login_hint",
    normalizeScope: (scope) => scope.replace(/^https:\/\/graph\.microsoft\.com\//i, "").toLowerCase(),

    async fetchAccount(api) {
      const me = await api.json<{ id: string; mail?: string | null; userPrincipalName?: string }>(
        `${GRAPH}/me?$select=id,mail,userPrincipalName`,
      );
      return { id: me.id, label: me.mail ?? me.userPrincipalName ?? me.id };
    },

    services: {
      graph: {
        baseUrl: "https://graph.microsoft.com",
        rules: [
          { capability: "email.read", methods: ["GET"], path: /^\/v1\.0\/me\/(messages|mailFolders)(\/[^/]+)*$/ },
          { capability: "email.send", methods: ["POST"], path: /^\/v1\.0\/me\/sendMail$/ },
          { capability: "calendar.read", methods: ["GET"], path: /^\/v1\.0\/me\/(events|calendarView|calendars)(\/[^/]+)*$/ },
          { capability: "calendar.write", methods: ["GET", "POST", "PATCH", "DELETE"], path: /^\/v1\.0\/me\/events(\/[^/]+)?$/ },
          { capability: "files.read", methods: ["GET"], path: /^\/v1\.0\/me\/drive\/(root(\/children|\/search\(q='[^/]*'\))?|items\/[^/]+(\/children)?)$/ },
        ],
      },
    },

    unified: {
      async listMessages(api, { query, limit }) {
        const url = new URL(`${GRAPH}/me/messages`);
        url.searchParams.set("$top", String(limit));
        url.searchParams.set("$select", MESSAGE_FIELDS);
        // Graph does not accept $orderby together with $search.
        if (query) url.searchParams.set("$search", `"${query.replace(/"/g, "")}"`);
        else url.searchParams.set("$orderby", "receivedDateTime desc");
        const list = await api.json<{ value?: GraphMessage[] }>(url.toString());
        return (list.value ?? []).map(toSummary);
      },

      async getMessage(api, id) {
        const message = await api.json<GraphMessage>(
          `${GRAPH}/me/messages/${encodeURIComponent(id)}?$select=${MESSAGE_FIELDS},body`,
          { headers: { prefer: 'outlook.body-content-type="text"' } },
        );
        return { ...toSummary(message), body_text: message.body?.content ?? "" };
      },

      async sendMessage(api, message) {
        const response = await api.fetch(`${GRAPH}/me/sendMail`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: {
              subject: message.subject,
              body: { contentType: "Text", content: message.body_text },
              toRecipients: recipients(message.to),
              ccRecipients: recipients(message.cc ?? []),
            },
            saveToSentItems: true,
          }),
        });
        if (!response.ok) throw new ProviderError("microsoft", response.status, "Microsoft did not send the message");
        // sendMail returns 202 with no body, so there is no message id.
        return { id: null };
      },

      async listEvents(api, { from, to, limit }) {
        const url = new URL(`${GRAPH}/me/calendarView`);
        url.searchParams.set("startDateTime", from);
        url.searchParams.set("endDateTime", to);
        url.searchParams.set("$top", String(limit));
        url.searchParams.set("$orderby", "start/dateTime");
        url.searchParams.set("$select", EVENT_FIELDS);
        const list = await api.json<{ value?: GraphEvent[] }>(url.toString(), {
          headers: { prefer: 'outlook.timezone="UTC"' },
        });
        return (list.value ?? []).map(toEvent);
      },

      async createEvent(api, event) {
        const created = await api.json<GraphEvent>(`${GRAPH}/me/events`, {
          method: "POST",
          headers: { "content-type": "application/json", prefer: 'outlook.timezone="UTC"' },
          body: JSON.stringify({
            subject: event.title,
            body: event.description ? { contentType: "Text", content: event.description } : undefined,
            location: event.location ? { displayName: event.location } : undefined,
            start: graphTime(event.start),
            end: graphTime(event.end),
            attendees: (event.attendees ?? []).map((address) => ({ ...recipients([address])[0], type: "required" })),
          }),
        });
        return toEvent(created);
      },

      async searchFiles(api, { query, limit }) {
        // Graph has no sorted list of all files. "recent" is deprecated. With no words, list the top folder.
        const path = query
          ? `${GRAPH}/me/drive/root/search(q='${encodeURIComponent(query.replace(/'/g, "''"))}')`
          : `${GRAPH}/me/drive/root/children`;
        const url = new URL(path);
        url.searchParams.set("$top", String(limit));
        url.searchParams.set("$select", FILE_FIELDS);
        if (!query) url.searchParams.set("$orderby", "lastModifiedDateTime desc");
        const list = await api.json<{ value?: GraphDriveItem[] }>(url.toString());
        // Only files: a folder, and a special item such as "Personal Vault", have no `file` part.
        return (list.value ?? []).filter((item) => item.file).map(toFile);
      },

      async readFile(api, id) {
        // No $select: Graph then includes the signed download address.
        const item = await api.json<GraphDriveItem>(`${GRAPH}/me/drive/items/${encodeURIComponent(id)}`);
        const file = toFile(item);
        const download = item["@microsoft.graph.downloadUrl"];
        // Graph cannot give Word, Excel or PowerPoint files as text.
        if (!download || !isTextType(file.mime_type)) return { ...file, text: null, truncated: false };
        const response = await api.download(download);
        if (!response.ok) throw new ProviderError("microsoft", response.status, "Microsoft did not give the file");
        return { ...file, ...(await readText(response)) };
      },
    },
  };
}
