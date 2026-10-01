#!/usr/bin/env python3
"""Bump the visible js/css build mark together with the cache-bust query."""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"


def read_ver(text: str, key: str) -> int:
    m = re.search(rf"{key} (\d+)", text)
    if not m:
        sys.exit(f"missing {key} mark in index.html")
    return int(m.group(1))


def main() -> None:
    check = "--check" in sys.argv
    text = INDEX.read_text()
    js = read_ver(text, "js")
    css = read_ver(text, "css")
    if check:
        print(f"js {js} · css {css}")
        return
    js += 1
    css += 1
    text2, n = re.subn(r"js \d+ · css \d+", f"js {js} · css {css}", text, count=1)
    text2, nq = re.subn(r"\?v=\d+", f"?v={js}", text2)
    if n != 1 or nq < 1:
        sys.exit("version rewrite failed")
    INDEX.write_text(text2)
    print(f"js {js} · css {css}")


if __name__ == "__main__":
    main()
