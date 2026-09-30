import {
  siAirtable,
  siAsana,
  siAtlassian,
  siBox,
  siClickup,
  siFigma,
  siGithub,
  siGoogle,
  siHubspot,
  siIntercom,
  siLinear,
  siMiro,
  siNeon,
  siNotion,
  siPaypal,
  siPosthog,
  siPrisma,
  siRailway,
  siRender,
  siSanity,
  siSentry,
  siSquare,
  siStripe,
  siSupabase,
  siVercel,
  siWebflow,
  siWix,
} from "simple-icons";
import type { CapabilityId } from "./capabilities.ts";
import type { Config } from "./config.ts";
import { logoImage, type LogoImage } from "./logos.ts";

export type Category = "Work" | "Meetings" | "Engineering" | "Sales and support" | "Design" | "Finance" | "Data" | "Personal";

export const CATEGORIES: Category[] = ["Work", "Meetings", "Engineering", "Sales and support", "Design", "Finance", "Data", "Personal"];

export type ConnectorSource =
  /** Gulpy calls the provider API and supplies its own tools. */
  | { kind: "native"; provider: string; capabilities: CapabilityId[] }
  /**
   * The provider operates an MCP server. `dynamic`: Gulpy registers itself
   * at the provider automatically. `static`: the operator must register an
   * OAuth app at the provider first and set its credentials.
   */
  | { kind: "mcp"; url: string; registration: "dynamic" | "static"; scope?: string };

export interface Connector {
  id: string;
  name: string;
  description: string;
  category: Category;
  /** Brand color, as 6 hex digits. */
  color: string;
  /** The logo image. If there is none, the page draws `icon`. */
  image?: LogoImage;
  /** SVG path in a 24 x 24 box. If there is none, the page shows the first letter. */
  icon?: string;
  /** The page shows "Beta": the connector works, but it did not run with many real accounts yet. */
  beta?: boolean;
  source: ConnectorSource;
}

interface Brand {
  hex: string;
  path: string;
}

function mcp(
  id: string,
  name: string,
  description: string,
  category: Category,
  url: string,
  brand: Brand | string,
  registration: "dynamic" | "static" = "dynamic",
): Connector {
  const branded = typeof brand === "string" ? { color: brand } : { color: brand.hex, icon: brand.path };
  return { id, name, description, category, ...branded, image: logoImage(id), source: { kind: "mcp", url, registration } };
}

/** Gulpy supplies the tools of these connectors. They are in beta until they run with more real accounts. */
function native(
  id: string,
  name: string,
  description: string,
  provider: string,
  capabilities: CapabilityId[],
  brand: Brand | string,
  category: Category = "Work",
): Connector {
  const branded = typeof brand === "string" ? { color: brand } : { color: brand.hex, icon: brand.path };
  return {
    id,
    name,
    description,
    category,
    ...branded,
    image: logoImage(id),
    beta: true,
    source: { kind: "native", provider, capabilities },
  };
}

/**
 * Each MCP address below answered with OAuth metadata on 2026-09-27.
 * `scripts/check-catalog.ts` does the check again.
 */
const CONNECTORS: Connector[] = [
  // One card for each company: one sign-in gives all its apps.
  native("google", "Google", "Gmail, Calendar, Drive", "google", ["email.read", "email.send", "calendar.read", "calendar.write", "files.read"], siGoogle),
  native("microsoft", "Microsoft", "Outlook, Calendar, OneDrive", "microsoft", ["email.read", "email.send", "calendar.read", "calendar.write", "files.read"], "0078D4"),

  mcp("notion", "Notion", "Pages, wikis and databases", "Work", "https://mcp.notion.com/mcp", siNotion),
  mcp("linear", "Linear", "Issues, projects and cycles", "Work", "https://mcp.linear.app/mcp", siLinear),
  mcp("atlassian", "Atlassian", "Jira issues and Confluence pages", "Work", "https://mcp.atlassian.com/v2/mcp", siAtlassian),
  mcp("asana", "Asana", "Tasks and projects", "Work", "https://mcp.asana.com/v2/mcp", siAsana, "static"),
  mcp("monday", "monday.com", "Boards, tasks and CRM", "Work", "https://mcp.monday.com/mcp", "6161FF"),
  mcp("clickup", "ClickUp", "Tasks, docs and goals", "Work", "https://mcp.clickup.com/mcp", siClickup),
  mcp("airtable", "Airtable", "Bases, tables and records", "Work", "https://mcp.airtable.com/mcp", siAirtable),
  mcp("slack", "Slack", "Messages and channels", "Work", "https://mcp.slack.com/mcp", "4A154B", "static"),
  mcp("granola", "Granola", "Meeting notes", "Meetings", "https://mcp.granola.ai/mcp", "5B7C3A"),
  mcp("box", "Box", "Files and folders", "Work", "https://mcp.box.com", siBox, "static"),

  mcp("github", "GitHub", "Repositories, issues and pull requests", "Engineering", "https://api.githubcopilot.com/mcp/", siGithub, "static"),
  mcp("vercel", "Vercel", "Projects and deployments", "Engineering", "https://mcp.vercel.com", siVercel),
  mcp("supabase", "Supabase", "Databases and projects", "Engineering", "https://mcp.supabase.com/mcp", siSupabase),
  mcp("sentry", "Sentry", "Errors and performance issues", "Engineering", "https://mcp.sentry.dev/mcp", siSentry),
  mcp("railway", "Railway", "Services and deployments", "Engineering", "https://mcp.railway.com/mcp", siRailway),
  mcp("render", "Render", "Services and databases", "Engineering", "https://mcp.render.com/mcp", siRender, "static"),
  mcp("neon", "Neon", "Postgres databases", "Engineering", "https://mcp.neon.tech/mcp", siNeon),
  mcp("prisma", "Prisma", "Postgres databases and schemas", "Engineering", "https://mcp.prisma.io/mcp", siPrisma),
  mcp("sanity", "Sanity", "Content and schemas", "Engineering", "https://mcp.sanity.io", siSanity),

  mcp("hubspot", "HubSpot", "Contacts, companies and deals", "Sales and support", "https://mcp.hubspot.com", siHubspot, "static"),
  mcp("intercom", "Intercom", "Conversations and contacts", "Sales and support", "https://mcp.intercom.com/mcp", siIntercom),
  mcp("attio", "Attio", "CRM records and lists", "Sales and support", "https://mcp.attio.com/mcp", "266DF0"),

  mcp("canva", "Canva", "Designs and templates", "Design", "https://mcp.canva.com/mcp", "00C4CC"),
  // Figma publishes a registration address, but it refused the registration (HTTP 403, 2026-09-27).
  mcp("figma", "Figma", "Design files and components", "Design", "https://mcp.figma.com/mcp", siFigma, "static"),
  mcp("miro", "Miro", "Boards and diagrams", "Design", "https://mcp.miro.com/", siMiro),
  mcp("webflow", "Webflow", "Sites and content", "Design", "https://mcp.webflow.com/mcp", siWebflow),
  mcp("wix", "Wix", "Sites and apps", "Design", "https://mcp.wix.com/mcp", siWix),
  mcp("higgsfield", "Higgsfield", "AI images, video and motion design", "Design", "https://mcp.higgsfield.ai/mcp", "111111"),

  mcp("stripe", "Stripe", "Payments, customers and invoices", "Finance", "https://mcp.stripe.com", siStripe),
  mcp("paypal", "PayPal", "Payments and invoices", "Finance", "https://mcp.paypal.com/mcp", siPaypal),
  mcp("square", "Square", "Payments, orders and catalog", "Finance", "https://mcp.squareup.com/mcp", siSquare),

  mcp("posthog", "PostHog", "Product analytics and feature flags", "Data", "https://mcp.posthog.com/mcp", siPosthog),

  // Added 2026-09-30. Each address answered with OAuth metadata and a registration endpoint.
  mcp("todoist", "Todoist", "Tasks and projects", "Work", "https://ai.todoist.net/mcp", "E44332"),
  mcp("ticktick", "TickTick", "Tasks and habits", "Work", "https://mcp.ticktick.com", "4772FA"),
  mcp("calendly", "Calendly", "Scheduling links and bookings", "Work", "https://mcp.calendly.com", "006BFF"),
  mcp("cal-com", "Cal.com", "Scheduling and bookings", "Work", "https://mcp.cal.com/mcp", "111827"),
  mcp("evernote", "Evernote", "Notes and notebooks", "Work", "https://mcp.evernote.com/mcp", "00A82D"),
  mcp("readwise", "Readwise", "Highlights and saved articles", "Work", "https://mcp2.readwise.io/mcp", "1D1D1F"),
  mcp("coda", "Coda", "Docs and tables", "Work", "https://coda.io/apis/mcp", "F46A54"),
  mcp("zapier", "Zapier", "Actions in 8,000 apps", "Work", "https://mcp.zapier.com/api/v1/connect", "FF4F00"),
  mcp("fireflies", "Fireflies", "Meeting transcripts", "Meetings", "https://api.fireflies.ai/mcp", "6B2BFF"),
  mcp("otter", "Otter", "Meeting notes", "Meetings", "https://mcp.otter.ai/mcp", "1F5CFF"),
  mcp("fathom", "Fathom", "Meeting recordings and notes", "Meetings", "https://api.fathom.ai/mcp", "00BFA5"),
  mcp("circleback", "Circleback", "Meeting notes and actions", "Meetings", "https://circleback.ai/api/mcp", "3A3A3A"),
  mcp("tldv", "tl;dv", "Meeting recordings", "Meetings", "https://mcp.tldv.io/mcp", "5A3FFF"),
  mcp("wispr-flow", "Wispr Flow", "Meeting notes from Flow", "Meetings", "https://api.wisprflow.ai/connect/mcp", "111111"),
  mcp("close", "Close", "CRM leads and deals", "Sales and support", "https://mcp.close.com/mcp", "2F5BEA"),
  mcp("apollo", "Apollo", "Contacts and outreach", "Sales and support", "https://mcp.apollo.io/mcp", "F7C744"),
  mcp("klaviyo", "Klaviyo", "Email and SMS marketing", "Sales and support", "https://mcp.klaviyo.com/mcp", "232426"),
  mcp("jam", "Jam", "Bug reports", "Engineering", "https://mcp.jam.dev/mcp", "F2C94C"),
  mcp("cloudflare", "Cloudflare", "Workers, storage and DNS", "Engineering", "https://bindings.mcp.cloudflare.com/mcp", "F38020"),
  mcp("hugging-face", "Hugging Face", "Models, datasets and papers", "Engineering", "https://huggingface.co/mcp", "FFD21E"),
  mcp("mercury", "Mercury", "Bank accounts and transactions", "Finance", "https://mcp.mercury.com/mcp", "5466F9"),
  mcp("brex", "Brex", "Cards and expenses", "Finance", "https://api.brex.com/mcp", "F46A35"),
  mcp("ramp", "Ramp", "Cards, bills and expenses", "Finance", "https://mcp.ramp.com/mcp", "E4F222"),
  mcp("amplitude", "Amplitude", "Product analytics", "Data", "https://mcp.amplitude.com/mcp", "1E61F0"),
  mcp("mixpanel", "Mixpanel", "Product analytics", "Data", "https://mcp.mixpanel.com/mcp", "7856FF"),
  mcp("hex", "Hex", "Data notebooks", "Data", "https://app.hex.tech/mcp", "473982"),
  mcp("perplexity", "Perplexity", "Web search with sources", "Data", "https://api.perplexity.ai/mcp", "20808D"),
  mcp("exa", "Exa", "Web search for agents", "Data", "https://mcp.exa.ai/mcp", "1F40ED"),
  mcp("strava", "Strava", "Workouts and activities", "Personal", "https://mcp.strava.com/mcp", "FC4C02"),
];

/** An MCP connector that is not in the built-in list. The operator supplies the address. */
export interface CustomConnector {
  id: string;
  name: string;
  description: string;
  color: string;
  url: string;
  category?: Category;
}

export type Availability = "ready" | "setup_needed";

export class Catalog {
  private readonly byId = new Map<string, Connector>();

  constructor(private readonly config: Config) {
    for (const connector of CONNECTORS) this.byId.set(connector.id, connector);
    for (const custom of config.customConnectors) {
      const category = custom.category ?? "Work";
      this.byId.set(custom.id, mcp(custom.id, custom.name, custom.description, category, custom.url, custom.color));
    }
  }

  get(id: string): Connector | undefined {
    return this.byId.get(id);
  }

  all(): Connector[] {
    return [...this.byId.values()];
  }

  /** The connectors that one connection serves. A Google account serves Gmail and Google Calendar. */
  forConnection(providerOrConnector: string): Connector[] {
    const direct = this.byId.get(providerOrConnector);
    if (direct && direct.source.kind === "mcp") return [direct];
    return this.all().filter(
      (connector) => connector.source.kind === "native" && connector.source.provider === providerOrConnector,
    );
  }

  availability(connector: Connector): Availability {
    const { source } = connector;
    if (source.kind === "native") {
      const configured = { google: this.config.google, microsoft: this.config.microsoft };
      return configured[source.provider as keyof typeof configured] ? "ready" : "setup_needed";
    }
    if (source.registration === "dynamic") return "ready";
    return this.config.connectorClients[connector.id] ? "ready" : "setup_needed";
  }
}
