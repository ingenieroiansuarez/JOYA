"""Build showcase.glb: ring.classic + one gem, with glTF PBR materials.

Shared reference scene for the render benchmarks (WebView/Three.js and
native Filament), so both paths draw the same triangles and materials.

    python tools/render-bench/scene/build_scene.py RING.stl OUT.glb

Input: the STL from services/geometry (mm, Z-up). Output: glTF 2.0 binary in
metres, Y-up. Ring centred on the origin; gem on the ring.top anchor.
Materials: gold (metallic-roughness) and a green gem using
KHR_materials_transmission / _ior / _volume. Original geometry, no licensed assets.
"""
from __future__ import annotations

import json
import math
import struct
import sys
from pathlib import Path

import numpy as np
import trimesh

GOLD_SRGB = (0xE6, 0xB9, 0x5C)
GEM_SRGB = (0x1F, 0x9E, 0x5A)
GEM_RADIUS_MM = 2.2
GEM_LIFT_MM = 1.5  # above the outer surface at ring.top


def srgb_to_linear(c: int) -> float:
    v = c / 255.0
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def to_gltf_frame(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    m = mesh.copy()
    m.apply_transform(trimesh.transformations.rotation_matrix(-math.pi / 2, [1, 0, 0]))
    m.apply_scale(0.001)
    return m


def smooth(mesh: trimesh.Trimesh) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Split vertices across sharp edges (> 30 deg) and return smooth normals."""
    s = trimesh.graph.smooth_shade(mesh, angle=math.radians(30))
    return (np.asarray(s.vertices, np.float32), np.asarray(s.vertex_normals, np.float32),
            np.asarray(s.faces, np.uint32).reshape(-1))


def build(stl: Path) -> tuple[dict, bytes]:
    ring = trimesh.load_mesh(stl)  # mm, Z-up, band from z=0..width
    z_mid = (ring.bounds[0][2] + ring.bounds[1][2]) / 2
    ring.apply_translation([0, 0, -z_mid])
    r_out = float(np.max(np.linalg.norm(ring.vertices[:, :2], axis=1)))
    gem = trimesh.creation.icosphere(subdivisions=1, radius=GEM_RADIUS_MM)
    gem.apply_translation([0, r_out + GEM_LIFT_MM, 0])  # ring.top normal is +Y in Z-up frame

    parts = []
    for name, mesh in (("ring", to_gltf_frame(ring)), ("gem", to_gltf_frame(gem))):
        parts.append((name, *smooth(mesh)))

    blob = bytearray()
    views, accessors, meshes, nodes = [], [], [], []

    def add_view(data: bytes, target: int) -> int:
        while len(blob) % 4:
            blob.append(0)
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data), "target": target})
        blob.extend(data)
        return len(views) - 1

    for i, (name, pos, nrm, idx) in enumerate(parts):
        pv = add_view(pos.tobytes(), 34962)
        accessors.append({"bufferView": pv, "componentType": 5126, "count": len(pos), "type": "VEC3",
                          "min": pos.min(0).tolist(), "max": pos.max(0).tolist()})
        nv = add_view(nrm.tobytes(), 34962)
        accessors.append({"bufferView": nv, "componentType": 5126, "count": len(nrm), "type": "VEC3"})
        iv = add_view(idx.tobytes(), 34963)
        accessors.append({"bufferView": iv, "componentType": 5125, "count": len(idx), "type": "SCALAR"})
        a = len(accessors) - 3
        meshes.append({"name": name, "primitives": [{"attributes": {"POSITION": a, "NORMAL": a + 1},
                                                     "indices": a + 2, "material": i}]})
        nodes.append({"name": name, "mesh": i})
    nodes.append({"name": "showcase", "children": [0, 1]})

    gltf = {
        "asset": {"version": "2.0", "generator": "aurea build_scene.py"},
        "extensionsUsed": ["KHR_materials_transmission", "KHR_materials_ior", "KHR_materials_volume"],
        "scene": 0,
        "scenes": [{"nodes": [2]}],
        "nodes": nodes,
        "meshes": meshes,
        "materials": [
            {"name": "gold-18k-yellow (illustrative)", "pbrMetallicRoughness": {
                "baseColorFactor": [*(srgb_to_linear(c) for c in GOLD_SRGB), 1.0],
                "metallicFactor": 1.0, "roughnessFactor": 0.22}},
            {"name": "gem-green (illustrative)", "pbrMetallicRoughness": {
                "baseColorFactor": [*(srgb_to_linear(c) for c in GEM_SRGB), 1.0],
                "metallicFactor": 0.0, "roughnessFactor": 0.02},
             "extensions": {"KHR_materials_transmission": {"transmissionFactor": 1.0},
                            "KHR_materials_ior": {"ior": 1.58},
                            "KHR_materials_volume": {"thicknessFactor": 0.004}}},
        ],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(blob)}],
    }
    return gltf, bytes(blob)


def write_glb(gltf: dict, blob: bytes, out: Path) -> None:
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    blob += b"\0" * (-len(blob) % 4)
    total = 12 + 8 + len(js) + 8 + len(blob)
    out.write_bytes(struct.pack("<4sII", b"glTF", 2, total) + struct.pack("<I4s", len(js), b"JSON") + js
                    + struct.pack("<I4s", len(blob), b"BIN\0") + blob)


if __name__ == "__main__":
    gltf, blob = build(Path(sys.argv[1]))
    write_glb(gltf, blob, Path(sys.argv[2]))
    tris = sum(a["count"] for a in gltf["accessors"] if a["type"] == "SCALAR") // 3
    print(json.dumps({"out": sys.argv[2], "triangles": tris, "bytes": Path(sys.argv[2]).stat().st_size}))
