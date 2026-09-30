/**
 * What an agent reads to connect to Gulpy and to use the tools: /agents.md.
 * /connect.sh does the sign-in in one command on macOS and Linux.
 */
import { BRAND } from "./brand.ts";

export function agentGuide(base: string): string {
  const name = BRAND.name;
  return `# ${name} for agents

${name} is a vault for the accounts of one person: email, calendar, files, Notion,
Linear, GitHub and others. After one sign-in you get a key. With the key you call
all the tools of the person with plain HTTP and JSON. ${name} signs in to each
tool for you. You never see a password or a provider token.

## 1. Connect (one time)

Do this when the user says "connect to ${name}".

On macOS or Linux, run:

\`\`\`sh
curl -fsSL ${base}/connect.sh | sh -s -- "<your name, for example Claude Code>"
\`\`\`

The script opens the browser. The user signs in and taps **Allow**. The script
saves the key in \`~/.config/gulpy/key\` (mode 600). Tell the user to look at the
browser, and show them the code that the script prints.

Without the script (RFC 8628, device authorization grant):

1. Ask for a code:

   \`\`\`sh
   curl -sS -X POST ${base}/device/code -d "client_name=Claude Code"
   \`\`\`

   The answer has \`device_code\`, \`user_code\`, \`verification_uri_complete\` and \`interval\`.
2. Open \`verification_uri_complete\` in the browser of the user (\`open\` on macOS,
   \`xdg-open\` on Linux). If you cannot open it, show the address to the user.
3. Every \`interval\` seconds, ask for the key:

   \`\`\`sh
   curl -sS -X POST ${base}/device/token -d "device_code=<device_code>"
   \`\`\`

   \`authorization_pending\`: ask again later. \`slow_down\`: wait 5 more seconds.
   \`access_denied\` or \`expired_token\`: stop and tell the user.
   Success gives \`{ "access_token": "gulpy_..." }\`. That is the key.
4. Save the key where you keep secrets, for example \`~/.config/gulpy/key\` with mode 600.

**A chat agent that cannot wait in the background** (for example an assistant in a
chat window): send the user the \`verification_uri_complete\` link and ask them to
say "done" after they tap Allow. When they say it, call \`/device/token\` one time.
The key waits for you for 1 hour after Allow.

Show the user only the link and the short \`user_code\`. Never show the
\`device_code\` or the key: they are secrets.

## 2. Keep the key secret

The key opens all the tools of the user. Send it only to ${base}. Do not print
it, do not put it in a file that other people read, and do not send it to another
service. The user can stop the key at any time on ${base}.

## 3. List the tools

\`\`\`sh
curl -sS ${base}/v1/tools -H "Authorization: Bearer $(cat ~/.config/gulpy/key)"
\`\`\`

The answer is \`{ "tools": [...] }\`. Each tool has \`name\`, \`description\`,
\`input\` (JSON Schema of the body) and \`read_only\`. The list changes when the
user adds or removes a tool. List the tools again when a name is not known.

## 4. Call a tool

\`\`\`sh
curl -sS -X POST ${base}/v1/tools/email_search \\
  -H "Authorization: Bearer $(cat ~/.config/gulpy/key)" \\
  -H "Content-Type: application/json" \\
  -d '{"query": "invoice", "limit": 5}'
\`\`\`

The answer is \`{ "result": ... }\`. Before a tool that is not \`read_only\` (for
example \`email_send\`), tell the user what you will do.

## 5. Errors

Each error has the shape \`{ "error": { "code", "message" } }\`.

| Code | What to do |
|---|---|
| \`invalid_token\` (401) | The user removed this agent. Connect again (step 1). |
| \`not_granted\` (403) | The user has no tool for this. Ask the user to add it on ${base}. |
| \`connection_needs_reauth\` (409) | The user must connect that account again on ${base}. |
| \`connection_required\` (400) | Two accounts match. Send \`connection_id\` from \`list_connections\`. |

## MCP

An agent that speaks MCP can use \`${base}/mcp\` with the same key, or with the
standard MCP sign-in.
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
CODE=$(field user_code "$START")
URL=$(field verification_uri_complete "$START")
WAIT=$(field interval "$START")
[ -n "$DEVICE" ] || { echo "${BRAND.name} did not give a code." >&2; exit 1; }

echo "Connect \\"$NAME\\" to ${BRAND.name}:"
echo "  1. Open $URL"
echo "  2. Check that the page shows the code $CODE, then tap Allow."
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
    echo "Connected. The key is in $DIR/key. Guide: $BASE/agents.md"
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
