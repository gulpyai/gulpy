import type { FC } from "hono/jsx";
import type { AuthorizeRequest } from "../agents.ts";
import type { Viewer } from "../auth.ts";
import { BRAND } from "../brand.ts";
import { agentLogo } from "../logos.ts";
import { connectorNames, type AgentChoice, type CatalogGroup } from "../present.ts";
import type { App } from "../store.ts";
import { CatalogGrid } from "./catalog.tsx";
import { SignInForm, type SignInState } from "./signin.tsx";
import { Avatar, ConnectorIcon, Icon, LinkPage, Mascot, Notice, type Logo } from "./ui.tsx";

/** The agent on the left, Gulpy on the right, and a line of dots that moves between them. */
export const Pair: FC<{ app: Pick<App, "name" | "redirectUris"> }> = ({ app }) => (
  <div class="pair">
    <Avatar label={app.name} image={agentLogo(app.redirectUris)} large />
    <span class="pair-dots">
      <i />
      <i />
      <i />
    </span>
    <Mascot size="large" />
  </div>
);

/** Where the agent sends the user back to. It helps the user see a false agent. */
function returnHost(redirectUri: string): string {
  const url = new URL(redirectUri);
  return url.protocol === "https:" || url.protocol === "http:" ? url.host : `${url.protocol}//`;
}

/**
 * The site that publishes the identity of the agent, for an agent with a
 * client ID metadata document (`https://claude.ai/oauth/...`). An agent that
 * registered itself has no such site.
 */
function identityHost(app: App): string | null {
  if (!/^https:\/\//.test(app.clientId)) return null;
  try {
    return new URL(app.clientId).host;
  } catch {
    return null;
  }
}

export const AgentSignIn: FC<{ app: App; state: SignInState }> = ({ app, state }) => (
  <LinkPage title={`Connect ${app.name}`}>
    <header class="link-head">
      <Pair app={app} />
      <h1>
        {app.name} wants to use your tools
      </h1>
      <p class="muted">
        Sign in to {BRAND.name}. Then select what {app.name} can use.
      </p>
    </header>
    <div class="link-stack">
      <SignInForm state={state} />
    </div>
    <footer class="link-foot">
      <p class="fine">
        <Icon name="lock" />
        {BRAND.name} does not give your passwords or your sign-in tokens to an agent.
      </p>
    </footer>
  </LinkPage>
);

const Choice: FC<{ choice: AgentChoice; next: string }> = ({ choice, next }) => {
  const { view, usable, selected, level } = choice;
  const { connection } = view;
  const names = connectorNames(view);
  const title = view.tools ? view.name : names;
  const detail = view.tools ? `${connection.accountLabel} · ${view.tools.total} tools` : connection.accountLabel;
  if (!usable) {
    const reconnect = view.connectors[0]?.id ?? connection.provider;
    const query = new URLSearchParams({ next, connection: connection.id });
    return (
      <div class="choice choice-off">
        <ConnectorIcon logo={view.logo} />
        <span class="choice-text">
          <strong>{title}</strong>
          <span>Sign in again to use this</span>
        </span>
        <a class="btn btn-light btn-small" href={`/connect/${encodeURIComponent(reconnect)}?${query}`}>
          Reconnect
        </a>
      </div>
    );
  }
  const field = `level:${connection.id}`;
  return (
    <div class="choice" data-choice>
      <label class="choice-main">
        <ConnectorIcon logo={view.logo} />
        <span class="choice-text">
          <strong>{title}</strong>
          <span>{detail}</span>
        </span>
        <input class="switch" type="checkbox" name="connection" value={connection.id} checked={selected} />
      </label>
      <div class="levels" role="radiogroup" aria-label={`Access for ${title}`}>
        <label>
          <input type="radio" name={field} value="read" checked={level === "read"} />
          <span>Read only</span>
        </label>
        <label>
          <input type="radio" name={field} value="write" checked={level === "write"} />
          <span>Read and write</span>
        </label>
      </div>
    </div>
  );
};

/**
 * Before consent, Google wants the person to know where the data goes. The
 * approval window shows it next to the button, with the rules.
 */
export const Disclosure: FC<{ name: string }> = ({ name }) => (
  <p class="disclosure">
    The data of the tools that you select, for example email or events, goes to {name}. A different company operates{" "}
    {name}, with its own privacy policy. Remove access at any time on My tools.{" "}
    <a href="/terms" target="_blank">
      Terms
    </a>{" "}
    ·{" "}
    <a href="/privacy" target="_blank">
      Privacy
    </a>
  </p>
);

export const AgentConsent: FC<{
  request: AuthorizeRequest;
  viewer: Viewer;
  choices: AgentChoice[];
  catalog: CatalogGroup[];
  /** The address of this page, with the request of the agent. */
  here: string;
  /** The request of the agent, to send back with the form. */
  params: Record<string, string>;
  notice?: string;
}> = ({ request, viewer, choices, catalog, here, params, notice }) => {
  const { app } = request;
  const canApprove = choices.some((choice) => choice.usable);
  return (
    <LinkPage title={`Connect ${app.name}`} script="/assets/catalog.js">
      <header class="link-head">
        <Pair app={app} />
        <h1>Let {app.name} use your tools?</h1>
        <div class="identity">
          <span>{viewer.user.email}</span>
          <form method="post" action="/auth/signout">
            <input type="hidden" name="csrf" value={viewer.csrf} />
            <input type="hidden" name="next" value={here} />
            <button class="link-button" type="submit">
              Not you?
            </button>
          </form>
        </div>
      </header>

      <form method="post" action="/oauth/authorize" class="link-form">
        <input type="hidden" name="csrf" value={viewer.csrf} />
        {Object.entries(params).map(([name, value]) => (
          <input type="hidden" name={name} value={value} />
        ))}

        <div class="link-scroll">
          {notice && <Notice kind="warn">{notice}</Notice>}
          {choices.length > 0 ? (
            <div class="choices">
              {choices.map((choice) => (
                <Choice choice={choice} next={here} />
              ))}
            </div>
          ) : (
            <p class="empty">
              You have no tools yet. Add one below. You do this one time: each agent after this one gets it with one
              tap.
            </p>
          )}

          <details class="more" open={choices.length === 0}>
            <summary>
              <Icon name="plus" />
              Add a tool
            </summary>
            <CatalogGrid groups={catalog} next={here} compact />
          </details>

          <p class="origin">
            <Icon name="eye" />
            <span>
              This sends you back to <strong>{returnHost(request.redirectUri)}</strong>.{" "}
              {identityHost(app) ? (
                <>
                  The identity of {app.name} comes from <strong>{identityHost(app)}</strong>.
                </>
              ) : (
                <>
                  {BRAND.name} did not verify {app.name}.
                </>
              )}{" "}
              Continue only if you started this.
            </span>
          </p>
        </div>

        <footer class="link-actions">
          <Disclosure name={app.name} />
          <button class="btn btn-light" type="submit" name="decision" value="deny" formnovalidate>
            Cancel
          </button>
          <button class="btn btn-primary" type="submit" name="decision" value="allow" disabled={!canApprove}>
            Allow
          </button>
        </footer>
      </form>
    </LinkPage>
  );
};

/**
 * The page after the decision. Gulpy eats the tools that the user shared, and
 * then the page sends the browser back to the agent.
 */
export const AgentDone: FC<{ to: string; name: string; logos: Logo[]; allowed: boolean }> = ({
  to,
  name,
  logos,
  allowed,
}) => (
  <LinkPage title={allowed ? "All set" : "Cancelled"} script="/assets/leave.js">
    <div class={`done${allowed ? " done-gulp" : ""}`}>
      {allowed ? (
        <div class="gulp-stage">
          {logos.slice(0, 5).map((logo, index) => (
            <ConnectorIcon logo={logo} extra={`gulp-item gulp-item-${index + 1}`} />
          ))}
          <Mascot size="hero" mood="gulp" />
        </div>
      ) : (
        <Mascot size="large" />
      )}
      <h1>{allowed ? "All set" : "Nothing was shared"}</h1>
      <p class="muted">
        Back to {name}…{" "}
        <a id="leave" href={to} data-delay={allowed ? "1700" : "300"}>
          Continue
        </a>
      </p>
    </div>
  </LinkPage>
);
