"""regenerate(document) -> artifacts, metrics, diagnostics (ENGINE.md interface)."""
from __future__ import annotations

import json
from pathlib import Path

import cadquery as cq
import OCP

from . import ENGINE_VERSION, STATUS
from .build import build_component
from .dfm import evaluate
from .document import canonical_digest, validate_document
from .export import STL_ANGULAR_TOLERANCE_RAD, STL_TOLERANCE_MM, export_component


def kernel_version() -> str:
    return f"cadquery {cq.__version__}; OCP {getattr(OCP, '__version__', 'unknown')}"


def regenerate(document: dict, out_dir: Path) -> dict:
    validate_document(document)
    built = [build_component(c) for c in document["components"]]
    exports = {b.id: export_component(b.solid, out_dir, b.id) for b in built}
    components = []
    for b in built:
        bb = b.solid.BoundingBox()
        components.append({
            "id": b.id,
            "family": b.family,
            "materialId": b.material_id,
            "analyticVolumeMm3": b.analytic_volume_mm3,
            "brepVolumeMm3": b.solid.Volume(),
            "boundingBoxMm": [[bb.xmin, bb.ymin, bb.zmin], [bb.xmax, bb.ymax, bb.zmax]],
            "anchors": [a.__dict__ for a in b.anchors],
            **exports[b.id],
        })
    manifest = {
        "status": STATUS,
        "engineVersion": ENGINE_VERSION,
        "kernelVersion": kernel_version(),
        "inputDigest": canonical_digest(document),
        "projectId": document["projectId"],
        "revision": document["revision"],
        "units": {"cad": "mm", "stl": "mm", "glb": "m"},
        "tessellation": {"toleranceMm": STL_TOLERANCE_MM, "angularToleranceRad": STL_ANGULAR_TOLERANCE_RAD},
        "components": components,
        "dfm": evaluate(document, built, exports),
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def mass_grams(volume_mm3: float, density_g_cm3: float) -> float:
    """Estimated mass. Density must come from configured alloy data; this is not an assay."""
    if not volume_mm3 > 0 or not density_g_cm3 > 0:
        raise ValueError("volume and density must be positive")
    return volume_mm3 * density_g_cm3 / 1000.0
