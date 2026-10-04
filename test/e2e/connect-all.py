"""Browser half of test/e2e/connect-all.ts: Chromium with the real extension loaded."""
import sys, tempfile, time
from playwright.sync_api import sync_playwright

gulpy, extension = sys.argv[1], sys.argv[2]
with sync_playwright() as p, tempfile.TemporaryDirectory() as profile:
    ctx = p.chromium.launch_persistent_context(
        profile,
        channel="chromium",
        headless=True,
        args=[f"--disable-extensions-except={extension}", f"--load-extension={extension}"],
    )
    page = ctx.new_page()
    page.goto(f"{gulpy}/connect-all")
    page.locator("form[action='/auth/start'] input[name=email]").first.fill("e2e@example.com")
    page.keyboard.press("Enter")
    page.wait_for_load_state("networkidle")
    page.locator("form[action='/auth/verify'] button[type=submit]").first.click()
    page.wait_for_url(f"{gulpy}/connect-all")
    page.wait_for_selector("[data-connect-all]:not([disabled])", timeout=10_000)
    print("extension:", page.locator("[data-ext-status]").inner_text(), flush=True)
    page.locator("[data-connect-all]").click()
    deadline = time.time() + 120
    while time.time() < deadline and page.locator("[data-connect-all]").inner_text() != "Done":
        time.sleep(1)
    for row in page.locator("[data-item]").all():
        print(" ", row.get_attribute("data-item"), "->", row.get_attribute("data-state"), flush=True)
    print("summary:", page.locator("[data-summary]").inner_text(), flush=True)
    print("open tabs left:", len(ctx.pages), flush=True)
    page.set_viewport_size({"width": 1280, "height": 700}); page.screenshot(path=f"{tempfile.gettempdir()}/gulpy-connect-all.png")
    ctx.close()
