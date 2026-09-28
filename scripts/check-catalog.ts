/**
 * Checks each MCP connector in the catalog against the real server.
 *
 *   bun run scripts/check-catalog.ts              reads the public sign-in metadata
 *   bun run scripts/check-catalog.ts --register   also registers Gulpy at each server that permits it
 *
 * A registration makes an OAuth client named "Gulpy" at the provider. It
 * is stored, encrypted, in the database, and the app uses it after that.
 * It gives no access to the data of a user.
 */
import { createDeps } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { discover, upstream } from "../src/upstream/oauth.ts";

const register = process.argv.includes("--register");
const json = process.argv.find((arg) => arg.startsWith("--json="))?.slice("--json=".length);
const deps = createDeps({ config: loadConfig() });

interface Row {
  id: string;
  name: string;
  url: string;
  metadata: boolean;
  automatic: boolean;
  document: boolean;
  registered: "yes" | "no" | "refused" | "needs app" | "-";
  detail: string;
}

async function check(id: string): Promise<Row | null> {
  const connector = deps.catalog.get(id);
  if (!connector || connector.source.kind !== "mcp") return null;
  const row: Row = {
    id,
    name: connector.name,
    url: connector.source.url,
    metadata: false,
    automatic: false,
    document: false,
    registered: "-",
    detail: "",
  };
  try {
    const found = await discover(deps, connector.source.url);
    row.metadata = true;
    row.automatic = typeof found.metadata.registration_endpoint === "string";
    row.document = found.metadata.client_id_metadata_document_supported === true;
    row.detail = found.scope ?? "";
  } catch (error) {
    row.detail = error instanceof Error ? error.message.slice(0, 80) : "failed";
    return row;
  }
  if (!register) return row;
  if (deps.store.upstreamClient(id)) {
    row.registered = "yes";
    return row;
  }
  if (!row.automatic && !deps.config.connectorClients[id]) {
    row.registered = "needs app";
    return row;
  }
  try {
    await upstream(deps, connector);
    row.registered = "yes";
  } catch (error) {
    row.registered = "refused";
    row.detail = error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 110) : "failed";
  }
  return row;
}

const rows: Row[] = [];
for (const connector of deps.catalog.all()) {
  const row = await check(connector.id);
  if (row) rows.push(row);
}

const mark = (value: boolean) => (value ? "yes" : "no");
console.log(["connector", "metadata", "automatic", "document", "registered", "detail"].join(" | "));
for (const row of rows) {
  console.log(
    [row.name.padEnd(12), mark(row.metadata), mark(row.automatic), mark(row.document), row.registered, row.detail].join(" | "),
  );
}
const count = (test: (row: Row) => boolean) => rows.filter(test).length;
console.log(
  `\n${rows.length} connectors. Automatic registration: ${count((row) => row.automatic)}. ` +
    `Metadata document: ${count((row) => row.document)}. ` +
    (register ? `Registered: ${count((row) => row.registered === "yes")}. Refused: ${count((row) => row.registered === "refused")}.` : ""),
);
if (json) await Bun.write(json, JSON.stringify(rows, null, 1));
