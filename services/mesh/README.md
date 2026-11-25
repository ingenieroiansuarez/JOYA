# services/mesh — AUREA AI mesh adapter (hito 000, P0-06)

Proof of concept for generative route B (`12_AI_ORCHESTRATION/AI_ARCHITECTURE.md`):
concept → mesh from a provider (async) → import, scale and repair → DFM → manual review.
**A generated mesh is a concept, not certified CAD.** Every report carries
`status: CONCEPT_MESH_NOT_CERTIFIED_CAD`, `fabricable: false` and
`humanReviewRequired: true`.

```bash
python -m venv .venv && . .venv/bin/activate          # Python 3.13
pip install -r services/mesh/requirements.lock
pip install --no-deps -e services/mesh
pytest services/mesh
aurea-mesh services/mesh/out --target-mm 24 --confirmed-by joyero
```

## Contents
- `adapter.py`: contract (`capabilities`, `health`, `estimate_cost`, `generate`,
  `poll`, `cancel`, `result`), request validation and registry record fields.
  Commercial terms the provider has not confirmed stay `None`.
- `simulated.py`: deterministic simulated provider with a "SIMULADO" banner.
  Idempotent per key (same key + same request = same job, no second charge;
  same key + different request = `IDEMPOTENCY_CONFLICT`), cancel, failure path.
- `registry.py`: fails closed. The simulator is refused in `production`; any real
  provider (Meshy, Tripo, ...) returns `PROVIDER_NOT_CONFIGURED`.
- `fixture.py`: original torus with typical provider defects (unitless scale, Y-up,
  unmerged vertices, flipped faces, holes, degenerate and duplicate triangles,
  floating fragment).
- `normalize.py`: GLB → Z-up → repair (merge, degenerate/duplicate removal,
  fragment removal, normals, hole filling) → **explicit scale** (a person-confirmed
  size in mm; never guessed) → DFM-01 → STL (mm) + preview GLB (m, Y-up) + report
  with SHA-256 of every artifact.

## DFM
DFM-01 is `BLOCK` if the repaired mesh is not a closed, consistently wound volume,
otherwise `REVIEW` (self-intersections are not measured). DFM-02..10 are `REVIEW`.
Nothing here ever returns `PASS`. Volume is reported only for closed meshes.

## Not covered
Any real provider (needs ian's permission, verified terms and credentials; none are
in this repo), persisted jobs and quota ledger (the simulator keeps state in memory),
self-intersection test, OBJ/FBX input, mesh-to-BREP conversion, thickness analysis.
