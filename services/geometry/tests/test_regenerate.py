import math

import pytest
import trimesh
from conftest import FIXTURES, load

from aurea_geometry.export import canonical_step_digest
from aurea_geometry.pipeline import mass_grams, regenerate


def ring_volume(d, w, t):
    return math.pi * ((d / 2 + t) ** 2 - (d / 2) ** 2) * w


def test_ring_matches_analytic_volume_and_roundtrips(ring_doc, tmp_path):
    m = regenerate(ring_doc, tmp_path)
    c = m["components"][0]
    expected = ring_volume(18, 4, 1.8)
    assert c["brepVolumeMm3"] == pytest.approx(expected, rel=1e-9)
    assert c["roundtrip"]["stepVolumeMm3"] == pytest.approx(expected, rel=1e-6)
    assert c["roundtrip"]["stlWatertight"]
    assert c["roundtrip"]["stlVolumeMm3"] == pytest.approx(expected, rel=5e-3)
    # GLB preview: metres, Y-up -> band width (4 mm) lies on Y.
    ex = sorted(c["roundtrip"]["glbExtentsM"])
    assert ex[0] == pytest.approx(0.004, abs=1e-6)
    assert ex[2] == pytest.approx(0.0216, abs=1e-4)
    assert {a["name"] for a in c["anchors"]} == {"ring.top", "ring.inner"}


def test_pendant_matches_analytic_volume(pendant_doc, tmp_path):
    m = regenerate(pendant_doc, tmp_path)
    c = m["components"][0]
    assert c["brepVolumeMm3"] == pytest.approx(math.pi * 10 * 12.5 * 2, rel=1e-9)
    assert c["roundtrip"]["stlWatertight"]


def test_boundary_parameters_build(ring_doc, tmp_path):
    p = ring_doc["components"][0]["parameters"]
    p.update(innerDiameter=14.0, bandWidth=1.5, radialThickness=0.8)
    ring_doc["constraints"] = []
    m = regenerate(ring_doc, tmp_path)
    assert m["components"][0]["brepVolumeMm3"] == pytest.approx(ring_volume(14, 1.5, 0.8), rel=1e-9)


def test_dfm_never_passes_and_requires_human(ring_doc, tmp_path):
    dfm = regenerate(ring_doc, tmp_path)["dfm"]
    assert dfm["state"] == "REVIEW"  # unimplemented rules are REVIEW, never PASS
    assert dfm["humanApprovalRequired"] is True
    by_rule = {f["rule"]: f for f in dfm["findings"]}
    assert by_rule["DFM-01"]["result"] == "PASS"
    assert by_rule["DFM-02"]["result"] == "PASS"
    assert by_rule["DFM-09"]["result"] == "PASS"


def test_thin_wall_blocks(tmp_path):
    dfm = regenerate(load(FIXTURES / "ring_thin_wall.json"), tmp_path)["dfm"]
    assert dfm["state"] == "FAIL"
    f = next(f for f in dfm["findings"] if f["rule"] == "DFM-02")
    assert (f["result"], f["measured"], f["threshold"]) == ("FAIL", 0.9, 1.2)


def test_missing_wall_rule_is_review(ring_doc, tmp_path):
    ring_doc["constraints"] = []
    f = next(f for f in regenerate(ring_doc, tmp_path)["dfm"]["findings"] if f["rule"] == "DFM-02")
    assert f["result"] == "REVIEW"


def test_step_canonical_digest_is_deterministic(ring_doc, tmp_path):
    a = regenerate(ring_doc, tmp_path / "a")["components"][0]["artifacts"][0]
    b = regenerate(ring_doc, tmp_path / "b")["components"][0]["artifacts"][0]
    assert a["kind"] == "STEP"
    assert a["canonicalSha256"] == b["canonicalSha256"]
    assert canonical_step_digest(tmp_path / "a" / a["file"]) == a["canonicalSha256"]


def test_transform_translates_geometry(ring_doc, tmp_path):
    ring_doc["components"][0]["transform"]["translation"] = [10, 0, 0]
    c = regenerate(ring_doc, tmp_path)["components"][0]
    (xmin, _, _), (xmax, _, _) = c["boundingBoxMm"]
    assert (xmin + xmax) / 2 == pytest.approx(10, abs=1e-6)
    top = next(a for a in c["anchors"] if a["name"] == "ring.top")
    assert top["position"][0] == pytest.approx(10)


def test_rotation_moves_anchor(ring_doc, tmp_path):
    s = math.sqrt(0.5)  # 90 deg about Z
    ring_doc["components"][0]["transform"]["rotationQuaternion"] = [0, 0, s, s]
    top = next(a for a in regenerate(ring_doc, tmp_path)["components"][0]["anchors"] if a["name"] == "ring.top")
    assert top["position"][0] == pytest.approx(-10.8, abs=1e-9)
    assert top["normal"][0] == pytest.approx(-1, abs=1e-9)


def test_glb_loads_as_mesh(ring_doc, tmp_path):
    regenerate(ring_doc, tmp_path)
    scene = trimesh.load(tmp_path / "ring-base.glb")
    assert len(scene.geometry) == 1


def test_mass_estimate_requires_density():
    assert mass_grams(1000, 15.5) == pytest.approx(15.5)
    with pytest.raises(ValueError):
        mass_grams(1000, 0)
