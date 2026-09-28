import type { FC } from "hono/jsx";
import type { Viewer } from "../auth.ts";
import { CAPABILITIES, type CapabilityId } from "../capabilities.ts";
import type { AccountChoice, LinkChoices, OpenLink } from "../link.ts";
import type { LinkedAccount } from "../store.ts";
import { BRAND } from "../brand.ts";
import { SignInForm, type SignInState } from "./signin.tsx";
import { Disclosure, Pair } from "./agent.tsx";
import { ConnectorIcon, Icon, LinkPage, Mascot, Notice } from "./ui.tsx";

export const LinkSignIn: FC<{ link: OpenLink; state: SignInState }> = ({ link, state }) => (
  <LinkPage title={`Connect to ${link.app.name}`}>
    <header class="link-head">
      <Pair app={link.app} />
      <h1>
        {link.app.name} uses {BRAND.name} to connect your accounts
      </h1>
      <p class="muted">Connect one time. Then approve each new app with one tap.</p>
    </header>
    <div class="link-stack">
      <SignInForm state={state} />
    </div>
    <footer class="link-foot">
      <p class="fine">{BRAND.name} does not see or keep your passwords. You sign in at the provider directly.</p>
    </footer>
  </LinkPage>
);

function connectUrl(token: string, providerId: string, connectionId?: string): string {
  const query = new URLSearchParams({ token });
  if (connectionId) query.set("connection", connectionId);
  return `/link/connect/${encodeURIComponent(providerId)}?${query}`;
}

const Account: FC<{ choice: AccountChoice; token: string }> = ({ choice, token }) => {
  const { connection, provider, logo, covers, missing, usable } = choice;
  const needsReauth = connection.status === "needs_reauth";
  const summary = covers.length
    ? covers.map((capability) => CAPABILITIES[capability].label).join(" · ")
    : "Does not supply these permissions yet";
  const text = (
    <span class="account-text">
      <strong>{connection.accountLabel}</strong>
      <span>
        {provider.name} · {needsReauth ? "Sign in again to use this account" : summary}
      </span>
    </span>
  );
  const fix = (needsReauth || missing.length > 0) && (
    <a class="btn btn-secondary btn-small" href={connectUrl(token, provider.id, connection.id)}>
      {needsReauth ? "Reconnect" : "Add permission"}
    </a>
  );
  if (!usable) {
    return (
      <div class="account account-off">
        <ConnectorIcon logo={logo} small />
        {text}
        {fix}
      </div>
    );
  }
  return (
    <label class="account">
      <input type="checkbox" name="connection" value={connection.id} checked={choice.preselected} />
      <ConnectorIcon logo={logo} small />
      {text}
      {fix}
    </label>
  );
};

export const LinkConsent: FC<{
  link: OpenLink;
  viewer: Viewer;
  choices: LinkChoices;
  token: string;
  notice?: string;
}> = ({ link, viewer, choices, token, notice }) => {
  const canApprove = choices.accounts.some((choice) => choice.usable);
  const uncovered = new Set(choices.uncovered);
  const addable = new Set(choices.accounts.flatMap((choice) => choice.missing));
  const detail = (capability: CapabilityId) => {
    if (!uncovered.has(capability) || choices.accounts.length === 0) return CAPABILITIES[capability].detail;
    return addable.has(capability)
      ? "Your account does not share this yet. Select “Add permission” below."
      : "No connected account supplies this. Add an account below.";
  };
  return (
    <LinkPage title={`Connect to ${link.app.name}`}>
      <header class="link-head">
        <Pair app={link.app} />
        <h1>{link.app.name} wants access to your accounts</h1>
      </header>
      <div class="identity">
        <span>Signed in as {viewer.user.email}</span>
        <form method="post" action="/auth/signout">
          <input type="hidden" name="csrf" value={viewer.csrf} />
          <input type="hidden" name="next" value={`/link?token=${encodeURIComponent(token)}`} />
          <button class="link-button" type="submit">
            Not you?
          </button>
        </form>
      </div>

      {notice && (
        <div class="link-stack">
          <Notice kind="warn">{notice}</Notice>
        </div>
      )}

      <section class="link-section">
        <h2>It will be able to</h2>
        <ul class="caps">
          {link.session.capabilities.map((capability) => (
            <li class="cap">
              <span class="cap-icon">
                <Icon name={CAPABILITIES[capability].icon} />
              </span>
              <span class="cap-text">
                <strong>{CAPABILITIES[capability].label}</strong>
                <span>{detail(capability)}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <form method="post" action="/link/approve">
        <input type="hidden" name="csrf" value={viewer.csrf} />
        <input type="hidden" name="token" value={token} />
        <section class="link-section">
          <h2>{choices.accounts.length ? "Choose accounts" : "Connect an account"}</h2>
          {choices.accounts.length > 0 && (
            <div class="accounts">
              {choices.accounts.map((choice) => (
                <Account choice={choice} token={token} />
              ))}
            </div>
          )}
          {choices.addable.length === 0 && choices.accounts.length === 0 && (
            <p class="empty">No provider is set up on this server.</p>
          )}
          <div class="add-row">
            {choices.addable.map(({ provider, logo }) => (
              <a class="btn btn-secondary add-provider" href={connectUrl(token, provider.id)}>
                <ConnectorIcon logo={logo} small />
                Add {provider.name}
              </a>
            ))}
          </div>
        </section>
        <footer class="link-foot">
          <Disclosure name={link.app.name} />
          <button class="btn btn-primary btn-block" type="submit" disabled={!canApprove}>
            Allow access
          </button>
          <button class="btn btn-ghost btn-block" type="submit" formaction="/link/cancel" formnovalidate>
            Cancel
          </button>
          <p class="fine">
            {link.app.name} gets only the permissions in the list. It does not get your passwords or your sign-in
            tokens. You can remove access at any time.
          </p>
        </footer>
      </form>
    </LinkPage>
  );
};

/** The last page. A script sends the result to the page that opened the window. */
export const LinkDone: FC<{
  origin: string;
  result: { type: "success"; publicToken: string; accounts: LinkedAccount[] } | { type: "exit" };
  appName: string;
}> = ({ origin, result, appName }) => (
  <LinkPage title={result.type === "success" ? "Connected" : "Cancelled"}>
    <div
      class="done"
      id="gulpy-result"
      data-origin={origin}
      data-type={result.type}
      data-public-token={result.type === "success" ? result.publicToken : undefined}
      data-accounts={result.type === "success" ? JSON.stringify(result.accounts) : undefined}
    >
      <span class={`done-mark${result.type === "exit" ? " done-mark-muted" : ""}`}>
        <Icon name={result.type === "success" ? "check" : "close"} />
      </span>
      <h1>{result.type === "success" ? "Connected" : "Nothing was shared"}</h1>
      <p class="muted">
        {result.type === "success"
          ? `${appName} can use the accounts that you selected. You can close this window.`
          : "You can close this window."}
      </p>
    </div>
    <script src="/assets/link-done.js" />
  </LinkPage>
);

export const LinkProblem: FC<{ title: string; detail: string }> = ({ title, detail }) => (
  <LinkPage title={title}>
    <div class="done">
      <span class="done-mark done-mark-muted">
        <Icon name="close" />
      </span>
      <h1>{title}</h1>
      <p class="muted">{detail}</p>
    </div>
  </LinkPage>
);

/** Shown in the window while the app gets its link token. */
export const LinkLoading: FC = () => (
  <LinkPage title="Loading">
    <div class="done">
      <Mascot size="large" />
      <p class="muted">Opening a secure connection…</p>
    </div>
  </LinkPage>
);
