import hashlib
import io
import json

import numpy as np
import pytest
import trimesh

from aurea_mesh import STATUS
from aurea_mesh.fixture import MAJOR, MINOR, clean_torus, defective_mesh, fixture_glb
from aurea_mesh.normalize import MeshImportError, ScaleSpec, normalize

SRC = {"provider": "simulated", "simulated": True}
OK_SCALE = ScaleSpec(target_mm=24.0, confirmed_by="joyero")


def load_stl(stl: bytes) -> trimesh.Trimesh:
    return trimesh.load(io.BytesIO(stl), file_type="stl")


def test_fixture_really_is_defective():
    m = defective_mesh()
    assert not m.is_watertight
    merged = m.copy()
    merged.merge_vertices()
    parts = merged.split(only_watertight=False, repair=False)
    big = sorted(len(p.faces) for p in parts if len(p.faces) > 10)
    assert len(big) == 2 and big[0] == 80 and big[1] > 2000  # fragment + torus
    assert not merged.is_watertight  # holes survive merging


def test_repair_scale_and_never_fabricable():
    report, stl, glb = normalize(fixture_glb(), OK_SCALE, source=SRC)
    assert report["status"] == STATUS and report["fabricable"] is False and report["humanReviewRequired"] is True
    assert report["simulated"] is True
    assert report["raw"]["watertight"] is False
    steps = {s["step"]: s for s in report["repair"]}
    assert steps["remove_fragments"]["components"] == [2, 1]
    assert steps["fill_holes"]["faces"][1] - steps["fill_holes"]["faces"][0] == 2

    mesh = load_stl(stl)
    assert mesh.is_watertight and mesh.is_winding_consistent and mesh.volume > 0
    # Scale: the longest side is exactly the confirmed size; Z-up, the ring lies flat.
    ext = mesh.extents
    assert ext.max() == pytest.approx(24.0, abs=1e-4)
    factor = 24.0 / (2 * (MAJOR + MINOR))
    assert ext[2] == pytest.approx(2 * MINOR * factor, rel=1e-3)
    # Volume equals the clean reference torus scaled by factor^3 (repair restored it exactly).
    assert mesh.volume == pytest.approx(clean_torus().volume * factor**3, rel=1e-6)
    assert report["result"]["volumeMm3"] == pytest.approx(mesh.volume, rel=1e-6)


def test_dfm_never_passes():
    report, _, _ = normalize(fixture_glb(), OK_SCALE, source=SRC)
    states = {d["rule"]: d["state"] for d in report["dfm"]}
    assert states["DFM-01"] == "REVIEW"  # self-intersections not measured
    assert len(states) == 10 and "PASS" not in states.values()


def test_preview_is_metres_y_up_and_hashes_match():
    report, stl, glb = normalize(fixture_glb(), OK_SCALE, source=SRC)
    prev = trimesh.load(io.BytesIO(glb), file_type="glb", force="scene").to_geometry()
    assert prev.extents.max() == pytest.approx(0.024, abs=1e-6)
    assert prev.extents[1] == pytest.approx(load_stl(stl).extents[2] / 1000, rel=1e-6)  # Z(mm) -> Y(m)
    assert report["artifacts"]["stl"]["sha256"] == hashlib.sha256(stl).hexdigest()
    assert report["artifacts"]["previewGlb"]["sha256"] == hashlib.sha256(glb).hexdigest()
    assert report["source"]["sha256"] == hashlib.sha256(fixture_glb()).hexdigest()


def test_deterministic():
    a = normalize(fixture_glb(), OK_SCALE, source=SRC)
    b = normalize(fixture_glb(), OK_SCALE, source=SRC)
    assert json.dumps(a[0], sort_keys=True) == json.dumps(b[0], sort_keys=True)
    assert a[1] == b[1] and a[2] == b[2]


def test_scale_on_named_axis():
    report, stl, _ = normalize(fixture_glb(), ScaleSpec(target_mm=5.0, axis="z", confirmed_by="joyero"), source=SRC)
    assert load_stl(stl).extents[2] == pytest.approx(5.0, abs=1e-4)
    assert report["scale"]["axis"] == "z"


@pytest.mark.parametrize(
    "spec,code",
    [
        (ScaleSpec(target_mm=24.0), "SCALE_REQUIRED"),
        (ScaleSpec(target_mm=24.0, confirmed_by="  "), "SCALE_REQUIRED"),
        (ScaleSpec(target_mm=0.5, confirmed_by="joyero"), "SCALE_INVALID"),
        (ScaleSpec(target_mm=500.0, confirmed_by="joyero"), "SCALE_INVALID"),
        (ScaleSpec(target_mm=float("nan"), confirmed_by="joyero"), "SCALE_INVALID"),
        (ScaleSpec(target_mm=24.0, axis="w", confirmed_by="joyero"), "SCALE_INVALID"),
    ],
)
def test_scale_is_never_guessed(spec, code):
    with pytest.raises(MeshImportError) as e:
        normalize(fixture_glb(), spec, source=SRC)
    assert e.value.code == code


@pytest.mark.parametrize(
    "data,code",
    [
        (b"", "MESH_IMPORT_FAILED"),
        (b"solid x\nendsolid x\n", "MESH_FORMAT_UNSUPPORTED"),
        (b"glTF\x02\x00\x00\x00garbage", "MESH_IMPORT_FAILED"),
    ],
)
def test_bad_input_is_rejected(data, code):
    with pytest.raises(MeshImportError) as e:
        normalize(data, OK_SCALE, source=SRC)
    assert e.value.code == code


def test_open_surface_is_blocked():
    # A plane cannot be repaired into a volume: DFM-01 must BLOCK and volume is withheld.
    plane = trimesh.Trimesh(vertices=[[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], faces=[[0, 1, 2], [0, 2, 3]])
    data = trimesh.exchange.gltf.export_glb(trimesh.Scene(plane))
    report, _, _ = normalize(data, OK_SCALE, source=SRC)
    assert report["dfm"][0]["state"] == "BLOCK"
    assert report["result"]["volumeMm3"] is None
    assert report["fabricable"] is False


def test_non_finite_vertices_rejected():
    m = clean_torus()
    v = m.vertices.copy()
    v[0] = [np.nan, 0, 0]
    bad = trimesh.Trimesh(vertices=v, faces=m.faces, process=False)
    data = trimesh.exchange.gltf.export_glb(trimesh.Scene(bad))
    with pytest.raises(MeshImportError):
        normalize(data, OK_SCALE, source=SRC)
