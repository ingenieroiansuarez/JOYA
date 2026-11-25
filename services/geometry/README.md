# services/geometry — AUREA geometry core (hito 300)

Proof of concept, **not approved for manufacturing**. Turns a `DesignDocument`
(`09_JEWELRY_ENGINE/design.schema.json`) into a BREP solid, STEP/STL (mm),
a GLB preview (metres, Y-up), a manifest and a partial DFM report.

Families (parameter names and ranges from `11_3D_ASSET_LIBRARY/families.json`,
enforced by a test):

| Family | Shape | Parameters (mm) | Exact volume |
|---|---|---|---|
| `ring.classic` | flat band | `innerDiameter`, `bandWidth`, `radialThickness` | annulus × width |
| `ring.02` | comfort fit: inner surface is a circular arc, crest at `innerDiameter` | same | Pappus integral, closed form (`comfort_volume`) |
| `pendant.01` | disc / ellipse plate | `width`, `height`, `thickness` | π·a·b·t |
| `pendant.02` | oval plate with a through hole for the jump ring | same | π·a·b·t − π·r²·t |

Fixed family choices (not user parameters, to be confirmed by the jeweller):
comfort dome depth = min(0.35 × thickness, 0.25 × width); bail hole diameter =
min(2 mm, 0.2 × width), centred one diameter below the top edge. The wall
around the hole is measured on a 4096-point sample of the outline, so a
narrow, tall oval reports a thin wall in DFM-02 instead of hiding it.

```bash
python -m venv .venv && . .venv/bin/activate          # Python 3.13
pip install -r services/geometry/requirements.lock
pip install --no-deps -e services/geometry
pytest services/geometry
aurea-geometry 09_JEWELRY_ENGINE/fixtures/ring.json services/geometry/out
```

## Worker (internal HTTP)
`aurea-geometry-worker` serves `POST /v1/regenerate` (`{jobId, document}` →
manifest + every file base64 with SHA-256 and size) and `GET /healthz`. Only
the API calls it:
- Every request is signed: header `X-Aurea-Signature: t=<unix>,v1=<hex>` with
  HMAC-SHA256 of `t.POST./v1/regenerate.` + body and `GEOMETRY_WORKER_SECRET`
  (≥ 32 chars; without it the worker refuses to start). Clock skew > 300 s is
  rejected. Binds to `127.0.0.1:3910` by default.
- Body ≤ 1 MB. The document is validated again (422 `INVALID_DOCUMENT` with
  detail codes). Each job runs in a child process (fork server that preloads
  the CAD kernel; spawn on Windows) with a wall-clock timeout
  (`GEOMETRY_JOB_TIMEOUT_S`, 60) → 504 `GEOMETRY_TIMEOUT`, plus CPU and memory
  limits where the OS has them (`GEOMETRY_JOB_MEMORY_MB`, 2048) → 500
  `GEOMETRY_FAILED` without internal details. At most
  `GEOMETRY_WORKER_CONCURRENCY` (2) jobs at once, else 503 with `Retry-After`.
- Stateless: no database, no files kept. The API stores the returned files by
  hash and owns job state.

```bash
GEOMETRY_WORKER_SECRET=... aurea-geometry-worker
```

## Canonical digest
`inputDigest` is SHA-256 over canonical JSON (RFC 8785 subset: sorted keys,
ECMAScript number formatting), the same bytes the TypeScript side hashes.
`09_JEWELRY_ENGINE/fixtures/digests.json` holds reference cases written by
Node; both sides must match them.

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
sculpture, PBR materials in GLB. The worker is plain `http.server` (stdlib),
not FastAPI: one endpoint, no extra dependencies to license.
