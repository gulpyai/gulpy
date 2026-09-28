/**
 * Starts Gulpy and two agents on this computer:
 *   Gulpy   http://localhost:4000
 *   Orbit   http://localhost:4500   an agent. It knows the Gulpy address only.
 *   Scout   http://localhost:4600   a second agent
 *
 * The tools are the real connectors in the list.
 */
import { createAgent } from "../examples/agent/server.tsx";
import { createApp, createDeps } from "../src/app.ts";
import { startCleanup } from "../src/cleanup.ts";
import { loadConfig } from "../src/config.ts";

// A second copy can run at the same time: set PORT_OFFSET=5000 and GULPY_DB.
const OFFSET = Number(process.env.PORT_OFFSET ?? 0);
const PORTS = { gulpy: 4000 + OFFSET, orbit: 4500 + OFFSET, scout: 4600 + OFFSET };
const url = (port: number) => `http://localhost:${port}`;

const config = loadConfig({ port: PORTS.gulpy, baseUrl: url(PORTS.gulpy) });
const { app: gulpy, deps } = await createApp(createDeps({ config }));

const mcpUrl = `${config.baseUrl}/mcp`;
const orbit = createAgent({
  name: "Orbit",
  tagline: "What can I do for you?",
  colors: ["#6d28d9", "#ede9fe"],
  baseUrl: url(PORTS.orbit),
  mcpUrl,
  ideas: ["What can you do with my tools?", "What is open for me today?", "Give me a summary of my last work"],
});
const scout = createAgent({
  name: "Scout",
  tagline: "Where do we start?",
  colors: ["#0f766e", "#ccfbf1"],
  baseUrl: url(PORTS.scout),
  mcpUrl,
  ideas: ["Which tools do I have?", "What changed this week?", "Find what I worked on last"],
});

startCleanup(deps);
Bun.serve({ port: PORTS.gulpy, fetch: gulpy.fetch });
Bun.serve({ port: PORTS.orbit, fetch: orbit.fetch });
Bun.serve({ port: PORTS.scout, fetch: scout.fetch });

const ready = deps.catalog.all().filter((connector) => deps.catalog.availability(connector) === "ready").length;
console.log(`
Gulpy

  1. Open Gulpy   ${url(PORTS.gulpy)}   Sign in. Add your tools.
  2. Open Orbit   ${url(PORTS.orbit)}   Select "Connect with Gulpy". A window opens. Select Allow.
  3. Open Scout   ${url(PORTS.scout)}   A second agent. One tap.

  The address that an agent needs: ${mcpUrl}
  Tools in the list: ${deps.catalog.all().length}. Ready now: ${ready}.
`);
