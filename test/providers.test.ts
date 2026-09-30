/**
 * The Google and Microsoft adapters, against responses in the shape that the
 * provider documentation shows. These tests do not call the real services.
 */
import { describe, expect, test } from "bun:test";
import type { CapabilityId } from "../src/capabilities.ts";
import { googleProvider } from "../src/providers/google.ts";
import { microsoftProvider } from "../src/providers/microsoft.ts";
import {
  capabilitiesFor,
  ProviderError,
  scopesFor,
  type Provider,
  type ProviderApi,
} from "../src/providers/types.ts";

const credentials = { clientId: "client-id", clientSecret: "client-secret" };
const google = googleProvider(credentials);
const microsoft = microsoftProvider(credentials);

interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: any;
}

/** A provider API that answers from a list of canned replies. A reply that is a Response goes back as it is. */
function fakeApi(replies: Record<string, unknown>): { api: ProviderApi; calls: Call[] } {
  const calls: Call[] = [];
  const call = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const parsed = new URL(url);
    const method = init.method ?? "GET";
    calls.push({
      method,
      url: parsed,
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const key = `${method} ${parsed.origin}${parsed.pathname}`;
    if (!(key in replies)) return new Response("{}", { status: 404 });
    const reply = replies[key];
    if (reply instanceof Response) return reply;
    return reply === null ? new Response(null, { status: 202 }) : Response.json(reply);
  };
  return {
    calls,
    api: {
      fetch: call,
      // Marks the call, so that a test can check that no token went with it.
      download: (url: string) => call(url, { headers: { "x-download": "no-token" } }),
      async json<T>(url: string, init?: RequestInit) {
        const response = await call(url, init);
        if (!response.ok) throw new ProviderError("test", response.status, "failed");
        return (await response.json()) as T;
      },
    },
  };
}

function allowed(provider: Provider, held: CapabilityId[], service: string, method: string, path: string): boolean {
  const rules = provider.services[service]?.rules ?? [];
  return rules.some((rule) => held.includes(rule.capability) && rule.methods.includes(method) && rule.path.test(path));
}

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");

describe("Google", () => {
  test("asks for the narrow scopes, plus offline access", () => {
    expect(scopesFor(google, ["email.read", "calendar.write"])).toEqual([
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.events",
    ]);
    expect(google.authorizeParams).toMatchObject({ access_type: "offline", prompt: "consent" });
  });

  test("gives only the capabilities for the boxes that the user kept selected", () => {
    const granted = ["openid", "email", "https://www.googleapis.com/auth/calendar.events"];
    expect(capabilitiesFor(google, granted)).toEqual(["calendar.read", "calendar.write"]);
    expect(capabilitiesFor(google, ["openid", "email"])).toEqual([]);
    expect(capabilitiesFor(google, ["https://www.googleapis.com/auth/gmail.readonly"])).toEqual(["email.read"]);
  });

  test("reads the account", async () => {
    const { api } = fakeApi({
      "GET https://openidconnect.googleapis.com/v1/userinfo": { sub: "1140", email: "skyler@gmail.com" },
    });
    expect(await google.fetchAccount(api)).toEqual({ id: "1140", label: "skyler@gmail.com" });
  });

  test("lists messages", async () => {
    const { api, calls } = fakeApi({
      "GET https://gmail.googleapis.com/gmail/v1/users/me/messages": { messages: [{ id: "m1", threadId: "t1" }] },
      "GET https://gmail.googleapis.com/gmail/v1/users/me/messages/m1": {
        id: "m1",
        threadId: "t1",
        labelIds: ["INBOX", "UNREAD"],
        snippet: "Here is the agenda",
        internalDate: "1790510400000",
        payload: {
          headers: [
            { name: "From", value: "Priya Raman <priya@northwind.example>" },
            { name: "To", value: "skyler@gmail.com, Dana <dana@lakeshore.example>" },
            { name: "Subject", value: "Q4 planning" },
          ],
        },
      },
    });
    const messages = await google.unified.listMessages(api, { query: "from:priya", limit: 5 });
    expect(messages).toEqual([
      {
        id: "m1",
        thread_id: "t1",
        from: "Priya Raman <priya@northwind.example>",
        to: ["skyler@gmail.com", "Dana <dana@lakeshore.example>"],
        subject: "Q4 planning",
        snippet: "Here is the agenda",
        date: "2026-09-27T12:00:00.000Z",
        unread: true,
      },
    ]);
    expect(calls[0]?.url.searchParams.get("q")).toBe("from:priya");
    expect(calls[0]?.url.searchParams.get("maxResults")).toBe("5");
    expect(calls[1]?.url.searchParams.get("format")).toBe("metadata");
    expect(calls[1]?.url.searchParams.getAll("metadataHeaders")).toContain("Subject");
  });

  test("reads the text of a multipart message, and falls back to HTML", async () => {
    const multipart = {
      id: "m1",
      payload: {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { data: b64("Plain text — with a dash") } },
          { mimeType: "text/html", body: { data: b64("<p>HTML</p>") } },
        ],
      },
    };
    const plain = fakeApi({ "GET https://gmail.googleapis.com/gmail/v1/users/me/messages/m1": multipart });
    expect((await google.unified.getMessage(plain.api, "m1")).body_text).toBe("Plain text — with a dash");
    expect(plain.calls[0]?.url.searchParams.get("format")).toBe("full");

    const htmlOnly = fakeApi({
      "GET https://gmail.googleapis.com/gmail/v1/users/me/messages/m2": {
        id: "m2",
        payload: { mimeType: "text/html", body: { data: b64("<style>p{}</style><p>Hello &amp; welcome</p><p>Line 2</p>") } },
      },
    });
    expect((await google.unified.getMessage(htmlOnly.api, "m2")).body_text).toBe("Hello & welcome\nLine 2");
  });

  test("sends a message as base64url MIME", async () => {
    const { api, calls } = fakeApi({
      "POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send": { id: "sent1" },
    });
    const result = await google.unified.sendMessage(api, {
      to: ["dana@lakeshore.example"],
      cc: ["priya@northwind.example"],
      subject: "Friday",
      body_text: "Friday at 10:00 is OK.",
    });
    expect(result).toEqual({ id: "sent1" });
    const mime = Buffer.from(calls[0]?.body.raw, "base64url").toString("utf8");
    const [head, body] = mime.split("\r\n\r\n");
    expect(head).toContain("To: dana@lakeshore.example");
    expect(head).toContain("Cc: priya@northwind.example");
    expect(head).toContain("Subject: Friday");
    expect(Buffer.from(body ?? "", "base64").toString("utf8")).toBe("Friday at 10:00 is OK.");
  });

  test("lists events, with all-day events", async () => {
    const { api, calls } = fakeApi({
      "GET https://www.googleapis.com/calendar/v3/calendars/primary/events": {
        items: [
          {
            id: "e1",
            summary: "Standup",
            start: { dateTime: "2026-09-28T09:00:00-04:00" },
            end: { dateTime: "2026-09-28T09:15:00-04:00" },
            attendees: [{ email: "bob@acme.test" }, {}],
            htmlLink: "https://calendar.google.com/event?eid=1",
          },
          { id: "e2", summary: "Conference", start: { date: "2026-09-29" }, end: { date: "2026-09-30" } },
        ],
      },
    });
    const events = await google.unified.listEvents(api, {
      from: "2026-09-27T00:00:00.000Z",
      to: "2026-10-04T00:00:00.000Z",
      limit: 10,
    });
    expect(events[0]).toEqual({
      id: "e1",
      title: "Standup",
      start: "2026-09-28T09:00:00-04:00",
      end: "2026-09-28T09:15:00-04:00",
      all_day: false,
      location: null,
      description: null,
      attendees: ["bob@acme.test"],
      link: "https://calendar.google.com/event?eid=1",
    });
    expect(events[1]).toMatchObject({ start: "2026-09-29", all_day: true });
    const query = calls[0]?.url.searchParams;
    expect(query?.get("singleEvents")).toBe("true");
    expect(query?.get("orderBy")).toBe("startTime");
    expect(query?.get("timeMin")).toBe("2026-09-27T00:00:00.000Z");
  });

  test("creates an event", async () => {
    const { api, calls } = fakeApi({
      "POST https://www.googleapis.com/calendar/v3/calendars/primary/events": {
        id: "e9",
        summary: "Focus",
        start: { dateTime: "2026-09-28T15:00:00Z" },
        end: { dateTime: "2026-09-28T16:00:00Z" },
      },
    });
    const event = await google.unified.createEvent(api, {
      title: "Focus",
      start: "2026-09-28T15:00:00.000Z",
      end: "2026-09-28T16:00:00.000Z",
      attendees: ["dana@lakeshore.example"],
    });
    expect(event.id).toBe("e9");
    expect(calls[0]?.body).toMatchObject({
      summary: "Focus",
      start: { dateTime: "2026-09-28T15:00:00.000Z" },
      attendees: [{ email: "dana@lakeshore.example" }],
    });
  });


  test("asks for read-only Drive access for files", () => {
    expect(scopesFor(google, ["files.read"])).toContain("https://www.googleapis.com/auth/drive.readonly");
    expect(capabilitiesFor(google, ["https://www.googleapis.com/auth/drive"])).toEqual(["files.read"]);
  });

  test("searches files. A search has no order, and quotes in the words are escaped", async () => {
    const replies = {
      "GET https://www.googleapis.com/drive/v3/files": {
        files: [
          {
            id: "d1",
            name: "Q4 plan",
            mimeType: "application/vnd.google-apps.document",
            modifiedTime: "2026-09-27T12:00:00.000Z",
            webViewLink: "https://docs.google.com/document/d/d1",
          },
          { id: "d2", name: "notes.txt", mimeType: "text/plain", size: "42", modifiedTime: "2026-09-26T12:00:00.000Z" },
        ],
      },
    };
    const search = fakeApi(replies);
    const files = await google.unified.searchFiles!(search.api, { query: "Dana's plan", limit: 5 });
    expect(files).toEqual([
      {
        id: "d1",
        name: "Q4 plan",
        mime_type: "application/vnd.google-apps.document",
        size: null,
        modified: "2026-09-27T12:00:00.000Z",
        link: "https://docs.google.com/document/d/d1",
      },
      { id: "d2", name: "notes.txt", mime_type: "text/plain", size: 42, modified: "2026-09-26T12:00:00.000Z", link: null },
    ]);
    const query = search.calls[0]?.url.searchParams;
    expect(query?.get("q")).toBe(
      "trashed = false and mimeType != 'application/vnd.google-apps.folder' and fullText contains 'Dana\\'s plan'",
    );
    expect(query?.has("orderBy")).toBe(false);
    expect(query?.get("pageSize")).toBe("5");

    const recent = fakeApi(replies);
    await google.unified.searchFiles!(recent.api, { limit: 5 });
    expect(recent.calls[0]?.url.searchParams.get("orderBy")).toBe("modifiedTime desc");
  });

  test("reads a Google Doc as exported text, and a text file as it is", async () => {
    const doc = fakeApi({
      "GET https://www.googleapis.com/drive/v3/files/d1": { id: "d1", name: "Q4 plan", mimeType: "application/vnd.google-apps.document" },
      "GET https://www.googleapis.com/drive/v3/files/d1/export": new Response("The plan for Q4."),
    });
    expect(await google.unified.readFile!(doc.api, "d1")).toMatchObject({ name: "Q4 plan", text: "The plan for Q4.", truncated: false });
    expect(doc.calls[1]?.url.searchParams.get("mimeType")).toBe("text/plain");

    const sheet = fakeApi({
      "GET https://www.googleapis.com/drive/v3/files/s1": { id: "s1", mimeType: "application/vnd.google-apps.spreadsheet" },
      "GET https://www.googleapis.com/drive/v3/files/s1/export": new Response("a,b\n1,2"),
    });
    expect((await google.unified.readFile!(sheet.api, "s1")).text).toBe("a,b\n1,2");
    expect(sheet.calls[1]?.url.searchParams.get("mimeType")).toBe("text/csv");

    const text = fakeApi({ "GET https://www.googleapis.com/drive/v3/files/t1": new Response("x".repeat(250_000)) });
    // The first call gets the metadata. The fake gives the same path both times, so give the metadata first.
    text.api.json = async <T>() => ({ id: "t1", name: "log.txt", mimeType: "text/plain" }) as T;
    const read = await google.unified.readFile!(text.api, "t1");
    expect(read.text?.length).toBe(200_000);
    expect(read.truncated).toBe(true);
    expect(text.calls[0]?.url.searchParams.get("alt")).toBe("media");
  });

  test("gives no text for a file type that it cannot read", async () => {
    const { api, calls } = fakeApi({
      "GET https://www.googleapis.com/drive/v3/files/p1": { id: "p1", name: "photo.jpg", mimeType: "image/jpeg" },
    });
    expect(await google.unified.readFile!(api, "p1")).toMatchObject({ name: "photo.jpg", text: null, truncated: false });
    expect(calls).toHaveLength(1);
  });

  test("proxy rules", () => {
    const read: CapabilityId[] = ["email.read", "calendar.read"];
    expect(allowed(google, read, "gmail", "GET", "/gmail/v1/users/me/messages")).toBe(true);
    expect(allowed(google, read, "gmail", "GET", "/gmail/v1/users/me/messages/18c2f")).toBe(true);
    expect(allowed(google, read, "gmail", "GET", "/gmail/v1/users/me/labels")).toBe(true);
    expect(allowed(google, read, "calendar", "GET", "/calendar/v3/calendars/primary/events")).toBe(true);

    expect(allowed(google, read, "gmail", "POST", "/gmail/v1/users/me/messages/send")).toBe(false);
    expect(allowed(google, read, "gmail", "DELETE", "/gmail/v1/users/me/messages/18c2f")).toBe(false);
    expect(allowed(google, read, "gmail", "POST", "/gmail/v1/users/me/messages/18c2f/trash")).toBe(false);
    expect(allowed(google, read, "gmail", "GET", "/gmail/v1/users/someone@else.example/messages")).toBe(false);
    expect(allowed(google, read, "gmail", "GET", "/gmail/v1/users/me/settings/forwardingAddresses")).toBe(false);
    expect(allowed(google, read, "calendar", "POST", "/calendar/v3/calendars/primary/events")).toBe(false);
    expect(allowed(google, read, "calendar", "GET", "/drive/v3/files")).toBe(false);

    expect(allowed(google, ["email.send"], "gmail", "POST", "/gmail/v1/users/me/messages/send")).toBe(true);
    expect(allowed(google, ["email.send"], "gmail", "GET", "/gmail/v1/users/me/messages")).toBe(false);
    expect(allowed(google, ["calendar.write"], "calendar", "PATCH", "/calendar/v3/calendars/primary/events/e1")).toBe(true);
    expect(allowed(google, ["files.read"], "drive", "GET", "/drive/v3/files/d1/export")).toBe(true);
    expect(allowed(google, ["files.read"], "drive", "DELETE", "/drive/v3/files/d1")).toBe(false);
    expect(allowed(google, ["files.read"], "drive", "GET", "/drive/v3/files/d1/permissions")).toBe(false);
  });
});

describe("Microsoft", () => {
  test("asks for offline access and compares scopes in any form", () => {
    expect(scopesFor(microsoft, ["email.read"])).toEqual([
      "openid",
      "email",
      "profile",
      "offline_access",
      "User.Read",
      "Mail.Read",
    ]);
    const granted = ["https://graph.microsoft.com/Mail.Read", "https://graph.microsoft.com/Calendars.ReadWrite", "openid"];
    expect(capabilitiesFor(microsoft, granted)).toEqual(["email.read", "calendar.read", "calendar.write"]);
    expect(capabilitiesFor(microsoft, ["mail.send"])).toEqual(["email.send"]);
  });

  test("reads the account, and uses the sign-in name if there is no mailbox address", async () => {
    const { api } = fakeApi({
      "GET https://graph.microsoft.com/v1.0/me": { id: "a1", mail: null, userPrincipalName: "skyler@outlook.com" },
    });
    expect(await microsoft.fetchAccount(api)).toEqual({ id: "a1", label: "skyler@outlook.com" });
  });

  test("lists messages. A search does not use $orderby", async () => {
    const replies = {
      "GET https://graph.microsoft.com/v1.0/me/messages": {
        value: [
          {
            id: "AAMk1",
            conversationId: "c1",
            subject: "Budget",
            from: { emailAddress: { name: "Priya Raman", address: "priya@northwind.example" } },
            toRecipients: [{ emailAddress: { name: "skyler@outlook.com", address: "skyler@outlook.com" } }],
            receivedDateTime: "2026-09-27T11:00:00Z",
            bodyPreview: "The budget is ready",
            isRead: false,
          },
        ],
      },
    };
    const newest = fakeApi(replies);
    expect(await microsoft.unified.listMessages(newest.api, { limit: 10 })).toEqual([
      {
        id: "AAMk1",
        thread_id: "c1",
        from: "Priya Raman <priya@northwind.example>",
        to: ["skyler@outlook.com"],
        subject: "Budget",
        snippet: "The budget is ready",
        date: "2026-09-27T11:00:00Z",
        unread: true,
      },
    ]);
    expect(newest.calls[0]?.url.searchParams.get("$orderby")).toBe("receivedDateTime desc");
    expect(newest.calls[0]?.url.searchParams.get("$top")).toBe("10");

    const search = fakeApi(replies);
    await microsoft.unified.listMessages(search.api, { query: 'budget "q4"', limit: 10 });
    expect(search.calls[0]?.url.searchParams.get("$search")).toBe('"budget q4"');
    expect(search.calls[0]?.url.searchParams.has("$orderby")).toBe(false);
  });

  test("reads one message as text", async () => {
    const { api, calls } = fakeApi({
      "GET https://graph.microsoft.com/v1.0/me/messages/AAMk1": {
        id: "AAMk1",
        subject: "Budget",
        body: { contentType: "text", content: "The budget is ready." },
      },
    });
    expect((await microsoft.unified.getMessage(api, "AAMk1")).body_text).toBe("The budget is ready.");
    expect(calls[0]?.headers.get("prefer")).toBe('outlook.body-content-type="text"');
  });

  test("sends a message", async () => {
    const { api, calls } = fakeApi({ "POST https://graph.microsoft.com/v1.0/me/sendMail": null });
    const result = await microsoft.unified.sendMessage(api, {
      to: ["dana@lakeshore.example"],
      subject: "Friday",
      body_text: "Friday at 10:00 is OK.",
    });
    expect(result).toEqual({ id: null });
    expect(calls[0]?.body).toEqual({
      message: {
        subject: "Friday",
        body: { contentType: "Text", content: "Friday at 10:00 is OK." },
        toRecipients: [{ emailAddress: { address: "dana@lakeshore.example" } }],
        ccRecipients: [],
      },
      saveToSentItems: true,
    });
  });

  test("lists events in UTC", async () => {
    const { api, calls } = fakeApi({
      "GET https://graph.microsoft.com/v1.0/me/calendarView": {
        value: [
          {
            id: "ev1",
            subject: "Standup",
            start: { dateTime: "2026-09-28T13:00:00.0000000", timeZone: "UTC" },
            end: { dateTime: "2026-09-28T13:15:00.0000000", timeZone: "UTC" },
            isAllDay: false,
            location: { displayName: "" },
            attendees: [{ emailAddress: { address: "bob@acme.test" } }],
            webLink: "https://outlook.office365.com/owa/?itemid=1",
          },
          {
            id: "ev2",
            subject: "Conference",
            start: { dateTime: "2026-09-29T00:00:00.0000000", timeZone: "UTC" },
            end: { dateTime: "2026-09-30T00:00:00.0000000", timeZone: "UTC" },
            isAllDay: true,
          },
        ],
      },
    });
    const events = await microsoft.unified.listEvents(api, {
      from: "2026-09-27T00:00:00.000Z",
      to: "2026-10-04T00:00:00.000Z",
      limit: 10,
    });
    expect(events[0]).toMatchObject({
      title: "Standup",
      start: "2026-09-28T13:00:00.000Z",
      end: "2026-09-28T13:15:00.000Z",
      all_day: false,
      location: null,
      attendees: ["bob@acme.test"],
    });
    expect(Date.parse(events[0]?.start ?? "")).toBe(Date.UTC(2026, 8, 28, 13, 0));
    expect(events[1]).toMatchObject({ start: "2026-09-29", end: "2026-09-30", all_day: true });
    expect(calls[0]?.headers.get("prefer")).toBe('outlook.timezone="UTC"');
    expect(calls[0]?.url.searchParams.get("startDateTime")).toBe("2026-09-27T00:00:00.000Z");
  });

  test("creates an event. A time with an offset becomes UTC", async () => {
    const { api, calls } = fakeApi({
      "POST https://graph.microsoft.com/v1.0/me/events": {
        id: "ev9",
        subject: "Focus",
        start: { dateTime: "2026-09-28T19:00:00.0000000", timeZone: "UTC" },
        end: { dateTime: "2026-09-28T20:00:00.0000000", timeZone: "UTC" },
      },
    });
    const event = await microsoft.unified.createEvent(api, {
      title: "Focus",
      start: "2026-09-28T15:00:00-04:00",
      end: "2026-09-28T16:00:00-04:00",
      location: "Room 4B",
      attendees: ["dana@lakeshore.example"],
    });
    expect(event).toMatchObject({ id: "ev9", start: "2026-09-28T19:00:00.000Z" });
    expect(calls[0]?.body).toMatchObject({
      subject: "Focus",
      start: { dateTime: "2026-09-28T19:00:00.000", timeZone: "UTC" },
      end: { dateTime: "2026-09-28T20:00:00.000", timeZone: "UTC" },
      location: { displayName: "Room 4B" },
      attendees: [{ emailAddress: { address: "dana@lakeshore.example" }, type: "required" }],
    });
  });


  test("searches OneDrive and leaves out folders", async () => {
    const replies = {
      "GET https://graph.microsoft.com/v1.0/me/drive/root/search(q='Dana''s%20plan')": {
        value: [
          { id: "f1", name: "Plan.docx", file: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, size: 900, lastModifiedDateTime: "2026-09-27T12:00:00Z", webUrl: "https://onedrive.live.com/f1" },
          { id: "f2", name: "Plans", folder: { childCount: 2 } },
        ],
      },
      "GET https://graph.microsoft.com/v1.0/me/drive/root/children": { value: [] },
    };
    const search = fakeApi(replies);
    expect(await microsoft.unified.searchFiles!(search.api, { query: "Dana's plan", limit: 5 })).toEqual([
      {
        id: "f1",
        name: "Plan.docx",
        mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 900,
        modified: "2026-09-27T12:00:00Z",
        link: "https://onedrive.live.com/f1",
      },
    ]);
    expect(search.calls[0]?.url.searchParams.has("$orderby")).toBe(false);

    const recent = fakeApi(replies);
    await microsoft.unified.searchFiles!(recent.api, { limit: 5 });
    expect(recent.calls[0]?.url.pathname).toBe("/v1.0/me/drive/root/children");
    expect(recent.calls[0]?.url.searchParams.get("$orderby")).toBe("lastModifiedDateTime desc");
  });

  test("reads a text file from the signed address, with no token", async () => {
    const { api, calls } = fakeApi({
      "GET https://graph.microsoft.com/v1.0/me/drive/items/f3": {
        id: "f3",
        name: "notes.md",
        file: { mimeType: "text/markdown" },
        "@microsoft.graph.downloadUrl": "https://public.am.files.1drv.com/y4m-signed",
      },
      "GET https://public.am.files.1drv.com/y4m-signed": new Response("# Notes"),
    });
    expect(await microsoft.unified.readFile!(api, "f3")).toMatchObject({ name: "notes.md", text: "# Notes", truncated: false });
    expect(calls[1]?.headers.get("x-download")).toBe("no-token");
  });

  test("gives no text for a Word file", async () => {
    const { api, calls } = fakeApi({
      "GET https://graph.microsoft.com/v1.0/me/drive/items/f1": {
        id: "f1",
        name: "Plan.docx",
        file: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
        "@microsoft.graph.downloadUrl": "https://public.am.files.1drv.com/y4m-signed",
      },
    });
    expect(await microsoft.unified.readFile!(api, "f1")).toMatchObject({ text: null });
    expect(calls).toHaveLength(1);
  });

  test("proxy rules", () => {
    const read: CapabilityId[] = ["email.read", "calendar.read"];
    expect(allowed(microsoft, read, "graph", "GET", "/v1.0/me/messages")).toBe(true);
    expect(allowed(microsoft, read, "graph", "GET", "/v1.0/me/mailFolders/inbox/messages")).toBe(true);
    expect(allowed(microsoft, read, "graph", "GET", "/v1.0/me/calendarView")).toBe(true);

    expect(allowed(microsoft, read, "graph", "POST", "/v1.0/me/sendMail")).toBe(false);
    expect(allowed(microsoft, read, "graph", "POST", "/v1.0/me/events")).toBe(false);
    expect(allowed(microsoft, read, "graph", "DELETE", "/v1.0/me/messages/AAMk1")).toBe(false);
    expect(allowed(microsoft, read, "graph", "GET", "/v1.0/users")).toBe(false);
    expect(allowed(microsoft, read, "graph", "GET", "/v1.0/me/drive/root/children")).toBe(false);
    expect(allowed(microsoft, read, "graph", "GET", "/beta/me/messages")).toBe(false);

    expect(allowed(microsoft, ["email.send"], "graph", "POST", "/v1.0/me/sendMail")).toBe(true);
    expect(allowed(microsoft, ["calendar.write"], "graph", "PATCH", "/v1.0/me/events/ev1")).toBe(true);
    expect(allowed(microsoft, ["files.read"], "graph", "GET", "/v1.0/me/drive/root/children")).toBe(true);
    expect(allowed(microsoft, ["files.read"], "graph", "GET", "/v1.0/me/drive/items/f1")).toBe(true);
    expect(allowed(microsoft, ["files.read"], "graph", "DELETE", "/v1.0/me/drive/items/f1")).toBe(false);
    expect(allowed(microsoft, ["files.read"], "graph", "GET", "/v1.0/me/drive/items/f1/permissions")).toBe(false);
  });
});
