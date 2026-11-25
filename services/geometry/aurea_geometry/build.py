"""Deterministic BREP generators for the hito 300 core families.

Internal frame: millimetres, right-handed, Z-up (ENGINE.md).
Anchors are semantic (e.g. ``ring.top``), never transient face indices.
"""
from __future__ import annotations

from dataclasses import dataclass

import cadquery as cq
from OCP.gp import gp_Quaternion, gp_Trsf, gp_Vec

from .families import BAIL_HOLE_MAX_MM, BAIL_HOLE_RATIO, COMFORT_DEPTH_RATIO, COMFORT_MAX_DEPTH_PER_WIDTH


@dataclass
class Anchor:
    name: str
    position: tuple[float, float, float]
    normal: tuple[float, float, float]


@dataclass
class BuiltComponent:
    id: str
    family: str
    material_id: str
    solid: cq.Shape
    anchors: list[Anchor]
    analytic_volume_mm3: float
    min_wall_mm: float


def _ring_classic(p: dict) -> tuple[cq.Shape, list[Anchor], float, float]:
    import math

    r_in = p["innerDiameter"] / 2
    r_out = r_in + p["radialThickness"]
    w = p["bandWidth"]
    solid = cq.Workplane("XY").circle(r_out).circle(r_in).extrude(w).val()
    volume = math.pi * (r_out**2 - r_in**2) * w
    anchors = [
        Anchor("ring.top", (0.0, r_out, w / 2), (0.0, 1.0, 0.0)),
        Anchor("ring.inner", (0.0, r_in, w / 2), (0.0, -1.0, 0.0)),
    ]
    return solid, anchors, volume, min(p["radialThickness"], w)


def _pendant_disc(p: dict) -> tuple[cq.Shape, list[Anchor], float, float]:
    import math

    a, b, t = p["width"] / 2, p["height"] / 2, p["thickness"]
    wp = cq.Workplane("XY")
    sketch = wp.circle(a) if a == b else wp.ellipse(a, b)
    solid = sketch.extrude(t).val()
    volume = math.pi * a * b * t
    # Bail anchor only: the bail itself is a separate future family.
    anchors = [Anchor("pendant.bail", (0.0, b, t / 2), (0.0, 1.0, 0.0))]
    return solid, anchors, volume, t


def comfort_geometry(p: dict) -> tuple[float, float, float, float, float]:
    """ring.02 section: (r_in, r_out, w, dome depth h, arc radius R)."""
    r_in = p["innerDiameter"] / 2
    t = p["radialThickness"]
    w = p["bandWidth"]
    h = min(COMFORT_DEPTH_RATIO * t, COMFORT_MAX_DEPTH_PER_WIDTH * w)
    big_r = (h * h + (w / 2) ** 2) / (2 * h)
    return r_in, r_in + t, w, h, big_r


def comfort_volume(p: dict) -> float:
    """Exact volume of the comfort-fit band.

    The inner surface is a circular arc in the (r, z) section through
    (r_in + h, 0), (r_in, w/2), (r_in + h, w), revolved about Z:
    r(u) = c - sqrt(R^2 - u^2), c = r_in + R, u = z - w/2.
    V = pi * integral(r_out^2 - r(u)^2) du over [-w/2, w/2].
    """
    import math

    r_in, r_out, w, h, big_r = comfort_geometry(p)
    c = r_in + big_r
    s0 = big_r - h  # sqrt(R^2 - (w/2)^2)
    int_s = (w / 2) * s0 + big_r**2 * math.asin(w / (2 * big_r))
    int_s2 = big_r**2 * w - w**3 / 12
    int_r2 = c * c * w - 2 * c * int_s + int_s2
    return math.pi * (r_out**2 * w - int_r2)


def _ring_comfort(p: dict) -> tuple[cq.Shape, list[Anchor], float, float]:
    r_in, r_out, w, h, _ = comfort_geometry(p)
    # Section on XZ (local x = radius, local y = global Z), revolved about Z.
    solid = (
        cq.Workplane("XZ")
        .moveTo(r_in + h, 0)
        .lineTo(r_out, 0)
        .lineTo(r_out, w)
        .lineTo(r_in + h, w)
        .threePointArc((r_in, w / 2), (r_in + h, 0))
        .close()
        .revolve(360, (0, 0, 0), (0, 1, 0))
        .val()
    )
    anchors = [
        Anchor("ring.top", (0.0, r_out, w / 2), (0.0, 1.0, 0.0)),
        Anchor("ring.inner", (0.0, r_in, w / 2), (0.0, -1.0, 0.0)),
    ]
    # Thinnest radial wall is at the band edges, where the dome is deepest.
    return solid, anchors, comfort_volume(p), min(r_out - (r_in + h), w)


def bail_hole(p: dict) -> tuple[float, float]:
    """pendant.02 hole: (diameter, centre y) in mm."""
    d = min(BAIL_HOLE_MAX_MM, BAIL_HOLE_RATIO * p["width"])
    return d, p["height"] / 2 - d


def pendant_oval_min_wall(p: dict, samples: int = 4096) -> float:
    """Thinnest wall: plate thickness or the metal ring around the bail hole.

    Distance from the hole edge to the ellipse outline, sampled on a fixed
    grid of the ellipse parameter (deterministic; an upper bound of the true
    minimum by at most the sampling step).
    """
    import math

    a, b, t = p["width"] / 2, p["height"] / 2, p["thickness"]
    d, yc = bail_hole(p)
    ring = min(
        math.hypot(a * math.cos(th), b * math.sin(th) - yc)
        for th in (2 * math.pi * k / samples for k in range(samples))
    ) - d / 2
    return min(t, ring)


def _pendant_oval(p: dict) -> tuple[cq.Shape, list[Anchor], float, float]:
    import math

    a, b, t = p["width"] / 2, p["height"] / 2, p["thickness"]
    d, yc = bail_hole(p)
    plate = cq.Workplane("XY").ellipse(a, b).extrude(t)
    hole = cq.Workplane("XY").center(0, yc).circle(d / 2).extrude(t)
    solid = plate.cut(hole).val()
    volume = math.pi * a * b * t - math.pi * (d / 2) ** 2 * t
    anchors = [Anchor("pendant.bail", (0.0, yc, t / 2), (0.0, 0.0, 1.0))]
    return solid, anchors, volume, pendant_oval_min_wall(p)


GENERATORS = {
    "ring.classic": _ring_classic,
    "ring.02": _ring_comfort,
    "pendant.01": _pendant_disc,
    "pendant.02": _pendant_oval,
}


def _transform(shape: cq.Shape, anchors: list[Anchor], transform: dict):
    x, y, z, w = transform["rotationQuaternion"]
    trsf = gp_Trsf()
    trsf.SetRotation(gp_Quaternion(x, y, z, w))
    trsf.SetTranslationPart(gp_Vec(*transform["translation"]))
    loc = cq.Location(trsf)
    moved = shape.moved(loc)

    def tp(pt):
        v = cq.Vector(*pt).transform(cq.Matrix(trsf))
        return (v.x, v.y, v.z)

    rot = gp_Trsf()
    rot.SetRotation(gp_Quaternion(x, y, z, w))

    def tn(n):
        v = cq.Vector(*n).transform(cq.Matrix(rot))
        return (v.x, v.y, v.z)

    return moved, [Anchor(a.name, tp(a.position), tn(a.normal)) for a in anchors]


def build_component(component: dict) -> BuiltComponent:
    gen = GENERATORS[component["family"]]
    solid, anchors, volume, min_wall = gen(component["parameters"])
    solid, anchors = _transform(solid, anchors, component["transform"])
    return BuiltComponent(
        id=component["id"],
        family=component["family"],
        material_id=component["materialId"],
        solid=solid,
        anchors=anchors,
        analytic_volume_mm3=volume,
        min_wall_mm=min_wall,
    )
