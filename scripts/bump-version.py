#!/usr/bin/env python3
"""Bump the cache-bust stamp on every file the browser can hold a stale copy of.

index.html stamps the entry points, but app.js and view.js reach the rest of
the app through bare module imports, and a browser will happily reuse an old
sim.js behind a freshly fetched app.js. The version badge then reports a build
the physics is not actually running. So every local module import carries the
same stamp as index.html, and --check refuses to pass if one is missing or has
drifted out of step.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"
STAMPED = re.compile(r"\?v=(\d+)")
# from "./sim.js" / from "./sim.js?v=73" — relative specifiers only, since a
# bare or absolute one is not ours to version.
IMPORT = re.compile(r"""(from\s+["'])(\.{1,2}/[\w./-]+\.js)(\?v=\d+)?(["'])""")


def js_files() -> list[Path]:
    return sorted(p for p in ROOT.glob("*.js") if p.name != "sw.js")


def main() -> None:
    index = INDEX.read_text()
    vers = [int(v) for v in STAMPED.findall(index)]
    if not vers:
        sys.exit("no ?v= cache-bust marks in index.html")
    cur = max(vers)

    if "--check" in sys.argv:
        problems = []
        if len(set(vers)) > 1:
            problems.append(f"index.html mixes versions {sorted(set(vers))}")
        for path in js_files():
            for m in IMPORT.finditer(path.read_text()):
                if not m.group(3):
                    problems.append(f"{path.name}: unstamped import {m.group(2)}")
                elif int(m.group(3)[3:]) != cur:
                    problems.append(f"{path.name}: {m.group(2)}{m.group(3)} should be ?v={cur}")
        if problems:
            print("\n".join(problems), file=sys.stderr)
            sys.exit(f"v{cur} is not coherent; the preview can serve stale code")
        print(f"v{cur}")
        return

    nxt = cur + 1
    text, n = STAMPED.subn(f"?v={nxt}", index)
    if n < 1:
        sys.exit("version rewrite failed")
    INDEX.write_text(text)
    for path in js_files():
        src = path.read_text()
        out = IMPORT.sub(rf"\g<1>\g<2>?v={nxt}\g<4>", src)
        if out != src:
            path.write_text(out)
    print(f"v{nxt}")


if __name__ == "__main__":
    main()
