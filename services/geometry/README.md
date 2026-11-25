# services/geometry — AUREA geometry core (hito 000)

Proof of concept, **not approved for manufacturing**. Turns a `DesignDocument`
(`09_JEWELRY_ENGINE/design.schema.json`) into a BREP solid, STEP/STL (mm),
a GLB preview (metres, Y-up), a manifest and a partial DFM report.

Families: `ring.classic`, `pendant.01` (disc/oval, no bail geometry yet).
Parameter names and ranges come from `11_3D_ASSET_LIBRARY/families.json`
(a test enforces it): `innerDiameter`, `bandWidth`, `radialThickness`;
`width`, `height`, `thickness`.

```bash
python -m venv .venv && . .venv/bin/activate          # Python 3.13
pip install -r services/geometry/requirements.lock
pip install --no-deps -e services/geometry
pytest services/geometry
aurea-geometry 09_JEWELRY_ENGINE/fixtures/ring.json services/geometry/out
```

## What it guarantees
- Schema + semantic validation (ranges, finite numbers, unknown params/families,
  family version, normalized quaternion, dependency cycles, safe ids). Invalid
  input is rejected with codes, never clamped.
- Volume of BREP equals the analytic formula; STEP reimport and STL volume are
  checked against it (DFM-09).
- DFM: DFM-01, DFM-02 (analytic wall for these families), DFM-09 implemented;
  every other rule is `REVIEW`. Missing rule = `REVIEW`, never `PASS`.
  `humanApprovalRequired` is always true.
- STEP files are made reproducible: OCCT's per-process PRODUCT counter is
  replaced with the component id, and `canonicalSha256` hashes the DATA section
  (the HEADER keeps a timestamp). Use `canonicalSha256` for caches/manifests.

## Not covered yet
Settings, stones, engraving, feature operations (refused), Manifold/mesh
sculpture, PBR materials in GLB, FastAPI worker wrapper, job queue.
