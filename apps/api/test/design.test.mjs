// Hito 300 design API against a real PostgreSQL (TEST_DATABASE_URL) and a geometry worker.
// By default the worker is a fake that checks the signature and returns deterministic files; set
// AUREA_REAL_WORKER_URL and AUREA_REAL_WORKER_SECRET to run the same tests against
// services/geometry (real BREP), which is how the hito evidence is produced.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import pg from "pg";
import { parse } from "yaml";
import { runMigrations } from "@aurea/db/src/migrate.mjs";

const require = createRequire(import.meta.url);
const { createApp } = require("../dist/app.js");
const { createVerifier } = require("../dist/identity/verifier.js");
const { loadDesignConfig } = require("../dist/design/config.js");
const { JobRunner } = require("../dist/design/jobs.js");
const { ArtifactStore } = require("../dist/design/store.js");
const { GeometryWorker } = require("../dist/design/worker-client.js");
const { massGrams } = require("../dist/design/decimal.js");

const ROOT = new URL("../../../", import.meta.url);
const api = parse(readFileSync(new URL("06_API_CONTRACTS/openapi.yaml", ROOT), "utf8"), { maxAliasCount: -1 });
const ajv = new Ajv({ strict: false });
addFormats(ajv);
ajv.addSchema({ $id: "openapi", components: api.components });
const schema = (name) => ajv.compile({ $ref: `openapi#/components/schemas/${name}` });
const V = Object.fromEntries(["Project", "ProjectPage", "Revision", "RevisionPage", "Job", "ArtifactDownload", "FamilyCatalog", "Error", "SyncResult", "Event", "RevisionCreatedPayload"]
  .map((n) => [n, schema(n)]));
const valid = (name, body) => assert.ok(V[name](body), `${name}: ${JSON.stringify(V[name].errors)}\n${JSON.stringify(body).slice(0, 600)}`);

const ADMIN = process.env.TEST_DATABASE_URL;
const skip = ADMIN ? false : "TEST_DATABASE_URL not set";
const DB = `aurea_t_design_${process.pid}_${Date.now()}`;
const dbUrl = () => { const u = new URL(ADMIN); u.pathname = `/${DB}`; return u.toString(); };
async function admin(sql) {
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

const REAL = process.env.AUREA_REAL_WORKER_URL;
const WORKER_SECRET = process.env.AUREA_REAL_WORKER_SECRET ?? "w".repeat(40);
const FILE_SECRET = "f".repeat(40);
const RETRY_MS = 100;
const ISSUER = "http://127.0.0.1:1/realms/test";
const ALICE = "3c1e9f50-0000-4000-8000-00000000a11c";
const BOB = "3c1e9f50-0000-4000-8000-000000000b0b";

// ---- fake worker: same signature scheme as services/geometry, deterministic files
const fake = { calls: 0, mode: "ok", failuresLeft: 0 };
function ringVolume(p) {
  const ri = p.innerDiameter / 2, ro = ri + p.radialThickness;
  return Math.PI * (ro * ro - ri * ri) * p.bandWidth;
}
function fakeWorker() {
  return createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const sig = Object.fromEntries((req.headers["x-aurea-signature"] ?? "").split(",").map((kv) => kv.split("=")));
      const mac = createHmac("sha256", WORKER_SECRET).update(Buffer.concat([Buffer.from(`${sig.t}.POST./v1/regenerate.`), body])).digest("hex");
      const send = (status, json) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };
      if (mac !== sig.v1) return send(401, { code: "UNAUTHENTICATED", details: [] });
      fake.calls++;
      if (fake.failuresLeft > 0) {
        fake.failuresLeft--;
        if (fake.mode === "busy") return send(503, { code: "SERVICE_UNAVAILABLE", details: [] });
        if (fake.mode === "timeout") return send(504, { code: "GEOMETRY_TIMEOUT", details: [] });
      }
      const { document } = JSON.parse(body);
      const c = document.components[0];
      const pendant = c.family.startsWith("pendant");
      const q = c.parameters;
      const vol = pendant ? Math.PI * (q.width / 2) * (q.height / 2) * q.thickness : ringVolume(q);
      const file = (name, kind, units, text) => {
        const data = Buffer.from(text);
        return { name, kind, units, sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length, contentBase64: data.toString("base64") };
      };
      const tag = JSON.stringify(c.parameters) + c.materialId;
      const r = pendant ? Math.max(q.width, q.height) / 2 : q.innerDiameter / 2 + q.radialThickness;
      send(200, {
        jobId: "x",
        manifest: {
          status: "POC_ONLY_NOT_APPROVED_FOR_MANUFACTURING", engineVersion: "fake/0", kernelVersion: "fake", inputDigest: "0".repeat(64),
          components: [{ id: c.id, family: c.family, materialId: c.materialId, brepVolumeMm3: vol, analyticVolumeMm3: vol,
            boundingBoxMm: [[-r, -r, 0], [r, r, pendant ? q.thickness : q.bandWidth]] }],
          dfm: { state: "REVIEW", humanApprovalRequired: true, findings: [{ rule: "DFM-02", component: c.id, measured: pendant ? q.thickness : q.radialThickness }] },
        },
        files: [file(`${c.id}.step`, "STEP", "mm", `STEP ${tag}`), file(`${c.id}.stl`, "STL", "mm", `STL ${tag}`),
          file(`${c.id}.glb`, "GLB_PREVIEW", "m", `GLB ${tag}`), file("dfm.json", "DFM_REPORT", "none", "{}"), file("manifest.json", "MANIFEST", "none", `{"t":${JSON.stringify(tag)}}`)],
      });
    });
  });
}

let key, s, runner, workerServer, artifactDir, pool;
const token = (sub, roles = ["customer"]) => new SignJWT({ realm_access: { roles } })
  .setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ISSUER).setAudience("aurea-api").setSubject(sub)
  .setIssuedAt().setExpirationTime("5m").sign(key.privateKey);
async function call(method, path, { sub = ALICE, roles, body, idem = method === "POST" ? randomUUID() : undefined, raw } = {}) {
  const headers = { "content-type": "application/json" };
  if (sub) headers.authorization = `Bearer ${await token(sub, roles)}`;
  if (idem) headers["idempotency-key"] = idem;
  const r = await fetch(s.url(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: raw ? Buffer.from(await r.arrayBuffer()) : await r.json().catch(() => null), headers: r.headers };
}
const newProject = async (sub = ALICE, templateId = "ring.classic", title = "Anillo de prueba") =>
  call("POST", "/v1/projects", { sub, body: { title, templateId, materialId: "gold-18k-yellow" } });
const modify = (name, value, componentId = "ring-base") => ({ type: "modify_parameter", componentId, name, value });

async function previewAndWait(projectId, baseRevisionId, operation) {
  const r = await call("POST", `/v1/projects/${projectId}/operations`, { body: { baseRevisionId, operation } });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  return settle(r.body.id);
}

/** Drain until the job is final; retries after a busy worker wait out their backoff first. */
async function settle(jobId, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    await runner.drain();
    const job = (await call("GET", `/v1/jobs/${jobId}`)).body;
    if (!["QUEUED", "RUNNING"].includes(job.state)) return job;
    assert.ok(Date.now() < deadline, `job still ${job.state}`);
    await new Promise((res) => setTimeout(res, 25));
  }
}

describe("design API (hito 300)", { skip }, () => {
  before(async () => {
    await admin(`CREATE DATABASE ${DB}`);
    await runMigrations(dbUrl());
    key = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(key.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    artifactDir = mkdtempSync(join(tmpdir(), "aurea-art-"));
    let workerUrl = REAL;
    if (!REAL) {
      workerServer = fakeWorker();
      await new Promise((r) => workerServer.listen(0, "127.0.0.1", r));
      workerUrl = `http://127.0.0.1:${workerServer.address().port}`;
    }
    const design = loadDesignConfig({ GEOMETRY_WORKER_URL: workerUrl, GEOMETRY_WORKER_SECRET: WORKER_SECRET, FILE_URL_SECRET: FILE_SECRET, ARTIFACT_DIR: artifactDir }, "ci");
    const config = { env: "ci", port: 0, databaseUrl: dbUrl(), valkeyUrl: "redis://127.0.0.1:1", oidc: { issuer: ISSUER, audience: "aurea-api" }, design };
    pool = new pg.Pool({ connectionString: dbUrl() });
    const app = await createApp(config, { check: async () => ({}), close: async () => {} },
      await createVerifier(config, createLocalJWKSet({ keys: [jwk] })), [], pool);
    await app.listen(0, "127.0.0.1");
    const { port } = app.getHttpServer().address();
    s = { app, url: (p) => `http://127.0.0.1:${port}${p}` };
    runner = new JobRunner(pool, new GeometryWorker(workerUrl, WORKER_SECRET, 120_000), new ArtifactStore(artifactDir), RETRY_MS);
  });
  after(async () => {
    await s?.app.close();
    workerServer?.close();
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    if (artifactDir) rmSync(artifactDir, { recursive: true, force: true });
  });

  test("families and alloys are public and follow the contract", async () => {
    const r = await call("GET", "/v1/geometry/families", { sub: null });
    assert.equal(r.status, 200);
    valid("FamilyCatalog", r.body);
    assert.deepEqual(r.body.items.map((f) => f.id), ["ring.classic", "ring.02", "pendant.01", "pendant.02"]);
    assert.ok(r.body.materials.every((m) => m.densityStatus === "NOMINAL_UNCONFIRMED"));
  });

  test("a guest cannot create or read projects", async () => {
    assert.equal((await call("POST", "/v1/projects", { sub: null, body: {} })).status, 401);
    assert.equal((await call("GET", "/v1/projects", { roles: ["guest"] })).status, 403);
  });

  test("create a project: revision 1 with family defaults, idempotent, private to its owner", async () => {
    const idem = randomUUID();
    const body = { title: "Mi anillo", templateId: "ring.02", materialId: "gold-18k-rose" };
    const a = await call("POST", "/v1/projects", { body, idem });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    valid("Project", a.body);
    assert.equal(a.body.headRevisionNumber, 1);
    const again = await call("POST", "/v1/projects", { body, idem });
    assert.deepEqual(again.body, a.body, "same key + same body = same project");
    const other = await call("POST", "/v1/projects", { body: { ...body, title: "Otro" }, idem });
    assert.equal(other.status, 409);
    assert.equal(other.body.code, "IDEMPOTENCY_CONFLICT");
    assert.equal((await call("POST", "/v1/projects", { body: { ...body, title: "Sin clave" }, idem: null })).status, 400);
    const rev = await call("GET", `/v1/projects/${a.body.id}/revisions/${a.body.headRevisionId}`);
    valid("Revision", rev.body);
    assert.deepEqual(rev.body.document.components[0].parameters, { innerDiameter: 18, bandWidth: 4, radialThickness: 1.8 });
    assert.equal(rev.body.document.components[0].materialId, "gold-18k-rose");
    assert.match(rev.body.digest, /^[0-9a-f]{64}$/);
    assert.equal((await call("GET", `/v1/projects/${a.body.id}`, { sub: BOB })).status, 404, "another customer sees nothing");
    const list = await call("GET", "/v1/projects");
    valid("ProjectPage", list.body);
    assert.ok(list.body.items.some((p) => p.id === a.body.id));
    assert.ok(!(await call("GET", "/v1/projects", { sub: BOB })).body.items.some((p) => p.id === a.body.id));
  });

  for (const [what, body, code] of [
    ["unknown family", { title: "x", templateId: "ring.99", materialId: "gold-18k-yellow" }, "UNKNOWN_FAMILY"],
    ["unknown alloy", { title: "x", templateId: "ring.classic", materialId: "gold-24k" }, "UNKNOWN_MATERIAL"],
  ]) {
    test(`create rejects ${what}`, async () => {
      const r = await call("POST", "/v1/projects", { body });
      assert.equal(r.status, 422);
      valid("Error", r.body);
      assert.equal(r.body.details[0].code, code);
    });
  }

  test("invalid operations are rejected with codes and create nothing", async () => {
    const p = (await newProject()).body;
    for (const [op, status, code, detail] of [
      [modify("innerDiameter", 40), 422, "INVALID_DOCUMENT", "OUT_OF_RANGE"],
      [modify("bandWidth", "4"), 422, "INVALID_DOCUMENT", "NOT_A_NUMBER"],
      [modify("height", 10), 422, "INVALID_DOCUMENT", "UNKNOWN_PARAMETER"],
      [{ type: "boolean_union", componentIds: ["a", "b"] }, 422, "INVALID_DOCUMENT", "UNSUPPORTED_OPERATION"],
      [modify("innerDiameter", 18), 422, "INVARIANT_VIOLATED", "NO_CHANGE"],
    ]) {
      const r = await call("POST", `/v1/projects/${p.id}/operations`, { body: { baseRevisionId: p.headRevisionId, operation: op } });
      assert.equal(r.status, status, JSON.stringify(op));
      valid("Error", r.body);
      assert.equal(r.body.code, code);
      assert.equal(r.body.details[0].code, detail);
    }
    const stale = await call("POST", `/v1/projects/${p.id}/operations`, { body: { baseRevisionId: randomUUID(), operation: modify("bandWidth", 5) } });
    assert.equal(stale.status, 409);
    const n = await pool.query("SELECT count(*)::int AS n FROM aurea.job WHERE project_id = $1", [p.id]);
    assert.equal(n.rows[0].n, 0);
  });

  test("parameter update → preview with real result → accepted revision 2", async () => {
    const p = (await newProject()).body;
    const job = await previewAndWait(p.id, p.headRevisionId, modify("innerDiameter", 19.5));
    valid("Job", job);
    assert.equal(job.state, "SUCCEEDED", JSON.stringify(job));
    assert.equal(job.kind, "PREVIEW");
    assert.deepEqual(job.summary.changes, [{ componentId: "ring-base", name: "innerDiameter", from: 18, to: 19.5 }]);
    const c = job.summary.components[0];
    const expected = ringVolume({ innerDiameter: 19.5, bandWidth: 4, radialThickness: 1.8 });
    // volumeMm3 is a decimal string to 0.001 mm³; the real kernel adds tessellation-free BREP error.
    assert.match(c.volumeMm3, /^\d+\.\d{3}$/);
    assert.ok(Math.abs(Number(c.volumeMm3) - expected) <= (REAL ? 1e-3 * expected : 0.0005), `${c.volumeMm3} vs ${expected}`);
    assert.equal(c.massGramsEstimate, massGrams(Number(c.volumeMm3), "15.5"));
    assert.equal(job.summary.humanApprovalRequired, true);
    assert.deepEqual(job.artifacts.map((a) => a.kind).sort(), ["DFM_REPORT", "GLB_PREVIEW", "MANIFEST", "STEP", "STL"]);
    // Nothing changed yet: a preview never moves the head.
    assert.equal((await call("GET", `/v1/projects/${p.id}`)).body.headRevisionNumber, 1);

    const refused = await call("POST", `/v1/projects/${p.id}/revisions`, { body: { baseRevisionId: p.headRevisionId, previewJobId: job.id, accepted: false } });
    assert.equal(refused.status, 422);
    const idem = randomUUID();
    const rev = await call("POST", `/v1/projects/${p.id}/revisions`, { body: { baseRevisionId: p.headRevisionId, previewJobId: job.id, accepted: true }, idem });
    assert.equal(rev.status, 200, JSON.stringify(rev.body));
    valid("Revision", rev.body);
    assert.equal(rev.body.number, 2);
    assert.equal(rev.body.parentId, p.headRevisionId);
    assert.equal(rev.body.document.components[0].parameters.innerDiameter, 19.5);
    const again = await call("POST", `/v1/projects/${p.id}/revisions`, { body: { baseRevisionId: p.headRevisionId, previewJobId: job.id, accepted: true }, idem });
    assert.deepEqual(again.body, rev.body, "retry returns the same revision");
    const dup = await call("POST", `/v1/projects/${p.id}/revisions`, { body: { baseRevisionId: p.headRevisionId, previewJobId: job.id, accepted: true } });
    assert.equal(dup.status, 409, "a second acceptance on the old base conflicts");
    const list = await call("GET", `/v1/projects/${p.id}/revisions`);
    valid("RevisionPage", list.body);
    assert.deepEqual(list.body.items.map((r) => [r.number, r.source]), [[2, "PREVIEW"], [1, "CREATE"]]);
    assert.deepEqual(list.body.items[0].changes, [{ componentId: "ring-base", name: "innerDiameter", from: 18, to: 19.5 }]);
    // The stored revision cannot be altered, even directly in the database.
    await assert.rejects(pool.query("UPDATE aurea.revision SET document = '{}' WHERE id = $1", [rev.body.id]), /immutable/);
  });

  test("artifacts download through a short signed URL only", async () => {
    const p = (await newProject()).body;
    const job = await previewAndWait(p.id, p.headRevisionId, modify("bandWidth", 5));
    const stl = job.artifacts.find((a) => a.kind === "STL");
    const dl = await call("GET", `/v1/jobs/${job.id}/artifacts/${stl.id}`);
    valid("ArtifactDownload", dl.body);
    const got = await fetch(dl.body.url);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("content-type"), "model/stl");
    const bytes = Buffer.from(await got.arrayBuffer());
    assert.equal(createHash("sha256").update(bytes).digest("hex"), stl.sha256);
    const u = new URL(dl.body.url);
    const tampered = new URL(u); tampered.searchParams.set("exp", String(Number(u.searchParams.get("exp")) + 1));
    assert.equal((await fetch(tampered)).status, 403);
    const expired = new URL(u); const old = Math.floor(Date.now() / 1000) - 10;
    expired.searchParams.set("exp", String(old));
    expired.searchParams.set("sig", createHmac("sha256", FILE_SECRET).update(`files.${stl.sha256}.${old}`).digest("hex"));
    assert.equal((await fetch(expired)).status, 403);
    assert.equal((await call("GET", `/v1/jobs/${job.id}/artifacts/${stl.id}`, { sub: BOB })).status, 404);
    assert.equal((await call("GET", `/v1/jobs/${job.id}`, { sub: BOB })).status, 404);
  });

  test("export a revision: STEP and STL in mm, reused for the same digest", async () => {
    const p = (await newProject()).body;
    const first = await call("POST", "/v1/geometry/jobs", { body: { revisionId: p.headRevisionId, quality: "INTERACTIVE" } });
    assert.equal(first.status, 202);
    valid("Job", first.body);
    const before = fake.calls;
    await runner.drain();
    const done = (await call("GET", `/v1/jobs/${first.body.id}`)).body;
    assert.equal(done.state, "SUCCEEDED");
    const units = Object.fromEntries(done.artifacts.map((a) => [a.kind, a.units]));
    assert.deepEqual([units.STEP, units.STL, units.GLB_PREVIEW], ["mm", "mm", "m"]);
    const second = await call("POST", "/v1/geometry/jobs", { body: { revisionId: p.headRevisionId, quality: "INTERACTIVE" } });
    await runner.drain();
    const reused = (await call("GET", `/v1/jobs/${second.body.id}`)).body;
    assert.equal(reused.state, "SUCCEEDED");
    assert.deepEqual(reused.artifacts.map((a) => a.sha256).sort(), done.artifacts.map((a) => a.sha256).sort());
    if (!REAL) assert.equal(fake.calls, before + 1, "second export reused the first result");
    assert.equal((await call("POST", "/v1/geometry/jobs", { sub: BOB, body: { revisionId: p.headRevisionId, quality: "INTERACTIVE" } })).status, 404);
  });

  test("worker busy is retried; timeout fails the job with its code", { skip: REAL ? "fake worker only" : false }, async () => {
    const p = (await newProject()).body;
    fake.mode = "busy"; fake.failuresLeft = 2;
    const queued = await call("POST", `/v1/projects/${p.id}/operations`, { body: { baseRevisionId: p.headRevisionId, operation: modify("bandWidth", 6) } });
    const started = Date.now();
    await runner.drain();
    // Not re-claimed in a tight loop: after one busy answer the job waits out its backoff.
    assert.equal((await call("GET", `/v1/jobs/${queued.body.id}`)).body.state, "QUEUED");
    assert.equal(fake.failuresLeft, 1);
    let job = await settle(queued.body.id);
    assert.equal(job.state, "SUCCEEDED");
    assert.ok(Date.now() - started >= RETRY_MS * 3, "backoff 100 ms then 200 ms before the third attempt");
    fake.mode = "busy"; fake.failuresLeft = 3;
    job = await previewAndWait(p.id, p.headRevisionId, modify("bandWidth", 6.5));
    assert.deepEqual([job.state, job.errorCode], ["FAILED", "SERVICE_UNAVAILABLE"], "gives up after 3 attempts");
    fake.mode = "timeout"; fake.failuresLeft = 1;
    job = await previewAndWait(p.id, p.headRevisionId, modify("bandWidth", 7));
    assert.equal(job.state, "FAILED");
    assert.equal(job.errorCode, "GEOMETRY_TIMEOUT");
    assert.deepEqual(job.artifacts, []);
    fake.mode = "ok";
  });

  test("offline sync: apply, dedupe, rebase independent values, conflict on the same value, keep order", async () => {
    const p = (await newProject()).body;
    const base = p.headRevisionId;
    const deviceId = randomUUID();
    const op = (operation, seq, baseRevisionId = base, id = randomUUID()) =>
      ({ id, projectId: p.id, branch: "main", baseRevisionId, sequence: seq, createdAt: new Date().toISOString(), operation });
    const push = (operations, sub = ALICE) => call("POST", "/v1/sync/push", { sub, body: { deviceId, operations } });

    const o1 = op(modify("bandWidth", 5), 1);
    const r1 = await push([o1]);
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    valid("SyncResult", r1.body);
    assert.equal(r1.body.results[0].status, "APPLIED");
    const rev2 = r1.body.results[0].revisionId;
    assert.deepEqual((await push([o1])).body.results[0], r1.body.results[0], "resending returns the original result");
    assert.equal((await call("GET", `/v1/projects/${p.id}`)).body.headRevisionNumber, 2, "no duplicate revision");
    const same = await push([{ ...o1, operation: modify("bandWidth", 6) }]);
    assert.deepEqual([same.body.results[0].status, same.body.results[0].error.code], ["REJECTED", "IDEMPOTENCY_CONFLICT"]);

    // Made offline on revision 1 while revision 2 changed bandWidth: diameter is independent → rebased.
    const indep = await push([op(modify("innerDiameter", 20), 2)]);
    assert.equal(indep.body.results[0].status, "APPLIED");
    const head = (await call("GET", `/v1/projects/${p.id}/revisions/${indep.body.results[0].revisionId}`)).body;
    assert.deepEqual(head.document.components[0].parameters, { innerDiameter: 20, bandWidth: 5, radialThickness: 1.8 });
    assert.equal(head.number, 3);

    // Also on revision 1, but bandWidth changed since: conflict, and the next one waits behind it.
    const clash = op(modify("bandWidth", 8), 3);
    const after = op(modify("radialThickness", 2), 4, head.id);
    const r = await push([clash, after]);
    assert.deepEqual(r.body.results.map((x) => x.status), ["CONFLICT", "CONFLICT"]);
    assert.equal(r.body.results[0].serverRevisionId, head.id);
    assert.equal((await call("GET", `/v1/projects/${p.id}`)).body.headRevisionNumber, 3, "no last-write-wins");
    // Alone, the second one applies (it was not stored as a conflict).
    assert.equal((await push([after])).body.results[0].status, "APPLIED");

    // A value changed on the server and changed back (net difference empty) was still written:
    // an offline edit of it made before those writes conflicts.
    const q = (await call("GET", `/v1/projects/${p.id}`)).body;
    const round1 = await push([op(modify("bandWidth", 9), 10, q.headRevisionId)]);
    const round2 = await push([op(modify("bandWidth", 5), 11, round1.body.results[0].revisionId)]);
    assert.deepEqual([round1, round2].map((x) => x.body.results[0].status), ["APPLIED", "APPLIED"]);
    const stale = await push([op(modify("bandWidth", 7), 12, q.headRevisionId)]);
    assert.equal(stale.body.results[0].status, "CONFLICT", "5 → 9 → 5 round trips are not erased");
    const fresh = await push([op(modify("innerDiameter", 21), 13, q.headRevisionId)]);
    assert.equal(fresh.body.results[0].status, "APPLIED", "an untouched value still rebases across them");

    // Two pushes of the same operation at once: one result, no 500, no second revision.
    const twin = op(modify("radialThickness", 1.9), 14, q.headRevisionId);
    const both = await Promise.all([push([twin]), push([twin])]);
    assert.deepEqual(both.map((x) => x.status), [200, 200]);
    assert.deepEqual(both[0].body.results[0], both[1].body.results[0]);

    const bad = await push([op(modify("radialThickness", 9), 5, (await call("GET", `/v1/projects/${p.id}`)).body.headRevisionId)]);
    assert.deepEqual([bad.body.results[0].status, bad.body.results[0].error.code], ["REJECTED", "OUT_OF_RANGE"]);
    const foreign = await push([op(modify("bandWidth", 5), 1)], BOB);
    assert.deepEqual([foreign.body.results[0].status, foreign.body.results[0].error.code], ["REJECTED", "NOT_FOUND"]);
    assert.ok(rev2);
  });

  test("pull returns my revision events in commit order and resumes from the cursor", async () => {
    // Pull only serves events below the oldest running transaction of the whole cluster, so a
    // just-committed event can lag behind concurrent work (other test files share the server).
    // Poll until it shows up instead of assuming it is visible at once.
    async function pullUntil(cursor, done, ms = 15_000) {
      const events = [];
      const deadline = Date.now() + ms;
      for (;;) {
        const r = await call("GET", `/v1/sync/pull${cursor ? `?cursor=${cursor}` : ""}`);
        assert.equal(r.status, 200);
        events.push(...r.body.events);
        if (r.body.events.length) cursor = r.body.cursor;
        if (!r.body.events.length && done(events)) return { events, cursor };
        assert.ok(Date.now() < deadline, `events did not appear: ${JSON.stringify(events.map((e) => [e.aggregateId, e.aggregateVersion]))}`);
        if (!r.body.events.length) await new Promise((res) => setTimeout(res, 100));
      }
    }
    const p = (await newProject(ALICE, "pendant.02", "Dije")).body;
    const first = await pullUntil(null, (es) => es.some((e) => e.aggregateId === p.id && e.aggregateVersion === 1));
    for (const e of first.events) {
      valid("Event", e);
      valid("RevisionCreatedPayload", e.payload);
    }
    const job = await previewAndWait(p.id, p.headRevisionId, modify("width", 22, "pendant-base"));
    assert.equal(job.state, "SUCCEEDED", JSON.stringify(job));
    const rev = await call("POST", `/v1/projects/${p.id}/revisions`, { body: { baseRevisionId: p.headRevisionId, previewJobId: job.id, accepted: true } });
    assert.equal(rev.status, 200, JSON.stringify(rev.body));
    const next = await pullUntil(first.cursor, (es) => es.some((e) => e.aggregateId === p.id && e.aggregateVersion === 2));
    assert.deepEqual(next.events.filter((e) => e.aggregateId === p.id).map((e) => e.aggregateVersion), [2], "resumes after the cursor, no repeats");
    const seen = [...first.events, ...next.events].map((e) => e.eventId);
    assert.equal(new Set(seen).size, seen.length, "no event twice");
    const bobs = await call("GET", "/v1/sync/pull", { sub: BOB });
    assert.ok(!bobs.body.events.some((e) => e.aggregateId === p.id));
  });
});

describe("design configuration fails closed", () => {
  const ok = { GEOMETRY_WORKER_URL: "http://127.0.0.1:3910", GEOMETRY_WORKER_SECRET: "a".repeat(32), FILE_URL_SECRET: "b".repeat(32), ARTIFACT_DIR: "/tmp/x" };
  test("valid", () => assert.equal(loadDesignConfig(ok, "local").workerUrl, "http://127.0.0.1:3910"));
  for (const [name, env, aurea, re] of [
    ["missing secret", { ...ok, GEOMETRY_WORKER_SECRET: "" }, "local", /GEOMETRY_WORKER_SECRET/],
    ["short secret", { ...ok, FILE_URL_SECRET: "short" }, "local", /at least 32/],
    ["same secret twice", { ...ok, FILE_URL_SECRET: "a".repeat(32) }, "local", /must differ/],
    ["plain http worker off loopback in production", { ...ok, GEOMETRY_WORKER_URL: "http://geometry.internal", API_PUBLIC_URL: "https://api.example" }, "production", /https/],
    ["no public URL in demo", ok, "demo", /API_PUBLIC_URL/],
  ]) {
    test(name, () => assert.throws(() => loadDesignConfig(env, aurea), re));
  }
});
