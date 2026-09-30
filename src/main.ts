import { createApp, createDeps } from "./app.ts";
import { startBackups } from "./backup.ts";
import { startCleanup } from "./cleanup.ts";
import { loadConfig } from "./config.ts";
import type { Mailer } from "./deps.ts";
import { ConsoleMailer, ResendMailer } from "./mailer.ts";

const config = loadConfig();

function mailer(): Mailer {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (key && from) return new ResendMailer(key, from);
  if (config.env === "production") {
    throw new Error("Set RESEND_API_KEY and MAIL_FROM. Production must send sign-in codes by email.");
  }
  return new ConsoleMailer();
}

const { app, deps } = await createApp(createDeps({ config, mailer: mailer() }));

startCleanup(deps);
if (config.backupDir) startBackups(deps, config.backupDir);
Bun.serve({ port: config.port, fetch: app.fetch });

console.log(`[gulpy] ${config.baseUrl} (${config.env})`);
console.log(`[gulpy] providers: ${[...deps.providers.keys()].join(", ") || "none"}`);
console.log(
  config.stripe
    ? `[gulpy] paid plans: on (${/^[sr]k_live_/.test(config.stripe.secretKey) ? "live" : "test"} mode)`
    : "[gulpy] paid plans: off. Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET to sell plans.",
);
console.log(`[gulpy] approval: ${config.autoApprove ? "automatic for known agents" : "the user approves each agent"}`);
