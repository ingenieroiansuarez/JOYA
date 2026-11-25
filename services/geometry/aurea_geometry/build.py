"""Deterministic BREP generators for hito 000 families.

Internal frame: millimetres, right-handed, Z-up (ENGINE.md).
Anchors are semantic (e.g. ``ring.top``), never transient face indices.
"""
from __future__ import annotations

from dataclasses import dataclass

import cadquery as cq
from OCP.gp import gp_Quaternion, gp_Trsf, gp_Vec


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


GENERATORS = {"ring.classic": _ring_classic, "pendant.01": _pendant_disc}


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
