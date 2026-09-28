import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { randomBytes } from "node:crypto";
import { demoProvider } from "./fixtures/mail-provider/adapter.ts";
import { createMockProvider, type MockProvider } from "./fixtures/mail-provider/server.tsx";
import { codeTools, notesTools, tasksTools } from "./fixtures/mcp-connector/connectors.ts";
import { createMockMcp, type MockMcp } from "./fixtures/mcp-connector/server.tsx";
import { createApp, createDeps, type GulpyApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { randomToken, sha256 } from "../src/crypto.ts";
import { ConsoleMailer } from "../src/mailer.ts";

export const GULPY = "https://gulpy.test";
export const ACME = "https://acme.test";
export const NOTES = "https://notes.acme.test";
export const TASKS = "https://tasks.acme.test";
/** A connector that does not annotate its tools. */
export const CODE = "https://code.acme.test";
/** A connector that does not permit automatic registration. */
export const LOCKED = "https://locked.acme.test";

export interface TestApp {
  id: string;
  name: string;
  clientId: string;
  secret: string;
  origin: string;
}

export interface World {
  gulpy: GulpyApp;
  mock: MockProvider;
  /** The mock connectors, by origin. */
  connectors: Record<string, MockMcp>;
  /** Pages that the tests serve at other origins, by address. For client ID metadata documents. */
  documents: Map<string, unknown>;
  mailer: ConsoleMailer;
  /** Each request that Gulpy or a browser made, as "METHOD origin/path". */
  requests: string[];
  fetch: typeof fetch;
  /** Moves the clock forward. */
  advance(ms: number): void;
  registerApp(name: string, origin: string): TestApp;
  browser(): Browser;
  /** Calls the Gulpy API as an agent app server. */
  api(path: string, init?: { method?: string; token?: string; body?: unknown }): Promise<{ status: number; body: any }>;
}

export async function createWorld(options: { accessTtlSeconds?: number; rawProxy?: string[] } = {}): Promise<World> {
  let clock = Date.parse("2026-09-27T12:00:00Z");
  const now = () => clock;
  const requests: string[] = [];

  const config: Config = {
    env: "test",
    port: 0,
    baseUrl: GULPY,
    dbPath: ":memory:",
    masterKey: randomBytes(32),
    rawProxy: options.rawProxy ?? ["demo"],
    customConnectors: [
      { id: "acme-notes", name: "Acme Notes", description: "Demo notes", color: "1F7A4D", url: `${NOTES}/mcp` },
      { id: "acme-tasks", name: "Acme Tasks", description: "Demo tasks", color: "B4530A", url: `${TASKS}/mcp` },
      { id: "acme-code", name: "Acme Code", description: "Demo code", color: "24292F", url: `${CODE}/mcp` },
    ],
    connectorClients: {},
  };

  // A mail provider and MCP connectors for the tests. The product has none of them.
  const mail = { baseUrl: ACME, clientId: "gulpy-test", clientSecret: randomToken("secret") };
  const mock = createMockProvider({
    signingKey: randomBytes(32),
    clientId: mail.clientId,
    clientSecret: mail.clientSecret,
    redirectUris: [`${GULPY}/oauth/callback/demo`],
    accessTtlSeconds: options.accessTtlSeconds ?? 300,
    now,
  });

  const mcpOptions = { signingKey: randomBytes(32), accessTtlSeconds: options.accessTtlSeconds ?? 300, now };
  const connectors: Record<string, MockMcp> = {
    [NOTES]: createMockMcp({ ...mcpOptions, name: "Acme Notes", baseUrl: NOTES, registration: "dynamic", tools: notesTools() }),
    [TASKS]: createMockMcp({ ...mcpOptions, name: "Acme Tasks", baseUrl: TASKS, registration: "dynamic", tools: tasksTools() }),
    [CODE]: createMockMcp({
      ...mcpOptions,
      name: "Acme Code",
      baseUrl: CODE,
      registration: "dynamic",
      tools: codeTools(),
      annotate: false,
    }),
    [LOCKED]: createMockMcp({
      ...mcpOptions,
      name: "Acme Locked",
      baseUrl: LOCKED,
      registration: "static",
      staticClient: {
        clientId: "gulpy-at-locked",
        clientSecret: "locked-secret-for-tests",
        redirectUris: [`${GULPY}/oauth/callback/mcp`],
      },
      tools: notesTools(),
    }),
  };
  const documents = new Map<string, unknown>();

  let gulpy: GulpyApp | undefined;

  // No network. Each origin goes to the app that owns it.
  const route = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.origin}${url.pathname}`);
    if (url.origin === ACME) return mock.app.fetch(request);
    if (url.origin === GULPY && gulpy) return gulpy.app.fetch(request);
    const connector = connectors[url.origin];
    if (connector) return connector.app.fetch(request);
    const document = documents.get(url.origin + url.pathname);
    if (document !== undefined) return Response.json(document);
    if ([...documents.keys()].some((address) => address.startsWith(url.origin))) return new Response("Not found", { status: 404 });
    throw new Error(`Unexpected request to ${url.origin}`);
  }) as typeof fetch;

  const mailer = new ConsoleMailer(() => {});
  gulpy = await createApp(createDeps({ config, fetch: route, mailer, now, providers: [demoProvider(mail)] }));
  const { store } = gulpy.deps;

  return {
    gulpy,
    mock,
    connectors,
    documents,
    mailer,
    requests,
    fetch: route,
    advance: (ms) => {
      clock += ms;
    },
    registerApp(name, origin) {
      const app: TestApp = {
        id: `app_${name.toLowerCase().replace(/\W+/g, "_")}`,
        name,
        clientId: `cid_${name.toLowerCase().replace(/\W+/g, "_")}`,
        secret: randomToken("secret"),
        origin,
      };
      store.createApp({
        id: app.id,
        ownerUserId: null,
        name,
        clientId: app.clientId,
        clientSecretHash: sha256(app.secret),
        origins: [origin],
        createdAt: now(),
      });
      return app;
    },
    browser: () => new Browser(route),
    async api(path, init = {}) {
      const response = await route(`${GULPY}/v1${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: {
          "content-type": "application/json",
          ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      const text = await response.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON. Keep the text.
      }
      return { status: response.status, body };
    },
  };
}

interface Cookie {
  value: string;
  path: string;
}

export interface Page {
  url: string;
  status: number;
  html: string;
}

function unescapeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Value of the first input with this name. */
export function field(html: string, name: string): string {
  const tag = new RegExp(`<input[^>]*\\bname="${name}"[^>]*>`).exec(html)?.[0];
  const value = tag ? /\bvalue="([^"]*)"/.exec(tag)?.[1] : undefined;
  if (value === undefined) throw new Error(`No input named "${name}" on the page`);
  return unescapeHtml(value);
}

/** Value of a data attribute, for example data-public-token. */
export function dataAttribute(html: string, name: string): string | undefined {
  const value = new RegExp(`\\bdata-${name}="([^"]*)"`).exec(html)?.[1];
  return value === undefined ? undefined : unescapeHtml(value);
}

/** The href values of all links on the page. */
export function links(html: string): string[] {
  return [...html.matchAll(/<a[^>]*\bhref="([^"]*)"/g)].map((match) => unescapeHtml(match[1] ?? ""));
}

/** The values of the checkboxes that are selected when the page loads. */
export function checked(html: string): string[] {
  return [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => /\bchecked\b/.test(tag))
    .map((tag) => unescapeHtml(/\bvalue="([^"]*)"/.exec(tag)?.[1] ?? ""));
}

/** A small browser: it keeps cookies for each origin and follows redirects. */
export class Browser {
  private readonly jar = new Map<string, Map<string, Cookie>>();

  constructor(private readonly route: typeof fetch) {}

  private cookieHeader(url: URL): string {
    const cookies = this.jar.get(url.origin);
    if (!cookies) return "";
    return [...cookies]
      .filter(([, cookie]) => url.pathname.startsWith(cookie.path))
      .map(([name, cookie]) => `${name}=${cookie.value}`)
      .join("; ");
  }

  private store(url: URL, response: Response): void {
    const cookies = this.jar.get(url.origin) ?? new Map<string, Cookie>();
    this.jar.set(url.origin, cookies);
    for (const line of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
      const split = pair.indexOf("=");
      const name = pair.slice(0, split);
      const value = pair.slice(split + 1);
      const attribute = (wanted: string) =>
        attributes.find((item) => item.toLowerCase().startsWith(`${wanted}=`))?.slice(wanted.length + 1);
      const expired = attribute("max-age") === "0" || Date.parse(attribute("expires") ?? "") < Date.now();
      if (expired || value === "") cookies.delete(name);
      else cookies.set(name, { value, path: attribute("path") ?? "/" });
    }
  }

  hasCookie(origin: string, name: string): boolean {
    return this.jar.get(origin)?.has(name) ?? false;
  }

  /**
   * Loads a page and follows redirects. `from` is the page that holds the form
   * or the link: the browser sends its origin, as a real browser does.
   */
  async open(
    target: string,
    options: { method?: "GET" | "POST"; form?: Record<string, string | string[]>; from?: string } = {},
  ): Promise<Page> {
    let url = new URL(target);
    let method = options.method ?? (options.form ? "POST" : "GET");
    let body: URLSearchParams | undefined;
    if (options.form) {
      body = new URLSearchParams();
      for (const [name, value] of Object.entries(options.form)) {
        for (const item of [value].flat()) body.append(name, item);
      }
    }

    for (let hop = 0; hop < 12; hop++) {
      const headers = new Headers();
      const cookie = this.cookieHeader(url);
      if (cookie) headers.set("cookie", cookie);
      if (method === "POST") {
        const from = new URL(options.from ?? url.toString()).origin;
        headers.set("origin", from);
        headers.set("sec-fetch-site", from === url.origin ? "same-origin" : "cross-site");
        headers.set("content-type", "application/x-www-form-urlencoded");
      }
      const response = await this.route(url.toString(), {
        method,
        headers,
        body: method === "POST" ? body?.toString() : undefined,
        redirect: "manual",
      });
      this.store(url, response);

      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        url = new URL(location, url);
        method = "GET";
        body = undefined;
        continue;
      }
      return { url: url.toString(), status: response.status, html: await response.text() };
    }
    throw new Error("Too many redirects");
  }

  /** Signs in to Gulpy with an email code. Returns the page that shows after sign-in. */
  async signIn(world: World, email: string, next = "/"): Promise<Page> {
    const start = await this.open(`${GULPY}/auth/start`, { form: { email, next } });
    const code = world.mailer.peek(email);
    if (!code) throw new Error("No sign-in code was sent");
    return this.open(`${GULPY}/auth/verify`, {
      form: { email, next, otp_id: field(start.html, "otp_id"), code },
    });
  }

  /** On the Acme Mail consent page, chooses an account. Returns the page after the redirect back. */
  async approveAtAcme(page: Page, accountId: string): Promise<Page> {
    if (!page.url.startsWith(`${ACME}/oauth/authorize`)) throw new Error(`Not the Acme consent page: ${page.url}`);
    const form: Record<string, string> = { account: accountId };
    for (const name of [
      "client_id",
      "redirect_uri",
      "response_type",
      "scope",
      "state",
      "code_challenge",
      "code_challenge_method",
    ]) {
      form[name] = field(page.html, name);
    }
    return this.open(`${ACME}/oauth/authorize`, { form, from: page.url });
  }
}

export const ALICE = "acme-1001";
export const BOB = "acme-1002";

/** Makes a link token for the app and returns the token and the Link address. */
export async function startLink(
  world: World,
  app: TestApp,
  capabilities: string[],
): Promise<{ token: string; url: string }> {
  const reply = await world.api("/link/token/create", {
    body: { client_id: app.clientId, secret: app.secret, capabilities },
  });
  if (reply.status !== 200) throw new Error(`No link token: ${JSON.stringify(reply.body)}`);
  return { token: reply.body.link_token, url: reply.body.link_url };
}

/** Submits the consent form with the accounts that are selected on the page. Returns the public token. */
export async function allow(browser: Browser, consent: Page, select?: string[]): Promise<{ page: Page; publicToken: string }> {
  const page = await browser.open(`${GULPY}/link/approve`, {
    form: {
      csrf: field(consent.html, "csrf"),
      token: field(consent.html, "token"),
      connection: select ?? checked(consent.html),
    },
    from: consent.url,
  });
  const publicToken = dataAttribute(page.html, "public-token");
  if (!publicToken) throw new Error(`Link did not complete (HTTP ${page.status})`);
  return { page, publicToken };
}

export async function exchange(world: World, app: TestApp, publicToken: string): Promise<string> {
  const reply = await world.api("/link/public_token/exchange", {
    body: { client_id: app.clientId, secret: app.secret, public_token: publicToken },
  });
  if (reply.status !== 200) throw new Error(`Exchange failed: ${JSON.stringify(reply.body)}`);
  return reply.body.access_token;
}

/**
 * The full first-time flow: sign in, add an Acme Mail account, allow, exchange.
 * Returns the access token of the app.
 */
export async function connectFirstTime(
  world: World,
  browser: Browser,
  app: TestApp,
  options: { email: string; capabilities: string[]; account?: string },
): Promise<string> {
  const link = await startLink(world, app, options.capabilities);
  const path = link.url.slice(GULPY.length);
  await browser.signIn(world, options.email, path);
  const acme = await browser.open(`${GULPY}/link/connect/demo?token=${encodeURIComponent(link.token)}`);
  const consent = await browser.approveAtAcme(acme, options.account ?? ALICE);
  const { publicToken } = await allow(browser, consent);
  return exchange(world, app, publicToken);
}

/** The address in the link of the page that sends the browser back to an agent. */
export function leaveAddress(html: string): string {
  const href = /<a[^>]*\bid="leave"[^>]*\bhref="([^"]*)"/.exec(html)?.[1];
  if (!href) throw new Error("The page does not send the browser to an agent");
  return unescapeHtml(href);
}

/** On the consent page of a mock connector, chooses an account. Returns the page after the redirect back. */
export async function approveAtConnector(browser: Browser, page: Page, accountId: string): Promise<Page> {
  const origin = new URL(page.url).origin;
  const form: Record<string, string> = { account: accountId };
  for (const name of ["client_id", "redirect_uri", "response_type", "scope", "state", "code_challenge", "code_challenge_method", "resource"]) {
    try {
      form[name] = field(page.html, name);
    } catch {
      // The connector did not get this parameter.
    }
  }
  return browser.open(`${origin}/authorize`, { form, from: page.url });
}

/** Adds a mock connector to the account of the signed-in user. Returns the page that shows after it. */
export async function addConnector(browser: Browser, connectorId: string, account = ALICE, next = "/"): Promise<Page> {
  const consent = await browser.open(`${GULPY}/connect/${connectorId}?${new URLSearchParams({ next })}`);
  return approveAtConnector(browser, consent, account);
}

/**
 * An agent that uses the MCP SDK to sign in, as real agents do. It finds the
 * authorization server, registers itself, and exchanges the code.
 */
export class TestAgent implements OAuthClientProvider {
  client: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  /** Where the SDK wants to send the user. */
  authorizeUrl: URL | undefined;
  private verifier = "";

  constructor(
    private readonly world: World,
    readonly name: string,
    readonly redirect = `https://${name.toLowerCase()}.agent.test/callback`,
    /** Set this to use a client ID metadata document and not registration. */
    readonly clientMetadataUrl?: string,
  ) {}

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.name,
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation() {
    return this.client;
  }

  saveClientInformation(client: OAuthClientInformationMixed) {
    this.client = client;
  }

  tokens() {
    return this.saved;
  }

  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }

  redirectToAuthorization(url: URL) {
    this.authorizeUrl = url;
  }

  state() {
    return `state-${this.name}`;
  }

  /** Forgets the tokens, so that the next sign-in asks the user again. */
  forget() {
    this.saved = undefined;
  }

  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }

  codeVerifier() {
    return this.verifier;
  }

  /** Starts the sign-in. Returns the Gulpy page that the user sees. */
  async start(browser: Browser): Promise<Page> {
    this.authorizeUrl = undefined;
    const result = await auth(this, { serverUrl: `${GULPY}/mcp`, fetchFn: this.world.fetch });
    // The SDK sets the address through redirectToAuthorization.
    const target = this.pending();
    if (result !== "REDIRECT" || !target) throw new Error(`The agent did not start the sign-in: ${result}`);
    return browser.open(target.toString());
  }

  private pending(): URL | undefined {
    return this.authorizeUrl;
  }

  /** Submits the approval page. `levels` sets the access for a connection; the default is what the page shows. */
  async allow(browser: Browser, consent: Page, options: { select?: string[]; levels?: Record<string, "read" | "write"> } = {}) {
    const selected = options.select ?? checked(consent.html);
    const form: Record<string, string | string[]> = { csrf: field(consent.html, "csrf"), decision: "allow", connection: selected };
    for (const name of ["client_id", "redirect_uri", "response_type", "state", "code_challenge", "code_challenge_method", "resource", "scope"]) {
      try {
        form[name] = field(consent.html, name);
      } catch {
        // The agent did not send this parameter.
      }
    }
    for (const id of selected) form[`level:${id}`] = options.levels?.[id] ?? selectedLevel(consent.html, id);
    const page = await browser.open(`${GULPY}/oauth/authorize`, { form, from: consent.url });
    const back = new URL(leaveAddress(page.html));
    const code = back.searchParams.get("code");
    if (!code) throw new Error(`No code: ${back.search}`);
    const result = await auth(this, { serverUrl: `${GULPY}/mcp`, authorizationCode: code, fetchFn: this.world.fetch });
    if (result !== "AUTHORIZED") throw new Error("The agent did not get tokens");
    return back;
  }

  /** Signs in from start to end with what the approval page selects. */
  async connect(browser: Browser, options: { select?: string[]; levels?: Record<string, "read" | "write"> } = {}) {
    return this.allow(browser, await this.start(browser), options);
  }

  /** An MCP client that uses the tokens of this agent. */
  async mcp(): Promise<Client> {
    const client = new Client({ name: this.name, version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${GULPY}/mcp`), { fetch: this.world.fetch, authProvider: this }),
    );
    return client;
  }

  async toolNames(): Promise<string[]> {
    const client = await this.mcp();
    try {
      return (await client.listTools()).tools.map((tool) => tool.name).sort();
    } finally {
      await client.close();
    }
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string }> {
    const client = await this.mcp();
    try {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as { type: string; text?: string }[];
      return { isError: result.isError === true, text: content.map((item) => item.text ?? "").join("") };
    } finally {
      await client.close();
    }
  }
}

/** The access level that the approval page shows for a connection. */
export function selectedLevel(html: string, connectionId: string): "read" | "write" {
  const radios = [...html.matchAll(new RegExp(`<input[^>]*name="level:${connectionId}"[^>]*>`, "g"))].map((match) => match[0]);
  const chosen = radios.find((tag) => /\bchecked\b/.test(tag));
  return chosen && /value="read"/.test(chosen) ? "read" : "write";
}

/** The connection ids on the approval page, with the name that the page shows. */
export function choices(html: string): { id: string; checked: boolean }[] {
  return [...html.matchAll(/<input[^>]*type="checkbox"[^>]*name="connection"[^>]*>/g)].map((match) => ({
    id: unescapeHtml(/\bvalue="([^"]*)"/.exec(match[0])?.[1] ?? ""),
    checked: /\bchecked\b/.test(match[0]),
  }));
}

/** The request of the agent, as the approval page holds it in hidden fields. */
export function agentRequest(html: string): Record<string, string> {
  const request: Record<string, string> = {};
  for (const name of ["client_id", "redirect_uri", "response_type", "state", "code_challenge", "code_challenge_method", "resource", "scope"]) {
    try {
      request[name] = field(html, name);
    } catch {
      // The agent did not send this parameter.
    }
  }
  return request;
}
