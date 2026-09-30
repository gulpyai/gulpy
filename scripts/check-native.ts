/**
 * Runs the Gulpy tools for Google and Microsoft against the real services, with
 * the connections of one user in the database. It only reads: it does not send
 * email and does not make events.
 *
 *   bun run scripts/check-native.ts <email of the Gulpy user>
 *
 * It prints counts and ids, not the content of the mail or the files.
 */
import { createDeps } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { providerTokens, Vault } from "../src/vault.ts";

const email = process.argv[2];
if (!email) throw new Error("Usage: bun run scripts/check-native.ts <email>");

const deps = createDeps({ config: loadConfig() });
const vault = new Vault(deps);
const user = deps.store.userByEmail(email);
if (!user) throw new Error(`No Gulpy user with the address ${email}`);

const DAY_MS = 24 * 60 * 60_000;
let failed = 0;

async function check(label: string, run: () => Promise<string>): Promise<void> {
  try {
    console.log(`ok    ${label}: ${await run()}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

for (const connection of deps.store.connectionsByUser(user.id)) {
  const provider = deps.providers.get(connection.provider);
  if (!provider) continue;
  const api = vault.api(connection, providerTokens(deps, provider));
  const { unified } = provider;
  const held = new Set(connection.capabilities);
  console.log(`\n${provider.name} · ${connection.accountLabel} · ${connection.capabilities.join(", ")}`);

  if (held.has("email.read")) {
    let firstId: string | undefined;
    await check("email_search", async () => {
      const messages = await unified.listMessages(api, { limit: 5 });
      firstId = messages[0]?.id;
      return `${messages.length} messages, newest ${messages[0]?.date ?? "none"}`;
    });
    await check("email_search with words", async () => `${(await unified.listMessages(api, { query: "the", limit: 5 })).length} messages`);
    if (firstId) {
      const id = firstId;
      await check("email_read", async () => `${(await unified.getMessage(api, id)).body_text.length} characters of text`);
    }
  }

  if (held.has("calendar.read")) {
    await check("calendar_list_events", async () => {
      const now = Date.now();
      const events = await unified.listEvents(api, {
        from: new Date(now - 7 * DAY_MS).toISOString(),
        to: new Date(now + 7 * DAY_MS).toISOString(),
        limit: 20,
      });
      return `${events.length} events in 14 days, ${events.filter((event) => event.all_day).length} all day`;
    });
  }

  if (held.has("files.read") && unified.searchFiles && unified.readFile) {
    const { searchFiles, readFile } = unified;
    let files: Awaited<ReturnType<typeof searchFiles>> = [];
    await check("files_search", async () => {
      files = await searchFiles(api, { limit: 20 });
      return `${files.length} files`;
    });
    await check("files_search with words", async () => `${(await searchFiles(api, { query: "the", limit: 5 })).length} files`);
    for (const file of files.slice(0, 20)) {
      const readable = file.mime_type?.startsWith("application/vnd.google-apps.") || file.mime_type?.startsWith("text/");
      if (!readable) continue;
      await check(`files_read (${file.mime_type})`, async () => {
        const content = await readFile(api, file.id);
        return content.text === null ? "no text" : `${content.text.length} characters${content.truncated ? ", cut" : ""}`;
      });
      break;
    }
  }
}

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} checks failed.`);
process.exit(failed === 0 ? 0 : 1);
