"""Embed a GLB into the benchmark page: python build.py RING.glb > index.html"""
import base64, hashlib, sys
from pathlib import Path
glb = Path(sys.argv[1]).read_bytes()
tpl = (Path(__file__).parent / "template.html").read_text(encoding="utf-8")
out = tpl.replace("__RING_GLB_B64__", base64.b64encode(glb).decode()).replace("__RING_GLB_SHA256__", hashlib.sha256(glb).hexdigest())
sys.stdout.write(out)
