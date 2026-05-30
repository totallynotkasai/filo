"""Phase 6 sweep: add aria-hidden=\"true\" to inline SVG opening tags that lack it.

Skips:
- SVGs that already carry aria-hidden (any value).
- SVGs whose attribute block contains role="img" (intended to be announced).
- SVGs that contain a <title> child (decorative protection not needed when titled).

Run from repo root. Idempotent.
"""
from __future__ import annotations
import re, pathlib, sys

SVG_OPEN = re.compile(r"<svg([^>]*?)>", flags=re.DOTALL)
HAS_TITLE_AFTER = re.compile(r"<svg([^>]*?)>\s*<title", flags=re.DOTALL)

ROOT = pathlib.Path("src/renderer/components")

stats = {"files": 0, "scanned": 0, "added": 0}

for p in sorted(ROOT.rglob("*.svelte")):
    text = p.read_text(encoding="utf-8")
    has_title_blocks = {m.start() for m in HAS_TITLE_AFTER.finditer(text)}
    file_added = 0

    def replace(m: re.Match) -> str:
        global file_added
        stats["scanned"] += 1
        attrs = m.group(1)
        if "aria-hidden" in attrs or 'role="img"' in attrs:
            return m.group(0)
        if m.start() in has_title_blocks:
            return m.group(0)
        stats["added"] += 1
        file_added += 1
        return "<svg" + attrs + ' aria-hidden="true">'

    new = SVG_OPEN.sub(replace, text)
    if new != text:
        p.write_text(new, encoding="utf-8")
        stats["files"] += 1
        print(f"  {p.as_posix()}: +{file_added}")

print(
    f"\nFiles modified: {stats['files']}\n"
    f"SVG opening tags scanned: {stats['scanned']}\n"
    f"aria-hidden added: {stats['added']}"
)
