#!/usr/bin/env python3
"""Bump cache-bust query params on CSS/JS links in index.html."""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"


def main() -> None:
    text = INDEX.read_text()
    vers = [int(v) for v in re.findall(r"\?v=(\d+)", text)]
    if not vers:
        sys.exit("no ?v= cache-bust marks in index.html")
    cur = max(vers)
    if "--check" in sys.argv:
        print(f"v{cur}")
        return
    nxt = cur + 1
    text2, n = re.subn(r"\?v=\d+", f"?v={nxt}", text)
    if n < 1:
        sys.exit("version rewrite failed")
    INDEX.write_text(text2)
    print(f"v{nxt}")


if __name__ == "__main__":
    main()
