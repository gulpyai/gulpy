# Gulpy

One login for all your AI plugins.

Each AI agent has its own list of plugins. You connect the same tools again in
each one. Gulpy is one place for your connections. You make a key on the
dashboard and paste one message into any agent. The agent saves the key and
calls your tools with plain HTTP and JSON. No MCP, no approval window.

"Plug", read from right to left, is "gulp". The mascot is a plug that eats tools.

| The site | Your tools |
|---|---|
| ![Landing](docs/screenshots/01-landing.png) | ![My tools](docs/screenshots/02-my-tools.png) |

The screenshots show the design before keys. The dashboard now has a "Connect an agent" panel.

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
| http://localhost:4000 | **Gulpy**: the site, your tools, the API for agents |
| http://localhost:4500 | **Orbit**, an agent to try Gulpy with. It knows the Gulpy address only. |
| http://localhost:4600 | **Scout**, a second agent |

Gulpy has no fake data. The tools are the real connectors in the list.

Do these steps:

1. Open Gulpy. Sign in with an email address. On this computer no mail goes out, so
   the page fills in the code.
2. Select **+** on a tool, for example Notion or Linear. You sign in at the provider.
3. On Gulpy, type "Orbit" and select **Make a key**. Copy the message.
4. Open Orbit. Paste the message. Orbit saves the key.
5. Ask Orbit a question about your tools.
6. Make a second key for Scout.
7. Open Gulpy. You see the agents and each call. Remove one agent. Its key stops.

Orbit and Scout think with the `claude` command of this computer, with your Claude
account. Each question uses a small part of your Claude plan. If the command is not
on the computer, the agents show a list of tools that you can run.

## Add Gulpy to a real agent

Any agent that can make a web request works: ChatGPT, Claude, Codex, Claude Code,
OpenClaw or your own script.

1. Open My tools. Type a name for the agent and select **Make a key**.
2. Copy the message and paste it into the agent. It looks like this:

   ```
   I use Gulpy to connect my tools (email, calendar, Notion, GitHub and others). You can use them with plain HTTP.

   Save these two lines in your memory, so that you can use my tools in later conversations:
   - Gulpy key: gulpy_...
   - Gulpy guide: https://cloud.gulpy.ai/agents.md

   Now read the guide, then list my tools. Keep the key secret: send it only to https://cloud.gulpy.ai.
   ```

3. The agent reads [`/agents.md`](src/guide.ts) and calls the API:

   ```sh
   curl https://cloud.gulpy.ai/v1/tools -H "Authorization: Bearer $GULPY_KEY"

   curl -X POST https://cloud.gulpy.ai/v1/tools/email_search \
     -H "Authorization: Bearer $GULPY_KEY" \
     -H "Content-Type: application/json" \
     -d '{"query": "invoice", "limit": 5}'
   ```

A key reaches each connection of the user, also the connections that the user
adds later. It does not expire. Remove the agent on My tools to stop the key.

An agent in the cloud needs a public `https` address. Set `GULPY_BASE_URL` to it.

## Real connectors

The list has 36 real connectors. On 2026-09-27 each address answered with its
sign-in metadata.

| Group | Count | What you must do |
|---|---|---|
| Register automatically | 25 | Nothing. Select **+**. Notion, Linear, Atlassian, Stripe, Vercel, Supabase, Canva, Higgsfield and others. |
| Need an app that you register at the provider | 7 | GitHub, Slack, HubSpot, Asana, Box, Render, Figma. The list shows them as "Soon". |
| Use the API of the provider, with Gulpy tools | 4 | Gmail, Google Calendar, Outlook Email, Outlook Calendar |

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
| Gmail, Google Calendar | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `<base>/oauth/callback/google` |
| Outlook Email, Outlook Calendar | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | `<base>/oauth/callback/microsoft` |

```sh
security add-generic-password -a "$USER" -s gulpy-connector-github-client-id -w "<client id>" -U
security add-generic-password -a "$USER" -s gulpy-connector-github-client-secret -w "<client secret>" -U
```


## How it works

```
   Agent (any)                                     Gulpy                      Connector (Notion)
        |                                             |                               |
        |  GET /v1/tools                              |                               |
        |  Authorization: Bearer gulpy_...            |                               |
        |-------------------------------------------->|  tools/list (cached 6 hours)  |
        |     { "tools": [...] }                      |------------------------------>|
        |<--------------------------------------------|                               |
        |  POST /v1/tools/notion_search {"query":..}  |                               |
        |-------------------------------------------->|  the call, with the token     |
        |                                             |  of the user                  |
        |     { "result": ... }                       |------------------------------>|
        |<--------------------------------------------|                               |
```

Three objects carry the design:

- A **connection** is one account at one connector. It belongs to the user. It holds
  the tokens, encrypted.
- A **key** belongs to one agent of the user. It reaches each connection of the user.
  Gulpy stores only its hash.
- A **connector** is an entry in the list. It is an MCP server that the provider
  operates, or a provider API for which Gulpy supplies the tools.

The agent never gets the token of a connector. Gulpy makes each call.

Many providers (Notion, Linear, Stripe and others) offer their tools only as an MCP
server. Gulpy talks to those servers itself, in `src/upstream/`. The agent does not
see this: it sends and gets plain JSON.

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
| `GET /tools` | key or access token | Lists the tools that the caller can use. |
| `POST /tools/:name` | key or access token | Runs one tool. The body is the arguments, as JSON. |
| `GET /connections` | access token | Lists the accounts that the user shared. |
| `DELETE /connections/:id` | access token | The app gives up its access to one account. |
| `GET /email/messages`, `GET /email/messages/:id`, `POST /email/messages` | access token | Mail |
| `GET /calendar/events`, `POST /calendar/events` | access token | Calendar |
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

## Security model

| Threat | Control |
|---|---|
| The database is stolen | Tokens and client registrations are encrypted with AES-256-GCM. Each value is bound to its row. Secrets of apps, access tokens, refresh tokens and session IDs are stored as hashes only. |
| A key leaks | A key reaches all the tools of the user, with read and write. Gulpy stores only its hash and shows it one time. The user removes the agent to stop the key. Each call is on the dashboard. |
| An agent gets a provider token | The agent never gets the token of a connector. Gulpy makes each call. |
| A Link app does more than the user approved | Gulpy reads the grant on each call. |
| A page on a different site submits a form | Gulpy checks `Sec-Fetch-Site`, and each form has a secret field. Cookies are `SameSite=Lax` and `HttpOnly`. |
| An attacker signs the victim in to the attacker's account | A sign-in code works only in the browser that asked for it. A provider callback works only in the session that started it. |
| A hidden frame gets a click on **Allow access** (Link) | Pages forbid frames (`frame-ancestors 'none'`). |
| Two apps compare their users | Each Link app sees a different user ID for the same person. |
| The user wants to know what happened | The dashboard shows each call. It records the tool and the result, not the content. |

Known gaps:

- **Tool descriptions come from the connector and go to the AI model.** A bad connector
  can put instructions in them. Gulpy limits the length. It does not inspect the text.
- A key has no scopes and no expiry. The user decided this on 2026-09-29: an agent
  gets everything with no approval step. The agent that holds the key, and the
  memory where it keeps the key, see the key.
- No rate limits. One server process only: the refresh lock is in memory.

## Logos

Each connector and each agent shows the logo of its company. The images are in
`src/assets/logos/`. `manifest.json` in that folder has the source address of each one.

```sh
~/.local/py/bin/python scripts/fetch-logos.py          # gets all logos again
~/.local/py/bin/python scripts/fetch-logos.py slack    # gets one
```

An agent gives its own name, so the name is not proof. The approval window shows the
logo of Claude, ChatGPT, Grok or Cursor only if each return address of the agent is on
the site of that company.

## Project layout

```
src/
  catalog.ts        the list of connectors
  logos.ts          the logo images, and the rule for the logo of an agent
  tools.ts          the tools that agents call: GET /v1/tools, POST /v1/tools/:name
  guide.ts          the guide for agents (/agents.md) and the message with the key
  upstream/         Gulpy as a client of an upstream MCP server
  service.ts        tools, mail, calendar and proxy operations
  vault.ts          token encryption and refresh
  store.ts          all SQL (SQLite), with migrations
  link.ts           Link: tokens, account choices, approval
  oauth.ts          sign-in at a provider that has its own API
  providers/        google.ts, microsoft.ts
  routes/           pages.tsx, info.tsx (support, security, privacy, terms), api.ts
  views/            the pages
examples/
  agent/            Orbit and Scout. They think with the `claude` command.
scripts/            dev.ts, check-catalog.ts, fetch-logos.py, make-social.py (the picture for link previews)
Dockerfile          Gulpy for a host
test/               end-to-end tests. They use no network.
  fixtures/         a mail provider and MCP connectors for the tests only
```

## Tests

```sh
bun test          # 102 tests
bun run typecheck
```

## Status

Verified:

- The full flow: 102 automated tests. The tests use a mail provider and connectors
  that exist for the tests only. The key flow is tested end to end: make a key, list
  tools, call tools, remove the key.
- The registration of Gulpy at 24 real connectors. Their sign-in pages show the name "Gulpy".

- Gulpy in production mode with the real address setting (`https://gulpy.ai`).

Not verified:

- The container build from `Dockerfile`.
- **The sign-in of a user at a real connector, and a tool call with a real account.**
  This needs your accounts. Select **+** on a tool to try it.
- The Google and Microsoft adapters did not run against the real services.
- A real agent (ChatGPT, Claude, Codex) that uses a key and `/agents.md`. Keys were
  added on 2026-09-29. Agents in the cloud need a public `https` address.
- Mail to a real person. The `ResendMailer` sent one message to the test mailbox of Resend (HTTP 200).

Not built yet:

- The 11 tools that show "Soon": Gmail, Google Calendar, Outlook Email, Outlook Calendar,
  GitHub, Slack, HubSpot, Asana, Box, Render, Figma. Each needs an app at the provider.
- Skills and plugin packs. Gulpy has connectors only.
- Connectors that use an API key and no OAuth, for example Exa and Firecrawl.
- Passkeys for sign-in to Gulpy.
- A search across the 830 connectors of the Claude directory.

## Run your own Gulpy

Gulpy is one process with one SQLite file. You can run it on your own server and keep
all your connections there.

1. Copy `.env.example` to `.env`.
2. Set `GULPY_BASE_URL` to your public `https` address.
3. Set `GULPY_MASTER_KEY` to 32 random bytes (`openssl rand -base64 32`). Keep a copy in a
   safe place. Without it, the stored tokens cannot be read.
4. Set `RESEND_API_KEY` and `MAIL_FROM`, so that the sign-in codes go out by email.
5. Start it with `bun run start`, or build the `Dockerfile`.

## Security

Report a security problem in private. Do not open a public issue. See [SECURITY.md](SECURITY.md).

## License

[GNU Affero General Public License v3.0](LICENSE). You can use, change and run Gulpy for
free. If you run a changed copy as a service for other people, you must publish your changes
under the same license.
