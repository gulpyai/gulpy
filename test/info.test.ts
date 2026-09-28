/** The public pages for help, security and the rules. */
import { describe, expect, test } from "bun:test";
import { CSP } from "../src/routes/pages.tsx";
import { createWorld, GULPY } from "./harness.ts";

const PAGES = ["/support", "/security", "/privacy", "/terms"];

describe("help and rules", () => {
  test("each page opens with no sign-in, with the security headers", async () => {
    const world = await createWorld();
    for (const path of PAGES) {
      const response = await world.gulpy.app.request(`${GULPY}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toBe(CSP);
      const html = await response.text();
      expect(html).toContain(`<link rel="canonical" href="${GULPY}${path}"`);
      expect(html).not.toContain('content="noindex"');
    }
  });

  test("the foot of each site page gives the official addresses", async () => {
    const world = await createWorld();
    const first = await (await world.gulpy.app.request(`${GULPY}/`)).text();
    for (const link of ['href="/support"', 'href="/security"', 'href="/privacy"', 'href="/terms"', "mailto:support@gulpy.ai"]) {
      expect(first).toContain(link);
    }
  });

  test("the support page gives the address for agents", async () => {
    const world = await createWorld();
    const html = await (await world.gulpy.app.request(`${GULPY}/support`)).text();
    expect(html).toContain(`${GULPY}/mcp`);
    expect(html).toContain("support@gulpy.ai");
  });

  test("security.txt names the contact, the policy and a date in the future", async () => {
    const world = await createWorld();
    const response = await world.gulpy.app.request(`${GULPY}/.well-known/security.txt`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const text = await response.text();
    expect(text).toContain("Contact: mailto:security@gulpy.ai");
    expect(text).toContain(`Policy: ${GULPY}/security`);
    const expires = Date.parse(/Expires: (\S+)/.exec(text)![1]!);
    expect(expires).toBeGreaterThan(Date.now());
  });

  test("robots.txt and the sitemap name the public pages, and keep the approval pages out", async () => {
    const world = await createWorld();
    const robots = await (await world.gulpy.app.request(`${GULPY}/robots.txt`)).text();
    expect(robots).toContain("Disallow: /oauth/");
    expect(robots).toContain(`Sitemap: ${GULPY}/sitemap.xml`);
    const sitemap = await (await world.gulpy.app.request(`${GULPY}/sitemap.xml`)).text();
    for (const path of PAGES) expect(sitemap).toContain(`<loc>${GULPY}${path}</loc>`);
  });
});
