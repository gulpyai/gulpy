/**
 * What an agent reads to use Gulpy. The user pastes the prompt into any agent.
 * The prompt points to the guide at /agents.md, which is plain Markdown.
 */
import { BRAND } from "./brand.ts";

/** The text that the user pastes into an agent. It has the key, so the page shows it one time only. */
export function agentPrompt(baseUrl: string, key: string): string {
  return [
    `I use ${BRAND.name} to connect my tools (email, calendar, Notion, GitHub and others). You can use them with plain HTTP.`,
    "",
    "Save these two lines in your memory, so that you can use my tools in later conversations:",
    `- ${BRAND.name} key: ${key}`,
    `- ${BRAND.name} guide: ${baseUrl}/agents.md`,
    "",
    `Now read the guide, then list my tools. Keep the key secret: send it only to ${baseUrl}.`,
  ].join("\n");
}

export function agentGuide(baseUrl: string): string {
  return `# ${BRAND.name} for agents

${BRAND.name} holds the accounts of one person: email, calendar, Notion, Linear,
GitHub and others. You call their tools with plain HTTP and JSON. ${BRAND.name}
signs in to each tool for you. You never see a password or a provider token.

## Auth

Send the key of the user in each request:

\`\`\`
Authorization: Bearer <key>
\`\`\`

The user gets the key on the ${BRAND.name} dashboard. Keep it in your memory.
Send it only to ${baseUrl}.

## 1. List the tools

\`\`\`sh
curl ${baseUrl}/v1/tools -H "Authorization: Bearer $GULPY_KEY"
\`\`\`

The answer is \`{ "tools": [...] }\`. Each tool has:

| Field | Meaning |
|---|---|
| \`name\` | Use it in the address of the call |
| \`description\` | What the tool does, and the account that it uses |
| \`input\` | JSON Schema of the body |
| \`read_only\` | \`true\` if the tool only reads data |

The list changes when the user adds or removes a tool. List the tools again
when a name is not known.

## 2. Call a tool

Send the arguments as a JSON object:

\`\`\`sh
curl -X POST ${baseUrl}/v1/tools/email_search \\
  -H "Authorization: Bearer $GULPY_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"query": "invoice", "limit": 5}'
\`\`\`

The answer is \`{ "result": ... }\`. The result is JSON when the tool gives
JSON, or \`{ "text": "..." }\` when it gives text.

## Errors

An error has this shape:

\`\`\`json
{ "error": { "code": "not_granted", "message": "..." } }
\`\`\`

| Status | Code | What to do |
|---|---|---|
| 401 | \`invalid_token\` | The key is wrong or the user removed it. Ask the user for a new key. |
| 403 | \`not_granted\` | The user has no connection that gives this tool. |
| 409 | \`connection_needs_reauth\` | The user must connect the account again on the dashboard. |
| 400 | \`connection_required\` | Two or more accounts match. Send \`connection_id\`. See \`list_connections\`. |
| 502 | \`tool_error\`, \`provider_error\` | The tool failed. Read the message. |

${BRAND.name} records each call on the dashboard of the user.
`;
}
