import type { ProviderCredentials } from "../config.ts";
import { buildMimeMessage, htmlToText } from "./mime.ts";
import {
  isTextType,
  readText,
  ProviderError,
  type CalendarEvent,
  type EmailMessage,
  type EmailSummary,
  type FileContent,
  type FileSummary,
  type Provider,
  type ProviderApi,
} from "./types.ts";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR = "https://www.googleapis.com/calendar/v3";
const DRIVE = "https://www.googleapis.com/drive/v3";
const SCOPE = "https://www.googleapis.com/auth";
const FILE_FIELDS = "id,name,mimeType,size,modifiedTime,webViewLink";

/** Google Docs, Sheets and Slides have no file. Drive exports them as text. Sheets gives the first sheet only. */
const EXPORTS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { data?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

interface GoogleEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string }[];
}

interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

function toFile(file: DriveFile): FileSummary {
  return {
    id: file.id,
    name: file.name ?? "",
    mime_type: file.mimeType ?? null,
    size: file.size === undefined ? null : Number(file.size),
    modified: file.modifiedTime ?? "",
    link: file.webViewLink ?? null,
  };
}

/** A value inside single quotes in a Drive query. */
function driveLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function header(message: GmailMessage, name: string): string {
  const wanted = name.toLowerCase();
  return message.payload?.headers?.find((item) => item.name.toLowerCase() === wanted)?.value ?? "";
}

function addresses(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toSummary(message: GmailMessage): EmailSummary {
  return {
    id: message.id,
    thread_id: message.threadId ?? null,
    from: header(message, "From"),
    to: addresses(header(message, "To")),
    subject: header(message, "Subject"),
    snippet: message.snippet ?? "",
    date: new Date(Number(message.internalDate ?? 0)).toISOString(),
    unread: message.labelIds?.includes("UNREAD") ?? false,
  };
}

function findPart(part: GmailPart | undefined, mimeType: string): string | null {
  if (!part) return null;
  if (part.mimeType === mimeType && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  }
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found !== null) return found;
  }
  return null;
}

function bodyText(message: GmailMessage): string {
  const plain = findPart(message.payload, "text/plain");
  if (plain !== null) return plain;
  const html = findPart(message.payload, "text/html");
  return html === null ? "" : htmlToText(html);
}

function toEvent(event: GoogleEvent): CalendarEvent {
  return {
    id: event.id,
    title: event.summary ?? "",
    start: event.start?.dateTime ?? event.start?.date ?? "",
    end: event.end?.dateTime ?? event.end?.date ?? "",
    all_day: !event.start?.dateTime,
    location: event.location ?? null,
    description: event.description ?? null,
    attendees: (event.attendees ?? []).flatMap((attendee) => (attendee.email ? [attendee.email] : [])),
    link: event.htmlLink ?? null,
  };
}

async function getMessage(api: ProviderApi, id: string, format: "metadata" | "full"): Promise<GmailMessage> {
  const url = new URL(`${GMAIL}/messages/${encodeURIComponent(id)}`);
  url.searchParams.set("format", format);
  if (format === "metadata") {
    for (const name of ["From", "To", "Subject", "Date"]) url.searchParams.append("metadataHeaders", name);
  }
  return api.json<GmailMessage>(url.toString());
}

export function googleProvider(credentials: ProviderCredentials): Provider {
  return {
    id: "google",
    name: "Google",
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    baseScopes: ["openid", "email", "profile"],
    capabilities: {
      "email.read": { request: [`${SCOPE}/gmail.readonly`], anyOf: [`${SCOPE}/gmail.readonly`, `${SCOPE}/gmail.modify`, "https://mail.google.com/"] },
      "email.send": { request: [`${SCOPE}/gmail.send`], anyOf: [`${SCOPE}/gmail.send`, `${SCOPE}/gmail.modify`, "https://mail.google.com/"] },
      "calendar.read": {
        request: [`${SCOPE}/calendar.events.readonly`],
        anyOf: [`${SCOPE}/calendar.events.readonly`, `${SCOPE}/calendar.readonly`, `${SCOPE}/calendar.events`, `${SCOPE}/calendar`],
      },
      "calendar.write": { request: [`${SCOPE}/calendar.events`], anyOf: [`${SCOPE}/calendar.events`, `${SCOPE}/calendar`] },
      "files.read": { request: [`${SCOPE}/drive.readonly`], anyOf: [`${SCOPE}/drive.readonly`, `${SCOPE}/drive`] },
    },
    // `prompt=consent` makes Google return a refresh token on each connect.
    authorizeParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    loginHintParam: "login_hint",
    normalizeScope: (scope) => scope,

    async fetchAccount(api) {
      const info = await api.json<{ sub: string; email?: string }>("https://openidconnect.googleapis.com/v1/userinfo");
      return { id: info.sub, label: info.email ?? info.sub };
    },

    services: {
      gmail: {
        baseUrl: "https://gmail.googleapis.com",
        rules: [
          { capability: "email.read", methods: ["GET"], path: /^\/gmail\/v1\/users\/me\/(profile|labels|messages|threads)(\/[\w-]+)*$/ },
          { capability: "email.send", methods: ["POST"], path: /^\/gmail\/v1\/users\/me\/messages\/send$/ },
        ],
      },
      calendar: {
        baseUrl: "https://www.googleapis.com",
        rules: [
          { capability: "calendar.read", methods: ["GET"], path: /^\/calendar\/v3\/calendars\/[^/]+\/events(\/[^/]+)?$/ },
          { capability: "calendar.write", methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], path: /^\/calendar\/v3\/calendars\/[^/]+\/events(\/[^/]+)?$/ },
        ],
      },
      drive: {
        baseUrl: "https://www.googleapis.com",
        rules: [{ capability: "files.read", methods: ["GET"], path: /^\/drive\/v3\/files(\/[\w-]+(\/export)?)?$/ }],
      },
    },

    unified: {
      async listMessages(api, { query, limit }) {
        const url = new URL(`${GMAIL}/messages`);
        url.searchParams.set("maxResults", String(limit));
        if (query) url.searchParams.set("q", query);
        const list = await api.json<{ messages?: { id: string }[] }>(url.toString());
        const messages = await Promise.all((list.messages ?? []).map((item) => getMessage(api, item.id, "metadata")));
        return messages.map(toSummary);
      },

      async getMessage(api, id): Promise<EmailMessage> {
        const message = await getMessage(api, id, "full");
        return { ...toSummary(message), body_text: bodyText(message) };
      },

      async sendMessage(api, message) {
        const raw = Buffer.from(buildMimeMessage(message), "utf8").toString("base64url");
        const sent = await api.json<{ id: string }>(`${GMAIL}/messages/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ raw }),
        });
        return { id: sent.id };
      },

      async listEvents(api, { from, to, limit }) {
        const url = new URL(`${CALENDAR}/calendars/primary/events`);
        url.searchParams.set("timeMin", from);
        url.searchParams.set("timeMax", to);
        url.searchParams.set("singleEvents", "true");
        url.searchParams.set("orderBy", "startTime");
        url.searchParams.set("maxResults", String(limit));
        const list = await api.json<{ items?: GoogleEvent[] }>(url.toString());
        return (list.items ?? []).map(toEvent);
      },

      async createEvent(api, event) {
        const created = await api.json<GoogleEvent>(`${CALENDAR}/calendars/primary/events`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            summary: event.title,
            description: event.description,
            location: event.location,
            start: { dateTime: event.start },
            end: { dateTime: event.end },
            attendees: event.attendees?.map((email) => ({ email })),
          }),
        });
        return toEvent(created);
      },

      async searchFiles(api, { query, limit }) {
        const url = new URL(`${DRIVE}/files`);
        const terms = ["trashed = false", "mimeType != 'application/vnd.google-apps.folder'"];
        // Drive does not sort a full-text search. It gives the best matches first.
        if (query) terms.push(`fullText contains ${driveLiteral(query)}`);
        else url.searchParams.set("orderBy", "modifiedTime desc");
        url.searchParams.set("q", terms.join(" and "));
        url.searchParams.set("pageSize", String(limit));
        url.searchParams.set("fields", `files(${FILE_FIELDS})`);
        url.searchParams.set("includeItemsFromAllDrives", "true");
        url.searchParams.set("supportsAllDrives", "true");
        const list = await api.json<{ files?: DriveFile[] }>(url.toString());
        return (list.files ?? []).map(toFile);
      },

      async readFile(api, id): Promise<FileContent> {
        const base = `${DRIVE}/files/${encodeURIComponent(id)}`;
        const file = toFile(await api.json<DriveFile>(`${base}?fields=${FILE_FIELDS}&supportsAllDrives=true`));
        const exportType = file.mime_type ? EXPORTS[file.mime_type] : undefined;
        let url: string;
        if (exportType) url = `${base}/export?mimeType=${encodeURIComponent(exportType)}`;
        else if (isTextType(file.mime_type)) url = `${base}?alt=media&supportsAllDrives=true`;
        else return { ...file, text: null, truncated: false };

        const response = await api.fetch(url, { headers: { accept: "*/*" } });
        if (!response.ok) throw new ProviderError("google", response.status, "Google did not give the file");
        return { ...file, ...(await readText(response)) };
      },
    },
  };
}
