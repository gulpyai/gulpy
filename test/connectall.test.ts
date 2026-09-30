/** The page /connect-all: what the extension Gulpy for Chrome gets to connect. */
import { beforeEach, expect, test } from "bun:test";
import { addConnector, GULPY, createWorld, type Browser, type World } from "./harness.ts";

let world: World;
let browser: Browser;

beforeEach(async () => {
  world = await createWorld();
  browser = world.browser();
});

test("asks to sign in first, then lists the apps to connect, each returning to /connect-all/done", async () => {
  const signedOut = await browser.open(`${GULPY}/connect-all`);
  expect(signedOut.html).toContain('name="next" value="/connect-all"');

  await browser.signIn(world, "skyler@example.com", "/connect-all");
  await addConnector(browser, "acme-notes");
  const page = await browser.open(`${GULPY}/connect-all`);
  expect(page.html).toContain("Connect everything");
  // An app that is already connected is not in the list again.
  expect(page.html).not.toContain('data-item="acme-notes"');
  expect(page.html).toContain('data-item="acme-tasks"');
  expect(page.html).toContain(`data-url="/connect/acme-tasks?next=%2Fconnect-all%2Fdone"`);
  expect(page.html).toContain('src="/assets/connect-all.js"');

  const done = await browser.open(`${GULPY}/connect-all/done?connected=conn_1`);
  expect(done.html).toContain("You can close this tab.");
});
