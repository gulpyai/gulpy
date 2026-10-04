import { SITE_URL } from "./brand.ts";
import { randomBytes } from "node:crypto";
import type { CustomConnector } from "./catalog.ts";

export type Env = "development" | "test" | "production";

export interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
}

/** Paid plans through Stripe. Without it, Gulpy sells nothing: each person is on Free. */
export interface StripeConfig {
  /** `sk_test_...` or `sk_live_...` */
  secretKey: string;
  /** `whsec_...`, the signing secret of the webhook endpoint `<GULPY_BASE_URL>/stripe/webhook`. */
  webhookSecret: string;
}

export interface Config {
  env: Env;
  port: number;
  /** Public origin of Gulpy, without a trailing slash. */
  baseUrl: string;
  dbPath: string;
  /** 32 bytes. Encrypts provider tokens at rest. */
  masterKey: Buffer;
  /** Gulpy writes a copy of the database to this folder each day. Not set: no copies. */
  backupDir?: string;
  /** Other host names of this server, for example an old address. Gulpy sends each request on them to `baseUrl`. */
  redirectHosts: string[];
  google?: ProviderCredentials;
  microsoft?: ProviderCredentials;
  /**
   * Provider ids for which `/v1/proxy` is on. The default is none.
   * The Google and Microsoft API terms do not permit you to offer a copy of their API
   * to third parties, so keep the proxy off for them unless each app uses its own OAuth client.
   */
  rawProxy: string[];
  /** MCP connectors that are not in the built-in list. */
  customConnectors: CustomConnector[];
  /**
   * OAuth apps that the operator registered at providers that do not permit
   * automatic registration, by connector id. For example `github`.
   */
  connectorClients: Record<string, ProviderCredentials>;
  stripe?: StripeConfig;
  /**
   * True: an agent that Gulpy knows, or a program on the computer of the user, connects
   * with no approval step, and a new connection goes to each agent of the user.
   * False: the user approves each agent. Set `GULPY_AUTO_APPROVE=off` for false.
   */
  autoApprove: boolean;
  /**
   * The origin of the marketing site. Its start form sends the email address to /auth/start;
   * no other form of a different site can. `GULPY_SITE_URL`, default https://gulpy.ai.
   */
  siteOrigin: string;
}

/** Connectors that need an OAuth app that the operator registers by hand. */
const STATIC_CONNECTORS = ["github", "slack", "hubspot", "asana", "box", "render", "figma"];

const KEYCHAIN_MASTER_KEY = "gulpy-dev-master-key";
/** The first name of the product. Data from before the change of name uses this key. */
const KEYCHAIN_MASTER_KEY_BEFORE = "connecty-dev-master-key";

function keychainGet(name: string): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const result = Bun.spawnSync(["security", "find-generic-password", "-s", name, "-w"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return undefined;
  return result.stdout.toString().trim() || undefined;
}

function keychainSet(name: string, value: string): boolean {
  if (process.platform !== "darwin") return false;
  const account = process.env.USER ?? "gulpy";
  const result = Bun.spawnSync(
    ["security", "add-generic-password", "-a", account, "-s", name, "-w", value, "-U"],
    { stdout: "ignore", stderr: "ignore" },
  );
  return result.exitCode === 0;
}

/** Environment first. In development, the macOS Keychain is the fallback. */
function secret(env: Env, envName: string, keychainName: string): string | undefined {
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  return env === "development" ? keychainGet(keychainName) : undefined;
}

function loadMasterKey(env: Env): Buffer {
  const encoded =
    process.env.GULPY_MASTER_KEY ??
    (env === "development" ? (keychainGet(KEYCHAIN_MASTER_KEY) ?? keychainGet(KEYCHAIN_MASTER_KEY_BEFORE)) : undefined);
  if (encoded) {
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) throw new Error("GULPY_MASTER_KEY must be 32 bytes, base64 encoded");
    return key;
  }
  if (env === "test") return randomBytes(32);
  if (env === "development") {
    const key = randomBytes(32);
    if (keychainSet(KEYCHAIN_MASTER_KEY, key.toString("base64"))) return key;
  }
  throw new Error("GULPY_MASTER_KEY is not set. Generate one with: openssl rand -base64 32");
}

function credentials(env: Env, name: "GOOGLE" | "MICROSOFT"): ProviderCredentials | undefined {
  const lower = name.toLowerCase();
  const clientId = secret(env, `${name}_CLIENT_ID`, `gulpy-${lower}-client-id`);
  const clientSecret = secret(env, `${name}_CLIENT_SECRET`, `gulpy-${lower}-client-secret`);
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

function stripeConfig(env: Env): StripeConfig | undefined {
  const secretKey = secret(env, "STRIPE_SECRET_KEY", "gulpy-stripe-secret-key");
  const webhookSecret = secret(env, "STRIPE_WEBHOOK_SECRET", "gulpy-stripe-webhook-secret");
  return secretKey && webhookSecret ? { secretKey, webhookSecret } : undefined;
}

function connectorClients(env: Env): Record<string, ProviderCredentials> {
  const clients: Record<string, ProviderCredentials> = {};
  for (const id of STATIC_CONNECTORS) {
    const name = `CONNECTOR_${id.toUpperCase()}`;
    const clientId = secret(env, `${name}_CLIENT_ID`, `gulpy-connector-${id}-client-id`);
    const clientSecret = secret(env, `${name}_CLIENT_SECRET`, `gulpy-connector-${id}-client-secret`);
    if (clientId && clientSecret) clients[id] = { clientId, clientSecret };
  }
  return clients;
}

/** True for an address on the computer of the developer, such as `http://localhost:4000`. */
export function isLocalAddress(baseUrl: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(baseUrl);
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const rawEnv = process.env.NODE_ENV ?? "development";
  const env: Env = overrides.env ?? (rawEnv === "production" || rawEnv === "test" ? rawEnv : "development");
  const port = overrides.port ?? Number(process.env.PORT ?? 4000);
  const baseUrl = (overrides.baseUrl ?? process.env.GULPY_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, "");
  return {
    env,
    port,
    baseUrl,
    dbPath: overrides.dbPath ?? process.env.GULPY_DB ?? ".data/gulpy.db",
    masterKey: overrides.masterKey ?? loadMasterKey(env),
    backupDir: overrides.backupDir ?? (process.env.GULPY_BACKUP_DIR || undefined),
    redirectHosts:
      overrides.redirectHosts ??
      (process.env.GULPY_REDIRECT_HOSTS ?? "")
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    google: overrides.google ?? credentials(env, "GOOGLE"),
    microsoft: overrides.microsoft ?? credentials(env, "MICROSOFT"),
    rawProxy:
      overrides.rawProxy ??
      (process.env.GULPY_RAW_PROXY ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    customConnectors: overrides.customConnectors ?? [],
    connectorClients: overrides.connectorClients ?? connectorClients(env),
    stripe: overrides.stripe ?? stripeConfig(env),
    autoApprove: overrides.autoApprove ?? process.env.GULPY_AUTO_APPROVE !== "off",
    siteOrigin: overrides.siteOrigin ?? new URL(SITE_URL).origin,
  };
}
