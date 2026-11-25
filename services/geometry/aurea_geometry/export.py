"""STEP / STL (technical, mm) and GLB (preview, metres, Y-up) exports."""
from __future__ import annotations

import hashlib
import math
import re
from pathlib import Path

import cadquery as cq
import trimesh

STL_TOLERANCE_MM = 0.01
STL_ANGULAR_TOLERANCE_RAD = 0.1


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical_step_digest(path: Path) -> str:
    """Digest of the STEP DATA section only.

    The HEADER carries a FILE_NAME timestamp, so raw file hashes change on
    every export even for identical geometry. Cache keys and release
    manifests must use this digest (or a geometry-based one), not the raw hash.
    """
    text = path.read_text(encoding="utf-8", errors="strict").replace("\r\n", "\n")
    idx = text.find("\nDATA;")
    if idx < 0:
        raise ValueError(f"{path.name}: no DATA section")
    return hashlib.sha256(text[idx:].encode("utf-8")).hexdigest()


_PRODUCT_NAME = re.compile(r"PRODUCT\('Open CASCADE STEP translator [^']*',\s*'Open CASCADE STEP translator [^']*'")


def _stabilise_step_product_name(path: Path, name: str) -> None:
    """OCCT names the STEP PRODUCT with a per-process counter ("... 7.9 7"),
    so identical geometry exported twice differs inside DATA. Replace it with
    the stable component id."""
    if not re.fullmatch(r"[A-Za-z0-9._-]+", name):
        raise ValueError(f"unsafe component id for STEP product name: {name!r}")
    text = path.read_text(encoding="utf-8")
    text, n = _PRODUCT_NAME.subn(f"PRODUCT('{name}','{name}'", text)
    if n != 1:
        raise ValueError(f"{path.name}: expected one OCCT PRODUCT entity, found {n}")
    path.write_text(text, encoding="utf-8")


def export_component(solid: cq.Shape, out_dir: Path, name: str) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    step, stl, glb = (out_dir / f"{name}.{ext}" for ext in ("step", "stl", "glb"))
    cq.exporters.export(solid, str(step))
    _stabilise_step_product_name(step, name)
    cq.exporters.export(
        solid, str(stl), tolerance=STL_TOLERANCE_MM, angularTolerance=STL_ANGULAR_TOLERANCE_RAD
    )
    mesh = trimesh.load_mesh(stl)
    preview = mesh.copy()
    # Internal Z-up mm -> glTF Y-up metres.
    preview.apply_transform(trimesh.transformations.rotation_matrix(-math.pi / 2, [1, 0, 0]))
    preview.apply_scale(0.001)
    preview.export(glb)

    restored = cq.importers.importStep(str(step)).val()
    return {
        "artifacts": [
            {"kind": "STEP", "file": step.name, "unit": "mm", "sha256": sha256_file(step),
             "canonicalSha256": canonical_step_digest(step)},
            {"kind": "STL", "file": stl.name, "unit": "mm (by manifest convention)",
             "sha256": sha256_file(stl)},
            {"kind": "GLB", "file": glb.name, "unit": "m", "upAxis": "Y",
             "sha256": sha256_file(glb), "role": "PREVIEW_NOT_A_SOLID"},
        ],
        "roundtrip": {
            "stepValid": bool(restored.isValid()),
            "stepVolumeMm3": restored.Volume(),
            "stlWatertight": bool(mesh.is_watertight),
            "stlWindingConsistent": bool(mesh.is_winding_consistent),
            "stlVolumeMm3": float(mesh.volume),
            "glbExtentsM": [float(v) for v in preview.extents],
        },
    }
