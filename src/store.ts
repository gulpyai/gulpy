import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeCapabilities, type CapabilityId } from "./capabilities.ts";

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS otps (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS otps_email ON otps(email, created_at);

CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  client_id TEXT NOT NULL UNIQUE,
  client_secret_hash TEXT NOT NULL,
  origins TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_label TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  scopes TEXT NOT NULL,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, provider, account_id)
);

CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  capabilities TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (app_id, connection_id)
);

CREATE TABLE IF NOT EXISTS link_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  capabilities TEXT NOT NULL,
  origin TEXT NOT NULL,
  client_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  public_token_enc TEXT,
  accounts TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  code_verifier_enc TEXT NOT NULL,
  return_to TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS public_tokens (
  token_hash TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS access_tokens (
  token_hash TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS access_tokens_pair ON access_tokens(app_id, user_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  app_id TEXT,
  connection_id TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  status INTEGER
);
CREATE INDEX IF NOT EXISTS audit_log_user ON audit_log(user_id, ts);
`;

/** Connectors that are MCP servers, and agents that sign in with standard OAuth. */
const SCHEMA_V2 = `
ALTER TABLE connections ADD COLUMN tools TEXT;
ALTER TABLE connections ADD COLUMN tools_fetched_at INTEGER;

ALTER TABLE apps ADD COLUMN kind TEXT NOT NULL DEFAULT 'embed';
ALTER TABLE apps ADD COLUMN redirect_uris TEXT NOT NULL DEFAULT '[]';
ALTER TABLE apps ADD COLUMN client_uri TEXT;

ALTER TABLE access_tokens ADD COLUMN expires_at INTEGER;
ALTER TABLE access_tokens ADD COLUMN family TEXT;

CREATE TABLE upstream_clients (
  connector TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  resource TEXT,
  metadata TEXT NOT NULL,
  client_enc TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE auth_codes (
  code_hash TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  family TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX refresh_tokens_family ON refresh_tokens(family);
`;

/**
 * Removed. It made a table for website sign-ins, which Gulpy does not have.
 * The entry keeps its place so that later migrations keep their numbers.
 */
const SCHEMA_V3 = `
DROP TABLE IF EXISTS site_logins;
`;

/** The version of the Terms and the Privacy page that each person accepted, and when. */
const SCHEMA_V4 = `
ALTER TABLE users ADD COLUMN rules_version TEXT;
ALTER TABLE users ADD COLUMN rules_accepted_at INTEGER;
CREATE INDEX IF NOT EXISTS audit_log_ts ON audit_log(ts);
`;

/** Removes the table of the old version 3 from databases that made it. */
const SCHEMA_V5 = `
DROP TABLE IF EXISTS site_logins;
`;

/** Each entry runs one time, in order. Add a new entry for each schema change. */
const MIGRATIONS = [SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, SCHEMA_V5];

export interface User {
  id: string;
  email: string;
  createdAt: number;
}

export interface Session {
  userId: string;
  csrf: string;
  expiresAt: number;
}

export interface Otp {
  id: string;
  email: string;
  codeHash: string;
  /** Hash of the cookie of the browser that asked for the code. */
  bindingHash: string;
  attempts: number;
  expiresAt: number;
  usedAt: number | null;
}

/**
 * `embed`: a developer registered it and it opens Link. `key`: the user made a key
 * for an agent on the dashboard. `agent`: an agent that signed up through OAuth
 * before Gulpy had keys. Gulpy no longer makes these.
 */
export type AppKind = "embed" | "key" | "agent";

export interface App {
  id: string;
  ownerUserId: string | null;
  name: string;
  clientId: string;
  /** Empty for a public client, which proves itself with PKCE only. */
  clientSecretHash: string;
  origins: string[];
  kind: AppKind;
  redirectUris: string[];
  clientUri: string | null;
  createdAt: number;
}

/** A tool of an upstream MCP server, as the server described it. */
export interface UpstreamTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

/** The OAuth client that Gulpy is at one upstream server. */
export interface UpstreamClient {
  connector: string;
  issuer: string;
  resource: string | null;
  /** Authorization server metadata, as JSON. */
  metadata: string;
  /** Client information, sealed. It can hold a client secret. */
  clientEnc: string;
  redirectUri: string;
}

export interface AuthCode {
  appId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string | null;
}

export interface RefreshToken {
  family: string;
  appId: string;
  userId: string;
  expiresAt: number;
  usedAt: number | null;
  revokedAt: number | null;
}

export type ConnectionStatus = "active" | "needs_reauth";

export interface Connection {
  id: string;
  userId: string;
  provider: string;
  accountId: string;
  accountLabel: string;
  capabilities: CapabilityId[];
  scopes: string[];
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  expiresAt: number | null;
  status: ConnectionStatus;
  /** Tools of the upstream MCP server. Null for a connection that is not an MCP server. */
  tools: UpstreamTool[] | null;
  toolsFetchedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Grant {
  id: string;
  userId: string;
  appId: string;
  connectionId: string;
  capabilities: CapabilityId[];
  createdAt: number;
  updatedAt: number;
}

export type LinkStatus = "open" | "completed" | "exited";

/** What the app learns about an account that the user shared. */
export interface LinkedAccount {
  connection_id: string;
  provider: string;
  account: string;
  capabilities: CapabilityId[];
}

export interface LinkSession {
  id: string;
  appId: string;
  capabilities: CapabilityId[];
  origin: string;
  clientUserId: string | null;
  status: LinkStatus;
  /** Sealed public token. Set when the user approves. */
  publicTokenEnc: string | null;
  accounts: LinkedAccount[];
  expiresAt: number;
}

export interface OAuthState {
  userId: string;
  provider: string;
  capabilities: CapabilityId[];
  codeVerifierEnc: string;
  returnTo: string;
  expiresAt: number;
}

export interface AccessToken {
  appId: string;
  userId: string;
  revokedAt: number | null;
  /** Null for a token that does not expire. */
  expiresAt: number | null;
}

export interface AuditEntry {
  id: number;
  ts: number;
  userId: string;
  appId: string | null;
  connectionId: string | null;
  action: string;
  detail: string | null;
  status: number | null;
}

type Row = Record<string, unknown>;

function strings(json: unknown): string[] {
  const parsed: unknown = JSON.parse(String(json));
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function toUser(row: Row): User {
  return { id: String(row.id), email: String(row.email), createdAt: Number(row.created_at) };
}

function toApp(row: Row): App {
  return {
    id: String(row.id),
    ownerUserId: row.owner_user_id === null ? null : String(row.owner_user_id),
    name: String(row.name),
    clientId: String(row.client_id),
    clientSecretHash: String(row.client_secret_hash),
    origins: strings(row.origins),
    kind: row.kind === "key" || row.kind === "agent" ? row.kind : "embed",
    redirectUris: strings(row.redirect_uris),
    clientUri: row.client_uri === null || row.client_uri === undefined ? null : String(row.client_uri),
    createdAt: Number(row.created_at),
  };
}

function toConnection(row: Row): Connection {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    provider: String(row.provider),
    accountId: String(row.account_id),
    accountLabel: String(row.account_label),
    capabilities: normalizeCapabilities(strings(row.capabilities)),
    scopes: strings(row.scopes),
    accessTokenEnc: String(row.access_token_enc),
    refreshTokenEnc: row.refresh_token_enc === null ? null : String(row.refresh_token_enc),
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    status: row.status === "needs_reauth" ? "needs_reauth" : "active",
    tools: row.tools === null || row.tools === undefined ? null : (JSON.parse(String(row.tools)) as UpstreamTool[]),
    toolsFetchedAt: row.tools_fetched_at === null || row.tools_fetched_at === undefined ? null : Number(row.tools_fetched_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toGrant(row: Row): Grant {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    appId: String(row.app_id),
    connectionId: String(row.connection_id),
    capabilities: normalizeCapabilities(strings(row.capabilities)),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toLinkStatus(value: unknown): LinkStatus {
  return value === "completed" || value === "exited" ? value : "open";
}

function toLinkSession(row: Row): LinkSession {
  return {
    id: String(row.id),
    appId: String(row.app_id),
    capabilities: normalizeCapabilities(strings(row.capabilities)),
    origin: String(row.origin),
    clientUserId: row.client_user_id === null ? null : String(row.client_user_id),
    status: toLinkStatus(row.status),
    publicTokenEnc: row.public_token_enc === null ? null : String(row.public_token_enc),
    accounts: row.accounts === null ? [] : (JSON.parse(String(row.accounts)) as LinkedAccount[]),
    expiresAt: Number(row.expires_at),
  };
}

function toAudit(row: Row): AuditEntry {
  return {
    id: Number(row.id),
    ts: Number(row.ts),
    userId: String(row.user_id),
    appId: row.app_id === null ? null : String(row.app_id),
    connectionId: row.connection_id === null ? null : String(row.connection_id),
    action: String(row.action),
    detail: row.detail === null ? null : String(row.detail),
    status: row.status === null ? null : Number(row.status),
  };
}

export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  const { user_version: version } = db.query("PRAGMA user_version").get() as { user_version: number };
  for (let index = version; index < MIGRATIONS.length; index++) {
    const migration = MIGRATIONS[index];
    if (migration === undefined) continue;
    db.transaction(() => {
      db.exec(migration);
      db.exec(`PRAGMA user_version = ${index + 1}`);
    })();
  }
  return db;
}

/** All SQL lives here. Every method takes the current time from the caller. */
export class Store {
  constructor(readonly db: Database) {}

  private one(sql: string, ...params: (string | number | null)[]): Row | null {
    return (this.db.query(sql).get(...params) as Row | null) ?? null;
  }

  private all(sql: string, ...params: (string | number | null)[]): Row[] {
    return this.db.query(sql).all(...params) as Row[];
  }

  private run(sql: string, ...params: (string | number | null)[]): number {
    return this.db.query(sql).run(...params).changes;
  }

  // Users and sessions

  userById(id: string): User | null {
    const row = this.one("SELECT * FROM users WHERE id = ?", id);
    return row ? toUser(row) : null;
  }

  userByEmail(email: string): User | null {
    const row = this.one("SELECT * FROM users WHERE email = ?", email);
    return row ? toUser(row) : null;
  }

  createUser(id: string, email: string, now: number): User {
    this.run("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)", id, email, now);
    return { id, email, createdAt: now };
  }

  /** Records that the user accepted this version of the Terms and the Privacy page. */
  acceptRules(userId: string, version: string, now: number): void {
    this.run("UPDATE users SET rules_version = ?, rules_accepted_at = ? WHERE id = ?", version, now, userId);
  }

  rulesAccepted(userId: string): { version: string; acceptedAt: number } | null {
    const row = this.one("SELECT rules_version, rules_accepted_at FROM users WHERE id = ?", userId);
    if (!row || row.rules_version === null) return null;
    return { version: String(row.rules_version), acceptedAt: Number(row.rules_accepted_at) };
  }

  /**
   * Deletes the user and all data about the user. The foreign keys delete the
   * sessions, connections, grants and tokens. The list of calls and the sign-in
   * codes have no foreign key, so they are deleted here. The apps that the user
   * registered as a developer are deleted too.
   */
  deleteUser(userId: string): boolean {
    const user = this.userById(userId);
    if (!user) return false;
    this.db.transaction(() => {
      this.run("DELETE FROM audit_log WHERE user_id = ?", userId);
      this.run("DELETE FROM otps WHERE email = ?", user.email);
      this.run("DELETE FROM apps WHERE owner_user_id = ?", userId);
      this.run("DELETE FROM users WHERE id = ?", userId);
    })();
    return true;
  }

  /** A copy of the data about the user, for the user. It has no tokens and no secrets. */
  exportUser(userId: string): Record<string, unknown> | null {
    const user = this.userById(userId);
    if (!user) return null;
    const rules = this.rulesAccepted(userId);
    const connections = this.all(
      "SELECT id, provider, account_label, capabilities, scopes, status, created_at, updated_at FROM connections WHERE user_id = ? ORDER BY created_at",
      userId,
    );
    const grants = this.all(
      `SELECT g.connection_id, g.capabilities, g.created_at, g.updated_at, a.name AS app_name
       FROM grants g JOIN apps a ON a.id = g.app_id WHERE g.user_id = ? ORDER BY g.created_at`,
      userId,
    );
    const apps = this.all(
      "SELECT name, client_id, origins, kind, redirect_uris, client_uri, created_at FROM apps WHERE owner_user_id = ? ORDER BY created_at",
      userId,
    );
    const calls = this.all(
      "SELECT ts, app_id, connection_id, action, detail, status FROM audit_log WHERE user_id = ? ORDER BY ts",
      userId,
    );
    const time = (value: unknown) => (value === null || value === undefined ? null : new Date(Number(value)).toISOString());
    return {
      account: {
        email: user.email,
        created: time(user.createdAt),
        rulesVersion: rules?.version ?? null,
        rulesAccepted: time(rules?.acceptedAt),
      },
      connections: connections.map((row) => ({
        id: row.id,
        provider: row.provider,
        account: row.account_label,
        capabilities: JSON.parse(String(row.capabilities)),
        scopes: String(row.scopes),
        status: row.status,
        created: time(row.created_at),
        updated: time(row.updated_at),
      })),
      approvals: grants.map((row) => ({
        agent: row.app_name,
        connection: row.connection_id,
        capabilities: JSON.parse(String(row.capabilities)),
        created: time(row.created_at),
        updated: time(row.updated_at),
      })),
      developerApps: apps.map((row) => ({
        name: row.name,
        clientId: row.client_id,
        origins: JSON.parse(String(row.origins)),
        kind: row.kind,
        redirectUris: JSON.parse(String(row.redirect_uris)),
        clientUri: row.client_uri,
        created: time(row.created_at),
      })),
      calls: calls.map((row) => ({
        time: time(row.ts),
        agent: row.app_id,
        connection: row.connection_id,
        action: row.action,
        detail: row.detail,
        status: row.status,
      })),
    };
  }

  /**
   * Deletes the rows that are not necessary now: expired codes, sessions and
   * tokens, and calls older than `callsBefore`. Returns the number of rows.
   */
  prune(now: number, callsBefore: number): number {
    const day = 24 * 60 * 60_000;
    const month = 30 * day;
    let count = 0;
    this.db.transaction(() => {
      count += this.run("DELETE FROM otps WHERE expires_at < ?", now - day);
      count += this.run("DELETE FROM sessions WHERE expires_at < ?", now);
      count += this.run("DELETE FROM oauth_states WHERE expires_at < ?", now - day);
      count += this.run("DELETE FROM auth_codes WHERE expires_at < ?", now - day);
      count += this.run("DELETE FROM public_tokens WHERE expires_at < ?", now - day);
      count += this.run("DELETE FROM link_sessions WHERE expires_at < ?", now - month);
      count += this.run(
        "DELETE FROM access_tokens WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR (expires_at IS NOT NULL AND expires_at < ?)",
        now - month,
        now - month,
      );
      count += this.run(
        "DELETE FROM refresh_tokens WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR expires_at < ?",
        now - month,
        now - month,
      );
      count += this.run("DELETE FROM audit_log WHERE ts < ?", callsBefore);
    })();
    return count;
  }

  createSession(idHash: string, userId: string, csrf: string, now: number, expiresAt: number): void {
    this.run(
      "INSERT INTO sessions (id_hash, user_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      idHash,
      userId,
      csrf,
      now,
      expiresAt,
    );
  }

  session(idHash: string, now: number): Session | null {
    const row = this.one("SELECT * FROM sessions WHERE id_hash = ? AND expires_at > ?", idHash, now);
    return row ? { userId: String(row.user_id), csrf: String(row.csrf), expiresAt: Number(row.expires_at) } : null;
  }

  deleteSession(idHash: string): void {
    this.run("DELETE FROM sessions WHERE id_hash = ?", idHash);
  }

  // One-time sign-in codes

  createOtp(otp: { id: string; email: string; codeHash: string; bindingHash: string }, now: number, expiresAt: number): void {
    this.run(
      "INSERT INTO otps (id, email, code_hash, binding_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      otp.id,
      otp.email,
      otp.codeHash,
      otp.bindingHash,
      now,
      expiresAt,
    );
  }

  otp(id: string): Otp | null {
    const row = this.one("SELECT * FROM otps WHERE id = ?", id);
    if (!row) return null;
    return {
      id: String(row.id),
      email: String(row.email),
      codeHash: String(row.code_hash),
      bindingHash: String(row.binding_hash),
      attempts: Number(row.attempts),
      expiresAt: Number(row.expires_at),
      usedAt: row.used_at === null ? null : Number(row.used_at),
    };
  }

  countRecentOtps(email: string, since: number): number {
    const row = this.one("SELECT COUNT(*) AS n FROM otps WHERE email = ? AND created_at > ?", email, since);
    return Number(row?.n ?? 0);
  }

  addOtpAttempt(id: string): void {
    this.run("UPDATE otps SET attempts = attempts + 1 WHERE id = ?", id);
  }

  /** Returns false if the code was used before. */
  useOtp(id: string, now: number): boolean {
    return this.run("UPDATE otps SET used_at = ? WHERE id = ? AND used_at IS NULL", now, id) === 1;
  }

  // Apps

  createApp(app: Omit<App, "kind" | "redirectUris" | "clientUri"> & Partial<Pick<App, "kind" | "redirectUris" | "clientUri">>): void {
    this.run(
      `INSERT INTO apps (id, owner_user_id, name, client_id, client_secret_hash, origins, kind, redirect_uris, client_uri, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      app.id,
      app.ownerUserId,
      app.name,
      app.clientId,
      app.clientSecretHash,
      JSON.stringify(app.origins),
      app.kind ?? "embed",
      JSON.stringify(app.redirectUris ?? []),
      app.clientUri ?? null,
      app.createdAt,
    );
  }

  /** Stores what a client metadata document says now. The document can change. */
  updateAgent(id: string, fields: { name: string; redirectUris: string[]; clientUri: string | null }): void {
    this.run(
      "UPDATE apps SET name = ?, redirect_uris = ?, client_uri = ? WHERE id = ? AND kind = 'agent'",
      fields.name,
      JSON.stringify(fields.redirectUris),
      fields.clientUri,
      id,
    );
  }

  updateApp(id: string, fields: { name: string; clientSecretHash: string; origins: string[] }): void {
    this.run(
      "UPDATE apps SET name = ?, client_secret_hash = ?, origins = ? WHERE id = ?",
      fields.name,
      fields.clientSecretHash,
      JSON.stringify(fields.origins),
      id,
    );
  }

  appById(id: string): App | null {
    const row = this.one("SELECT * FROM apps WHERE id = ?", id);
    return row ? toApp(row) : null;
  }

  appByClientId(clientId: string): App | null {
    const row = this.one("SELECT * FROM apps WHERE client_id = ?", clientId);
    return row ? toApp(row) : null;
  }

  appsByOwner(userId: string, kind: AppKind = "embed"): App[] {
    return this.all("SELECT * FROM apps WHERE owner_user_id = ? AND kind = ? ORDER BY created_at DESC", userId, kind).map(
      toApp,
    );
  }

  deleteApp(id: string, ownerUserId: string): boolean {
    return this.run("DELETE FROM apps WHERE id = ? AND owner_user_id = ?", id, ownerUserId) === 1;
  }

  // Connections

  connectionById(id: string): Connection | null {
    const row = this.one("SELECT * FROM connections WHERE id = ?", id);
    return row ? toConnection(row) : null;
  }

  connectionByAccount(userId: string, provider: string, accountId: string): Connection | null {
    const row = this.one(
      "SELECT * FROM connections WHERE user_id = ? AND provider = ? AND account_id = ?",
      userId,
      provider,
      accountId,
    );
    return row ? toConnection(row) : null;
  }

  connectionsByUser(userId: string): Connection[] {
    return this.all("SELECT * FROM connections WHERE user_id = ? ORDER BY updated_at DESC, id", userId).map(
      toConnection,
    );
  }

  insertConnection(conn: Connection): void {
    this.run(
      `INSERT INTO connections (id, user_id, provider, account_id, account_label, capabilities, scopes,
         access_token_enc, refresh_token_enc, expires_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      conn.id,
      conn.userId,
      conn.provider,
      conn.accountId,
      conn.accountLabel,
      JSON.stringify(conn.capabilities),
      JSON.stringify(conn.scopes),
      conn.accessTokenEnc,
      conn.refreshTokenEnc,
      conn.expiresAt,
      conn.status,
      conn.createdAt,
      conn.updatedAt,
    );
  }

  updateConnection(
    id: string,
    fields: {
      accountLabel: string;
      capabilities: CapabilityId[];
      scopes: string[];
      accessTokenEnc: string;
      refreshTokenEnc: string | null;
      expiresAt: number | null;
      status: ConnectionStatus;
    },
    now: number,
  ): void {
    this.run(
      `UPDATE connections SET account_label = ?, capabilities = ?, scopes = ?, access_token_enc = ?,
         refresh_token_enc = ?, expires_at = ?, status = ?, updated_at = ? WHERE id = ?`,
      fields.accountLabel,
      JSON.stringify(fields.capabilities),
      JSON.stringify(fields.scopes),
      fields.accessTokenEnc,
      fields.refreshTokenEnc,
      fields.expiresAt,
      fields.status,
      now,
      id,
    );
  }

  /** Stores a refreshed token pair. Does not change `updated_at`, which orders the account list. */
  updateConnectionTokens(
    id: string,
    accessTokenEnc: string,
    refreshTokenEnc: string | null,
    expiresAt: number | null,
  ): void {
    this.run(
      "UPDATE connections SET access_token_enc = ?, refresh_token_enc = ?, expires_at = ?, status = 'active' WHERE id = ?",
      accessTokenEnc,
      refreshTokenEnc,
      expiresAt,
      id,
    );
  }

  setConnectionTools(id: string, tools: UpstreamTool[], now: number): void {
    this.run("UPDATE connections SET tools = ?, tools_fetched_at = ? WHERE id = ?", JSON.stringify(tools), now, id);
  }

  setConnectionStatus(id: string, status: ConnectionStatus): void {
    this.run("UPDATE connections SET status = ? WHERE id = ?", status, id);
  }

  deleteConnection(id: string, userId: string): boolean {
    return this.run("DELETE FROM connections WHERE id = ? AND user_id = ?", id, userId) === 1;
  }

  // Grants

  grant(appId: string, connectionId: string): Grant | null {
    const row = this.one("SELECT * FROM grants WHERE app_id = ? AND connection_id = ?", appId, connectionId);
    return row ? toGrant(row) : null;
  }

  grantsForAppUser(appId: string, userId: string): Grant[] {
    return this.all(
      "SELECT * FROM grants WHERE app_id = ? AND user_id = ? ORDER BY created_at, id",
      appId,
      userId,
    ).map(toGrant);
  }

  grantsByUser(userId: string): Grant[] {
    return this.all("SELECT * FROM grants WHERE user_id = ? ORDER BY created_at, id", userId).map(toGrant);
  }

  /** Sets the capabilities of the grant for this app and connection. */
  upsertGrant(grant: Grant): void {
    this.run(
      `INSERT INTO grants (id, user_id, app_id, connection_id, capabilities, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (app_id, connection_id)
       DO UPDATE SET capabilities = excluded.capabilities, updated_at = excluded.updated_at`,
      grant.id,
      grant.userId,
      grant.appId,
      grant.connectionId,
      JSON.stringify(grant.capabilities),
      grant.createdAt,
      grant.updatedAt,
    );
  }

  deleteGrant(id: string, userId: string): Grant | null {
    const row = this.one("SELECT * FROM grants WHERE id = ? AND user_id = ?", id, userId);
    if (!row) return null;
    this.run("DELETE FROM grants WHERE id = ?", id);
    return toGrant(row);
  }

  deleteGrantFor(appId: string, connectionId: string): void {
    this.run("DELETE FROM grants WHERE app_id = ? AND connection_id = ?", appId, connectionId);
  }

  deleteGrantsForAppUser(appId: string, userId: string): number {
    return this.run("DELETE FROM grants WHERE app_id = ? AND user_id = ?", appId, userId);
  }

  // Link sessions

  createLinkSession(session: LinkSession, tokenHash: string, now: number): void {
    this.run(
      `INSERT INTO link_sessions (id, token_hash, app_id, capabilities, origin, client_user_id, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      session.id,
      tokenHash,
      session.appId,
      JSON.stringify(session.capabilities),
      session.origin,
      session.clientUserId,
      session.status,
      now,
      session.expiresAt,
    );
  }

  linkSession(tokenHash: string): LinkSession | null {
    const row = this.one("SELECT * FROM link_sessions WHERE token_hash = ?", tokenHash);
    return row ? toLinkSession(row) : null;
  }

  /** Returns false if the session is not open. A link session completes one time only. */
  completeLinkSession(id: string, publicTokenEnc: string, accounts: LinkedAccount[]): boolean {
    return (
      this.run(
        "UPDATE link_sessions SET status = 'completed', public_token_enc = ?, accounts = ? WHERE id = ? AND status = 'open'",
        publicTokenEnc,
        JSON.stringify(accounts),
        id,
      ) === 1
    );
  }

  exitLinkSession(id: string): void {
    this.run("UPDATE link_sessions SET status = 'exited' WHERE id = ? AND status = 'open'", id);
  }

  // OAuth state

  createOAuthState(stateHash: string, state: OAuthState, now: number): void {
    this.run(
      `INSERT INTO oauth_states (state_hash, user_id, provider, capabilities, code_verifier_enc, return_to, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      stateHash,
      state.userId,
      state.provider,
      JSON.stringify(state.capabilities),
      state.codeVerifierEnc,
      state.returnTo,
      now,
      state.expiresAt,
    );
  }

  /** Reads the state and deletes it. A state works one time only. */
  takeOAuthState(stateHash: string): OAuthState | null {
    const row = this.one("DELETE FROM oauth_states WHERE state_hash = ? RETURNING *", stateHash);
    if (!row) return null;
    return {
      userId: String(row.user_id),
      provider: String(row.provider),
      capabilities: normalizeCapabilities(strings(row.capabilities)),
      codeVerifierEnc: String(row.code_verifier_enc),
      returnTo: String(row.return_to),
      expiresAt: Number(row.expires_at),
    };
  }

  // Public tokens and access tokens

  createPublicToken(tokenHash: string, appId: string, userId: string, now: number, expiresAt: number): void {
    this.run(
      "INSERT INTO public_tokens (token_hash, app_id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      tokenHash,
      appId,
      userId,
      now,
      expiresAt,
    );
  }

  /** Marks the token as used and returns its owner. A public token works one time only. */
  takePublicToken(tokenHash: string, appId: string, now: number): { userId: string } | null {
    const row = this.one(
      `UPDATE public_tokens SET used_at = ?
       WHERE token_hash = ? AND app_id = ? AND used_at IS NULL AND expires_at > ?
       RETURNING user_id`,
      now,
      tokenHash,
      appId,
      now,
    );
    return row ? { userId: String(row.user_id) } : null;
  }

  createAccessToken(
    tokenHash: string,
    appId: string,
    userId: string,
    now: number,
    options: { expiresAt?: number; family?: string } = {},
  ): void {
    this.run(
      "INSERT INTO access_tokens (token_hash, app_id, user_id, created_at, expires_at, family) VALUES (?, ?, ?, ?, ?, ?)",
      tokenHash,
      appId,
      userId,
      now,
      options.expiresAt ?? null,
      options.family ?? null,
    );
  }

  accessToken(tokenHash: string): AccessToken | null {
    const row = this.one("SELECT * FROM access_tokens WHERE token_hash = ?", tokenHash);
    if (!row) return null;
    return {
      appId: String(row.app_id),
      userId: String(row.user_id),
      revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
      expiresAt: row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at),
    };
  }

  touchAccessToken(tokenHash: string, now: number): void {
    this.run("UPDATE access_tokens SET last_used_at = ? WHERE token_hash = ?", now, tokenHash);
  }

  revokeAccessToken(tokenHash: string, now: number): void {
    this.run("UPDATE access_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL", now, tokenHash);
  }

  revokeAccessTokensForAppUser(appId: string, userId: string, now: number): void {
    this.run(
      "UPDATE access_tokens SET revoked_at = ? WHERE app_id = ? AND user_id = ? AND revoked_at IS NULL",
      now,
      appId,
      userId,
    );
    this.run(
      "UPDATE refresh_tokens SET revoked_at = ? WHERE app_id = ? AND user_id = ? AND revoked_at IS NULL",
      now,
      appId,
      userId,
    );
  }

  // Authorization codes and refresh tokens, for agents that sign in with standard OAuth

  createAuthCode(codeHash: string, code: AuthCode, now: number, expiresAt: number): void {
    this.run(
      `INSERT INTO auth_codes (code_hash, app_id, user_id, redirect_uri, code_challenge, resource, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      codeHash,
      code.appId,
      code.userId,
      code.redirectUri,
      code.codeChallenge,
      code.resource,
      now,
      expiresAt,
    );
  }

  /** Marks the code as used and returns it. A code works one time only. */
  takeAuthCode(codeHash: string, now: number): AuthCode | null {
    const row = this.one(
      "UPDATE auth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING *",
      now,
      codeHash,
      now,
    );
    if (!row) return null;
    return {
      appId: String(row.app_id),
      userId: String(row.user_id),
      redirectUri: String(row.redirect_uri),
      codeChallenge: String(row.code_challenge),
      resource: row.resource === null ? null : String(row.resource),
    };
  }

  createRefreshToken(tokenHash: string, token: { family: string; appId: string; userId: string }, now: number, expiresAt: number): void {
    this.run(
      "INSERT INTO refresh_tokens (token_hash, family, app_id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      tokenHash,
      token.family,
      token.appId,
      token.userId,
      now,
      expiresAt,
    );
  }

  refreshToken(tokenHash: string): RefreshToken | null {
    const row = this.one("SELECT * FROM refresh_tokens WHERE token_hash = ?", tokenHash);
    if (!row) return null;
    return {
      family: String(row.family),
      appId: String(row.app_id),
      userId: String(row.user_id),
      expiresAt: Number(row.expires_at),
      usedAt: row.used_at === null ? null : Number(row.used_at),
      revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    };
  }

  /** Returns false if a different request used the token first. */
  useRefreshToken(tokenHash: string, now: number): boolean {
    return this.run("UPDATE refresh_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL", now, tokenHash) === 1;
  }

  /** Cancels all tokens that came from one sign-in. */
  revokeFamily(family: string, now: number): void {
    this.run("UPDATE refresh_tokens SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL", now, family);
    this.run("UPDATE access_tokens SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL", now, family);
  }

  // The OAuth clients that Gulpy is at upstream MCP servers

  upstreamClient(connector: string): UpstreamClient | null {
    const row = this.one("SELECT * FROM upstream_clients WHERE connector = ?", connector);
    if (!row) return null;
    return {
      connector: String(row.connector),
      issuer: String(row.issuer),
      resource: row.resource === null ? null : String(row.resource),
      metadata: String(row.metadata),
      clientEnc: String(row.client_enc),
      redirectUri: String(row.redirect_uri),
    };
  }

  saveUpstreamClient(client: UpstreamClient, now: number): void {
    this.run(
      `INSERT INTO upstream_clients (connector, issuer, resource, metadata, client_enc, redirect_uri, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (connector) DO UPDATE SET issuer = excluded.issuer, resource = excluded.resource,
         metadata = excluded.metadata, client_enc = excluded.client_enc, redirect_uri = excluded.redirect_uri`,
      client.connector,
      client.issuer,
      client.resource,
      client.metadata,
      client.clientEnc,
      client.redirectUri,
      now,
    );
  }

  deleteUpstreamClient(connector: string): void {
    this.run("DELETE FROM upstream_clients WHERE connector = ?", connector);
  }

  // Audit log

  audit(entry: Omit<AuditEntry, "id">): void {
    this.run(
      "INSERT INTO audit_log (ts, user_id, app_id, connection_id, action, detail, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      entry.ts,
      entry.userId,
      entry.appId,
      entry.connectionId,
      entry.action,
      entry.detail,
      entry.status,
    );
  }

  /** The number of calls that agents made for the user after a time. */
  countCalls(userId: string, since: number): number {
    const row = this.one(
      "SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ? AND ts > ? AND app_id IS NOT NULL AND status IS NOT NULL",
      userId,
      since,
    );
    return Number(row?.n ?? 0);
  }

  /** The time of the last call of each agent, by app id. */
  lastCalls(userId: string): Map<string, number> {
    const rows = this.all(
      "SELECT app_id, MAX(ts) AS ts FROM audit_log WHERE user_id = ? AND app_id IS NOT NULL AND status IS NOT NULL GROUP BY app_id",
      userId,
    );
    return new Map(rows.map((row) => [String(row.app_id), Number(row.ts)]));
  }

  auditByUser(userId: string, limit: number): AuditEntry[] {
    return this.all("SELECT * FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT ?", userId, limit).map(toAudit);
  }
}
