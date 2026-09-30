"""
Makes the picture for link previews and the icon for the home screen.

Run:  ~/.local/py/bin/python scripts/make-social.py

Output: src/assets/social.png (1200 x 630) and src/assets/touch-icon.png (180 x 180).
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "src" / "assets"
LOGOS = ["google", "notion", "slack", "github", "linear", "figma", "stripe", "microsoft"]
DISPLAY = 'ui-rounded, "SF Pro Rounded", "Nunito", "Hiragino Maru Gothic ProN", system-ui, sans-serif'


def data(path: Path, kind: str) -> str:
    return f"data:{kind};base64,{base64.b64encode(path.read_bytes()).decode()}"


def social() -> str:
    mascot = data(ASSETS / "icon.svg", "image/svg+xml")
    kinds = json.loads((ASSETS / "logos" / "manifest.json").read_text())
    tiles = "".join(
        f'<span class="tile {kinds[name]["kind"]}"><img src="{data(ASSETS / "logos" / f"{name}.png", "image/png")}"></span>'
        for name in LOGOS
    )
    return f"""
<html><body>
<style>
  * {{ box-sizing: border-box; margin: 0; }}
  body {{ width: 1200px; height: 630px; background: #FAF9F5; color: #101112; font-family: {DISPLAY};
         display: grid; grid-template-columns: 1fr 380px; align-items: center; padding: 0 84px; }}
  .name {{ display: flex; align-items: center; gap: 16px; font-size: 40px; font-weight: 800; letter-spacing: -0.02em; }}
  .name img {{ width: 56px; height: 56px; }}
  h1 {{ margin-top: 34px; font-size: 84px; line-height: 1.02; font-weight: 800; letter-spacing: -0.04em; }}
  .tiles {{ margin-top: 44px; display: flex; gap: 14px; }}
  .tile {{ width: 64px; height: 64px; border-radius: 19px; overflow: hidden; background: #fff;
          box-shadow: inset 0 0 0 1px rgba(16,17,18,.1), 0 6px 18px rgba(16,17,18,.08); display: grid; place-items: center; }}
  .tile img {{ width: 100%; height: 100%; object-fit: cover; }}
  .tile.mark img {{ width: 66%; height: 66%; object-fit: contain; }}
  .art {{ justify-self: end; width: 360px; height: 360px; border-radius: 50%; display: grid; place-items: center;
         background: radial-gradient(circle, rgba(201,247,58,.38), rgba(201,247,58,0) 68%); }}
  .art img {{ width: 250px; height: 250px; }}
  .address {{ position: absolute; left: 84px; bottom: 52px; font: 600 26px ui-monospace, Menlo, monospace; color: #5b6470; }}
</style>
<div>
  <div class="name"><img src="{mascot}">Gulpy</div>
  <h1>One login for all your AI plugins.</h1>
  <div class="tiles">{tiles}</div>
</div>
<div class="art"><img src="{mascot}"></div>
<div class="address">gulpy.ai</div>
</body></html>"""


def touch_icon() -> str:
    mascot = data(ASSETS / "icon.svg", "image/svg+xml")
    return f"""
<html><body style="margin:0;width:180px;height:180px;background:#101112;display:grid;place-items:center">
<img src="{mascot}" style="width:124px;height:124px"></body></html>"""


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page(viewport={"width": 1200, "height": 630})
        page.set_content(social())
        page.wait_for_timeout(200)
        page.screenshot(path=str(ASSETS / "social.png"))
        page.set_viewport_size({"width": 180, "height": 180})
        page.set_content(touch_icon())
        page.wait_for_timeout(100)
        page.screenshot(path=str(ASSETS / "touch-icon.png"))
        browser.close()
    for name in ("social.png", "touch-icon.png"):
        print(name, (ASSETS / name).stat().st_size, "bytes")


if __name__ == "__main__":
    main()
