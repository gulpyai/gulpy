/** The logos of the companies, and the rule for the logo of an agent. */
import { describe, expect, test } from "bun:test";
import { agentLogo, logoImage } from "../src/logos.ts";
import { createWorld, GULPY } from "./harness.ts";

describe("logos", () => {
  test("each built-in connector has the logo image of its company", async () => {
    const world = await createWorld();
    const custom = new Set(world.gulpy.deps.config.customConnectors.map((connector) => connector.id));
    const missing = world.gulpy.deps.catalog
      .all()
      .filter((connector) => !custom.has(connector.id))
      .filter((connector) => !connector.image)
      .map((connector) => connector.id);
    expect(missing).toEqual([]);
  });

  test("the site supplies a logo as a PNG image that the browser can keep", async () => {
    const world = await createWorld();
    const image = logoImage("github");
    expect(image?.src).toStartWith("/assets/logos/github.png?v=");
    const response = await world.gulpy.app.request(`${GULPY}${image!.src}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("immutable");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test("an agent gets the logo of a company only if each return address is on the site of the company", () => {
    expect(agentLogo(["https://claude.ai/api/mcp/auth_callback"])?.src).toContain("/assets/logos/claude.png");
    expect(agentLogo(["https://chatgpt.com/connector_platform_oauth_redirect"])?.src).toContain("/assets/logos/chatgpt.png");
    expect(agentLogo(["cursor://anysphere.cursor-retrieval/oauth/callback"])?.src).toContain("/assets/logos/cursor.png");
  });

  test("an agent with the name of a company, but a different return address, gets no logo", () => {
    expect(agentLogo(["https://claude.ai.attacker.example/callback"])).toBeUndefined();
    expect(agentLogo(["https://attacker.example/claude.ai"])).toBeUndefined();
    expect(agentLogo(["https://claude.ai/callback", "https://attacker.example/callback"])).toBeUndefined();
    expect(agentLogo(["http://claude.ai/callback"])).toBeUndefined();
    expect(agentLogo(["http://localhost:4500/callback"])).toBeUndefined();
    expect(agentLogo(["not an address"])).toBeUndefined();
    expect(agentLogo([])).toBeUndefined();
  });
});

describe("the first page on a real address", () => {
  test("has the tags for search engines and link previews, and the pages of a user do not", async () => {
    const world = await createWorld();
    const first = await (await world.gulpy.app.request(`${GULPY}/`)).text();
    expect(first).toContain(`<link rel="canonical" href="${GULPY}/"`);
    expect(first).toContain(`<meta property="og:image" content="${GULPY}/assets/social.png"`);
    expect(first).not.toContain('content="noindex"');

    const picture = await world.gulpy.app.request(`${GULPY}/assets/social.png`);
    expect(picture.status).toBe(200);
    expect(picture.headers.get("content-type")).toBe("image/png");

    const approval = await (await world.gulpy.app.request(`${GULPY}/oauth/authorize`)).text();
    expect(approval).not.toContain("og:image");
  });
});
