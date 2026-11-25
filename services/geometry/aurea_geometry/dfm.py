"""Minimal DFM evaluation for hito 000 (subset of 10_CAD_AND_GEOMETRY/DFM.md).

Implemented: DFM-01 (solid validity / watertight), DFM-02 (min wall, analytic
for parametric families only), DFM-09 (export roundtrip tolerance).
Everything else is REVIEW, never PASS. Human approval is always required,
even when every implemented check passes.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

RULES_VERSION = "dfm-poc-0.1.0"
STEP_VOLUME_REL_TOL = 1e-6
STL_VOLUME_REL_TOL = 5e-3  # chordal error of STL_TOLERANCE_MM on small parts

NOT_IMPLEMENTED = ["DFM-03", "DFM-04", "DFM-05", "DFM-06", "DFM-07", "DFM-08", "DFM-10"]


@dataclass
class Finding:
    rule: str
    component: str
    result: str  # PASS | FAIL | REVIEW
    severity: str  # BLOCK | WARN | REVIEW
    method: str
    measured: float | None
    threshold: float | None
    unit: str | None
    message: str


def evaluate(document: dict, built: list, exports: dict[str, dict]) -> dict:
    findings: list[Finding] = []
    walls = {
        c["target"]: float(c["parameters"]["minMm"])
        for c in document["constraints"]
        if c["type"] == "min_wall"
    }
    for comp in built:
        rt = exports[comp.id]["roundtrip"]
        ok = comp.solid.isValid() and rt["stepValid"] and rt["stlWatertight"] and rt["stlWindingConsistent"]
        findings.append(Finding(
            "DFM-01", comp.id, "PASS" if ok else "FAIL", "BLOCK",
            "OCCT BRepCheck isValid + trimesh watertight/winding on STL", None, None, None,
            "solid valid and closed" if ok else "invalid or open geometry"))

        if comp.id in walls:
            thr = walls[comp.id]
            passed = comp.min_wall_mm >= thr
            findings.append(Finding(
                "DFM-02", comp.id, "PASS" if passed else "FAIL", "BLOCK",
                "analytic from family parameters (exact for this family; not a distance field)",
                comp.min_wall_mm, thr, "mm",
                "wall above minimum" if passed else "wall below minimum"))
        else:
            findings.append(Finding(
                "DFM-02", comp.id, "REVIEW", "REVIEW", "none", comp.min_wall_mm, None, "mm",
                "no min_wall rule for this component/process/alloy; cannot pass"))

        exp = comp.analytic_volume_mm3
        d_step = abs(rt["stepVolumeMm3"] - exp) / exp
        d_stl = abs(rt["stlVolumeMm3"] - exp) / exp
        passed = d_step <= STEP_VOLUME_REL_TOL and d_stl <= STL_VOLUME_REL_TOL
        findings.append(Finding(
            "DFM-09", comp.id, "PASS" if passed else "FAIL", "BLOCK",
            "STEP reimport and STL volume vs analytic volume (relative error)",
            max(d_step, d_stl), STL_VOLUME_REL_TOL, "ratio",
            f"step rel err {d_step:.2e}, stl rel err {d_stl:.2e}"))

        for rule in NOT_IMPLEMENTED:
            findings.append(Finding(rule, comp.id, "REVIEW", "REVIEW", "not implemented in hito 000",
                                    None, None, None, "requires implementation or human review"))

    if any(f.result == "FAIL" and f.severity == "BLOCK" for f in findings):
        state = "FAIL"
    elif any(f.result == "REVIEW" for f in findings):
        state = "REVIEW"
    elif any(f.result == "FAIL" for f in findings):
        state = "WARN"
    else:
        state = "PASS"
    return {
        "rulesVersion": RULES_VERSION,
        "state": state,
        "humanApprovalRequired": True,
        "findings": [asdict(f) for f in findings],
    }
