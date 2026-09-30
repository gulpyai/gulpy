/**
 * What an agent reads to connect to Gulpy and to use the tools: /agents.md.
 * /connect.sh does the sign-in in one command on macOS and Linux.
 */
import { BRAND } from "./brand.ts";

export function agentGuide(base: string): string {
  const name = BRAND.name;
  return `# ${name} for agents

${name} is a vault for the accounts of one person: email, calendar, files, Notion,
Linear, Stripe and others. After one tap you get a key, and with it you use all
their tools. ${name} signs in to each tool for you. You never see a password.

## Do this when the user says "connect to ${name}"

Work silently. Do not ask the user to choose anything. They only tap **Allow** in
the browser (and sign in the first time). Pick the first case that fits you.

### A. You can run shell commands (Claude Code, Codex, Cursor, OpenClaw, a terminal agent)

Run, with your own name:

\`\`\`sh
curl -fsSL ${base}/connect.sh | sh -s -- "Claude Code"
\`\`\`

It opens the browser, waits for Allow, saves the key in \`~/.config/gulpy/key\`,
tests the tools and prints one line, for example \`Connected: 58 tools.\`
In Claude Code it also adds ${name} as an MCP server, so the tools are built in from
the next session. Until then, and in every other agent, use the HTTP calls below.

### B. You can send web requests but not run commands (for example Meta Muse, Instinct)

1. \`POST ${base}/device/code\` with the form field \`client_name=<your name>\`.
   The answer has \`device_code\`, \`verification_uri_complete\` and \`interval\`.
2. Send the user the \`verification_uri_complete\` link: "Tap Allow here, then say done."
3. When they say done (or every \`interval\` seconds), \`POST ${base}/device/token\` with
   \`device_code=<device_code>\`. \`authorization_pending\`: ask again later.
   \`slow_down\`: wait 5 more seconds. Success: \`{ "access_token": "gulpy_..." }\`.
   The key waits 1 hour after Allow.
4. Keep the key in your memory for later conversations.

### C. You cannot run commands or send web requests (the ChatGPT app, the Claude app, Grok, Gemini)

Tell the user these steps. They take one minute and need no key:

- **Claude:** Settings, Connectors, "Add custom connector", paste \`${base}/mcp\`, then Connect.
- **ChatGPT:** Settings, Apps and connectors, Advanced, turn on Developer mode, then Create, paste \`${base}/mcp\`.
- **Grok:** grok.com/connectors, New Connector, Custom, paste \`${base}/mcp\`.

A window opens. The user taps Allow. The tools are then built in.

### Then, in every case

Call the tool list (below). Tell the user one line: "Connected to ${name}: <number> tools,
for example Gmail, Calendar, Notion." If the list is empty, say: "Your ${name} account has
no tools yet. Add them at ${base}."

## Keep the key secret

The key opens all the tools of the user. Send it only to ${base}. Never show the key
or the \`device_code\` to the user, never put them in a shared file, and never send
them to another service. The user can stop the key at any time on ${base}.

## Use the tools with HTTP

List them:

\`\`\`sh
curl -sS ${base}/v1/tools -H "Authorization: Bearer $(cat ~/.config/gulpy/key)"
\`\`\`

The answer is \`{ "tools": [...] }\`. Each tool has \`name\`, \`description\`, \`input\`
(JSON Schema of the body) and \`read_only\`. List them again when a name is not known.

Call one:

\`\`\`sh
curl -sS -X POST ${base}/v1/tools/email_search \\
  -H "Authorization: Bearer $(cat ~/.config/gulpy/key)" \\
  -H "Content-Type: application/json" \\
  -d '{"query": "invoice", "limit": 5}'
\`\`\`

The answer is \`{ "result": ... }\`. Before a tool that is not \`read_only\` (for example
\`email_send\`), tell the user what you will do.

## Use the tools with MCP

The address is \`${base}/mcp\` (Streamable HTTP). Send the same key as
\`Authorization: Bearer <key>\`, or let the client sign in with OAuth.

## Errors

Each error has the shape \`{ "error": { "code", "message" } }\`.

| Code | What to do |
|---|---|
| \`invalid_token\` (401) | The user removed this agent. Connect again. |
| \`not_granted\` (403) | The user has no tool for this. Ask them to add it at ${base}. |
| \`connection_needs_reauth\` (409) | The user must connect that account again at ${base}. |
| \`connection_required\` (400) | Two accounts match. Send \`connection_id\` from \`list_connections\`. |
`;
}

export function connectScript(base: string): string {
  return `#!/bin/sh
# Connects an agent on this computer to ${BRAND.name}.
#   curl -fsSL ${base}/connect.sh | sh -s -- "Claude Code"
# It opens the browser. You sign in and tap Allow. The key goes to ~/.config/gulpy/key.
set -eu

BASE="${base}"
NAME="\${1:-\${GULPY_AGENT_NAME:-Agent on $(hostname)}}"
DIR="\${XDG_CONFIG_HOME:-$HOME/.config}/gulpy"

field() { printf '%s' "$2" | sed -n "s/.*\\"$1\\":\\"\\{0,1\\}\\([^\\",}]*\\).*/\\1/p"; }

START=$(curl -fsS -X POST "$BASE/device/code" --data-urlencode "client_name=$NAME")
DEVICE=$(field device_code "$START")
URL=$(field verification_uri_complete "$START")
WAIT=$(field interval "$START")
[ -n "$DEVICE" ] || { echo "${BRAND.name} did not answer." >&2; exit 1; }

echo "Connect \\"$NAME\\" to ${BRAND.name}: tap Allow in the browser."
echo "If no browser opens, open: $URL"
if command -v open >/dev/null 2>&1; then open "$URL" >/dev/null 2>&1 || true
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true
fi

while :; do
  sleep "\${WAIT:-5}"
  REPLY=$(curl -sS -X POST "$BASE/device/token" --data-urlencode "device_code=$DEVICE")
  KEY=$(field access_token "$REPLY")
  if [ -n "$KEY" ]; then
    mkdir -p "$DIR"
    umask 077
    printf '%s\\n' "$KEY" > "$DIR/key"
    printf '%s\\n' "$BASE" > "$DIR/url"
    # In Claude Code, also add ${BRAND.name} as an MCP server: built-in tools from the next session.
    MCP=""
    if [ -n "\${CLAUDECODE:-}" ] && command -v claude >/dev/null 2>&1; then
      claude mcp remove gulpy -s user >/dev/null 2>&1 || true
      if claude mcp add --scope user --transport http gulpy "$BASE/mcp" -H "Authorization: Bearer $KEY" >/dev/null 2>&1; then
        MCP=" ${BRAND.name} is also an MCP server in Claude Code from the next session."
      fi
    fi
    TOOLS=$(curl -sS "$BASE/v1/tools" -H "Authorization: Bearer $KEY" | grep -o '"read_only":' | wc -l | tr -d ' ')
    echo "Connected: $TOOLS tools. The key is in $DIR/key.$MCP"
    if [ "$TOOLS" -le 1 ]; then echo "Your ${BRAND.name} account has no tools yet. Add them at $BASE."; fi
    exit 0
  fi
  case "$(field error "$REPLY")" in
    authorization_pending) ;;
    slow_down) WAIT=$(( \${WAIT:-5} + 5 )) ;;
    *) echo "Not connected: $(field error_description "$REPLY")" >&2; exit 1 ;;
  esac
done
`;
}
