/**
 * End to end: "Connect everything" with the real extension in Chromium.
 *   bun run test/e2e/connect-all.ts
 * It starts Gulpy and three test apps on localhost: two where the user is signed in, one where
 * the user is signed out. The extension must connect the first two and skip the third.
 * It needs Playwright for Python at ~/.local/py (the browser part is test/e2e/connect-all.py).
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createDeps } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { ConsoleMailer } from "../../src/mailer.ts";
import { notesTools, tasksTools } from "../fixtures/mcp-connector/connectors.ts";
import { createMockMcp } from "../fixtures/mcp-connector/server.tsx";

const dir = mkdtempSync(join(tmpdir(), "gulpy-e2e-"));
const GULPY = "http://localhost:4430";
const apps = [
  { id: "acme-notes", name: "Acme Notes", port: 4431, tools: notesTools(), signedOut: false },
  { id: "acme-tasks", name: "Acme Tasks", port: 4432, tools: tasksTools(), signedOut: false },
  { id: "acme-closed", name: "Acme Closed", port: 4433, tools: notesTools(), signedOut: true },
];
const servers = apps.map((app) =>
  Bun.serve({
    port: app.port,
    fetch: createMockMcp({
      name: app.name,
      baseUrl: `http://localhost:${app.port}`,
      signingKey: randomBytes(32),
      registration: "dynamic",
      tools: app.tools,
      signedOut: app.signedOut,
    }).app.fetch,
  }),
);

const mailer = new ConsoleMailer(() => {});
const config = loadConfig({
  env: "development",
  port: 4430,
  baseUrl: GULPY,
  dbPath: join(dir, "gulpy.db"),
  masterKey: randomBytes(32),
  google: undefined,
  microsoft: undefined,
  stripe: undefined,
  connectorClients: {},
  customConnectors: apps.map((app) => ({
    id: app.id,
    name: app.name,
    description: "Test app",
    color: "1F7A4D",
    url: `http://localhost:${app.port}/mcp`,
  })),
});
const gulpy = await createApp(createDeps({ config, mailer }));
const server = Bun.serve({ port: 4430, fetch: gulpy.app.fetch });

const browser = Bun.spawn(
  [`${process.env.HOME}/.local/py/bin/python`, join(import.meta.dir, "connect-all.py"), GULPY, join(import.meta.dir, "../../extension")],
  { stdout: "pipe", stderr: "inherit" },
);
// The browser part prints each row and the summary.
process.stdout.write(await new Response(browser.stdout).text());
await browser.exited;

const user = gulpy.deps.store.userByEmail("e2e@example.com");
const connected = user ? gulpy.deps.store.connectionsByUser(user.id).map((c) => c.provider).sort() : [];
console.log("connections in Gulpy:", connected.join(", ") || "none");
const pass = connected.join(",") === "acme-notes,acme-tasks";
console.log(pass ? "PASS" : "FAIL");
server.stop(true);
for (const s of servers) s.stop(true);
rmSync(dir, { recursive: true, force: true });
process.exit(pass ? 0 : 1);
