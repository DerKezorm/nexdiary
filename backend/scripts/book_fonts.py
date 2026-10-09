"""Makes the fonts of the book (``app/assets/fonts``) from the ones the interface ships.

The interface has Fraunces and Lora as variable web fonts (Fontsource, in ``frontend/node_modules``). The PDF needs
static TrueType files: this script fixes the weight of each, joins the Latin and the Latin Extended part into one file,
and writes them next to the licence. Lora carries the Reserved Font Name "Lora", so its fixed cuts are named
"Diary Serif" here, as the SIL Open Font License asks of a modified version. Fraunces has no reserved name and keeps
its own.

Only needed when the fonts change; not part of the app. Needs ``fonttools`` and ``brotli``:

    pip install fonttools brotli
    python scripts/book_fonts.py
"""

from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

from fontTools.merge import Merger
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

BACKEND = Path(__file__).resolve().parent.parent
SOURCE = BACKEND.parent / "frontend" / "node_modules" / "@fontsource-variable"
TARGET = BACKEND / "app" / "assets" / "fonts"

#: file name -> (package, style, weight, family name, style name)
CUTS = {
    "Fraunces-SemiBold.ttf": ("fraunces", "normal", 600, "Fraunces", "SemiBold"),
    "DiarySerif-Regular.ttf": ("lora", "normal", 400, "Diary Serif", "Regular"),
    "DiarySerif-Bold.ttf": ("lora", "normal", 700, "Diary Serif", "Bold"),
    "DiarySerif-Italic.ttf": ("lora", "italic", 400, "Diary Serif", "Italic"),
    "DiarySerif-BoldItalic.ttf": ("lora", "italic", 700, "Diary Serif", "Bold Italic"),
}
PARTS = ("latin", "latin-ext")


def fixed(path: Path, weight: int, out: Path) -> None:
    font = TTFont(path)
    axes = {axis.axisTag: axis.defaultValue for axis in font["fvar"].axes}
    axes["wght"] = weight
    instantiateVariableFont(font, axes, inplace=True)
    font.flavor = None
    font.save(out)


def rename(font: TTFont, family: str, style: str) -> None:
    names = font["name"]
    full = f"{family} {style}"
    postscript = f"{family.replace(' ', '')}-{style.replace(' ', '')}"
    for record in list(names.names):
        if record.nameID in (16, 17, 21, 22, 25):
            names.removeNames(nameID=record.nameID)
    subfamily = style if style in ("Regular", "Bold", "Italic", "Bold Italic") else "Regular"
    for name_id, value in ((1, family), (2, subfamily), (3, f"nexdiary:{postscript}"), (4, full), (6, postscript)):
        names.setName(value, name_id, 3, 1, 0x409)
        names.setName(value, name_id, 1, 0, 0)


def main() -> int:
    if not SOURCE.is_dir():
        print("Install the frontend first (npm ci in frontend/).", file=sys.stderr)
        return 1
    TARGET.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as scratch:
        work = Path(scratch)
        for name, (package, style, weight, family, style_name) in CUTS.items():
            parts = []
            for part in PARTS:
                woff = SOURCE / package / "files" / f"{package}-{part}-wght-{style}.woff2"
                out = work / f"{name}.{part}.ttf"
                fixed(woff, weight, out)
                parts.append(str(out))
            merged = Merger().merge(parts)
            rename(merged, family, style_name)
            merged.save(TARGET / name)
            print(name, (TARGET / name).stat().st_size)
    for package, licence in (("fraunces", "Fraunces-OFL.txt"), ("lora", "Lora-OFL.txt")):
        shutil.copyfile(SOURCE / package / "LICENSE", TARGET / licence)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
