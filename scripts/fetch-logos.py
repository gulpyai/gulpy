"""
Gets the logo of each company from the site of the company.

Run:  ~/.local/py/bin/python scripts/fetch-logos.py [id ...]

For each company the script collects the icons that the site publishes
(apple-touch-icon, icon links, the web app manifest) and keeps the largest
square one. The result is a 160 x 160 PNG in src/assets/logos/, and one
line in src/assets/logos/manifest.json with the source address.

An image smaller than 96 pixels is not kept. The page then draws the mark
of the company as a vector, from the `simple-icons` package.

`PINNED` sets the address of the image when the site publishes only a small
icon, or when the site icon is not the logo of the product.

Each image gets a kind:
  fill  a filled square or an app icon. It covers the tile.
  mark  a mark on a clear or white ground. The tile shows it with a margin.
"""

from __future__ import annotations

import base64
import io
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "assets" / "logos"
SIZE = 160
SMALLEST = 96
AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)

# id -> site. The ids of connectors are the ids in src/catalog.ts.
SITES: dict[str, str] = {
    # Connectors
    "gmail": "https://mail.google.com",
    "google-calendar": "https://calendar.google.com",
    "outlook-email": "https://outlook.live.com",
    "outlook-calendar": "https://outlook.live.com",
    "notion": "https://www.notion.com",
    "linear": "https://linear.app",
    "atlassian": "https://www.atlassian.com",
    "asana": "https://asana.com",
    "monday": "https://monday.com",
    "clickup": "https://clickup.com",
    "airtable": "https://www.airtable.com",
    "slack": "https://slack.com",
    "granola": "https://www.granola.ai",
    "box": "https://www.box.com",
    "github": "https://github.com",
    "vercel": "https://vercel.com",
    "supabase": "https://supabase.com",
    "sentry": "https://sentry.io",
    "railway": "https://railway.com",
    "render": "https://render.com",
    "neon": "https://neon.com",
    "prisma": "https://www.prisma.io",
    "sanity": "https://www.sanity.io",
    "hubspot": "https://www.hubspot.com",
    "intercom": "https://www.intercom.com",
    "attio": "https://attio.com",
    "canva": "https://www.canva.com",
    "figma": "https://www.figma.com",
    "miro": "https://miro.com",
    "webflow": "https://webflow.com",
    "wix": "https://www.wix.com",
    "higgsfield": "https://higgsfield.ai",
    "stripe": "https://stripe.com",
    "paypal": "https://www.paypal.com",
    "square": "https://squareup.com",
    "posthog": "https://posthog.com",
    # Agents
    "claude": "https://claude.ai",
    "chatgpt": "https://chatgpt.com",
    "grok": "https://grok.com",
    "cursor": "https://cursor.com",
    "poke": "https://poke.com",
    "google": "https://www.google.com",
    "teams": "https://teams.microsoft.com",
    "zoom": "https://zoom.us",
    "instinct": "https://instinct.com",
    "manus": "https://manus.im",
    "perplexity": "https://www.perplexity.ai",
    "gemini": "https://gemini.google.com",
    "mistral": "https://chat.mistral.ai",
}

# Image addresses that the script tries first, in this order.
PINNED: dict[str, list[str]] = {
    "gmail": [
        "https://www.gstatic.com/images/branding/productlogos/gmail_2026/v1/web-96dp/logo_gmail_2026_color_2x_web_96dp.png",
    ],
    "google-calendar": [
        "https://www.gstatic.com/images/branding/productlogos/calendar_2026/v1/web-96dp/logo_calendar_2026_color_2x_web_96dp.png",
    ],
    "asana": [
        "https://brand.asana.biz/image/upload/f_auto:image,fl_preserve_transparency/v1696462483/asana_favicon_180x180.png",
    ],
    "airtable": ["https://www.airtable.com/images/favicon/baymax/apple-touch-icon.png"],
    "slack": [
        "https://a.slack-edge.com/80588/marketing/img/icons/icon_slack_hash_colored.png",
        "https://a.slack-edge.com/80588/marketing/img/meta/slack_hash_256.png",
    ],
    "clickup": ["https://clickup.com/favicons/apple-touch-icon.png"],
    "render": ["https://render.com/icon.svg"],
    "grok": ["https://grok.com/images/apple-touch-icon.png"],
    # These sites publish a small icon only. The account picture on GitHub is from the company.
    "attio": ["https://github.com/attio.png?size=256"],
    "sentry": ["https://github.com/getsentry.png?size=256"],
    "intercom": ["https://github.com/intercom.png?size=256"],
    "square": ["https://github.com/square.png?size=256"],
}

_playwright = None
_browser = None


def render_svg(body: bytes) -> bytes | None:
    """Draws an SVG with Chromium, on a clear ground."""
    global _playwright, _browser
    try:
        if _browser is None:
            from playwright.sync_api import sync_playwright

            _playwright = sync_playwright().start()
            _browser = _playwright.chromium.launch()
        page = _browser.new_page(viewport={"width": 512, "height": 512})
        data = base64.b64encode(body).decode()
        page.set_content(
            '<html><body style="margin:0;background:transparent">'
            f'<img src="data:image/svg+xml;base64,{data}" style="display:block;width:512px;height:512px">'
            "</body></html>"
        )
        page.wait_for_timeout(150)
        image = page.screenshot(omit_background=True, clip={"x": 0, "y": 0, "width": 512, "height": 512})
        page.close()
        return image
    except Exception:
        return None


def stop_browser() -> None:
    if _browser is not None:
        _browser.close()
    if _playwright is not None:
        _playwright.stop()


def get(url: str, limit: int = 3_000_000) -> tuple[bytes, str, str]:
    request = urllib.request.Request(url, headers={"User-Agent": AGENT, "Accept": "image/png,image/svg+xml,text/html;q=0.9,*/*;q=0.8"})
    with urllib.request.urlopen(request, timeout=20) as response:
        return response.read(limit), response.headers.get("Content-Type", ""), response.geturl()


def links_of(site: str) -> list[str]:
    """The icon addresses that the home page and its manifest name."""
    found: list[str] = []
    try:
        body, _, final = get(site, 1_500_000)
    except Exception:
        return found
    html = body.decode("utf-8", "replace")
    for tag in re.findall(r"<link\b[^>]*>", html, flags=re.I):
        rel = re.search(r'rel=["\']?([^"\'>]+)', tag, flags=re.I)
        href = re.search(r'href=["\']?([^"\'\s>]+)', tag, flags=re.I)
        if not rel or not href:
            continue
        kind = rel.group(1).lower()
        address = urllib.parse.urljoin(final, href.group(1).replace("&amp;", "&"))
        if "apple-touch-icon" in kind or "icon" in kind.split():
            found.append(address)
        elif kind.strip() == "manifest":
            try:
                data = json.loads(get(address, 300_000)[0].decode("utf-8", "replace"))
                for icon in data.get("icons", []):
                    if icon.get("src"):
                        found.append(urllib.parse.urljoin(address, icon["src"]))
            except Exception:
                pass
    return found


def candidates(company: str, site: str) -> list[str]:
    host = urllib.parse.urlparse(site).netloc
    return [
        *PINNED.get(company, []),
        *links_of(site),
        f"{site}/apple-touch-icon.png",
        f"{site}/apple-touch-icon-precomposed.png",
        f"https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://{host}&size=256",
        f"{site}/favicon.ico",
    ]


def is_svg(url: str) -> bool:
    return url.split("?")[0].endswith(".svg")


def load(url: str) -> Image.Image | None:
    if "pinned-tab" in url or "mask-icon" in url:
        # A one-color shape for the browser. It is not the logo.
        return None
    try:
        body, kind, _ = get(url)
    except Exception:
        return None
    if "svg" in kind or is_svg(url) or body.lstrip()[:5] in (b"<?xml", b"<svg "):
        drawn = render_svg(body)
        if drawn is None:
            return None
        body = drawn
    try:
        image = Image.open(io.BytesIO(body))
        if image.format == "ICO":
            image.size = max(image.info.get("sizes", {image.size}))
        image = image.convert("RGBA")
        image.load()
        return image
    except Exception:
        return None


def squared(image: Image.Image, ground: tuple[int, int, int, int]) -> Image.Image:
    side = max(image.size)
    square = Image.new("RGBA", (side, side), ground)
    square.paste(image, ((side - image.width) // 2, (side - image.height) // 2))
    return square


def trim_clear(image: Image.Image) -> Image.Image:
    """Removes the clear border."""
    box = image.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
    return squared(image.crop(box), (0, 0, 0, 0)) if box else image


def trim_white(image: Image.Image) -> Image.Image:
    """Removes the white border of an image that has a white ground."""
    flat = Image.new("RGBA", image.size, (255, 255, 255, 255))
    flat.alpha_composite(image)
    ink = flat.convert("L").point(lambda v: 255 if v < 240 else 0)
    box = ink.getbbox()
    return squared(flat.crop(box), (255, 255, 255, 255)) if box else flat


def solid(image: Image.Image, points: list[tuple[int, int]]) -> list[tuple[int, int, int, int]]:
    return [pixel for pixel in (image.getpixel(point) for point in points) if pixel[3] > 200]


def prepare(image: Image.Image) -> tuple[Image.Image, str]:
    image = trim_clear(image)
    width, height = image.size
    corners = solid(image, [(1, 1), (width - 2, 1), (1, height - 2), (width - 2, height - 2)])
    if len(corners) >= 3:
        if all(min(pixel[:3]) >= 244 for pixel in corners):
            image = trim_white(image)
            width, height = image.size
            middles = [(width // 2, 1), (width // 2, height - 2), (1, height // 2), (width - 2, height // 2)]
            colored = sum(1 for point in middles if min(image.getpixel(point)[:3]) < 235)
            # An app icon with round corners on a white ground covers the tile.
            return image, "fill" if colored >= 3 else "mark"
        return image, "fill"
    edges = solid(image, [(width // 2, 1), (width // 2, height - 2), (1, height // 2), (width - 2, height // 2)])
    # An app icon with round corners has solid edges and clear corners.
    return image, "fill" if len(edges) >= 3 else "mark"


def fetch(company: str, site: str) -> dict | None:
    pinned = PINNED.get(company, [])
    best: tuple[int, Image.Image, str] | None = None
    for url in dict.fromkeys(candidates(company, site)):
        image = load(url)
        if image is None:
            continue
        width, height = image.size
        if min(width, height) < SMALLEST or abs(width - height) > max(width, height) * 0.1:
            continue
        if url in pinned:
            best = (0, image, url)
            break
        # The icon of the app is better than the small icon of the browser tab.
        score = 190 if is_svg(url) else min(width, height, 512)
        if best is None or score > best[0]:
            best = (score, image, url)
    if best is None:
        return None
    _, image, url = best
    image, kind = prepare(image)
    image = image.resize((SIZE, SIZE), Image.LANCZOS)
    image.save(OUT / f"{company}.png", optimize=True)
    return {"file": f"{company}.png", "kind": kind, "source": url}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / "manifest.json"
    manifest: dict[str, dict] = json.loads(path.read_text()) if path.exists() else {}
    wanted = sys.argv[1:] or list(SITES)
    for company in wanted:
        entry = fetch(company, SITES[company])
        if entry is None:
            manifest.pop(company, None)
            (OUT / f"{company}.png").unlink(missing_ok=True)
            print(f"{company}: no image of {SMALLEST} pixels or more. The page draws the vector mark.")
            continue
        manifest[company] = entry
        print(f"{company}: {entry['kind']}  {entry['source']}")
    stop_browser()
    path.write_text(json.dumps(dict(sorted(manifest.items())), indent=2) + "\n")


if __name__ == "__main__":
    main()
