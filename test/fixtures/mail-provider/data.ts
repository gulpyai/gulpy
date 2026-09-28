import type { CalendarEvent, EmailMessage } from "../../../src/providers/types.ts";

export interface Account {
  id: string;
  email: string;
  name: string;
}

export const ACCOUNTS: Account[] = [
  { id: "acme-1001", email: "alice@acme.test", name: "Alice Moreno" },
  { id: "acme-1002", email: "bob@acme.test", name: "Bob Tanaka" },
];

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

interface MessageSeed {
  from: string;
  subject: string;
  body: string;
  hoursAgo: number;
  unread: boolean;
}

const MESSAGES: Record<string, MessageSeed[]> = {
  "acme-1001": [
    {
      from: "Priya Raman <priya@northwind.example>",
      subject: "Q4 planning: agenda for Thursday",
      body: "Hi Alice,\n\nHere is the agenda for Thursday:\n1. Hiring plan\n2. Launch date for the agent SDK\n3. Budget\n\nTell me if you want to add a topic.\n\nPriya",
      hoursAgo: 1,
      unread: true,
    },
    {
      from: "Dana Whitfield <dana@lakeshore.example>",
      subject: "Can we move our 1:1 to Friday?",
      body: "Alice, I have a conflict on Wednesday. Is Friday at 10:00 OK for you?\n\nDana",
      hoursAgo: 3,
      unread: true,
    },
    {
      from: "Git Host <noreply@githost.example>",
      subject: "[gulpy] Review requested on pull request 42",
      body: "bob-tanaka requested your review on pull request 42: Add Microsoft provider.",
      hoursAgo: 7,
      unread: false,
    },
    {
      from: "Skyline Air <no-reply@skylineair.example>",
      subject: "Your flight to San Francisco is confirmed",
      body: "Confirmation code: QX7L2M\nNewark (EWR) to San Francisco (SFO)\nDeparture: Monday 08:15\nSeat: 14C",
      hoursAgo: 20,
      unread: false,
    },
    {
      from: "Payments <receipts@payments.example>",
      subject: "Your receipt from Design Tool",
      body: "Amount paid: $15.00\nPlan: Professional, monthly\nCard ending in 4242",
      hoursAgo: 26,
      unread: false,
    },
    {
      from: "Mom <mom@family.example>",
      subject: "Dinner on Sunday?",
      body: "Are you free on Sunday at 6? Dad wants to make the pasta.",
      hoursAgo: 49,
      unread: false,
    },
  ],
  "acme-1002": [
    {
      from: "Alice Moreno <alice@acme.test>",
      subject: "Review of the Microsoft provider",
      body: "Bob, I left three comments on pull request 42. The token refresh looks good.",
      hoursAgo: 2,
      unread: true,
    },
    {
      from: "Building Office <office@harborlofts.example>",
      subject: "Water off on Tuesday, 9:00 to 11:00",
      body: "We will repair a valve on Tuesday. The water will be off from 9:00 to 11:00.",
      hoursAgo: 30,
      unread: false,
    },
  ],
};

interface EventSeed {
  title: string;
  inDays: number;
  hour: number;
  lengthMinutes: number;
  location?: string;
  attendees?: string[];
}

const EVENTS: Record<string, EventSeed[]> = {
  "acme-1001": [
    { title: "Standup", inDays: 1, hour: 9, lengthMinutes: 15, attendees: ["bob@acme.test"] },
    { title: "1:1 with Dana", inDays: 2, hour: 14, lengthMinutes: 30, attendees: ["dana@lakeshore.example"] },
    { title: "Q4 planning", inDays: 3, hour: 11, lengthMinutes: 60, location: "Room 4B", attendees: ["priya@northwind.example"] },
    { title: "Flight to San Francisco", inDays: 5, hour: 8, lengthMinutes: 360, location: "Newark (EWR)" },
  ],
  "acme-1002": [{ title: "Standup", inDays: 1, hour: 9, lengthMinutes: 15, attendees: ["alice@acme.test"] }],
};

/** Fake mailbox and calendar for each account. Times are relative to the start time, so the data looks new. */
export class MockData {
  private readonly messages = new Map<string, EmailMessage[]>();
  private readonly events = new Map<string, CalendarEvent[]>();
  private counter = 0;

  constructor(now: number) {
    const midnight = new Date(now).setUTCHours(0, 0, 0, 0);
    for (const account of ACCOUNTS) {
      this.messages.set(
        account.id,
        (MESSAGES[account.id] ?? []).map((seed, index) => ({
          id: `msg-${account.id}-${index + 1}`,
          thread_id: `thr-${account.id}-${index + 1}`,
          from: seed.from,
          to: [account.email],
          subject: seed.subject,
          snippet: seed.body.replace(/\s+/g, " ").slice(0, 110),
          date: new Date(now - seed.hoursAgo * HOUR).toISOString(),
          unread: seed.unread,
          body_text: seed.body,
        })),
      );
      this.events.set(
        account.id,
        (EVENTS[account.id] ?? []).map((seed, index) => {
          const start = midnight + seed.inDays * DAY + seed.hour * HOUR;
          return {
            id: `evt-${account.id}-${index + 1}`,
            title: seed.title,
            start: new Date(start).toISOString(),
            end: new Date(start + seed.lengthMinutes * 60_000).toISOString(),
            all_day: false,
            location: seed.location ?? null,
            description: null,
            attendees: seed.attendees ?? [],
            link: null,
          };
        }),
      );
    }
  }

  listMessages(accountId: string, query: string | undefined, limit: number): EmailMessage[] {
    const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    return (this.messages.get(accountId) ?? [])
      .filter((message) => {
        const haystack = `${message.from} ${message.subject} ${message.body_text}`.toLowerCase();
        return words.every((word) => haystack.includes(word));
      })
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, limit);
  }

  message(accountId: string, id: string): EmailMessage | undefined {
    return this.messages.get(accountId)?.find((message) => message.id === id);
  }

  send(account: Account, input: { to: string[]; subject: string; body_text: string }, now: number): EmailMessage {
    const message: EmailMessage = {
      id: `msg-${account.id}-sent-${++this.counter}`,
      thread_id: null,
      from: `${account.name} <${account.email}>`,
      to: input.to,
      subject: input.subject,
      snippet: input.body_text.replace(/\s+/g, " ").slice(0, 110),
      date: new Date(now).toISOString(),
      unread: false,
      body_text: input.body_text,
    };
    this.messages.get(account.id)?.push(message);
    return message;
  }

  listEvents(accountId: string, from: number, to: number, limit: number): CalendarEvent[] {
    return (this.events.get(accountId) ?? [])
      .filter((event) => Date.parse(event.end) > from && Date.parse(event.start) < to)
      .sort((a, b) => a.start.localeCompare(b.start))
      .slice(0, limit);
  }

  createEvent(
    accountId: string,
    input: { title: string; start: string; end: string; location?: string; description?: string; attendees?: string[] },
  ): CalendarEvent {
    const event: CalendarEvent = {
      id: `evt-${accountId}-new-${++this.counter}`,
      title: input.title,
      start: new Date(input.start).toISOString(),
      end: new Date(input.end).toISOString(),
      all_day: false,
      location: input.location ?? null,
      description: input.description ?? null,
      attendees: input.attendees ?? [],
      link: null,
    };
    this.events.get(accountId)?.push(event);
    return event;
  }
}
