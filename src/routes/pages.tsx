import { Hono, type Context } from "hono";
import type { Child } from "hono/jsx";
import { backendOf, tokensFor } from "../access.ts";
import { shareWithAgents } from "../agents.ts";
import {
  checkCsrf,
  endSession,
  normalizeEmail,
  requestCode,
  safeNext,
  startSession,
  verifyCode,
  viewer,
} from "../auth.ts";
import { billingOn, checkoutUrl, completeCheckout, isInterval, isPlan, planOf, portalUrl } from "../billing.ts";
import { BRAND, LEGAL } from "../brand.ts";
import { isLocalAddress } from "../config.ts";
import { randomId, randomToken, sha256 } from "../crypto.ts";
import type { Deps } from "../deps.ts";
import { approveLink, findLink, linkChoices, linkStatus, parseOrigin } from "../link.ts";
import { beginAuthorization, completeAuthorization, OAuthError, type Connected } from "../oauth.ts";
import { viewCatalog, viewConnection, viewConnections } from "../present.ts";
import { beginUpstream, completeUpstream } from "../upstream/oauth.ts";
import type { Vault } from "../vault.ts";
import {
  DeviceConsent,
  DeviceDone,
  DeviceEnter,
  DeviceSignIn,
} from "../views/agent.tsx";
import { ConnectAll, ConnectAllDone } from "../views/connectall.tsx";
import type { Connector } from "../catalog.ts";
import { allowDevice, denyDevice, normalizeUserCode, pendingAgent, tellUser } from "../device.ts";
import { LinkConsent, LinkDone, LinkLoading, LinkProblem, LinkSignIn } from "../views/link.tsx";
import type { SignInState } from "../views/signin.tsx";
import {
  AccountDeleted,
  Dashboard,
  DeleteAccount,
  Developers,
  Landing,
  type AgentAccess,
  type DashboardModel,
  type LandingModel,
  type NewAppSecret,
} from "../views/site.tsx";

/** The connectors in the picture at the top of the first page. */
const HERO = ["google", "notion", "slack", "github", "linear", "figma", "stripe", "microsoft"];

export const CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "script-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

const NOTICES: Record<string, string> = {
  denied: "The provider did not give access. Nothing changed.",
  no_access: "The provider did not give the requested permissions. Try again and keep the boxes selected.",
  exchange_failed: "The provider did not complete the sign-in. Try again.",
  nothing_selected: "Select one or more connections.",
  setup_needed: "This connector needs an app that the operator registers at the provider first.",
  payment_pending: "Gulpy could not confirm the payment yet. If you paid, the plan shows in a minute.",
  no_plan: "That plan is not for sale yet.",
};

/**
 * On the computer of the developer, no mail goes out, so the sign-in page shows the code.
 * Never on a public address: a person could sign in with the email address of a different person.
 */
const showCode = (deps: Deps): boolean => deps.config.env !== "production" && isLocalAddress(deps.config.baseUrl);

const OK_NOTICES: Record<string, string> = {
  connected: "The connection is added.",
  removed: "The connection is removed. The tokens are deleted.",
  revoked: "The agent does not have access now.",
  paid: "Thank you. Your plan is active.",
};

function render(c: Context, page: Child, status: 200 | 400 | 403 | 404 = 200): Response {
  return c.html(`<!DOCTYPE html>${String(page)}`, status);
}

function linkPath(token: string): string {
  return `/link?token=${encodeURIComponent(token)}`;
}

/** Adds a query parameter to a path on this site. */
function withParam(path: string, name: string, value: string): string {
  const url = new URL(path, "http://local");
  url.searchParams.set(name, value);
  return url.pathname + url.search;
}

/**
 * True if a page of this site made the request. A page on a different site
 * cannot submit the forms of Gulpy. Browsers set Sec-Fetch-Site and scripts
 * cannot change it. Browsers from before 2023 do not send it: for those, the
 * Origin header must match.
 */
function sameOrigin(c: Context, expectedOrigin: string): boolean {
  const site = c.req.header("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = c.req.header("origin");
  // A client that is not a browser sends none of the two headers. It has no cookies of a victim.
  return origin === undefined || origin === expectedOrigin;
}

export function pageRoutes(deps: Deps, vault: Vault): Hono {
  const app = new Hono();
  const expectedOrigin = new URL(deps.config.baseUrl).origin;

  app.use("*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && !sameOrigin(c, expectedOrigin)) {
      return c.text(`This request did not come from ${BRAND.name}`, 403);
    }
    await next();
    c.header("Content-Security-Policy", CSP);
    // The link token is in the URL. With this policy the browser does not send the URL to a provider.
    // Do not use "no-referrer" here: it makes the browser send "Origin: null" on the forms of this site.
    c.header("Referrer-Policy", "same-origin");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-store");
  });

  const landing = (state: SignInState): LandingModel => {
    const real = deps.catalog.all();
    const first = HERO.flatMap((id) => real.find((connector) => connector.id === id) ?? []);
    return {
      state,
      logos: [...first, ...real.filter((connector) => !HERO.includes(connector.id))],
      connectors: real.length,
      meta: deps.config.baseUrl.startsWith("https://")
        ? {
            description: `Connect your tools to ${BRAND.name} one time. Then any AI agent calls them with plain HTTP.`,
            url: `${deps.config.baseUrl}/`,
            image: `${deps.config.baseUrl}/assets/social.png`,
          }
        : undefined,
    };
  };

  /** The sign-in page has the look of the flow that the user is in. */
  const signInPage = async (c: Context, state: SignInState, status: 200 | 400 = 200) => {
    const next = new URL(state.next, "http://local");
    if (next.pathname === "/link") {
      const link = findLink(deps, next.searchParams.get("token") ?? undefined);
      if (link) return render(c, <LinkSignIn link={link} state={state} />, status);
    }
    if (next.pathname === "/device") {
      const code = normalizeUserCode(next.searchParams.get("code"));
      const agent = code ? pendingAgent(deps, code) : null;
      if (code && agent) return render(c, <DeviceSignIn app={agent} state={state} />, status);
    }
    return render(c, <Landing model={landing(state)} />, status);
  };

  // Sign-in

  app.post("/auth/start", async (c) => {
    const form = await c.req.parseBody();
    const next = safeNext(String(form.next ?? ""));
    const typed = String(form.email ?? "");
    const email = normalizeEmail(typed);
    if (!email) return signInPage(c, { next, email: typed, error: "Enter a valid email address." }, 400);
    const result = await requestCode(deps, c, email);
    if (!result.ok) {
      return signInPage(c, { next, email, error: "Too many codes. Wait 10 minutes, then try again." }, 400);
    }
    const devCode = showCode(deps) ? deps.mailer.peek?.(email) : undefined;
    return signInPage(c, { next, email, otpId: result.otpId, devCode });
  });

  app.post("/auth/verify", async (c) => {
    const form = await c.req.parseBody();
    const next = safeNext(String(form.next ?? ""));
    const otpId = String(form.otp_id ?? "");
    const result = verifyCode(deps, c, otpId, String(form.code ?? ""));
    if (result.ok) {
      // The sign-in form says that Continue means consent to the Terms and the Privacy page.
      deps.store.acceptRules(result.user.id, LEGAL.rulesVersion, deps.now());
      startSession(deps, c, result.user.id);
      return c.redirect(next, 303);
    }
    const email = normalizeEmail(String(form.email ?? "")) ?? undefined;
    if (result.reason === "wrong") {
      const devCode = showCode(deps) && email ? deps.mailer.peek?.(email) : undefined;
      return signInPage(c, { next, email, otpId, devCode, error: "That code is not correct. Try again." }, 400);
    }
    return signInPage(c, { next, email, error: "That code expired. Ask for a new code." }, 400);
  });

  app.post("/auth/signout", async (c) => {
    const form = await c.req.parseBody();
    const current = viewer(deps, c);
    if (current && checkCsrf(current, form.csrf)) endSession(deps, c);
    return c.redirect(safeNext(String(form.next ?? "")), 303);
  });

  // Connect to Gulpy: an agent on the computer of the user (src/device.ts)

  // Connect everything: the extension Gulpy for Chrome does the clicks (src/views/connectall.tsx)

  app.get("/connect-all", async (c) => {
    const current = viewer(deps, c);
    if (!current) return signInPage(c, { next: "/connect-all" });
    const cards = viewCatalog(deps, current.user.id).flatMap((group) => group.cards);
    const item = (connector: Connector) => ({
      connector,
      url: `/connect/${encodeURIComponent(connector.id)}?${new URLSearchParams({ next: "/connect-all/done" })}`,
    });
    const ready = cards.filter((card) => card.state === "ready").map((card) => card.connector);
    return render(
      c,
      <ConnectAll
        viewer={current}
        // Google and Microsoft keep one tap by the user: their consent pages are theirs to confirm.
        auto={ready.filter((connector) => connector.source.kind === "mcp").map(item)}
        tap={ready.filter((connector) => connector.source.kind === "native").map(item)}
        connected={cards.filter((card) => card.state === "connected").length}
      />,
    );
  });

  app.get("/connect-all/done", (c) => render(c, <ConnectAllDone />));

  app.get("/device", (c) => {
    const typed = c.req.query("code");
    if (typed === undefined) return render(c, <DeviceEnter />);
    const code = normalizeUserCode(typed);
    const agent = code ? pendingAgent(deps, code) : null;
    if (!code || !agent) {
      return render(c, <DeviceEnter error={`This link is old or used. Tell your agent "connect to ${BRAND.name}" again.`} />, 400);
    }
    const current = viewer(deps, c);
    if (!current) return render(c, <DeviceSignIn app={agent} state={{ next: `/device?code=${code}` }} />);
    const logos = viewConnections(deps, current.user.id).map((view) => view.logo);
    return render(c, <DeviceConsent app={agent} code={code} viewer={current} logos={logos} />);
  });

  app.post("/device", async (c) => {
    const form = await c.req.parseBody();
    const code = normalizeUserCode(form.code);
    const current = viewer(deps, c);
    if (!code) return render(c, <DeviceEnter />, 400);
    if (!current) return c.redirect(`/device?code=${code}`, 303);
    if (!sameOrigin(c, deps.config.baseUrl) || !checkCsrf(current, form.csrf)) {
      return c.text("The form expired. Go back and try again.", 403);
    }
    const agent = pendingAgent(deps, code);
    if (!agent) return render(c, <DeviceEnter error={`This link expired. Tell your agent "connect to ${BRAND.name}" again.`} />, 400);
    if (form.decision !== "allow") {
      denyDevice(deps, code, current.user.id);
      return render(c, <DeviceDone name={agent.name} allowed={false} logos={[]} />);
    }
    if (allowDevice(deps, code, current.user.id)) await tellUser(deps, current.user.email, agent.name);
    const logos = viewConnections(deps, current.user.id).map((view) => view.logo);
    return render(c, <DeviceDone name={agent.name} allowed logos={logos} />);
  });

  // Link: the window that an agent app opens from its own page

  app.get("/link/loading", (c) => render(c, <LinkLoading />));

  app.get("/link/status", (c) => {
    const token = c.req.query("token");
    const link = findLink(deps, token);
    // Only the page that the link token was made for can read the result.
    if (link && c.req.header("origin") === link.session.origin) {
      c.header("Access-Control-Allow-Origin", link.session.origin);
      c.header("Vary", "Origin");
    }
    return c.json(linkStatus(deps, token));
  });

  app.get("/link", (c) => {
    const token = c.req.query("token") ?? "";
    const link = findLink(deps, token);
    if (!link) {
      return render(c, <LinkProblem title="This link expired" detail="Go back to the app and start again." />, 404);
    }
    if (link.session.status !== "open") {
      return render(c, <LinkProblem title="This request is complete" detail="You can close this window." />);
    }
    const current = viewer(deps, c);
    if (!current) return render(c, <LinkSignIn link={link} state={{ next: linkPath(token) }} />);
    const choices = linkChoices(deps, link, current.user.id, c.req.query("connected"));
    const notice = NOTICES[c.req.query("notice") ?? ""];
    return render(c, <LinkConsent link={link} viewer={current} choices={choices} token={token} notice={notice} />);
  });

  app.get("/link/connect/:provider", (c) => {
    const token = c.req.query("token") ?? "";
    const link = findLink(deps, token);
    const current = viewer(deps, c);
    const provider = deps.providers.get(c.req.param("provider"));
    if (!link || link.session.status !== "open" || !current || !provider) return c.redirect(linkPath(token), 303);
    const existing = deps.store.connectionById(c.req.query("connection") ?? "");
    const connection =
      existing && existing.userId === current.user.id && existing.provider === provider.id ? existing : undefined;
    return c.redirect(
      beginAuthorization(deps, {
        provider,
        userId: current.user.id,
        capabilities: link.session.capabilities,
        returnTo: linkPath(token),
        connection,
      }),
      303,
    );
  });

  app.post("/link/approve", async (c) => {
    const form = await c.req.parseBody({ all: true });
    const token = String(form.token ?? "");
    const link = findLink(deps, token);
    const current = viewer(deps, c);
    if (!link || !current) return c.redirect(linkPath(token), 303);
    if (!checkCsrf(current, form.csrf)) return c.text("The form expired. Go back and try again.", 403);

    const selected = [form.connection ?? []].flat().map(String);
    const result = approveLink(deps, link, current.user.id, selected);
    if (!result.ok) {
      if (result.reason === "nothing_selected") {
        return c.redirect(withParam(linkPath(token), "notice", "nothing_selected"), 303);
      }
      return render(c, <LinkProblem title="This request is complete" detail="You can close this window." />);
    }
    return render(
      c,
      <LinkDone
        origin={link.session.origin}
        appName={link.app.name}
        result={{ type: "success", publicToken: result.publicToken, accounts: result.accounts }}
      />,
    );
  });

  app.post("/link/cancel", async (c) => {
    const form = await c.req.parseBody();
    const link = findLink(deps, String(form.token ?? ""));
    const current = viewer(deps, c);
    if (!link) return render(c, <LinkProblem title="This link expired" detail="You can close this window." />, 404);
    if (current && checkCsrf(current, form.csrf)) deps.store.exitLinkSession(link.session.id);
    return render(c, <LinkDone origin={link.session.origin} appName={link.app.name} result={{ type: "exit" }} />);
  });

  // The provider sends the user back here

  const afterConnect = async (c: Context, complete: (userId: string) => Promise<Connected>) => {
    const current = viewer(deps, c);
    if (!current) {
      return render(c, <LinkProblem title="Sign-in did not complete" detail="Your session ended. Start again." />, 400);
    }
    try {
      const { connection, returnTo, created } = await complete(current.user.id);
      if (created) shareWithAgents(deps, current.user.id, connection);
      const next = safeNext(returnTo);
      return c.redirect(next === "/" ? "/?ok=connected" : withParam(next, "connected", connection.id), 303);
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      if (error.returnTo) return c.redirect(withParam(safeNext(error.returnTo), "notice", error.code), 303);
      return render(c, <LinkProblem title="Sign-in did not complete" detail={error.message} />, 400);
    }
  };

  app.get("/oauth/callback/mcp", (c) =>
    afterConnect(c, (userId) =>
      completeUpstream(deps, vault, {
        userId,
        state: c.req.query("state") ?? "",
        code: c.req.query("code"),
        error: c.req.query("error"),
      }),
    ),
  );

  app.get("/oauth/callback/:provider", (c) => {
    const provider = deps.providers.get(c.req.param("provider"));
    if (!provider) return render(c, <LinkProblem title="Sign-in did not complete" detail="Unknown provider." />, 400);
    return afterConnect(c, (userId) =>
      completeAuthorization(deps, vault, {
        provider,
        userId,
        state: c.req.query("state") ?? "",
        code: c.req.query("code"),
        error: c.req.query("error"),
      }),
    );
  });

  // Add a connection, from the dashboard or from the approval page of an agent

  app.get("/connect/:connector", async (c) => {
    const current = viewer(deps, c);
    const next = safeNext(c.req.query("next"));
    const connector = deps.catalog.get(c.req.param("connector"));
    if (!current || !connector) return c.redirect(next, 303);
    if (deps.catalog.availability(connector) !== "ready") {
      return c.redirect(next === "/" ? "/?notice=setup_needed" : withParam(next, "notice", "setup_needed"), 303);
    }

    const { source } = connector;
    if (source.kind === "mcp") {
      try {
        return c.redirect(await beginUpstream(deps, { connector, userId: current.user.id, returnTo: next }), 303);
      } catch (error) {
        console.error(`[gulpy] ${connector.id} did not start`, error);
        return c.redirect(next === "/" ? "/?notice=exchange_failed" : withParam(next, "notice", "exchange_failed"), 303);
      }
    }

    const provider = deps.providers.get(source.provider);
    if (!provider) return c.redirect(next, 303);
    // Add the permission to the account that the user has, if there is one.
    const named = deps.store.connectionById(c.req.query("connection") ?? "");
    const mine = deps.store.connectionsByUser(current.user.id).filter((item) => item.provider === provider.id);
    const connection = named && mine.some((item) => item.id === named.id) ? named : mine.length === 1 ? mine[0] : undefined;
    return c.redirect(
      beginAuthorization(deps, {
        provider,
        userId: current.user.id,
        capabilities: source.capabilities,
        returnTo: next,
        connection,
      }),
      303,
    );
  });

  // Dashboard

  app.get("/", async (c) => {
    const current = viewer(deps, c);
    // A page that needs a sign-in, for example the checkout, sends the person here with `next`.
    if (!current) return render(c, <Landing model={landing({ next: safeNext(c.req.query("next"), "/") })} />);

    // Back from the Stripe checkout page: read the session, so the plan shows at once.
    const checkout = c.req.query("checkout");
    if (checkout !== undefined) {
      let done = false;
      if (billingOn(deps)) {
        try {
          done = await completeCheckout(deps, current.user, checkout);
        } catch (error) {
          console.error("[gulpy] checkout session", error);
        }
      }
      return c.redirect(done ? "/?ok=paid" : "/?notice=payment_pending", 303);
    }

    const connections = viewConnections(deps, current.user.id);
    const byId = new Map(connections.map((view) => [view.connection.id, view]));

    const now = deps.now();
    const lastCalls = deps.store.lastCalls(current.user.id);
    const agents = new Map<string, AgentAccess>();
    for (const grant of deps.store.grantsByUser(current.user.id)) {
      const agent = deps.store.appById(grant.appId);
      const view = byId.get(grant.connectionId);
      if (!agent || !view) continue;
      const entry = agents.get(agent.id) ?? { app: agent, shares: [], lastUsed: lastCalls.get(agent.id) ?? null };
      const held = new Set(view.connection.capabilities);
      entry.shares.push({ view, capabilities: grant.capabilities.filter((capability) => held.has(capability)) });
      agents.set(agent.id, entry);
    }

    const okText = OK_NOTICES[c.req.query("ok") ?? ""];
    const warnText = NOTICES[c.req.query("notice") ?? ""];
    const model: DashboardModel = {
      connections,
      catalog: viewCatalog(deps, current.user.id),
      agents: [...agents.values()],
      activity: deps.store.auditByUser(current.user.id, 30).map((entry) => ({
        entry,
        appName: entry.appId ? (deps.store.appById(entry.appId)?.name ?? "Deleted agent") : null,
        target: entry.connectionId ? (byId.get(entry.connectionId)?.name ?? entry.detail?.split(" · ")[0] ?? "Removed tool") : null,
      })),
      baseUrl: deps.config.baseUrl,
      local: /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(deps.config.baseUrl),
      calls: deps.store.countCalls(current.user.id, now - 7 * 24 * 60 * 60_000),
      now,
      notice: okText ? { kind: "ok", text: okText } : warnText ? { kind: "warn", text: warnText } : undefined,
      plan: billingOn(deps) ? planOf(deps, current.user.id) : undefined,
    };
    return render(c, <Dashboard viewer={current} model={model} />);
  });

  // Paid plans. The webhook is in routes/billing.ts.

  app.get("/billing/checkout", async (c) => {
    if (!billingOn(deps)) return c.text("Payments are not set up", 404);
    const plan = c.req.query("plan");
    const interval = c.req.query("interval") ?? "yearly";
    if (!isPlan(plan) || !isInterval(interval)) return c.text("Unknown plan", 400);
    const current = viewer(deps, c);
    if (!current) return c.redirect(withParam("/", "next", `/billing/checkout?plan=${plan}&interval=${interval}`), 303);
    const url = await checkoutUrl(deps, current.user, plan, interval);
    if (!url) return c.redirect("/?notice=no_plan", 303);
    return c.redirect(url, 303);
  });

  app.post("/billing/portal", async (c) => {
    if (!billingOn(deps)) return c.text("Payments are not set up", 404);
    const form = await c.req.parseBody();
    const current = viewer(deps, c);
    if (!current || !checkCsrf(current, form.csrf)) return c.text("Sign in again", 403);
    const subscription = deps.store.subscription(current.user.id);
    if (!subscription) return c.redirect("/#account", 303);
    return c.redirect(await portalUrl(deps, subscription.customerId, `${deps.config.baseUrl}/#account`), 303);
  });

  app.post("/connections/:id/remove", async (c) => {
    const form = await c.req.parseBody();
    const current = viewer(deps, c);
    if (!current) return c.redirect("/", 303);
    if (!checkCsrf(current, form.csrf)) return c.text("The form expired. Go back and try again.", 403);
    const connection = deps.store.connectionById(c.req.param("id"));
    if (connection && connection.userId === current.user.id) {
      const backend = backendOf(deps, connection);
      const name = viewConnection(deps, connection)?.name ?? connection.provider;
      if (backend) await vault.revoke(connection, tokensFor(deps, backend));
      deps.store.deleteConnection(connection.id, current.user.id);
      deps.store.audit({
        ts: deps.now(),
        userId: current.user.id,
        appId: null,
        connectionId: connection.id,
        action: "connection.remove",
        detail: `${name} · ${connection.accountLabel}`,
        status: null,
      });
    }
    return c.redirect("/?ok=removed", 303);
  });

  app.post("/apps/:id/revoke", async (c) => {
    const form = await c.req.parseBody();
    const current = viewer(deps, c);
    if (!current) return c.redirect("/", 303);
    if (!checkCsrf(current, form.csrf)) return c.text("The form expired. Go back and try again.", 403);
    const appId = c.req.param("id");
    const now = deps.now();
    if (deps.store.deleteGrantsForAppUser(appId, current.user.id) > 0) {
      deps.store.revokeAccessTokensForAppUser(appId, current.user.id, now);
      deps.store.audit({
        ts: now,
        userId: current.user.id,
        appId,
        connectionId: null,
        action: "grant.remove",
        detail: "Removed by the user",
        status: null,
      });
    }
    return c.redirect("/?ok=revoked", 303);
  });

  // The account: a copy of the data, and deletion

  app.get("/account/export", (c) => {
    const current = viewer(deps, c);
    if (!current) return c.redirect("/", 303);
    const data = deps.store.exportUser(current.user.id);
    c.header("Content-Disposition", `attachment; filename="gulpy-data-${new Date(deps.now()).toISOString().slice(0, 10)}.json"`);
    return c.json({ exported: new Date(deps.now()).toISOString(), ...data });
  });

  app.get("/account/delete", (c) => {
    const current = viewer(deps, c);
    if (!current) return c.redirect("/", 303);
    return render(c, <DeleteAccount viewer={current} />);
  });

  app.post("/account/delete", async (c) => {
    const form = await c.req.parseBody();
    const current = viewer(deps, c);
    if (!current) return c.redirect("/", 303);
    if (!checkCsrf(current, form.csrf)) return c.text("The form expired. Go back and try again.", 403);
    if (normalizeEmail(String(form.confirm ?? "")) !== current.user.email) {
      return render(c, <DeleteAccount viewer={current} error="The email address is not the same. Type it again." />, 400);
    }
    // Cancel each token at the provider first. A provider that does not answer does not stop the deletion.
    for (const connection of deps.store.connectionsByUser(current.user.id)) {
      const backend = backendOf(deps, connection);
      if (!backend) continue;
      try {
        await vault.revoke(connection, tokensFor(deps, backend));
      } catch (error) {
        console.error("[gulpy] revoke during account deletion failed", connection.provider, error);
      }
    }
    endSession(deps, c);
    deps.store.deleteUser(current.user.id);
    return render(c, <AccountDeleted />);
  });

  // Developers

  const developersPage = (c: Context, extra: { created?: NewAppSecret; error?: string } = {}) => {
    const current = viewer(deps, c);
    if (!current) return c.redirect("/", 303);
    const apps = deps.store.appsByOwner(current.user.id);
    return render(
      c,
      <Developers viewer={current} apps={apps} baseUrl={deps.config.baseUrl} {...extra} />,
      extra.error ? 400 : 200,
    );
  };

  app.get("/developers", (c) => developersPage(c));

  app.post("/developers/apps", async (c) => {
    const form = await c.req.parseBody();
    const current = viewer(deps, c);
    if (!current) return c.redirect("/", 303);
    if (!checkCsrf(current, form.csrf)) return c.text("The form expired. Go back and try again.", 403);

    const name = String(form.name ?? "").trim().slice(0, 60);
    const typed = String(form.origins ?? "")
      .split(/[\s,]+/)
      .filter(Boolean);
    const origins = typed.map(parseOrigin);
    if (!name) return developersPage(c, { error: "Enter a name for the app." });
    if (origins.length === 0 || origins.includes(null)) {
      return developersPage(c, { error: "Each origin must look like https://app.example.com, with no path." });
    }

    const clientId = randomId("cid");
    const secret = randomToken("secret");
    deps.store.createApp({
      id: randomId("app"),
      ownerUserId: current.user.id,
      name,
      clientId,
      clientSecretHash: sha256(secret),
      origins: [...new Set(origins.filter((origin): origin is string => origin !== null))],
      createdAt: deps.now(),
    });
    return developersPage(c, { created: { name, clientId, secret } });
  });

  app.post("/developers/apps/:id/remove", async (c) => {
    const form = await c.req.parseBody();
    const current = viewer(deps, c);
    if (!current) return c.redirect("/", 303);
    if (!checkCsrf(current, form.csrf)) return c.text("The form expired. Go back and try again.", 403);
    deps.store.deleteApp(c.req.param("id"), current.user.id);
    return c.redirect("/developers", 303);
  });

  return app;
}
