"""Rebuild committed status-bar icons: python -m pip install fonttools==4.60.1.

Normal extension builds use the committed WOFF and do not need Python.
The logo paths come from resource/icon/*.svg; see their README and license.
"""

from pathlib import Path
from xml.etree import ElementTree

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.transformPen import TransformPen
from fontTools.svgLib.path import parse_path


ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "resource" / "icon"
GLYPHS = [".notdef", "codex", "claude"] + [f"quota{step}" for step in range(11)]
WIDTHS = {name: (2000 if name.startswith("quota") else 1000) for name in GLYPHS}
CHARSTRINGS = {}


def rounded_rectangle(x, y, width, height, radius):
    """Clockwise SVG capsule, parsed as an outline (no SVG strokes in fonts)."""
    return (
        f"M{x + radius} {y}h{width - 2 * radius}"
        f"a{radius} {radius} 0 0 1 {radius} {radius}v{height - 2 * radius}"
        f"a{radius} {radius} 0 0 1 {-radius} {radius}h{-width + 2 * radius}"
        f"a{radius} {radius} 0 0 1 {-radius} {-radius}v{-height + 2 * radius}"
        f"a{radius} {radius} 0 0 1 {radius} {-radius}z"
    )


for glyph in GLYPHS:
    pen = T2CharStringPen(WIDTHS[glyph], None)
    if glyph in ("codex", "claude"):
        svg = ElementTree.parse(ICON_DIR / f"{glyph}.svg").getroot()
        # SVG coordinates grow down, font coordinates grow up. Keep a 4% margin.
        transform = TransformPen(pen, (920 / 24, 0, 0, -920 / 24, 40, 800))
        for path in svg.iter("{http://www.w3.org/2000/svg}path"):
            parse_path(path.attrib["d"], transform)
    elif glyph.startswith("quota"):
        step = int(glyph.removeprefix("quota"))
        # Use one contour for the fill and track. Overlapping font contours can
        # cancel out in Chromium's font rasterizer instead of filling their union.
        if step == 0:
            outline = rounded_rectangle(60, 295, 1880, 60, 30)
        elif step == 10:
            outline = rounded_rectangle(60, 195, 1880, 260, 80)
        else:
            width = 1880 * step / 10
            right = 60 + width
            outline = (
                f"M140 195h{width - 160}a80 80 0 0 1 80 80v20"
                "H1910a30 30 0 0 1 0 60"
                f"H{right}v20a80 80 0 0 1 -80 80h{-width + 160}"
                "a80 80 0 0 1 -80 -80V275a80 80 0 0 1 80 -80z"
            )
        parse_path(outline, pen)
    CHARSTRINGS[glyph] = pen.getCharString()

builder = FontBuilder(1000, isTTF=False)
builder.setupGlyphOrder(GLYPHS)
builder.setupCharacterMap({0xE001: "codex", 0xE002: "claude", **{0xE010 + step: f"quota{step}" for step in range(11)}})
builder.setupCFF("AgentTrackerIcons", {"FullName": "Agent Tracker Icons", "FamilyName": "Agent Tracker Icons", "Weight": "Regular"}, CHARSTRINGS, {})
builder.setupHorizontalMetrics({name: (WIDTHS[name], 0) for name in GLYPHS})
builder.setupHorizontalHeader(ascent=850, descent=-150)
builder.setupNameTable({"familyName": "Agent Tracker Icons", "styleName": "Regular", "uniqueFontIdentifier": "Agent Tracker Icons 1.0", "fullName": "Agent Tracker Icons", "psName": "AgentTrackerIcons", "version": "Version 1.0"})
builder.setupOS2(sTypoAscender=850, sTypoDescender=-150, usWinAscent=850, usWinDescent=150)
builder.setupPost()
# Fixed timestamps make rebuilding the same sources deterministic.
builder.font["head"].created = builder.font["head"].modified = 3786912000
builder.font.recalcTimestamp = False
builder.font.flavor = "woff"
builder.save(ICON_DIR / "agent-tracker.woff")
print(f"Generated {ICON_DIR / 'agent-tracker.woff'} ({len(GLYPHS) - 1} icons)")
