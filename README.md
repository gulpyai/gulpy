# Gulpy

One login for all your AI plugins.

Each AI agent has its own list of plugins. You connect the same tools again in
each one. Gulpy is one place for your connections. You say "connect to Gulpy" to
an agent, tap **Allow** one time, and the agent calls all your tools with plain
HTTP and one key. Gulpy has no MCP server for agents.

"Plug", read from right to left, is "gulp". The mascot is a plug that eats tools.

| The site | Your tools |
|---|---|
| ![Landing](docs/screenshots/01-landing.png) | ![My tools](docs/screenshots/02-my-tools.png) |

The screenshots are from before 2026-10-03. The "Add Gulpy to an agent" panel changed since then.

The name is in one file: [src/brand.ts](src/brand.ts). The folder and the key labels keep
the first name, "connecty".

## Run it

You need [Bun](https://bun.sh) 1.3 or later.

```sh
bun install
bun run dev
```

| Address | What it is |
|---|---|
| http://localhost:4000 | **Gulpy**: the site, your tools, the Allow page, the API for agents |
| http://localhost:4500 | **Orbit**, an agent to try Gulpy with. It knows the Gulpy address only. |
| http://localhost:4600 | **Scout**, a second agent |

Gulpy has no fake data. The tools are the real connectors in the list.

Do these steps:

1. Open Gulpy. Sign in with an email address. On this computer no mail goes out, so
   the page fills in the code.
2. Select **+** on a tool, for example Notion or Linear. You sign in at the provider.
3. Open Orbit. Select **Connect with Gulpy**. A Gulpy window opens. Tap **Allow**.
   Orbit takes its key (the device flow, as in `/agents.md`).
4. Ask Orbit a question about your tools.
5. Open Scout. Connect it. Add a new tool in Gulpy: Orbit and Scout get it.
6. Open Gulpy. You see the agents and each call. Remove the access of one agent.

Orbit and Scout think with the `claude` command of this computer, with your Claude
account. Each question uses a small part of your Claude plan. If the command is not
on the computer, the agents show a list of tools that you can run.

## Add Gulpy to a real agent

### An agent on your computer: "Connect to Gulpy"

Say this to Claude Code, Codex, Cursor or any agent that can run commands:

```
Connect to Gulpy. Read https://app.gulpy.ai/agents.md and follow it.
```

The agent runs `curl -fsSL https://app.gulpy.ai/connect.sh | sh`. A browser window
opens with a code. You sign in and tap **Allow** one time. The agent saves one key in
`~/.config/gulpy/key` and calls all your tools with plain HTTP:

```sh
curl https://app.gulpy.ai/v1/tools -H "Authorization: Bearer $(cat ~/.config/gulpy/key)"
curl -X POST https://app.gulpy.ai/v1/tools/email_search -H "Authorization: Bearer $(cat ~/.config/gulpy/key)" \
  -H "Content-Type: application/json" -d '{"query": "invoice"}'
```

The key reaches each tool, also the tools that you add later. It does not expire.
Remove the agent on My tools to stop it. The sign-in is the device authorization
grant (RFC 8628): `POST /device/code`, the page `/device`, `POST /device/token`.
The one tap stays on purpose: anyone can ask for a code and send you the link.

### An agent that can send web requests but not run commands

It follows case B of `/agents.md`: `POST /device/code`, sends you the link, you tap
**Allow**, and it collects the key with `POST /device/token`.

An agent that can do neither (the ChatGPT, Claude and Grok chat apps) cannot use Gulpy.
Gulpy has no MCP server. For an agent in the cloud, Gulpy needs a public `https`
address: set `GULPY_BASE_URL` to it.

## Real connectors

The list has 63 real connectors. On 2026-09-29 each MCP address answered with its
sign-in metadata.

| Group | Count | What you must do |
|---|---|---|
| Register automatically | 25 | Nothing. Select **+**. Notion, Linear, Atlassian, Stripe, Vercel, Supabase, Canva, Higgsfield and others. |
| Need an app that you register at the provider | 7 | GitHub, Slack, HubSpot, Asana, Box, Render, Figma. The list shows them as "Soon". |
| Use the API of the provider, with Gulpy tools (Beta) | 2 | Google (Gmail, Calendar, Drive) and Microsoft (Outlook, Calendar, OneDrive). One sign-in each. Register one Google app and one Microsoft app (table below). |

Check the list against the real servers:

```sh
bun run scripts/check-catalog.ts              # reads public metadata only
bun run scripts/check-catalog.ts --register   # also registers Gulpy where the server permits it
```

Credentials for the connectors that need an app. Put them in the environment, or
in the macOS Keychain for development.

| Connector | Environment | Redirect address to register |
|---|---|---|
| GitHub, Slack, HubSpot, Asana, Box, Render, Figma | `CONNECTOR_<NAME>_CLIENT_ID`, `CONNECTOR_<NAME>_CLIENT_SECRET` | `<base>/oauth/callback/mcp` |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `<base>/oauth/callback/google` |
| Microsoft | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | `<base>/oauth/callback/microsoft` |

```sh
security add-generic-password -a "$USER" -s gulpy-connector-github-client-id -w "<client id>" -U
security add-generic-password -a "$USER" -s gulpy-connector-github-client-secret -w "<client secret>" -U
```


## How it works

```
   Agent (any)                                     Gulpy                      Connector (Notion)
        |                                             |                               |
        |  1. POST /device/code                       |                               |
        |-------------------------------------------->|                               |
        |  2. the user opens the link, taps Allow     |                               |
        |  3. POST /device/token  -> gulpy_... key    |                               |
        |<--------------------------------------------|                               |
        |  4. GET /v1/tools, POST /v1/tools/:name     |   the call, with the token    |
        |     Authorization: Bearer gulpy_...         |   of the user                 |
        |-------------------------------------------->|------------------------------>|
        |     { "result": ... } (plain JSON)          |                               |
        |<--------------------------------------------|<------------------------------|
```

Three objects carry the design:

- A **connection** is one account at one connector. It belongs to the user. It holds
  the tokens, encrypted.
- A **grant** gives one agent access to one connection. Allow gives each connection, with
  read and write. A new connection goes to each agent of the user (`GULPY_AUTO_APPROVE`).
- A **connector** is an entry in the list. It is an MCP server that the provider
  operates, or a provider API for which Gulpy supplies the tools.

The agent never gets the token of a connector. Gulpy reads the grant on each call and
then makes the call. Many providers offer their tools only as an MCP server. Gulpy talks
to those servers itself, in `src/upstream/`. The agent sees only plain JSON.

## Link: connect from your own page

An app can also open Gulpy in a window from its own page, as Plaid Link does.
Register the app at http://localhost:4000/developers.

```ts
// 1. On your server
const { link_token } = await post("/v1/link/token/create", {
  client_id, secret, capabilities: ["email.read", "calendar.read"],
});
```

```html
<!-- 2. On your page. Call Gulpy.open directly in the click handler. -->
<script src="http://localhost:4000/link.js"></script>
<script>
  button.onclick = () =>
    Gulpy.open({
      linkToken: () => fetch("/api/link-token", { method: "POST" }).then((r) => r.json()).then((d) => d.link_token),
      onSuccess: ({ publicToken }) => fetch("/api/exchange", { method: "POST", body: JSON.stringify({ publicToken }) }),
    });
</script>
```

```ts
// 3. On your server
const { access_token } = await post("/v1/link/public_token/exchange", { client_id, secret, public_token });
const mail = await fetch("http://localhost:4000/v1/email/messages?q=invoice", {
  headers: { authorization: `Bearer ${access_token}` },
});
```

### API for Link apps

All paths start with `/v1`. Errors have the shape `{ "error": { "code", "message" } }`.

| Method and path | Auth | What it does |
|---|---|---|
| `POST /link/token/create` | client ID + secret | Makes a link token. It works for 30 minutes. |
| `POST /link/public_token/exchange` | client ID + secret | Gives an access token for one user. |
| `GET /connections` | access token | Lists the accounts that the user shared. |
| `DELETE /connections/:id` | access token | The app gives up its access to one account. |
| `GET /email/messages`, `GET /email/messages/:id`, `POST /email/messages` | access token | Mail |
| `GET /calendar/events`, `POST /calendar/events` | access token | Calendar |
| `GET /files?q=`, `GET /files/:id` | access token | Files in Google Drive and OneDrive: search, and read the text. Beta. |
| `ANY /proxy/:connection_id/:service/*` | access token | A raw request to the provider API. Off by default. |

| Error code | Status | Meaning |
|---|---|---|
| `not_granted` | 403 | The user did not give this. |
| `connection_needs_reauth` | 409 | The provider cancelled the token. The user must reconnect. |
| `connection_required` | 400 | The user shared two or more accounts. Send `connection_id`. |
| `invalid_token` | 401 | The user removed the access, or the token is wrong. |

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `GULPY_BASE_URL` | `http://localhost:4000` | The public address of Gulpy |
| `GULPY_MASTER_KEY` | made and kept in the Keychain (development) | 32 bytes, base64. Encrypts the tokens. Necessary in production. |
| `GULPY_DB` | `.data/gulpy.db` | The SQLite file |
| `RESEND_API_KEY`, `MAIL_FROM` | not set | Sends sign-in codes by email. Necessary in production. |
| `GULPY_RAW_PROXY` | none | Provider ids for which `/v1/proxy` is on. Keep Google and Microsoft out. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | not set | Paid plans through Stripe. See [Paid plans](#paid-plans). Without them, each person is on Free. |
| `GULPY_AUTO_APPROVE` | on | `off`: a new connection does not go to the agents that the user has already. |
| `GULPY_BACKUP_DIR` | not set | Gulpy writes a copy of the database to this folder each day and keeps 14 copies. |

In development on macOS, each secret can also sit in the Keychain: `gulpy-stripe-secret-key`, `gulpy-stripe-webhook-secret`, and the same pattern for the provider credentials.

## Paid plans

Gulpy sells the plans Personal, Family and Business through Stripe. The products, the prices and the payment links live in Stripe; the `stripe` script of the marketing site makes them. Gulpy needs only the secret key and the signing secret of one webhook endpoint at `<GULPY_BASE_URL>/stripe/webhook`, with the events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`.

| Address | What it does |
|---|---|
| `GET /billing/checkout?plan=personal&interval=yearly` | Sends the signed-in person to the Stripe checkout of the plan. The link carries the user id, so the payment lands on this account. The pricing page of the site links here. |
| `POST /stripe/webhook` | Stripe reports each payment and each change of a subscription. Gulpy checks the signature and writes the plan of the person into the `subscriptions` table. |
| `GET /?checkout=<session id>` | Where Stripe sends the person after payment. Gulpy reads the session and shows the plan at once. |
| `POST /billing/portal` | Opens the Stripe customer portal: cancel, change the plan or the number of users, change the card, see invoices. |

What a plan changes: a person on Free keeps 7 days of calls in the activity list; a paid plan keeps `LEGAL.callLogDays`. The dashboard shows the plan under Your account, and the export has it. With no Stripe settings, all of this is off and Gulpy shows no plan.

## Security model

| Threat | Control |
|---|---|
| The database is stolen | Tokens and client registrations are encrypted with AES-256-GCM. Each value is bound to its row. Secrets of apps, access tokens, refresh tokens and session IDs are stored as hashes only. |
| A fault gives the row of one user to a different user | Each user has a vault key of their own. It comes from the master key and the id of the user. The token of one user does not open with the key of a different user. |
| Someone sends the user a connect link | The user must tap **Allow**. Gulpy then emails the user ("Not you? Remove it"). A link works one time, for 10 minutes. |
| An agent gets a provider token | The agent never gets the token of a connector. Gulpy reads the grant on each call. |
| A key leaks | A key reaches all the tools of the user. Gulpy stores only its hash. The user removes the agent to stop it. Each call is on the dashboard. |
| A page on a different site submits a form | Gulpy checks `Sec-Fetch-Site`, and each form has a secret field. Cookies are `SameSite=Lax` and `HttpOnly`. |
| An attacker signs the victim in to the attacker's account | A sign-in code works only in the browser that asked for it. A provider callback works only in the session that started it. |
| A hidden frame gets a click on **Allow** | Pages forbid frames (`frame-ancestors 'none'`). |
| Two apps compare their users | Each Link app sees a different user ID for the same person. |
| The user wants to know what happened | The dashboard shows each call. It records the tool and the result, not the content. |

Known gaps:

- **Tool descriptions come from the connector and go to the AI model.** A bad connector
  can put instructions in them. Gulpy limits the length. It does not inspect the text.
- A key has no scopes and does not expire. Anyone with the key has all the tools.
- No rate limits. One server process only: the refresh lock is in memory.
- The copies of the database are on the disk of the server. A copy in a different place is not made.

## Logos

Each connector and each agent shows the logo of its company. The images are in
`src/assets/logos/`. `manifest.json` in that folder has the source address of each one.

```sh
~/.local/py/bin/python scripts/fetch-logos.py          # gets all logos again
~/.local/py/bin/python scripts/fetch-logos.py slack    # gets one
```

An agent gives its own name, so the name is not proof.

## Project layout

```
src/
  catalog.ts        the list of connectors
  logos.ts          the logo images, and the rule for the logo of an agent
  device.ts         "connect to Gulpy": the device flow that gives an agent its key
  agents.ts         gives a new connection to the agents of the user
  tools.ts          the tools that agents call: GET /v1/tools, POST /v1/tools/:name
  guide.ts          /agents.md and /connect.sh
  upstream/         Gulpy as a client of an upstream MCP server
  service.ts        tools, mail, calendar and proxy operations
  vault.ts          token encryption and refresh, with one key for each user
  backup.ts         the daily copy of the database
  store.ts          all SQL (SQLite), with migrations
  link.ts           Link: tokens, account choices, approval
  oauth.ts          sign-in at a provider that has its own API
  providers/        google.ts, microsoft.ts
  routes/           pages.tsx, info.tsx (support, security, privacy, terms), connect.ts (device flow, guide), api.ts, billing.ts (the Stripe webhook)
  billing.ts        paid plans: the Stripe checkout, the webhook events, the customer portal
  views/            the pages
examples/
  agent/            Orbit and Scout. They think with the `claude` command.
scripts/            dev.ts, check-catalog.ts, fetch-logos.py, make-social.py (the picture for link previews),
                    deploy-vm.sh (puts Gulpy on a server)
deploy/             compose.yml: the app and the Cloudflare tunnel on a server
Dockerfile          Gulpy for a host
test/               end-to-end tests. They use no network.
  fixtures/         a mail provider and MCP connectors for the tests only
```

## Tests

```sh
bun test
bun run typecheck
```

## Status

Verified:

- The full flow: 136 automated tests, and runs in a real browser (Chromium) with the
  pop-up window. The tests use a mail provider and connectors that exist for the tests only.
- A real AI agent: Claude answered questions with tools that came through Gulpy.
- The agent side: the device flow, keys, `GET /v1/tools` and `POST /v1/tools/:name`,
  in the tests and live with Orbit on 2026-10-03.
- The registration of Gulpy at 24 real connectors. Their sign-in pages show the name "Gulpy".

- Gulpy in production mode with the real address setting (`https://gulpy.ai`).
- On 2026-09-29, Gulpy on a server (`https://cloud.gulpy.ai`, Google Cloud, Docker, Cloudflare
  tunnel): the container build from `Dockerfile`, sign-in with a code that Resend sent to a real
  mailbox, the dashboard, the registration of an agent, and the registration of Gulpy at Linear
  and Notion, which sent the browser to their sign-in pages.

Not verified:

- **The sign-in of a user at a real connector, and a tool call with a real account.**
  This needs your accounts. Select **+** on a tool to try it.
- The Google and Microsoft adapters did not run against the real services. They show **Beta**.
- Google Drive and OneDrive give text for Google Docs, Sheets (first sheet), Slides and text files only.
  Word, Excel, PowerPoint and PDF files give a link and no text.
- Mail to a real person. The `ResendMailer` sent one message to the test mailbox of Resend (HTTP 200).

Not built yet:

- The Google and Microsoft apps. Without `GOOGLE_*` and `MICROSOFT_*`, their 2 cards show "Soon".
- The 7 tools that show "Soon": GitHub, Slack, HubSpot, Asana, Box, Render, Figma. Each needs an app at the provider.
- Skills and plugin packs. Gulpy has connectors only.
- Connectors that use an API key and no OAuth, for example Exa and Firecrawl.
- Passkeys for sign-in to Gulpy.
- A search across the 830 connectors of the Claude directory.

## Run your own Gulpy

Gulpy is one process with one SQLite file. You can run it on your own server and keep
all your connections there.

On a server that has Docker, one command does all the steps. It makes the master key, makes
a Cloudflare tunnel for the public `https` address, sends the code, and starts Gulpy:

```sh
GULPY_VM=<ssh host> GULPY_HOST=<name in your domain> scripts/deploy-vm.sh
```

Run it again to send new code. The data stays. The secrets are on the server in `/etc/gulpy`,
which only root can read. A copy of the master key stays in the macOS Keychain as `gulpy-vm-master-key`.

By hand:

1. Copy `.env.example` to `.env`.
2. Set `GULPY_BASE_URL` to your public `https` address.
3. Set `GULPY_MASTER_KEY` to 32 random bytes (`openssl rand -base64 32`). Keep a copy in a
   safe place. Without it, the stored tokens cannot be read.
4. Set `RESEND_API_KEY` and `MAIL_FROM`, so that the sign-in codes go out by email.
5. Start it with `bun run start`, or build the `Dockerfile`.
6. Optional: sell plans. See [Paid plans](#paid-plans). Without it, everybody is on Free.

## Security

Report a security problem in private. Do not open a public issue. See [SECURITY.md](SECURITY.md).

## License

[GNU Affero General Public License v3.0](LICENSE). You can use, change and run Gulpy for
free. If you run a changed copy as a service for other people, you must publish your changes
under the same license.
