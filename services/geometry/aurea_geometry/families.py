"""Family parameter specs for the hito 300 core families (ring and pendant).

Canonical parameter names and exploration ranges are copied from
11_3D_ASSET_LIBRARY/families.json; tests/test_families.py asserts they stay
identical. Ranges are exploration limits, NOT manufacturing minimums.
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class ParamSpec:
    minimum: float
    maximum: float
    default: float
    unit: str = "mm"


@dataclass(frozen=True)
class FamilySpec:
    id: str
    version: str
    category: str
    params: dict[str, ParamSpec]
    # Parameters that bound the thinnest wall for analytic DFM-02.
    wall_params: tuple[str, ...]


FAMILIES: dict[str, FamilySpec] = {
    "ring.classic": FamilySpec(
        id="ring.classic",
        version="0.1.0",
        category="ring",
        params={
            "innerDiameter": ParamSpec(14.0, 24.0, 18.0),
            "bandWidth": ParamSpec(1.5, 12.0, 4.0),
            "radialThickness": ParamSpec(0.8, 4.0, 1.8),
        },
        wall_params=("radialThickness", "bandWidth"),
    ),
    "ring.02": FamilySpec(
        id="ring.02",
        version="0.1.0",
        category="ring",
        params={
            "innerDiameter": ParamSpec(14.0, 24.0, 18.0),
            "bandWidth": ParamSpec(1.5, 12.0, 4.0),
            "radialThickness": ParamSpec(0.8, 4.0, 1.8),
        },
        wall_params=("radialThickness", "bandWidth"),
    ),
    "pendant.01": FamilySpec(
        id="pendant.01",
        version="0.1.0",
        category="pendant",
        params={
            "width": ParamSpec(5.0, 60.0, 20.0),
            "height": ParamSpec(5.0, 70.0, 25.0),
            "thickness": ParamSpec(0.8, 6.0, 2.0),
        },
        wall_params=("thickness",),
    ),
    "pendant.02": FamilySpec(
        id="pendant.02",
        version="0.1.0",
        category="pendant",
        params={
            "width": ParamSpec(5.0, 60.0, 20.0),
            "height": ParamSpec(5.0, 70.0, 25.0),
            "thickness": ParamSpec(0.8, 6.0, 2.0),
        },
        wall_params=("thickness",),
    ),
}

# ring.02: depth of the comfort-fit dome = min(COMFORT_DEPTH_RATIO * radialThickness,
# COMFORT_MAX_DEPTH_PER_WIDTH * bandWidth). Fixed by the family (not a user
# parameter). The width cap keeps the arc flatter than a half circle on narrow,
# thick bands. Design choice, not a standard.
COMFORT_DEPTH_RATIO = 0.35
COMFORT_MAX_DEPTH_PER_WIDTH = 0.25

# pendant.02: through hole for the jump ring (the bail is a future family).
# Diameter = min(BAIL_HOLE_MAX_MM, BAIL_HOLE_RATIO * width); centre sits one
# hole diameter below the top edge, so the metal above the hole equals the
# hole radius. Design choice to be confirmed by the jeweller.
BAIL_HOLE_MAX_MM = 2.0
BAIL_HOLE_RATIO = 0.2
