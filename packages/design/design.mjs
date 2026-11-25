// AUREA design documents (09_JEWELRY_ENGINE/design.schema.json) shared by the API and the app.
//
// What lives here: the families and materials the engine builds, canonical JSON for digests,
// creating a document from a family, applying the allowlisted DesignOperations of hito 300 and
// deciding whether an offline operation can be rebased. What does NOT live here: geometry.
// services/geometry re-validates every document and is the authority on solids, volumes and DFM.
import { FAMILIES, MATERIALS } from "./catalog.mjs";

export { FAMILIES, MATERIALS };
export const SCHEMA_VERSION = "1.0.0";
export const MAIN_BRANCH = "main";
export const COMPONENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Operations hito 300 applies. The rest of DesignOperation is refused, never ignored. */
export const SUPPORTED_OPERATIONS = ["modify_parameter", "change_material"];

const familyById = new Map(FAMILIES.map((f) => [f.id, f]));
const materialById = new Map(MATERIALS.map((m) => [m.id, m]));

export function family(id) {
  return familyById.get(id);
}

export function material(id) {
  return materialById.get(id);
}

// ---------------------------------------------------------------------------- canonical JSON

/**
 * RFC 8785 subset: keys sorted by UTF-16 code units, ECMAScript number formatting, no whitespace.
 * Same bytes as services/geometry/aurea_geometry/canonical.py (checked against
 * 09_JEWELRY_ENGINE/fixtures/digests.json on both sides).
 */
export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  throw new TypeError(`unsupported type ${typeof value}`);
}

// ---------------------------------------------------------------------------- documents

function issue(code, path, message) {
  return { code, path, message };
}

/** Revision 1 of a new project: one component of `familyId` with the family defaults. */
export function newDocument({ projectId, familyId, materialId }) {
  const fam = family(familyId);
  if (!fam) return { ok: false, issues: [issue("UNKNOWN_FAMILY", "/templateId", familyId)] };
  if (!material(materialId)) return { ok: false, issues: [issue("UNKNOWN_MATERIAL", "/materialId", materialId)] };
  const parameters = Object.fromEntries(fam.parameters.map((p) => [p.name, p.default]));
  return {
    ok: true,
    document: {
      schemaVersion: SCHEMA_VERSION,
      projectId,
      revision: 1,
      units: "mm",
      components: [
        {
          id: `${fam.category}-base`,
          family: fam.id,
          familyVersion: fam.version,
          materialId,
          parameters,
          transform: { translation: [0, 0, 0], rotationQuaternion: [0, 0, 0, 1] },
          dependsOn: [],
        },
      ],
      operations: [],
      // No manufacturing rule is invented here: without one, DFM-02 stays REVIEW.
      constraints: [],
    },
  };
}

/**
 * Semantic checks the app can run offline and the API runs before storing anything. A subset of
 * services/geometry's validation (which runs again on every regeneration) plus materials.
 */
export function validateDocument(doc) {
  const issues = [];
  if (!doc || typeof doc !== "object") return [issue("SCHEMA", "", "not an object")];
  if (doc.schemaVersion !== SCHEMA_VERSION) issues.push(issue("SCHEMA", "/schemaVersion", String(doc.schemaVersion)));
  if (doc.units !== "mm") issues.push(issue("SCHEMA", "/units", String(doc.units)));
  if (!Array.isArray(doc.components) || doc.components.length === 0) {
    issues.push(issue("EMPTY_DESIGN", "/components", "at least one component required"));
    return issues;
  }
  const seen = new Set();
  doc.components.forEach((c, i) => {
    const base = `/components/${i}`;
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      issues.push(issue("SCHEMA", base, "component must be an object"));
      return;
    }
    if (typeof c.id !== "string" || !COMPONENT_ID.test(c.id)) issues.push(issue("INVALID_ID", `${base}/id`, String(c.id)));
    if (seen.has(c.id)) issues.push(issue("DUPLICATE_ID", `${base}/id`, c.id));
    seen.add(c.id);
    if (!material(c.materialId)) issues.push(issue("UNKNOWN_MATERIAL", `${base}/materialId`, String(c.materialId)));
    const fam = family(c.family);
    if (!fam) {
      issues.push(issue("UNKNOWN_FAMILY", `${base}/family`, String(c.family)));
      return;
    }
    if (c.familyVersion !== fam.version) issues.push(issue("UNSUPPORTED_FAMILY_VERSION", `${base}/familyVersion`, String(c.familyVersion)));
    const params = c.parameters ?? {};
    for (const name of Object.keys(params)) {
      if (!fam.parameters.some((p) => p.name === name)) issues.push(issue("UNKNOWN_PARAMETER", `${base}/parameters/${name}`, name));
    }
    for (const spec of fam.parameters) issues.push(...checkValue(spec, params[spec.name], `${base}/parameters/${spec.name}`));
  });
  if (Array.isArray(doc.operations) && doc.operations.length) {
    issues.push(issue("UNSUPPORTED_OPERATION", "/operations", "feature operations are not supported yet"));
  }
  return issues;
}

function checkValue(spec, v, path) {
  if (v === undefined) return [issue("MISSING_PARAMETER", path, spec.name)];
  if (typeof v !== "number") return [issue("NOT_A_NUMBER", path, String(v))];
  if (!Number.isFinite(v)) return [issue("NOT_FINITE", path, String(v))];
  if (v < spec.min || v > spec.max) return [issue("OUT_OF_RANGE", path, `${v} not in [${spec.min}, ${spec.max}] ${spec.unit}`)];
  return [];
}

// ---------------------------------------------------------------------------- operations

/** Stable keys an operation writes; two operations conflict when their keys intersect. */
export function touchedKeys(op) {
  switch (op?.type) {
    case "modify_parameter":
      return [`${op.componentId}/parameters/${op.name}`];
    case "change_material":
      return [`${op.componentId}/materialId`];
    default:
      return ["*"];
  }
}

/**
 * Apply one DesignOperation to a document. Never mutates `doc`. The result is the next revision
 * (`revision` + 1) or the issues that reject the operation; nothing is clamped or guessed.
 */
export function applyOperation(doc, op) {
  if (!op || typeof op !== "object" || !SUPPORTED_OPERATIONS.includes(op.type)) {
    return { ok: false, issues: [issue("UNSUPPORTED_OPERATION", "/operation/type", String(op?.type))] };
  }
  const index = doc.components.findIndex((c) => c.id === op.componentId);
  if (index < 0) return { ok: false, issues: [issue("UNKNOWN_COMPONENT", "/operation/componentId", String(op.componentId))] };
  const next = JSON.parse(JSON.stringify(doc)); // documents are plain JSON
  const comp = next.components[index];
  if (op.type === "modify_parameter") {
    const spec = family(comp.family)?.parameters.find((p) => p.name === op.name);
    if (!spec) return { ok: false, issues: [issue("UNKNOWN_PARAMETER", "/operation/name", String(op.name))] };
    const bad = checkValue(spec, op.value, "/operation/value");
    if (bad.length) return { ok: false, issues: bad };
    if (comp.parameters[op.name] === op.value) return { ok: false, issues: [issue("NO_CHANGE", "/operation/value", String(op.value))] };
    comp.parameters[op.name] = op.value;
  } else {
    if (!material(op.materialId)) return { ok: false, issues: [issue("UNKNOWN_MATERIAL", "/operation/materialId", String(op.materialId))] };
    if (comp.materialId === op.materialId) return { ok: false, issues: [issue("NO_CHANGE", "/operation/materialId", op.materialId)] };
    comp.materialId = op.materialId;
  }
  next.revision = doc.revision + 1;
  const issues = validateDocument(next);
  return issues.length ? { ok: false, issues } : { ok: true, document: next };
}

/** Apply operations in order; stops at the first rejection. */
export function applyAll(doc, ops) {
  let current = doc;
  for (const op of ops) {
    const r = applyOperation(current, op);
    if (!r.ok) return r;
    current = r.document;
  }
  return { ok: true, document: current };
}

/**
 * SYNC.md: an operation made offline on `baseRevision` may land on a newer head only if none of
 * the operations applied since then wrote the same keys (independent stable parameters). Anything
 * else is a conflict the person resolves; never last-write-wins.
 */
export function canRebase(op, appliedSince) {
  const mine = touchedKeys(op);
  if (mine.includes("*")) return false;
  const theirs = new Set(appliedSince.flatMap(touchedKeys));
  return !theirs.has("*") && mine.every((k) => !theirs.has(k));
}

/** Parameter values that differ between two documents (for "what changed" in revision lists). */
export function diffParameters(before, after) {
  const out = [];
  for (const c of after.components) {
    const prev = before.components.find((p) => p.id === c.id);
    if (!prev) continue;
    for (const [name, value] of Object.entries(c.parameters)) {
      if (prev.parameters[name] !== value) out.push({ componentId: c.id, name, from: prev.parameters[name], to: value });
    }
    if (prev.materialId !== c.materialId) out.push({ componentId: c.id, name: "materialId", from: prev.materialId, to: c.materialId });
  }
  return out;
}
