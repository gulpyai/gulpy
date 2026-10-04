import type { FC } from "hono/jsx";
import type { Viewer } from "../auth.ts";
import type { PlanView } from "../billing.ts";
import { BRAND } from "../brand.ts";
import { agentLogo, logoImage } from "../logos.ts";
import { areaLevel, areasOf, areaWrites, type AccessLevel, type AreaId, type CapabilityId } from "../capabilities.ts";
import { connectorNames, type CatalogGroup, type ConnectionView } from "../present.ts";
import type { App, AuditEntry } from "../store.ts";
import { CatalogGrid } from "./catalog.tsx";
import { SignInForm, type SignInState } from "./signin.tsx";
import { Avatar, ConnectorIcon, formatDate, Icon, Mascot, Notice, SitePage, timeAgo, type Logo, type PageMeta } from "./ui.tsx";

export interface LandingModel {
  state: SignInState;
  /** Logos for the picture at the top and for the list of tools. */
  logos: Logo[];
  connectors: number;
  /** For search engines and link previews. Not set on a computer of a developer. */
  meta?: PageMeta;
}

/** The three steps of the diagram in "How it works". hero.js shows them one at a time as the page scrolls. */
/** The steps of "How it works". hero.js has one camera view for each step, in the same order, then a view of all. */
const FLOW = ["Connect your tools", `Add ${BRAND.name} to your AI`, "Choose what each AI can use"] as const;

/** Each sentence here must stay true of the code. See the Security page. */
const PROMISES = [
  {
    icon: "lock",
    title: "Tokens are encrypted",
    text: "Each token is sealed with AES-256-GCM. The key is not in the database.",
  },
  {
    icon: "shield",
    title: "Your AI never sees a token",
    text: `It gets tools only. ${BRAND.name} checks your approval on each call.`,
  },
  {
    icon: "edit",
    title: "Read only, or read and write",
    text: "You choose for each tool and for each AI app.",
  },
  {
    icon: "eye",
    title: "Each call is on your list",
    text: "See which app used which tool, and when.",
  },
  {
    icon: "close",
    title: "Remove access in one tap",
    text: "Remove an app and its access stops immediately.",
  },
  {
    icon: "key",
    title: "No passwords to steal",
    text: "You sign in with a code by email. You sign in to each tool at the tool.",
  },
] as const;

/**
 * The AI makers in the map of "How it works", as icons. An agent connects with the device flow and a key, so
 * it must run commands or send web requests (Claude Code, Codex, Gemini CLI, Cursor). The chat apps alone cannot.
 */
const DIAGRAM_AGENTS = [
  { name: "ChatGPT", logo: "chatgpt" },
  { name: "Claude", logo: "claude" },
  { name: "Gemini", logo: "gemini" },
  { name: "Grok", logo: "grok" },
  { name: "Le Chat", logo: "mistral" },
  { name: "Manus", logo: "manus" },
  { name: "Poke", logo: "poke" },
  { name: "Cursor", logo: "cursor" },
] as const;

export const Landing: FC<{ model: LandingModel }> = ({ model }) => {
  const { state, logos } = model;
  return (
    <SitePage title={BRAND.promise} viewer={null} current="none" script="/assets/hero.js" meta={model.meta}>
      <main class="landing" id="main">
        {/* Start free and Sign in go to #start: the top of the page, with the cursor in the email field. */}
        <section class="hero" id="start">
          <div class="hero-copy">
            <h1>{BRAND.promise}</h1>
            <p class="lede">
              Each AI makes you connect the same tools again. Connect them to {BRAND.name} one time. Then say "connect
              to {BRAND.name}" to any agent, and it calls your tools with plain HTTP.
            </p>
            <div class="signin-card">
              <h2>{state.otpId ? "Check your email" : "Start free"}</h2>
              <SignInForm state={state} autofocus={false} />
            </div>
          </div>
          {/* hero.js makes the ring turn and the mascot eat the connectors. With no script it is a still picture. */}
          <div class="hero-art" aria-hidden="true">
            <div class="orbit" data-gulp-hero>
              <div class="orbit-ring" data-gulp-ring>
                {logos.slice(0, 8).map((logo, index) => (
                  <span class={`orbit-item orbit-item-${index + 1}`} data-name={logo.name}>
                    <ConnectorIcon logo={logo} />
                  </span>
                ))}
              </div>
              <div class="hero-mascot" data-gulp-body>
                <Mascot size="hero" mood="live" />
              </div>
              <span class="gulp-bubble" data-gulp-bubble />
              <div data-gulp-queue hidden>
                {logos.slice(8).map((logo) => (
                  <span class="orbit-item" data-name={logo.name}>
                    <ConnectorIcon logo={logo} />
                  </span>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/*
          How it works, in the style of multiplier.ai/architecture: one large map stays on the screen, and a
          camera moves over it as the page scrolls. hero.js moves the camera and draws the lines. With no script,
          the map shows all of it, still.
        */}
        <section class="flow" id="how" data-flow>
          <div class="flow-track" data-flow-track>
            <div class="flow-view">
              <h2 class="flow-title">How it works</h2>
              <div class="flow-map" aria-hidden="true">
                <div class="flow-world" data-flow-world>
                  <svg class="flow-lines" data-flow-lines />
                  <div class="flow-group">
                    <p class="flow-cap">Your tools</p>
                    <ul class="flow-tools" data-flow-tools>
                      {logos.slice(0, 8).map((logo) => (
                        <li class="flow-tool" title={logo.name}>
                          <ConnectorIcon logo={logo} />
                          <span class="flow-tick">
                            <Icon name="check" />
                          </span>
                        </li>
                      ))}
                      <li class="flow-tool flow-more">+{model.connectors - 8}</li>
                    </ul>
                  </div>
                  <div class="flow-hub" data-flow-hub>
                    <Mascot size="large" mood="live" />
                    <b>{BRAND.name}</b>
                    <span class="flow-done">
                      <svg viewBox="0 0 52 52">
                        <circle cx="26" cy="26" r="25" />
                        <path d="M15 27.5l7.5 7.5L37.5 19" />
                      </svg>
                      All set
                    </span>
                  </div>
                  <div class="flow-group">
                    <p class="flow-cap">Your AI</p>
                    <ul class="flow-agents" data-flow-agents>
                      {DIAGRAM_AGENTS.map((agent, row) => (
                        <li>
                          <span class="flow-agent" title={agent.name}>
                            <Avatar label={agent.name} image={logoImage(agent.logo)} />
                          </span>
                          <span class="flow-perm">
                            {logos.slice(0, 4).map((logo, index) => (
                              <span class={(row + index) % 3 === 2 ? "flow-pick is-off" : "flow-pick"}>
                                <ConnectorIcon logo={logo} small />
                              </span>
                            ))}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
              <ol class="flow-copy" data-flow-copy>
                {FLOW.map((stop, index) => (
                  <li class={index === FLOW.length - 1 ? "is-on" : undefined}>
                    <span class="flow-count">
                      {String(index + 1).padStart(2, "0")} / {String(FLOW.length).padStart(2, "0")}
                    </span>
                    <h3>{stop}</h3>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        <section class="trust" id="security">
          <div class="trust-head">
            <h2>You stay in control</h2>
            <p>{BRAND.name} sits between your AI and your accounts. So we built it like a vault.</p>
          </div>
          <ul class="promises">
            {PROMISES.map((promise) => (
              <li>
                <span class="promise-icon">
                  <Icon name={promise.icon} />
                </span>
                <h3>{promise.title}</h3>
                <p>{promise.text}</p>
              </li>
            ))}
          </ul>
          <p class="trust-foot">
            <a href="/security">
              How we protect your data <Icon name="arrow" />
            </a>
          </p>
        </section>

        <section class="closing">
          <Mascot size="large" />
          <h2>Connect one time. Use it with each agent.</h2>
          <a class="btn btn-primary" href="#start">
            Start free
          </a>
        </section>
      </main>
    </SitePage>
  );
};

export interface AgentShare {
  view: ConnectionView;
  capabilities: CapabilityId[];
}

export interface AgentAccess {
  app: App;
  shares: AgentShare[];
  /** Time of the last call of the agent, or null. */
  lastUsed: number | null;
}

export interface DashboardModel {
  connections: ConnectionView[];
  catalog: CatalogGroup[];
  agents: AgentAccess[];
  /** The address of Gulpy. Agents call `${baseUrl}/v1`. */
  baseUrl: string;
  now: number;
  notice?: { kind: "ok" | "warn"; text: string };
  /** The plan of the person. Undefined where this Gulpy sells no plans. */
  plan?: PlanView;
  /** The number of agents that Free permits. Undefined with no limit: Pro, or a Gulpy that sells no plans. */
  agentLimit?: number;
  /** What the agents did. Only on Pro, and where this Gulpy sells no plans. */
  activity?: {
    entry: AuditEntry;
    appName: string | null;
    /** The tool that the event is about, for example "Notion". */
    target: string | null;
  }[];
}

const ACTIONS: Record<string, string> = {
  "connection.create": "Added a tool",
  "connection.update": "Updated a tool",
  "connection.remove": "Removed a tool",
  "grant.approve": "Approved access",
  "grant.remove": "Removed access",
  "email.read": "Read email",
  "email.send": "Sent email",
  "calendar.read": "Read calendar",
  "calendar.write": "Changed calendar",
  tool: "Used",
  proxy: "API request",
  "plan.change": "Changed the plan",
};

const Hidden: FC<{ viewer: Viewer }> = ({ viewer }) => <input type="hidden" name="csrf" value={viewer.csrf} />;

/** A paid plan, with the way to change it or cancel it. */
const PlanLine: FC<{ plan: PlanView; viewer: Viewer }> = ({ plan, viewer }) => (
  <div class="plan-line">
    <span>
      Plan: <strong>{plan.name}</strong>
      {plan.interval && <span class="muted"> · Billed {plan.interval}</span>}
      {plan.plan === "business" && plan.quantity > 1 && <span class="muted"> · {plan.quantity} users</span>}
      {plan.periodEnd && (
        <span class="muted">
          {" "}
          · {plan.ends ? "Ends" : "Renews"} {formatDate(plan.periodEnd)}
        </span>
      )}
    </span>
    {plan.manage && (
      <form method="post" action="/billing/portal">
        <Hidden viewer={viewer} />
        <button class="btn btn-secondary btn-small" type="submit">
          Manage plan
        </button>
      </form>
    )}
  </div>
);

/** Free: the agents that are left, and the way to Pro. */
const FreeLine: FC<{ used: number; limit: number; viewer: Viewer; invoices: boolean }> = ({ used, limit, viewer, invoices }) => (
  <div class="plan-line">
    <span>
      Plan: <strong>Free</strong>
      <span class="muted">
        {" "}
        · {Math.min(used, limit)} of {limit} agents
      </span>
    </span>
    <span class="plan-actions">
      {/* A person who paid before can still get the invoices. */}
      {invoices && (
        <form method="post" action="/billing/portal">
          <Hidden viewer={viewer} />
          <button class="btn btn-secondary btn-small" type="submit">
            Invoices
          </button>
        </form>
      )}
      <a class="btn btn-primary btn-small" href="/billing/checkout?plan=pro&interval=monthly">
        Upgrade to Pro · $10/month
      </a>
    </span>
  </div>
);

const Activity: FC<{ model: DashboardModel }> = ({ model }) =>
  !model.activity || model.activity.length === 0 ? (
    <p class="panel-empty">No activity yet.</p>
  ) : (
    <ul class="feed">
      {model.activity.map(({ entry, appName, target }) => (
        <li>
          <span class={`dot${entry.status !== null && entry.status >= 400 ? " dot-warn" : ""}`} />
          <span class="feed-text">
            <strong>{appName ?? "You"}</strong> {(ACTIONS[entry.action] ?? entry.action).toLowerCase()}
            {(entry.action === "proxy" || entry.action === "tool") && entry.detail ? (
              <code>{entry.detail}</code>
            ) : target ? (
              <span>
                · {target}
                {entry.action === "grant.approve" && entry.detail ? ` · ${entry.detail}` : ""}
              </span>
            ) : null}
            {entry.status !== null && entry.status >= 400 && (
              <span class="chip chip-warn">{entry.status === 403 ? "Blocked" : `Error ${entry.status}`}</span>
            )}
          </span>
          <time>{timeAgo(entry.ts, model.now)}</time>
        </li>
      ))}
    </ul>
  );

/** What the user pastes into any agent. agents.md tells the agent the way that fits it. See src/guide.ts. */
function connectSentence(baseUrl: string): string {
  return `Connect to ${BRAND.name}. Read ${baseUrl}/agents.md and follow it.`;
}

const Guide: FC<{ model: DashboardModel }> = ({ model }) => (
  <section class="panel guide">
    <div class="guide-text">
      <h2>Add {BRAND.name} to any AI</h2>
      <p>Copy this into the chat. Tap Allow.</p>
    </div>
    <div class="address address-wrap">
      <code data-copy-text>{connectSentence(model.baseUrl)}</code>
      <button class="copy" type="button" data-copy aria-label="Copy the sentence">
        <Icon name="copy" />
        <span data-copy-label>Copy</span>
      </button>
    </div>
  </section>
);

const ConnectionRow: FC<{ view: ConnectionView; viewer: Viewer }> = ({ view, viewer }) => {
  const { connection } = view;
  const reconnect = view.connectors[0]?.id ?? connection.provider;
  const title = view.tools ? view.name : connectorNames(view);
  return (
    <li>
      <ConnectorIcon logo={view.logo} />
      <div class="row-text">
        <strong>
          {title}
          {view.connectors.some((connector) => connector.beta) && <span class="chip chip-beta">Beta</span>}
        </strong>
        <span>
          {connection.accountLabel}
          {view.tools ? ` · ${view.tools.total} tools` : ""}
        </span>
      </div>
      {connection.status === "needs_reauth" && <span class="chip chip-warn">Sign in again</span>}
      <div class="row-actions">
        {connection.status === "needs_reauth" && (
          <a class="btn btn-light btn-small" href={`/connect/${reconnect}?connection=${connection.id}`}>
            Reconnect
          </a>
        )}
        <form method="post" action={`/connections/${connection.id}/remove`}>
          <Hidden viewer={viewer} />
          <button class="btn btn-quiet btn-small" type="submit">
            Remove
          </button>
        </form>
      </div>
    </li>
  );
};

/** The names of the areas of a Google or a Microsoft account. The tools of an MCP server have the name of the connection. */
const AREA_NAMES: Record<string, Partial<Record<AreaId, string>>> = {
  google: { email: "Gmail", calendar: "Google Calendar", files: "Google Drive" },
  microsoft: { email: "Outlook", calendar: "Outlook Calendar", files: "OneDrive" },
};
const DEFAULT_AREA_NAMES: Partial<Record<AreaId, string>> = { email: "Email", calendar: "Calendar", files: "Files" };

const WRITE_LABELS: Record<AreaId, string> = {
  email: "Read & send",
  calendar: "Read & edit",
  files: "Read & write",
  tools: "Read & write",
};

/** Off, Read, and Read & write for one area of one connection. Tapping a choice saves it (catalog.js). */
const Levels: FC<{ name: string; label: string; area: AreaId; current: AccessLevel | "off"; writes: boolean }> = ({
  name,
  label,
  area,
  current,
  writes,
}) => (
  <span class="segmented" role="radiogroup" aria-label={label}>
    {(
      [
        ["off", "Off"],
        ["read", "Read"],
        ...(writes ? [["write", WRITE_LABELS[area]]] : []),
      ] as [AccessLevel | "off", string][]
    ).map(([value, text]) => (
      <label>
        <input type="radio" name={name} value={value} checked={current === value || (!writes && value === "read" && current === "write")} />
        <span>{text}</span>
      </label>
    ))}
  </span>
);

/** One connection in the Edit form. A Google account has a row for Gmail, Calendar and Drive. */
const AccessRows: FC<{ view: ConnectionView; granted: readonly CapabilityId[] }> = ({ view, granted }) => {
  const { connection } = view;
  const areas = areasOf(connection.capabilities);
  const title = view.tools ? view.name : connectorNames(view);
  const names = AREA_NAMES[connection.provider] ?? DEFAULT_AREA_NAMES;
  const levels = (area: AreaId) => (
    <Levels
      name={`level:${connection.id}:${area}`}
      label={`${names[area] ?? title}: access`}
      area={area}
      current={areaLevel(area, granted)}
      writes={areaWrites(area, connection.capabilities)}
    />
  );
  if (areas.length === 1) {
    return (
      <li>
        <ConnectorIcon logo={view.logo} small />
        <span class="access-name">
          {title}
          <small>{connection.accountLabel}</small>
        </span>
        {levels(areas[0]!)}
      </li>
    );
  }
  return (
    <li class="access-group">
      <div class="access-head">
        <ConnectorIcon logo={view.logo} small />
        <span class="access-name">
          {title}
          <small>{connection.accountLabel}</small>
        </span>
      </div>
      <ul>
        {areas.map((area) => (
          <li>
            <span class="access-name">{names[area] ?? title}</span>
            {levels(area)}
          </li>
        ))}
      </ul>
    </li>
  );
};

function toolCount(shared: number, total: number): string {
  return shared === total ? `All ${total} tools` : `${shared} of ${total} tools`;
}

/** One agent: a short line, and the Edit form with one choice for each part of each tool. */
const AgentRow: FC<{ agent: AgentAccess; model: DashboardModel; viewer: Viewer }> = ({ agent, model, viewer }) => {
  const { app, shares, lastUsed } = agent;
  const granted = new Map(shares.map((share) => [share.view.connection.id, share.capabilities]));
  return (
    <li class="agent">
      <details>
        <summary>
          <Avatar label={app.name} image={agentLogo(app.redirectUris)} />
          <span class="row-text">
            <strong>{app.name}</strong>
            <span>
              <span data-agent-count>{toolCount(shares.length, model.connections.length)}</span> ·{" "}
              {lastUsed ? `Last used ${timeAgo(lastUsed, model.now)}` : "Not used yet"}
            </span>
          </span>
          <span class="btn btn-light btn-small agent-edit">Edit</span>
        </summary>
        <form method="post" action={`/apps/${app.id}/access`} class="access" data-access>
          <Hidden viewer={viewer} />
          <ul class="access-list">
            {model.connections.map((view) => (
              <AccessRows view={view} granted={granted.get(view.connection.id) ?? []} />
            ))}
          </ul>
          <div class="access-actions">
            <button class="btn btn-dark btn-small" type="submit" data-access-save>
              Save
            </button>
            <span class="access-status" data-access-status role="status" aria-live="polite" />
            <button class="btn btn-danger-quiet btn-small" type="submit" formaction={`/apps/${app.id}/revoke`}>
              Remove access
            </button>
          </div>
        </form>
      </details>
    </li>
  );
};

export const Dashboard: FC<{ viewer: Viewer; model: DashboardModel }> = ({ viewer, model }) => (
  <SitePage title="My tools" viewer={viewer} current="tools" script="/assets/catalog.js">
    <main class="site-main dash" id="main">
      {model.notice && (
        <div class={`toast toast-${model.notice.kind}`} role="status">
          {model.notice.kind === "ok" && <Mascot size="small" mood="gulp" />}
          {model.notice.text}
        </div>
      )}

      <Guide model={model} />

      {/* The panels have ids with "tab-", so the browser does not scroll to them. catalog.js shows the panel of the #hash. */}
      <div class="tabs" role="tablist" data-tabs>
        <a href="#tools" role="tab" data-tab-link="tools">
          Tools <span class="count">{model.connections.length}</span>
        </a>
        <a href="#agents" role="tab" data-tab-link="agents">
          Agents <span class="count">{model.agents.length}</span>
        </a>
        {model.activity && (
          <a href="#activity" role="tab" data-tab-link="activity">
            Activity
          </a>
        )}
        <a href="#account" role="tab" data-tab-link="account">
          Account
        </a>
      </div>

      <section class="tab-panel" id="tab-tools" role="tabpanel" data-tab="tools">
        {model.connections.length > 0 && (
          <div class="panel">
            <div class="panel-head">
              <h2>Connected</h2>
            </div>
            <ul class="rows">
              {model.connections.map((view) => (
                <ConnectionRow view={view} viewer={viewer} />
              ))}
            </ul>
          </div>
        )}
        <div class="panel">
          <div class="panel-head">
            <div>
              <h2>{model.connections.length > 0 ? "Add a tool" : "Add your first tool"}</h2>
              <p>You sign in at the tool. {BRAND.name} never sees your password.</p>
            </div>
            <a class="btn btn-primary btn-small" href="/connect-all">
              Connect everything
            </a>
          </div>
          <div class="panel-body">
            <CatalogGrid groups={model.catalog} next="/" />
          </div>
        </div>
      </section>

      <section class="tab-panel" id="tab-agents" role="tabpanel" data-tab="agents">
        <div class="panel">
          <div class="panel-head">
            <div>
              <h2>Agents</h2>
              <p>
                Each agent uses only what you allow. Select Edit to change it.
                {model.agentLimit !== undefined &&
                  ` Free has ${model.agentLimit} agents. Pro has no limit.`}
              </p>
            </div>
          </div>
          {model.agents.length === 0 ? (
            <p class="panel-empty">No agent yet. Copy the sentence above into any AI.</p>
          ) : (
            <ul class="rows agents">
              {model.agents.map((agent) => (
                <AgentRow agent={agent} model={model} viewer={viewer} />
              ))}
            </ul>
          )}
        </div>
      </section>

      {model.activity && (
        <section class="tab-panel" id="tab-activity" role="tabpanel" data-tab="activity">
          <div class="panel">
            <div class="panel-head">
              <div>
                <h2>Activity</h2>
                <p>What each agent did. {BRAND.name} records the action, not the content.</p>
              </div>
            </div>
            <Activity model={model} />
          </div>
        </section>
      )}

      <section class="tab-panel" id="tab-account" role="tabpanel" data-tab="account">
        <div class="panel">
          <div class="panel-head">
            <div>
              <h2>Account</h2>
              <p>
                {viewer.user.email} · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a>
              </p>
            </div>
          </div>
          {model.agentLimit !== undefined && <FreeLine used={model.agents.length} limit={model.agentLimit} viewer={viewer} invoices={model.plan?.manage ?? false} />}
          {model.plan && model.plan.plan !== "free" && <PlanLine plan={model.plan} viewer={viewer} />}
          <div class="account-actions">
            <a class="btn btn-secondary" href="/account/export">
              Download my data
            </a>
            <a class="btn btn-danger-quiet" href="/account/delete">
              Delete my account
            </a>
          </div>
        </div>
      </section>
    </main>
  </SitePage>
);

/** The last step before the account goes. The person types the email address to confirm. */
export const DeleteAccount: FC<{ viewer: Viewer; error?: string }> = ({ viewer, error }) => (
  <SitePage title="Delete my account" viewer={viewer} current="tools">
    <main class="site-main" id="main">
      <section class="panel danger-panel">
        <h1>Delete your account</h1>
        <p>This deletes all of your data at {BRAND.name}. You cannot undo it.</p>
        <ul class="danger-list">
          <li>{BRAND.name} asks each provider to cancel your tokens, then deletes them.</li>
          <li>Each AI app loses access immediately.</li>
          <li>Your approvals, your list of calls and your developer apps are deleted.</li>
        </ul>
        <p>
          To keep a copy first, <a href="/account/export">download your data</a>.
        </p>
        <form method="post" action="/account/delete" class="form-grid">
          <input type="hidden" name="csrf" value={viewer.csrf} />
          {error && <Notice kind="error">{error}</Notice>}
          <div class="field">
            <label for="confirm">Type your email address to confirm</label>
            <input
              class="input"
              id="confirm"
              name="confirm"
              type="email"
              autocomplete="off"
              placeholder={viewer.user.email}
              required
            />
          </div>
          <div class="account-actions">
            <button class="btn btn-danger" type="submit">
              Delete my account
            </button>
            <a class="btn btn-secondary" href="/#account">
              Cancel
            </a>
          </div>
        </form>
      </section>
    </main>
  </SitePage>
);

/** After the deletion. The person is signed out. */
export const AccountDeleted: FC = () => (
  <SitePage title="Account deleted" viewer={null} current="none">
    <main class="site-main" id="main">
      <section class="panel danger-panel">
        <Mascot size="large" />
        <h1>Your account is deleted</h1>
        <p>
          {BRAND.name} deleted your data and asked each provider to cancel your tokens. You can also check the connected
          apps page of each provider.
        </p>
        <a class="btn btn-primary" href="/">
          Back to {BRAND.name}
        </a>
      </section>
    </main>
  </SitePage>
);

export interface NewAppSecret {
  name: string;
  clientId: string;
  secret: string;
}

export const Developers: FC<{
  viewer: Viewer;
  apps: App[];
  created?: NewAppSecret;
  error?: string;
  baseUrl: string;
}> = ({ viewer, apps, created, error, baseUrl }) => (
  <SitePage title="Developers" viewer={viewer} current="developers">
    <main class="site-main" id="main">
      <section class="summary">
        <div class="summary-title">
          <h1>Developers</h1>
          <p class="muted">
            An agent needs no registration: it connects with <code>{baseUrl}/agents.md</code>. Register an app here
            only to open {BRAND.name} from your own page.
          </p>
        </div>
      </section>

      {created && (
        <section class="panel">
          <div class="panel-head">
            <div>
              <h2>{created.name} is registered</h2>
              <p>Copy the secret now. {BRAND.name} does not show it again.</p>
            </div>
          </div>
          <div class="panel-body">
            <div class="secret-box">
              <dl>
                <div>
                  <dt>Client ID</dt>
                  <dd>{created.clientId}</dd>
                </div>
                <div>
                  <dt>Secret</dt>
                  <dd>{created.secret}</dd>
                </div>
                <div>
                  <dt>API</dt>
                  <dd>{baseUrl}/v1</dd>
                </div>
              </dl>
            </div>
          </div>
        </section>
      )}

      <section class="panel">
        <div class="panel-head">
          <h2>Your apps</h2>
        </div>
        {apps.length === 0 ? (
          <p class="panel-empty">No apps yet.</p>
        ) : (
          <ul class="rows">
            {apps.map((app) => (
              <li>
                <Avatar label={app.name} image={agentLogo(app.redirectUris)} />
                <div class="row-text">
                  <strong>{app.name}</strong>
                  <span class="mono">{app.clientId}</span>
                  <span>{app.origins.join(", ")}</span>
                </div>
                <div class="row-actions">
                  <form method="post" action={`/developers/apps/${app.id}/remove`}>
                    <Hidden viewer={viewer} />
                    <button class="btn btn-quiet btn-small" type="submit">
                      Delete
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>Register an app</h2>
        </div>
        <div class="panel-body">
          <form method="post" action="/developers/apps" class="form-grid">
            <Hidden viewer={viewer} />
            {error && <Notice kind="error">{error}</Notice>}
            <div class="field">
              <label for="name">App name</label>
              <input class="input" id="name" name="name" maxlength={60} required />
              <span class="hint">Users see this name when they approve access.</span>
            </div>
            <div class="field">
              <label for="origins">Web origins</label>
              <input class="input" id="origins" name="origins" placeholder="https://app.example.com" required />
              <span class="hint">The pages that can open {BRAND.name}. Separate two or more with a comma.</span>
            </div>
            <button class="btn btn-dark" type="submit">
              Register app
            </button>
          </form>
        </div>
      </section>
    </main>
  </SitePage>
);
