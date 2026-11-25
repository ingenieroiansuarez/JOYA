"""Hito 300 core families: ring.02 (comfort fit) and pendant.02 (oval with bail hole)."""
import copy
import itertools

import pytest
from conftest import REPO, load

from aurea_geometry.build import build_component, comfort_volume
from aurea_geometry.pipeline import regenerate

TRANSFORM = {"translation": [0, 0, 0], "rotationQuaternion": [0, 0, 0, 1]}


def component(family, params):
    return {"id": "c1", "family": family, "familyVersion": "0.1.0", "materialId": "gold-18k-yellow",
            "parameters": params, "transform": TRANSFORM, "dependsOn": []}


def document(family, params, constraints=()):
    doc = load(REPO / "09_JEWELRY_ENGINE" / "fixtures" / "ring.json")
    doc["components"] = [component(family, params)]
    doc["constraints"] = [{"type": "min_wall", "target": "c1", "parameters": {"minMm": mm}} for mm in constraints]
    return doc


RING_GRID = list(itertools.product([14, 18, 24], [1.5, 4, 12], [0.8, 1.8, 4]))
PENDANT_GRID = list(itertools.product([5, 20, 60], [5, 25, 70], [0.8, 2, 6]))


@pytest.mark.parametrize("d,w,t", RING_GRID)
def test_comfort_ring_brep_equals_analytic_volume_on_range_corners(d, w, t):
    b = build_component(component("ring.02", {"innerDiameter": d, "bandWidth": w, "radialThickness": t}))
    assert b.solid.isValid()
    assert b.solid.Volume() == pytest.approx(b.analytic_volume_mm3, rel=1e-9)


def test_comfort_ring_is_lighter_than_classic_and_keeps_inner_diameter():
    p = {"innerDiameter": 18, "bandWidth": 4, "radialThickness": 1.8}
    classic = build_component(component("ring.classic", p))
    comfort = build_component(component("ring.02", p))
    assert comfort.analytic_volume_mm3 < classic.analytic_volume_mm3
    bb = comfort.solid.BoundingBox()
    assert bb.xmax == pytest.approx(9 + 1.8, abs=0.01)
    # The finger touches the dome crest at exactly the requested inner diameter.
    inner = next(a for a in comfort.anchors if a.name == "ring.inner")
    assert inner.position[1] == pytest.approx(9)
    # Thinnest wall is at the band edge: thickness minus dome depth (0.35 * 1.8).
    assert comfort.min_wall_mm == pytest.approx(1.8 * 0.65)


def test_comfort_volume_matches_numeric_integral():
    import math

    from scipy.integrate import quad

    from aurea_geometry.build import comfort_geometry

    p = {"innerDiameter": 21, "bandWidth": 7, "radialThickness": 2.5}
    r_in, r_out, w, h, big_r = comfort_geometry(p)
    numeric = math.pi * quad(lambda z: r_out**2 - (r_in + big_r - math.sqrt(big_r**2 - (z - w / 2) ** 2)) ** 2, 0, w)[0]
    assert comfort_volume(p) == pytest.approx(numeric, rel=1e-12)


@pytest.mark.parametrize("w,h,t", PENDANT_GRID)
def test_oval_pendant_brep_equals_analytic_volume_on_range_corners(w, h, t):
    b = build_component(component("pendant.02", {"width": w, "height": h, "thickness": t}))
    assert b.solid.isValid()
    assert b.solid.Volume() == pytest.approx(b.analytic_volume_mm3, rel=1e-9)
    assert 0 < b.min_wall_mm <= t


def test_oval_pendant_hole_and_bail_anchor():
    b = build_component(component("pendant.02", {"width": 20, "height": 25, "thickness": 2}))
    bail = next(a for a in b.anchors if a.name == "pendant.bail")
    assert bail.position == pytest.approx((0.0, 12.5 - 2.0, 1.0))  # 2 mm hole, one diameter below the top


def test_narrow_tall_oval_reports_thin_wall_around_hole(tmp_path):
    # 5 x 70 mm: the outline closes in around the hole; DFM-02 must say so, not hide it.
    dfm = regenerate(document("pendant.02", {"width": 5, "height": 70, "thickness": 2}, [0.6]), tmp_path)["dfm"]
    f = next(f for f in dfm["findings"] if f["rule"] == "DFM-02")
    assert f["result"] == "FAIL" and f["measured"] < 0.6
    assert dfm["state"] == "FAIL"


@pytest.mark.parametrize("family,params", [
    ("ring.02", {"innerDiameter": 18, "bandWidth": 4, "radialThickness": 1.8}),
    ("pendant.02", {"width": 20, "height": 25, "thickness": 2}),
])
def test_step_and_stl_roundtrip(family, params, tmp_path):
    m = regenerate(document(family, params, [0.8]), tmp_path)
    c = m["components"][0]
    rt = c["roundtrip"]
    assert rt["stepValid"] and rt["stlWatertight"] and rt["stlWindingConsistent"]
    assert rt["stepVolumeMm3"] == pytest.approx(c["analyticVolumeMm3"], rel=1e-6)
    assert rt["stlVolumeMm3"] == pytest.approx(c["analyticVolumeMm3"], rel=5e-3)
    by_rule = {f["rule"]: f["result"] for f in m["dfm"]["findings"]}
    assert by_rule["DFM-01"] == by_rule["DFM-09"] == "PASS"
    assert m["dfm"]["state"] == "REVIEW" and m["dfm"]["humanApprovalRequired"] is True


def test_parameter_change_changes_real_geometry(tmp_path):
    base = {"innerDiameter": 18, "bandWidth": 4, "radialThickness": 1.8}
    a = regenerate(document("ring.02", base), tmp_path / "a")["components"][0]
    changed = copy.deepcopy(base) | {"innerDiameter": 19}
    b = regenerate(document("ring.02", changed), tmp_path / "b")["components"][0]
    assert b["brepVolumeMm3"] > a["brepVolumeMm3"]
    assert b["boundingBoxMm"][1][0] == pytest.approx(9.5 + 1.8, abs=0.01)  # OCCT boxes are not tight
    stl = lambda c: next(x["sha256"] for x in c["artifacts"] if x["kind"] == "STL")  # noqa: E731
    assert stl(a) != stl(b)
