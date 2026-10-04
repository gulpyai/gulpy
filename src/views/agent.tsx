import type { FC } from "hono/jsx";
import type { Viewer } from "../auth.ts";
import { BRAND } from "../brand.ts";
import { agentLogo } from "../logos.ts";
import type { App } from "../store.ts";
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

/** The link is missing, old or used. */
export const DeviceEnter: FC<{ error?: string }> = ({ error }) => (
  <LinkPage title={`Connect an agent to ${BRAND.name}`}>
    <header class="link-head">
      <Mascot size="large" />
      <h1>Connect an agent</h1>
      <p class="muted">
        {error ?? `Tell your agent "connect to ${BRAND.name}". It opens this page with a new link.`}
      </p>
    </header>
  </LinkPage>
);

export const DeviceSignIn: FC<{ app: App; state: SignInState }> = ({ app, state }) => (
  <LinkPage title={`Connect ${app.name}`}>
    <header class="link-head">
      <Pair app={app} />
      <h1>Connect {app.name}</h1>
      <p class="muted">Sign in to {BRAND.name}. Then tap Allow, and {app.name} gets your tools.</p>
    </header>
    <div class="link-stack">
      <SignInForm state={state} />
    </div>
  </LinkPage>
);

export const DeviceConsent: FC<{ app: App; code: string; viewer: Viewer; logos: Logo[] }> = ({
  app,
  code,
  viewer,
  logos,
}) => (
  <LinkPage title={`Connect ${app.name}`}>
    <header class="link-head">
      <Pair app={app} />
      <h1>Connect {app.name}?</h1>
      <p class="muted">
        {app.name} gets all your tools, and the tools that you add later.
      </p>
      {logos.length > 0 && (
        <p class="device-logos">
          {logos.slice(0, 8).map((logo) => (
            <ConnectorIcon logo={logo} small />
          ))}
        </p>
      )}
    </header>
    <div class="link-stack">
      {logos.length === 0 && (
        <Notice kind="warn">
          {viewer.user.email} has no tools yet. {app.name} will see nothing until you add some. Signed in with the
          wrong email?{" "}
          <form method="post" action="/auth/signout" class="inline-form">
            <input type="hidden" name="csrf" value={viewer.csrf} />
            <input type="hidden" name="next" value={`/device?code=${code}`} />
            <button class="link-button" type="submit">
              Use a different email
            </button>
          </form>
        </Notice>
      )}
      <form method="post" action="/device" class="link-form">
        <input type="hidden" name="csrf" value={viewer.csrf} />
        <input type="hidden" name="code" value={code} />
        <div class="link-actions">
          <button class="btn btn-light" type="submit" name="decision" value="deny">
            Cancel
          </button>
          <button class="btn btn-primary" type="submit" name="decision" value="allow">
            Allow
          </button>
        </div>
      </form>
      <p class="fine">Only tap Allow if you just asked {app.name} to connect. You can remove it at any time.</p>
      <Disclosure name={app.name} />
    </div>
    <footer class="link-foot">
      <p class="fine">
        <Icon name="lock" />
        Signed in as {viewer.user.email}. {BRAND.name} does not give your passwords to an agent.
      </p>
    </footer>
  </LinkPage>
);

export const DeviceDone: FC<{ name: string; allowed: boolean; logos: Logo[] }> = ({ name, allowed, logos }) => (
  <LinkPage title={allowed ? "All set" : "Cancelled"}>
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
        {allowed
          ? `Go back to ${name}. If it waits for you, say "done". Then it has your tools. You can close this page.`
          : "You can close this page."}
      </p>
    </div>
  </LinkPage>
);

/** A person on Free has `FREE_AGENTS` agents and tries to add one more. */
export const AgentLimit: FC<{ name: string; limit: number }> = ({ name, limit }) => (
  <LinkPage title="Upgrade to Pro">
    <div class="done">
      <Mascot size="large" />
      <h1>Free has {limit} agents</h1>
      <p class="muted">
        To add {name}, upgrade to Pro for unlimited agents, or remove an agent you do not use.
      </p>
      <div class="done-actions">
        <a class="btn btn-primary" href="/billing/checkout?plan=pro&interval=monthly" target="_blank" rel="noopener">
          Upgrade to Pro · $10/month
        </a>
        <a class="btn btn-secondary" href="/#agents" target="_blank" rel="noopener">
          Manage agents
        </a>
      </div>
    </div>
  </LinkPage>
);
