"""The illustrations of the covers, drawn into the book.

The interface draws the 256 illustrations as SVG (``frontend/src/covers/drawings.tsx``). The same drawings lie as SVG
text in ``app/assets/covers.json``, written by a test of the interface (``covers/export.test.tsx``), which also fails
when the two part. Here they are drawn into the PDF as vector graphics: sharp at any size, small, and without a
browser on the server.

Only what the drawings use is understood: ``rect`` (with ``rx`` and a ``rotate`` transform), ``circle``,
``ellipse``, ``path`` (every command, arcs included), groups with a clip path, a vertical linear gradient, fill,
stroke, its width, caps and joins, and opacity.
"""

from __future__ import annotations

import json
import math
import re
import threading
from collections.abc import Iterator
from functools import cache
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

from reportlab.lib.colors import HexColor

from . import covers

ART = Path(__file__).resolve().parent.parent / "assets" / "covers.json"
#: The box every illustration is drawn in.
WIDTH = 160.0
HEIGHT = 110.0
_SVG = "{http://www.w3.org/2000/svg}"
_NUMBER = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")
_TOKEN = re.compile(r"[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")
_URL = re.compile(r"url\(#([^)]+)\)")
_ROTATE = re.compile(r"rotate\(([^)]*)\)")
_lock = threading.Lock()


@cache
def _all() -> dict[str, str]:
    with ART.open(encoding="utf-8") as handle:
        found = json.load(handle)
    return found if isinstance(found, dict) else {}


def known(illustration: str) -> bool:
    return illustration in covers.ILLUSTRATIONS and illustration in _all()


@cache
def _tree(illustration: str) -> ElementTree.Element:
    with _lock:
        return ElementTree.fromstring(_all()[illustration])


# --- Paths ----------------------------------------------------------------------------------------------------------


def _arc(x1: float, y1: float, rx: float, ry: float, angle: float, large: bool, sweep: bool, x2: float,
         y2: float) -> Iterator[tuple[float, float, float, float, float, float]]:
    """An SVG arc as cubic curves (the endpoint form turned into the centre form, then at most a quarter per curve)."""
    if rx == 0 or ry == 0:
        yield (x1, y1, x2, y2, x2, y2)
        return
    phi = math.radians(angle)
    cos, sin = math.cos(phi), math.sin(phi)
    dx, dy = (x1 - x2) / 2, (y1 - y2) / 2
    x1p, y1p = cos * dx + sin * dy, -sin * dx + cos * dy
    rx, ry = abs(rx), abs(ry)
    scale = (x1p**2) / (rx**2) + (y1p**2) / (ry**2)
    if scale > 1:
        rx, ry = rx * math.sqrt(scale), ry * math.sqrt(scale)
    numerator = rx**2 * ry**2 - rx**2 * y1p**2 - ry**2 * x1p**2
    factor = math.sqrt(max(0.0, numerator / (rx**2 * y1p**2 + ry**2 * x1p**2)))
    if large == sweep:
        factor = -factor
    cxp, cyp = factor * rx * y1p / ry, -factor * ry * x1p / rx
    cx = cos * cxp - sin * cyp + (x1 + x2) / 2
    cy = sin * cxp + cos * cyp + (y1 + y2) / 2

    def angle_of(ux: float, uy: float, vx: float, vy: float) -> float:
        value = math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
        return value

    start = angle_of(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    delta = angle_of((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if not sweep and delta > 0:
        delta -= 2 * math.pi
    elif sweep and delta < 0:
        delta += 2 * math.pi
    pieces = max(1, math.ceil(abs(delta) / (math.pi / 2)))
    step = delta / pieces
    k = 4 / 3 * math.tan(step / 4)

    def point(theta: float) -> tuple[float, float]:
        x, y = rx * math.cos(theta), ry * math.sin(theta)
        return cos * x - sin * y + cx, sin * x + cos * y + cy

    def tangent(theta: float) -> tuple[float, float]:
        x, y = -rx * math.sin(theta), ry * math.cos(theta)
        return cos * x - sin * y, sin * x + cos * y

    theta = start
    for _ in range(pieces):
        ax, ay = point(theta)
        bx, by = point(theta + step)
        tax, tay = tangent(theta)
        tbx, tby = tangent(theta + step)
        yield (ax + k * tax, ay + k * tay, bx - k * tbx, by - k * tby, bx, by)
        theta += step


def path_of(canvas: Any, d: str) -> Any:
    """An SVG path as a path of the canvas, in the same coordinates."""
    path = canvas.beginPath()
    tokens = _TOKEN.findall(d)
    index = 0
    command = ""
    x = y = start_x = start_y = 0.0
    control: tuple[float, float] | None = None
    quad: tuple[float, float] | None = None

    def numbers(count: int) -> list[float]:
        nonlocal index
        found = [float(value) for value in tokens[index : index + count]]
        index += count
        return found

    while index < len(tokens):
        token = tokens[index]
        if token.isalpha():
            command = token
            index += 1
            if command in "Zz":
                path.close()
                x, y = start_x, start_y
                control = quad = None
                continue
        relative = command.islower()
        kind = command.upper()
        ox, oy = (x, y) if relative else (0.0, 0.0)
        if kind == "M":
            mx, my = numbers(2)
            x, y = ox + mx, oy + my
            path.moveTo(x, y)
            start_x, start_y = x, y
            command = "l" if relative else "L"
            control = quad = None
        elif kind == "L":
            lx, ly = numbers(2)
            x, y = ox + lx, oy + ly
            path.lineTo(x, y)
            control = quad = None
        elif kind == "H":
            (hx,) = numbers(1)
            x = ox + hx
            path.lineTo(x, y)
            control = quad = None
        elif kind == "V":
            (vy,) = numbers(1)
            y = oy + vy
            path.lineTo(x, y)
            control = quad = None
        elif kind in "CS":
            if kind == "C":
                c1x, c1y, c2x, c2y, ex, ey = numbers(6)
                c1 = (ox + c1x, oy + c1y)
            else:
                c2x, c2y, ex, ey = numbers(4)
                c1 = (2 * x - control[0], 2 * y - control[1]) if control else (x, y)
            c2 = (ox + c2x, oy + c2y)
            x, y = ox + ex, oy + ey
            path.curveTo(c1[0], c1[1], c2[0], c2[1], x, y)
            control, quad = c2, None
        elif kind in "QT":
            if kind == "Q":
                qx, qy, ex, ey = numbers(4)
                q = (ox + qx, oy + qy)
            else:
                ex, ey = numbers(2)
                q = (2 * x - quad[0], 2 * y - quad[1]) if quad else (x, y)
            nx, ny = ox + ex, oy + ey
            path.curveTo(x + 2 / 3 * (q[0] - x), y + 2 / 3 * (q[1] - y), nx + 2 / 3 * (q[0] - nx),
                         ny + 2 / 3 * (q[1] - ny), nx, ny)
            x, y = nx, ny
            quad, control = q, None
        elif kind == "A":
            rx, ry, rotation, large, sweep, ex, ey = numbers(7)
            nx, ny = ox + ex, oy + ey
            for curve in _arc(x, y, rx, ry, rotation, bool(large), bool(sweep), nx, ny):
                path.curveTo(*curve)
            x, y = nx, ny
            control = quad = None
        else:
            index += 1
    return path


# --- Drawing --------------------------------------------------------------------------------------------------------


def colour(value: str) -> Any:
    """``#rrggbb`` or the short ``#rgb`` (which ReportLab would read as a number, ``#fff`` as blue)."""
    value = value.strip()
    if len(value) == 4 and value.startswith("#"):
        value = "#" + "".join(char * 2 for char in value[1:])
    return HexColor(value)


def _number(element: ElementTree.Element, name: str, default: float = 0.0) -> float:
    raw = element.get(name)
    found = _NUMBER.match(raw.strip()) if raw else None
    return float(found.group(0)) if found else default


def _shape(canvas: Any, element: ElementTree.Element) -> Any | None:
    tag = element.tag.removeprefix(_SVG)
    path = canvas.beginPath()
    if tag == "rect":
        x, y = _number(element, "x"), _number(element, "y")
        width, height = _number(element, "width"), _number(element, "height")
        radius = _number(element, "rx")
        if radius:
            path.roundRect(x, y, width, height, radius)
        else:
            path.rect(x, y, width, height)
    elif tag == "circle":
        radius = _number(element, "r")
        path.circle(_number(element, "cx"), _number(element, "cy"), radius)
    elif tag == "ellipse":
        rx, ry = _number(element, "rx"), _number(element, "ry")
        path.ellipse(_number(element, "cx") - rx, _number(element, "cy") - ry, 2 * rx, 2 * ry)
    elif tag == "path":
        path = path_of(canvas, element.get("d") or "")
    else:
        return None
    return path


def _bounds(element: ElementTree.Element) -> tuple[float, float, float, float]:
    tag = element.tag.removeprefix(_SVG)
    if tag == "rect":
        return (_number(element, "x"), _number(element, "y"), _number(element, "width"), _number(element, "height"))
    if tag == "circle":
        r = _number(element, "r")
        return (_number(element, "cx") - r, _number(element, "cy") - r, 2 * r, 2 * r)
    return (0.0, 0.0, WIDTH, HEIGHT)


class _Defs:
    def __init__(self) -> None:
        self.gradients: dict[str, ElementTree.Element] = {}
        self.clips: dict[str, ElementTree.Element] = {}


def _collect(element: ElementTree.Element, defs: _Defs) -> None:
    for child in element.iter():
        tag = child.tag.removeprefix(_SVG)
        uid = child.get("id")
        if uid and tag == "linearGradient":
            defs.gradients[uid] = child
        elif uid and tag == "clipPath":
            defs.clips[uid] = child


def _gradient(canvas: Any, element: ElementTree.Element, gradient: ElementTree.Element) -> None:
    x, y, width, height = _bounds(element)
    stops = [child for child in gradient if child.tag.removeprefix(_SVG) == "stop"]
    colours = [colour(stop.get("stop-color") or "#000000") for stop in stops]
    positions = [_number(stop, "offset") for stop in stops]
    canvas.saveState()
    canvas.clipPath(_shape(canvas, element), stroke=0, fill=0)
    canvas.linearGradient(x + _number(gradient, "x1") * width, y + _number(gradient, "y1") * height,
                          x + _number(gradient, "x2") * width, y + _number(gradient, "y2", 1) * height,
                          colours, positions, extend=True)
    canvas.restoreState()


def _paint(canvas: Any, element: ElementTree.Element, defs: _Defs) -> None:
    fill = element.get("fill", "#000000")
    stroke = element.get("stroke", "none")
    opacity = _number(element, "opacity", 1.0)
    gradient = _URL.match(fill)
    transform = _ROTATE.search(element.get("transform") or "")
    canvas.saveState()
    if transform:
        values = [float(value) for value in _NUMBER.findall(transform.group(1))]
        angle, cx, cy = (values + [0.0, 0.0])[:3]
        canvas.translate(cx, cy)
        canvas.rotate(angle)
        canvas.translate(-cx, -cy)
    if gradient:
        found = defs.gradients.get(gradient.group(1))
        if found is not None:
            _gradient(canvas, element, found)
        fill = "none"
    shape = _shape(canvas, element)
    filled = fill != "none"
    stroked = stroke != "none"
    if shape is not None and (filled or stroked):
        if filled:
            canvas.setFillColor(colour(fill))
            canvas.setFillAlpha(opacity * _number(element, "fill-opacity", 1.0))
        if stroked:
            canvas.setStrokeColor(colour(stroke))
            canvas.setStrokeAlpha(opacity)
            canvas.setLineWidth(_number(element, "stroke-width", 1.0))
            canvas.setLineCap({"round": 1, "square": 2}.get(element.get("stroke-linecap", ""), 0))
            canvas.setLineJoin({"round": 1, "bevel": 2}.get(element.get("stroke-linejoin", ""), 0))
        canvas.drawPath(shape, stroke=1 if stroked else 0, fill=1 if filled else 0)
    canvas.restoreState()


def _walk(canvas: Any, element: ElementTree.Element, defs: _Defs) -> None:
    for child in element:
        tag = child.tag.removeprefix(_SVG)
        if tag in ("defs", "linearGradient", "clipPath", "title", "desc"):
            continue
        if tag == "g":
            clip = _URL.match(child.get("clip-path") or "")
            canvas.saveState()
            if clip and clip.group(1) in defs.clips:
                for shape_element in defs.clips[clip.group(1)]:
                    shape = _shape(canvas, shape_element)
                    if shape is not None:
                        canvas.clipPath(shape, stroke=0, fill=0)
            _walk(canvas, child, defs)
            canvas.restoreState()
        else:
            _paint(canvas, child, defs)


def place(canvas: Any, illustration: str, x: float, y: float, width: float, height: float) -> None:
    """The illustration filling the box, cut at its edges as the interface shows it (``xMidYMid slice``). Drawn right
    on the page (not as a form of its own: a form drawn apart would lose the page's transparency and gradients)."""
    root = _tree(illustration)
    defs = _Defs()
    _collect(root, defs)
    scale = max(width / WIDTH, height / HEIGHT)
    canvas.saveState()
    clip = canvas.beginPath()
    clip.rect(x, y, width, height)
    canvas.clipPath(clip, stroke=0, fill=0)
    canvas.translate(x + (width - WIDTH * scale) / 2, y + (height + HEIGHT * scale) / 2)
    # The drawings count from the top down, the PDF from the bottom up.
    canvas.scale(scale, -scale)
    _walk(canvas, root, defs)
    canvas.restoreState()
