#!/usr/bin/env python3
"""One-off repair for pi-lazy-compact < 0.2.6: compaction entries written by
the retry path may be missing the nested usage.cost object, which crashes the
pi 1.5.0 TUI footer (addUsageToTotals reads usage.cost.total). Adds a zeroed
cost to any compaction entry lacking one. Safe to run multiple times."""

import json
import glob
from os import expanduser


def main() -> None:
    pattern = glob.glob(expanduser("~/.pi/agent/sessions/**/*.jsonl"), recursive=True)
    for f in pattern:
        out: list[str] = []
        changed = False
        with open(f) as fh:
            for line in fh:
                try:
                    e = json.loads(line)
                except Exception:
                    out.append(line)
                    continue
                u = e.get("usage") if e.get("type") == "compaction" else None
                if isinstance(u, dict) and not isinstance(u.get("cost"), dict):
                    u["cost"] = {k: 0 for k in ("input", "output", "cacheRead", "cacheWrite", "total")}
                    line = json.dumps(e) + "\n"
                    changed = True
                out.append(line)
        if changed:
            with open(f, "w") as fh:
                fh.writelines(out)
            print("repaired", f)
    print("done")


if __name__ == "__main__":
    main()
