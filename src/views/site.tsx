import type { FC } from "hono/jsx";
import type { Viewer } from "../auth.ts";
import { BRAND } from "../brand.ts";
import { agentLogo, logoImage } from "../logos.ts";
import { levelOf, type CapabilityId } from "../capabilities.ts";
import { connectorNames, type CatalogGroup, type ConnectionView } from "../present.ts";
import type { App, AuditEntry } from "../store.ts";
import { CatalogGrid } from "./catalog.tsx";
import { SignInForm, type SignInState } from "./signin.tsx";
import { Avatar, ConnectorIcon, Icon, Mascot, Notice, SitePage, timeAgo, type Logo, type PageMeta } from "./ui.tsx";

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
 * The AI apps that passed a live test with Gulpy on 2026-09-27: each one added Gulpy,
 * showed the approval page and made correct tool calls. See
 * research/notes/10-assistant-support.md. Add a name only after a live test.
 * Names only: Anthropic, OpenAI and Google do not permit their logos without
 * approval (docs/legal-and-security.md, section 6.4).
 */
const AGENTS = ["ChatGPT", "Claude", "Gemini", "Grok", "Le Chat", "Manus", "Claude Code", "Codex"] as const;

/**
 * The AI apps in the map of "How it works", as icons. Claude Code and Codex are not here: their icons are the
 * same as Claude and ChatGPT. Poke and Cursor say in their documents that they accept a custom connector; they
 * were not tested with Gulpy. Instinct is not here: it has no custom connector.
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
        <section class="hero">
          <div class="hero-copy">
            <h1>{BRAND.promise}</h1>
            <p class="lede">
              ChatGPT, Claude and Grok each make you connect the same tools again. Connect them to {BRAND.name} one
              time. Then each new agent gets them with one tap.
            </p>
            <div class="signin-card" id="start">
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
  /** `target` is the tool that the event is about, for example "Notion". */
  activity: {
    entry: AuditEntry;
    appName: string | null;
    target: string | null;
  }[];
  /** The address that the user gives to an agent. */
  mcpUrl: string;
  /** True if only this computer can reach the address. */
  local: boolean;
  calls: number;
  now: number;
  notice?: { kind: "ok" | "warn"; text: string };
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
};

const Hidden: FC<{ viewer: Viewer }> = ({ viewer }) => <input type="hidden" name="csrf" value={viewer.csrf} />;

const GUIDES = [
  {
    id: "claude",
    name: "Claude",
    logo: "claude",
    steps: [
      "Open Customize, then Connectors.",
      'Select "+", then "Add custom connector".',
      "Paste the address. Select Add, then Connect.",
    ],
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    logo: "chatgpt",
    steps: [
      "Open Settings, then Security and login. Turn on Developer mode.",
      "Select the plus button and create an app for a remote MCP server.",
      "Paste the address and sign in.",
    ],
  },
  {
    id: "grok",
    name: "Grok",
    logo: "grok",
    steps: ["Open grok.com/connectors.", "Select New Connector, then Custom.", "Paste the address and sign in."],
  },
] as const;

const Guide: FC<{ model: DashboardModel }> = ({ model }) => (
  <section class="panel guide">
    <div class="guide-main">
      <div>
        <h2>
          {model.connections.length > 0 ? `Add ${BRAND.name} to an agent` : `Step 2. Add ${BRAND.name} to an agent`}
        </h2>
        <p class="muted">Paste this address into the agent. The agent opens {BRAND.name}, and you tap Allow.</p>
      </div>
      <div class="address">
        <code data-copy-text>{model.mcpUrl}</code>
        <button class="copy" type="button" data-copy aria-label="Copy the address">
          <Icon name="copy" />
          <span data-copy-label>Copy</span>
        </button>
      </div>
      {model.local && (
        <p class="guide-note">
          This address works on this computer only. ChatGPT, Claude and Grok need a public address.
        </p>
      )}
    </div>
    <div class="guide-steps">
      {GUIDES.map((guide) => (
        <details name="guide" open={guide.id === "claude"}>
          <summary>
            <Avatar label={guide.name} image={logoImage(guide.logo)} />
            {guide.name}
          </summary>
          <ol>
            {guide.steps.map((step) => (
              <li>{step}</li>
            ))}
          </ol>
        </details>
      ))}
      <details name="guide">
        <summary>
          <Avatar label="Claude Code" image={logoImage("claude")} />
          Claude Code
        </summary>
        <pre class="command">claude mcp add --transport http gulpy {model.mcpUrl}</pre>
      </details>
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
      {connection.status === "needs_reauth" ? (
        <span class="chip chip-warn">Sign in again</span>
      ) : (
        <span class="chip chip-ok">Connected</span>
      )}
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

export const Dashboard: FC<{ viewer: Viewer; model: DashboardModel }> = ({ viewer, model }) => (
  <SitePage title="My tools" viewer={viewer} current="tools" script="/assets/catalog.js">
    <main class="site-main" id="main">
      {model.notice && (
        <div class={`toast toast-${model.notice.kind}`} role="status">
          {model.notice.kind === "ok" && <Mascot size="small" mood="gulp" />}
          {model.notice.text}
        </div>
      )}

      <section class="summary">
        <div class="summary-title">
          <h1>My tools</h1>
          <p class="muted">Connect a tool one time. Approve each agent with one tap.</p>
        </div>
        <ul class="stats">
          <li>
            <strong>{model.connections.length}</strong>
            <span>{model.connections.length === 1 ? "tool connected" : "tools connected"}</span>
          </li>
          <li>
            <strong>{model.agents.length}</strong>
            <span>{model.agents.length === 1 ? "agent with access" : "agents with access"}</span>
          </li>
          <li>
            <strong>{model.calls}</strong>
            <span>{model.calls === 1 ? "call in 7 days" : "calls in 7 days"}</span>
          </li>
        </ul>
      </section>

      {model.connections.length > 0 && <Guide model={model} />}

      {model.connections.length > 0 && (
        <section class="panel">
          <div class="panel-head">
            <h2>Connected</h2>
          </div>
          <ul class="rows">
            {model.connections.map((view) => (
              <ConnectionRow view={view} viewer={viewer} />
            ))}
          </ul>
        </section>
      )}

      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>{model.connections.length > 0 ? "Add a tool" : "Step 1. Add your first tool"}</h2>
            <p>You sign in at the provider. {BRAND.name} does not see your password.</p>
          </div>
        </div>
        <div class="panel-body">
          <CatalogGrid groups={model.catalog} next="/" />
        </div>
      </section>

      {model.connections.length === 0 && <Guide model={model} />}

      <section class="panel" id="agents">
        <div class="panel-head">
          <div>
            <h2>Agents</h2>
            <p>Each agent can use only what you approved.</p>
          </div>
        </div>
        {model.agents.length === 0 ? (
          <p class="panel-empty">No agent has access yet. Add {BRAND.name} to an agent with the address above.</p>
        ) : (
          <ul class="rows">
            {model.agents.map(({ app, shares, lastUsed }) => (
              <li class="row-top">
                <Avatar label={app.name} image={agentLogo(app.redirectUris)} />
                <div class="row-text">
                  <strong>{app.name}</strong>
                  <span>{lastUsed ? `Last call ${timeAgo(lastUsed, model.now)}` : "No calls yet"}</span>
                  <div class="shares">
                    {shares.map((share) => (
                      <span class="share">
                        <ConnectorIcon logo={share.view.logo} small />
                        {share.view.name}
                        <em>{levelOf(share.capabilities) === "write" ? "Read and write" : "Read only"}</em>
                      </span>
                    ))}
                  </div>
                </div>
                <div class="row-actions">
                  <form method="post" action={`/apps/${app.id}/revoke`}>
                    <Hidden viewer={viewer} />
                    <button class="btn btn-quiet btn-small" type="submit">
                      Remove access
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section class="panel" id="activity">
        <div class="panel-head">
          <div>
            <h2>Activity</h2>
            <p>{BRAND.name} records the action, not the content.</p>
          </div>
        </div>
        {model.activity.length === 0 ? (
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
        )}
      </section>

      <section class="panel" id="account">
        <div class="panel-head">
          <div>
            <h2>Your account</h2>
            <p>
              {viewer.user.email} · You accepted the <a href="/terms">Terms</a> and the <a href="/privacy">Privacy</a>{" "}
              page when you signed in.
            </p>
          </div>
        </div>
        <div class="account-actions">
          <a class="btn btn-secondary" href="/account/export">
            Download my data
          </a>
          <a class="btn btn-danger-quiet" href="/account/delete">
            Delete my account
          </a>
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
            An agent that supports MCP needs no registration: give it <code>{baseUrl}/mcp</code>. Register an app here
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
