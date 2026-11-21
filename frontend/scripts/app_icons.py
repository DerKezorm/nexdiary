"""The icons for the home screen and notifications, rendered once from the light version of the mark.

Same shape as components/Logo.tsx and public/logo.svg; the source of every version is nexapps/icons-vergleich/neu.py.
Rendered headless with Playwright, as the end-to-end checks in e2e/ are:  python frontend/scripts/app_icons.py

The maskable icon is cropped by Android, so the mark sits smaller on a full white square. The Apple touch icon is
full bleed: iOS rounds it itself. The badge is one colour: Android tints everything that is not transparent.
"""

from __future__ import annotations

from pathlib import Path

from playwright.sync_api import sync_playwright

PUBLIC = Path(__file__).resolve().parents[1] / "public"

GRADIENT = """<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="10" y1="10" x2="54" y2="54">
  <stop offset="0" stop-color="#a9c79f"/><stop offset=".5" stop-color="#5a7a52"/><stop offset="1" stop-color="#2f4a2a"/>
</linearGradient></defs>"""
QUILL = (
    "M48 12c-12.5 1.5-21.5 9.5-25 22l-.5 7c6.2-1.5 12.4-5.6 16.5-11.3-2.9-.2-5.6 0-7.8.8 "
    "5.2-3.3 9.3-7.8 12.4-12.8 1.8-2.4 3.5-4.2 4.4-5.7z"
)
MARK = f"""<path d="{QUILL}" fill="#fff" stroke="url(#g)" stroke-width="3.8" stroke-linejoin="round"/>
  <path d="M21.5 43.5 37 27" stroke="url(#g)" stroke-width="3.2" stroke-linecap="round"/>
  <path d="M12.5 52.5c6-2 10 2 16 0s9-3 15-1" fill="none" stroke="#4a8c3c" stroke-width="3.6" stroke-linecap="round"/>
  <circle cx="19.5" cy="46.5" r="3.8" fill="#4a8c3c" stroke="#fff" stroke-width="1.8"/>"""


def tile(s: int) -> str:
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="{s}" height="{s}">{GRADIENT}
  <rect x="2" y="2" width="60" height="60" rx="16" fill="#fff"/>
  <rect x="2.75" y="2.75" width="58.5" height="58.5" rx="15.3" fill="none" stroke="#5a7a52" stroke-opacity=".35"
    stroke-width="1.5"/>
  {MARK}</svg>"""


def full(s: int, m: float) -> str:
    # The mark spans about 10.5 to 50.5 across and 10 to 54.5 down; its middle goes to the middle of the square.
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="{s}" height="{s}">{GRADIENT}
  <rect width="64" height="64" fill="#fff"/>
  <g transform="translate(32 32) scale({m}) translate(-30.5 -32.2)">{MARK}</g></svg>"""


def bleed(s: int) -> str:
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="2 2 60 60" width="{s}" height="{s}">{GRADIENT}
  <rect x="2" y="2" width="60" height="60" fill="#fff"/>{MARK}</svg>"""


def badge(s: int) -> str:
    # White on clear: the quill's outline, its shaft, the line of ink and the drop, a little bolder for the status bar.
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="6 6 52 52" width="{s}" height="{s}">
  <path d="{QUILL}" fill="none" stroke="#fff" stroke-width="4.2" stroke-linejoin="round"/>
  <path d="M21.5 43.5 37 27" stroke="#fff" stroke-width="3.8" stroke-linecap="round"/>
  <path d="M12.5 52.5c6-2 10 2 16 0s9-3 15-1" fill="none" stroke="#fff" stroke-width="4.2" stroke-linecap="round"/>
  <circle cx="19.5" cy="46.5" r="4" fill="#fff"/></svg>"""


PICTURES = [
    ("icon-192.png", tile(192), 192),
    ("icon-512.png", tile(512), 512),
    ("icon-maskable-512.png", full(512, 0.8), 512),
    ("apple-touch-icon.png", bleed(180), 180),
    ("badge-96.png", badge(96), 96),
]

if __name__ == "__main__":
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for name, svg, size in PICTURES:
            page = browser.new_page(viewport={"width": size, "height": size})
            page.set_content(f'<body style="margin:0;background:transparent">{svg}</body>')
            page.locator("svg").screenshot(path=str(PUBLIC / name), omit_background=True)
            page.close()
            print("written:", name)
        browser.close()
