"""Import a provider mesh: parse, axis, repair, explicit scale, DFM-01, exports.

The provider's units are unknown, so scale is never guessed: the caller passes a
target dimension in mm that a person confirmed. The result is a concept mesh
for review; it never becomes PASS or fabricable here.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import trimesh

from . import ENGINE_VERSION, STATUS
from .adapter import MeshAdapterError

MAX_INPUT_BYTES = 50 * 1024 * 1024
MAX_TRIANGLES = 2_000_000
MIN_TARGET_MM = 1.0
MAX_TARGET_MM = 200.0
FRAGMENT_AREA_FRACTION = 0.01  # components under 1% of the largest one's area are debris
AXES = {"x": 0, "y": 1, "z": 2}


class MeshImportError(MeshAdapterError):
    code = "MESH_IMPORT_FAILED"


@dataclass(frozen=True)
class ScaleSpec:
    """`axis` of the repaired bounding box (internal Z-up frame) must measure `target_mm`.

    `axis="max"` uses the longest side. `confirmed_by` records who supplied the
    dimension (role, not a name), because a wrong scale changes weight and price.
    """

    target_mm: float
    axis: str = "max"
    confirmed_by: str = ""

    def validate(self) -> None:
        if not isinstance(self.target_mm, (int, float)) or not math.isfinite(self.target_mm):
            raise MeshImportError("target_mm must be a finite number", code="SCALE_INVALID")
        if not MIN_TARGET_MM <= self.target_mm <= MAX_TARGET_MM:
            raise MeshImportError(
                f"target_mm must be within {MIN_TARGET_MM}-{MAX_TARGET_MM} mm", code="SCALE_INVALID"
            )
        if self.axis not in (*AXES, "max"):
            raise MeshImportError("axis must be x, y, z or max", code="SCALE_INVALID")
        if not self.confirmed_by.strip():
            raise MeshImportError("scale must be confirmed by a person (confirmed_by)", code="SCALE_REQUIRED")


def _load(data: bytes) -> trimesh.Trimesh:
    if not data:
        raise MeshImportError("empty input")
    if len(data) > MAX_INPUT_BYTES:
        raise MeshImportError(f"input exceeds {MAX_INPUT_BYTES} bytes", code="MESH_TOO_LARGE")
    if data[:4] != b"glTF":
        raise MeshImportError("input is not a binary glTF (GLB)", code="MESH_FORMAT_UNSUPPORTED")
    try:
        scene = trimesh.load(io.BytesIO(data), file_type="glb", force="scene", process=False)
        mesh = scene.to_geometry()
    except Exception as exc:  # malformed provider output must not crash the worker
        raise MeshImportError(f"GLB could not be parsed: {type(exc).__name__}") from None
    if not isinstance(mesh, trimesh.Trimesh) or len(mesh.faces) == 0:
        raise MeshImportError("GLB contains no triangle mesh", code="MESH_EMPTY")
    if len(mesh.faces) > MAX_TRIANGLES:
        raise MeshImportError(f"more than {MAX_TRIANGLES} triangles", code="MESH_TOO_LARGE")
    if not np.isfinite(mesh.vertices).all():
        raise MeshImportError("non-finite vertex coordinates", code="MESH_INVALID")
    return mesh


def _repair(mesh: trimesh.Trimesh) -> tuple[trimesh.Trimesh, list[dict]]:
    log: list[dict] = []

    def step(name: str, fn) -> None:
        before = (len(mesh.vertices), len(mesh.faces))
        fn()
        log.append({"step": name, "vertices": [before[0], len(mesh.vertices)], "faces": [before[1], len(mesh.faces)]})

    step("merge_vertices", lambda: mesh.merge_vertices())
    step("remove_degenerate_faces", lambda: mesh.update_faces(mesh.nondegenerate_faces()))
    step("remove_duplicate_faces", lambda: mesh.update_faces(mesh.unique_faces()))

    parts = mesh.split(only_watertight=False, repair=False)
    if len(parts) > 1:
        areas = np.array([p.area for p in parts])
        keep = [p for p, a in zip(parts, areas) if a >= FRAGMENT_AREA_FRACTION * areas.max()]
        log.append({"step": "remove_fragments", "components": [len(parts), len(keep)]})
        mesh = trimesh.util.concatenate(keep)

    step("fix_normals", lambda: trimesh.repair.fix_normals(mesh, multibody=True))
    step("fill_holes", lambda: trimesh.repair.fill_holes(mesh))
    step("remove_unreferenced_vertices", lambda: mesh.remove_unreferenced_vertices())
    return mesh, log


def _dfm(mesh: trimesh.Trimesh) -> list[dict]:
    watertight = bool(mesh.is_watertight)
    winding = bool(mesh.is_winding_consistent)
    volume_ok = bool(mesh.is_volume)
    if not (watertight and winding and volume_ok):
        dfm01 = {
            "rule": "DFM-01",
            "state": "BLOCK",
            "reason": "mesh is not a closed, consistently wound volume after automatic repair",
        }
    else:
        dfm01 = {
            "rule": "DFM-01",
            "state": "REVIEW",
            "reason": "closed and consistently wound; self-intersections not measured",
        }
    dfm01["evidence"] = {"watertight": watertight, "windingConsistent": winding, "isVolume": volume_ok,
                         "eulerNumber": int(mesh.euler_number)}
    others = [
        {"rule": f"DFM-{i:02d}", "state": "REVIEW", "reason": "not measured for imported concept meshes"}
        for i in range(2, 11)
    ]
    return [dfm01, *others]


def normalize(data: bytes, scale: ScaleSpec, *, source: dict) -> tuple[dict, bytes, bytes]:
    """Return (report, stl_mm_bytes, preview_glb_bytes)."""
    scale.validate()
    mesh = _load(data)
    raw = {"vertices": len(mesh.vertices), "faces": len(mesh.faces),
           "watertight": bool(mesh.is_watertight), "windingConsistent": bool(mesh.is_winding_consistent)}

    # glTF Y-up -> internal Z-up (+90 deg about X).
    mesh.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, [1, 0, 0]))
    mesh, repair_log = _repair(mesh)
    if len(mesh.faces) == 0:
        raise MeshImportError("no triangles left after repair", code="MESH_EMPTY")

    extents = mesh.extents
    idx = int(np.argmax(extents)) if scale.axis == "max" else AXES[scale.axis]
    if extents[idx] <= 0:
        raise MeshImportError("zero extent on the scale axis", code="SCALE_INVALID")
    factor = scale.target_mm / float(extents[idx])
    mesh.apply_translation(-mesh.bounds.mean(axis=0))
    mesh.apply_scale(factor)

    dfm = _dfm(mesh)
    stl = trimesh.exchange.stl.export_stl(mesh)
    preview = mesh.copy()
    preview.apply_scale(0.001)
    preview.apply_transform(trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0]))
    glb = trimesh.exchange.gltf.export_glb(trimesh.Scene(preview))

    watertight = bool(mesh.is_watertight)
    report = {
        "engine": ENGINE_VERSION,
        "status": STATUS,
        "fabricable": False,
        "humanReviewRequired": True,
        "simulated": bool(source.get("simulated")),
        "source": {**source, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)},
        "raw": raw,
        "repair": repair_log,
        "scale": {
            "axis": "xyz"[idx], "requested": scale.axis, "targetMm": scale.target_mm,
            "factor": factor, "confirmedBy": scale.confirmed_by, "providerUnits": "unknown",
        },
        "result": {
            "units": "mm", "upAxis": "Z",
            "vertices": len(mesh.vertices), "triangles": len(mesh.faces),
            "bboxMm": [round(float(v), 6) for v in mesh.extents],
            # Volume only means something for a closed mesh; otherwise it is withheld, not estimated.
            "volumeMm3": round(float(mesh.volume), 4) if watertight else None,
        },
        "dfm": dfm,
        "artifacts": {
            "stl": {"units": "mm", "sha256": hashlib.sha256(stl).hexdigest(), "bytes": len(stl)},
            "previewGlb": {"units": "m", "upAxis": "Y", "sha256": hashlib.sha256(glb).hexdigest(), "bytes": len(glb)},
        },
    }
    return report, stl, glb


def write_outputs(out_dir: Path, name: str, report: dict, stl: bytes, glb: bytes) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{name}.stl").write_bytes(stl)
    (out_dir / f"{name}.preview.glb").write_bytes(glb)
    (out_dir / f"{name}.report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
