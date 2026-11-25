"""Deterministic fixture standing in for a provider's generated mesh.

It reproduces the defects real image-to-mesh output usually has, so the import
pipeline is exercised end to end without a provider:
- arbitrary, unitless scale and Y-up axes (glTF convention);
- unmerged vertices (every triangle has its own three vertices);
- a few faces with reversed winding;
- two small holes (faces removed);
- degenerate (zero-area) and duplicated triangles;
- a tiny floating fragment.

Original geometry (a torus), no third-party asset.
"""
from __future__ import annotations

import numpy as np
import trimesh

FIXTURE_ID = "sim.torus-sculpture.v1"
# Unitless provider scale: outer diameter is 2 * (MAJOR + MINOR) = 2.7 "units".
MAJOR = 1.0
MINOR = 0.35
SECTIONS = (48, 24)
REMOVED_FACES = (100, 1300)  # one-triangle holes, far apart
FLIPPED_FACES = (10, 400, 900, 1700, 2200)


def clean_torus() -> trimesh.Trimesh:
    """Watertight reference torus, Z is the symmetry axis (before the Y-up swap)."""
    return trimesh.creation.torus(
        major_radius=MAJOR, minor_radius=MINOR, major_sections=SECTIONS[0], minor_sections=SECTIONS[1]
    )


def defective_mesh() -> trimesh.Trimesh:
    base = clean_torus()
    faces = base.faces.copy()
    faces[list(FLIPPED_FACES)] = faces[list(FLIPPED_FACES)][:, ::-1]
    keep = np.ones(len(faces), dtype=bool)
    keep[list(REMOVED_FACES)] = False
    faces = faces[keep]
    tris = base.vertices[faces]  # (n, 3, 3): unmerged soup
    tris = np.concatenate([tris, tris[:3]])  # duplicated triangles
    a = tris[0, 0]
    tris = np.concatenate([tris, np.array([[a, a, a], [a, a + [1e-9, 0, 0], a]])])  # degenerate
    frag = trimesh.creation.icosphere(subdivisions=1, radius=0.01)
    frag.apply_translation([0.0, 0.0, 1.2])
    tris = np.concatenate([tris, frag.vertices[frag.faces]])
    # Z-up (internal) -> Y-up (glTF): rotate -90 deg about X.
    rot = trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0])
    verts = tris.reshape(-1, 3)
    verts = trimesh.transform_points(verts, rot)
    n = len(tris)
    return trimesh.Trimesh(vertices=verts, faces=np.arange(n * 3).reshape(n, 3), process=False)


def fixture_glb() -> bytes:
    return trimesh.exchange.gltf.export_glb(trimesh.Scene(defective_mesh()))
