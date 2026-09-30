/**
 * Merges two Gulpy accounts of one person: everything of <from> goes to <into>, then
 * <from> is deleted. Use this, not SQL: tokens are sealed with the key of their owner,
 * and only the vault can seal them again for the new owner.
 *
 *   bun run scripts/merge-accounts.ts <from email> <into email>          # shows what moves
 *   bun run scripts/merge-accounts.ts <from email> <into email> --apply  # does it, after a backup
 *
 * On the server: copy it into the container and run it there, with the server environment.
 */
import { createDeps } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { randomId } from "../src/crypto.ts";
import { Vault } from "../src/vault.ts";

const [fromEmail, intoEmail] = process.argv.slice(2);
const apply = process.argv.includes("--apply");
if (!fromEmail || !intoEmail) throw new Error("Usage: bun run scripts/merge-accounts.ts <from email> <into email> [--apply]");

const deps = createDeps({ config: loadConfig() });
const { store } = deps;
const from = store.userByEmail(fromEmail);
const into = store.userByEmail(intoEmail);
if (!from || !into || from.id === into.id) throw new Error("Both accounts must exist and be different");

const connections = store.connectionsByUser(from.id);
console.log(`${fromEmail} -> ${intoEmail}: ${connections.length} connections`);
if (!apply) process.exit(0);

const backup = `${deps.config.dbPath}.pre-merge-${deps.now()}`;
store.db.exec(`VACUUM INTO '${backup}'`);
console.log("backup:", backup);

const vault = new Vault(deps);
const now = deps.now();
store.db.transaction(() => {
  for (const connection of connections) vault.moveConnection(connection, into.id);
  for (const table of ["access_tokens", "refresh_tokens", "device_codes", "audit_log", "public_tokens", "auth_codes"]) {
    store.db.query(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`).run(into.id, from.id);
  }
  store.db.query("UPDATE apps SET owner_user_id = ? WHERE owner_user_id = ?").run(into.id, from.id);
  // Each agent of the person gets each working tool, as a new tool would.
  const agents = store.db
    .query("SELECT DISTINCT app_id FROM access_tokens WHERE user_id = ? AND revoked_at IS NULL")
    .all(into.id) as { app_id: string }[];
  for (const { app_id } of agents) {
    for (const connection of store.connectionsByUser(into.id)) {
      if (connection.status !== "active" || store.grant(app_id, connection.id)) continue;
      store.upsertGrant({
        id: randomId("grant"),
        userId: into.id,
        appId: app_id,
        connectionId: connection.id,
        capabilities: connection.capabilities,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  store.db.query("DELETE FROM users WHERE id = ?").run(from.id);
})();
console.log("merged");
