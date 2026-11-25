"""Usage: python -m aurea_geometry.cli DESIGN.json OUT_DIR"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from .document import InvalidDocument
from .pipeline import regenerate


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    document = json.loads(Path(args[0]).read_text(encoding="utf-8"))
    try:
        manifest = regenerate(document, Path(args[1]))
    except InvalidDocument as e:
        print(json.dumps({"error": "INVALID_DOCUMENT", "issues": [i.__dict__ for i in e.issues]}, indent=2))
        return 1
    print(json.dumps({"dfm": manifest["dfm"]["state"], "inputDigest": manifest["inputDigest"],
                      "components": [{"id": c["id"], "brepVolumeMm3": c["brepVolumeMm3"]} for c in manifest["components"]]}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
