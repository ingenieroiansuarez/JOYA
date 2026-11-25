// Studio renders of the synthetic catalog (tools/jewel-renders). Runs in a headless browser driven by
// render.mjs. Every piece is built from parameters (millimetres) with three.js primitives, PBR metal
// and refractive gems lit by three's RoomEnvironment (MIT, procedural: no HDRI file to license).
// These are illustrations of catalog pieces, not CAD solids and not photographs (CLAUDE.md: a render
// is not a solid); the app labels them as 3D illustrations.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

const canvas = document.getElementById("c");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = false;

const pmrem = new THREE.PMREMGenerator(renderer);
const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;

// --- materials -------------------------------------------------------------------------------
// Base colours are the usual PBR reflectance of each alloy (sRGB), slightly warmed for 18k.
export const METALS = {
  GOLD_18K_YELLOW: { color: "#f1c76b", roughness: 0.16 },
  GOLD_18K_WHITE: { color: "#dcdbd6", roughness: 0.12 },
  GOLD_18K_ROSE: { color: "#eeb497", roughness: 0.16 },
  SILVER_925: { color: "#ecebe8", roughness: 0.2 },
  PLATINUM_950: { color: "#cfcdc8", roughness: 0.14 },
};
// Refractive index from gemmology tables; colour and absorption are illustrative.
export const GEMS = {
  DIAMOND: { color: "#f4f7ff", ior: 2.42, dispersion: 0.044, attenuation: "#ffffff", distance: 50, glow: "#9fb4d8", glowIntensity: 0.18, env: 3.2 },
  EMERALD: { color: "#159a55", ior: 1.58, dispersion: 0.014, attenuation: "#0f7a40", distance: 3, glow: "#06582c", glowIntensity: 0.35, env: 2.6 },
  RUBY: { color: "#c8143c", ior: 1.77, dispersion: 0.018, attenuation: "#a1001e", distance: 3, glow: "#78061c", glowIntensity: 0.4, env: 2.6 },
  SAPPHIRE: { color: "#2448c4", ior: 1.77, dispersion: 0.018, attenuation: "#0d2a9e", distance: 3, glow: "#0c2380", glowIntensity: 0.4, env: 2.6 },
};

function metalMaterial(metal, extra = {}) {
  const m = METALS[metal];
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(m.color), metalness: 1, roughness: m.roughness, envMapIntensity: 1.35,
    clearcoat: 0.15, clearcoatRoughness: 0.1, ...extra,
  });
}

// Real-time transmission only refracts the dark studio behind the stone, which reads as a black
// gem. Stones are drawn as faceted bodies instead: strong environment reflections per facet, the
// gem's body colour as a soft glow, and a little transmission for depth.
function gemMaterial(gem) {
  const g = GEMS[gem];
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(g.color), metalness: 0.35, roughness: 0.02, transmission: 0.35, thickness: 1.5, ior: g.ior,
    dispersion: g.dispersion, attenuationColor: new THREE.Color(g.attenuation), attenuationDistance: g.distance,
    emissive: new THREE.Color(g.glow), emissiveIntensity: g.glowIntensity, specularIntensity: 1, envMapIntensity: g.env,
    clearcoat: 1, clearcoatRoughness: 0, flatShading: true,
  });
}

// --- geometry helpers --------------------------------------------------------------------------
/** Revolves a (radius, height) profile around the Y axis. */
function lathe(points, segments = 160) {
  return new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), segments);
}

/** Closed polygon outline, unit size: n-gon or a custom list of [x, z]. */
function ngon(n, phase = 0) {
  return Array.from({ length: n }, (_, i) => [Math.cos(phase + (i / n) * Math.PI * 2), Math.sin(phase + (i / n) * Math.PI * 2)]);
}

/**
 * Faceted solid from one outline lofted through levels [sx, sz, y]. Consecutive levels become flat
 * facets (flat shading), the first and last are capped. Used for cut stones and bezels.
 */
function loft(outline, levels) {
  const pos = [];
  const tri = (a, b, c) => pos.push(...a, ...b, ...c);
  const at = (l, i) => { const [x, z] = outline[i % outline.length]; return [x * l[0], l[2], z * l[1]]; };
  for (let k = 0; k < levels.length - 1; k++) {
    const a = levels[k], b = levels[k + 1];
    for (let i = 0; i < outline.length; i++) {
      const p0 = at(a, i), p1 = at(a, i + 1), q0 = at(b, i), q1 = at(b, i + 1);
      tri(p0, q0, p1);
      tri(p1, q0, q1);
    }
  }
  const cap = (l, up) => {
    const c = [0, l[2], 0];
    for (let i = 0; i < outline.length; i++) up ? tri(c, at(l, i + 1), at(l, i)) : tri(c, at(l, i), at(l, i + 1));
  };
  cap(levels[0], false);
  cap(levels[levels.length - 1], true);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Round brilliant of girdle diameter d (mm), table up (+Y), girdle at y = 0. */
function brilliant(d) {
  const r = d / 2;
  const outline = ngon(16, Math.PI / 16);
  return loft(outline, [
    [0.02 * r, 0.02 * r, -0.86 * r], // culet
    [0.55 * r, 0.55 * r, -0.42 * r],
    [r, r, -0.02 * r], // girdle
    [r, r, 0.02 * r],
    [0.8 * r, 0.8 * r, 0.2 * r],
    [0.56 * r, 0.56 * r, 0.32 * r], // table
  ]);
}

/** Emerald (step) cut, length l by width w, octagonal outline. */
function emeraldCut(l, w) {
  const c = 0.22;
  const outline = [[1, 1 - c], [1 - c, 1], [-(1 - c), 1], [-1, 1 - c], [-1, -(1 - c)], [-(1 - c), -1], [1 - c, -1], [1, -(1 - c)]]
    .map(([x, z]) => [x * l / 2, z * w / 2]);
  return loft(outline, [
    [0.25, 0.08, -0.62 * w], [0.6, 0.45, -0.38 * w], [0.86, 0.78, -0.18 * w], [1, 1, -0.02 * w], [1, 1, 0.02 * w],
    [0.9, 0.88, 0.1 * w], [0.78, 0.74, 0.2 * w], [0.7, 0.64, 0.26 * w],
  ]);
}

/** Pear outline (tip at -Z), length l by width w. */
function pearOutline(l, w, n = 32) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const u = (1 - Math.cos(t)) / 2; // 0 at the tip, 1 at the round end
    const taper = u < 0.5 ? Math.pow(u * 2, 0.75) : 1;
    out.push([Math.sin(t) * (w / 2) * taper, -Math.cos(t) * (l / 2)]);
  }
  return out;
}

/** Pear (drop) cut, table up (+Y). */
function pearCut(l, w) {
  return loft(pearOutline(l, w), [[0.08, 0.3, -0.5 * w], [0.6, 0.65, -0.26 * w], [1, 1, -0.02 * w], [1, 1, 0.02 * w], [0.8, 0.82, 0.16 * w], [0.6, 0.64, 0.24 * w]]);
}

/** Sweeps a closed cross-section (width x height, rounded) along a parametric path. */
function sweep(path, { width, height, roundness = 0.5, segments = 220, sectionSegments = 24, closed = false, displace }) {
  const pos = [];
  const sec = [];
  for (let j = 0; j < sectionSegments; j++) {
    const a = (j / sectionSegments) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    // Superellipse: roundness 1 = ellipse, toward 0 = rectangle.
    const e = 2 / (1 + (1 - roundness) * 6);
    sec.push([Math.sign(c) * Math.pow(Math.abs(c), e) * width / 2, Math.sign(s) * Math.pow(Math.abs(s), e) * height / 2]);
  }
  const frames = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = path(t);
    const q = path(Math.min(1, t + 1e-3));
    const q0 = path(Math.max(0, t - 1e-3));
    const tangent = new THREE.Vector3().subVectors(q, q0).normalize();
    const up = new THREE.Vector3(0, 0, 1);
    const normal = new THREE.Vector3().crossVectors(up, tangent).normalize();
    const binormal = new THREE.Vector3().crossVectors(tangent, normal).normalize();
    frames.push({ p, normal, binormal, t });
  }
  const ring = (f, j) => {
    const [u, v] = sec[j % sectionSegments];
    const out = f.p.clone().addScaledVector(f.normal, u).addScaledVector(f.binormal, v);
    if (displace) out.addScaledVector(f.normal.clone().multiplyScalar(u).addScaledVector(f.binormal, v).normalize(), displace(f.t, j / sectionSegments));
    return out.toArray();
  };
  const count = closed ? segments : segments;
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < sectionSegments; j++) {
      const a = ring(frames[i], j), b = ring(frames[i], j + 1), c = ring(frames[i + 1], j), d = ring(frames[i + 1], j + 1);
      pos.push(...a, ...c, ...b, ...b, ...c, ...d);
    }
  }
  if (!closed) {
    for (const [f, flip] of [[frames[0], true], [frames[segments], false]]) {
      const center = f.p.toArray();
      for (let j = 0; j < sectionSegments; j++) {
        const a = ring(f, j), b = ring(f, j + 1);
        flip ? pos.push(...center, ...b, ...a) : pos.push(...center, ...a, ...b);
      }
    }
  }
  let g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g = mergeVertices(g, 1e-4);
  g.computeVertexNormals();
  return g;
}

const mesh = (geometry, material) => new THREE.Mesh(geometry, material);

/** Classic ring band lying in the XY plane (hole along Z): half-round outside, comfort-fit inside. */
function band({ inner = 8.6, thickness = 1.8, width = 4, top = 0, topWidth = 0 }) {
  const pts = [];
  const w = width / 2;
  const n = 40;
  for (let i = 0; i <= n; i++) {
    const a = -Math.PI / 2 + (i / n) * Math.PI;
    pts.push([inner + thickness * 0.15 + Math.cos(a) * thickness * 0.85, Math.sin(a) * w]);
  }
  for (let i = n; i >= 0; i--) {
    const a = -Math.PI / 2 + (i / n) * Math.PI;
    pts.push([inner + Math.cos(a) * thickness * 0.12, Math.sin(a) * w * 0.98]);
  }
  pts.push(pts[0]);
  const g = lathe(pts, 200);
  g.rotateX(Math.PI / 2);
  if (top || topWidth) void 0;
  return g;
}

/** A prong: tapered wire from `from` to `to`, with a rounded tip. */
function prong(from, to, radius, material) {
  const curve = new THREE.CatmullRomCurve3([from, from.clone().lerp(to, 0.5).add(new THREE.Vector3(0, 0, 0)), to]);
  const g = new THREE.TubeGeometry(curve, 24, radius, 12, false);
  const group = new THREE.Group();
  group.add(mesh(g, material));
  const tip = mesh(new THREE.SphereGeometry(radius * 1.15, 16, 12), material);
  tip.position.copy(to);
  group.add(tip);
  return group;
}

// --- pieces (millimetres; the camera frames whatever is built) ---------------------------------
const PIECES = {
  classicBand({ metal }) {
    const g = new THREE.Group();
    g.add(mesh(band({ width: 4.2, thickness: 1.9 }), metalMaterial(metal)));
    return g;
  },

  solitaire({ metal, stone = "DIAMOND" }) {
    const g = new THREE.Group();
    const m = metalMaterial(metal);
    g.add(mesh(band({ inner: 8.6, width: 2, thickness: 1.5 }), m));
    const d = 4.1; // ~0.25 ct round brilliant
    const seat = 10.1 + 2.4;
    const gem = mesh(brilliant(d), gemMaterial(stone));
    gem.position.set(0, seat, 0);
    g.add(gem);
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + (k * Math.PI) / 2;
      const from = new THREE.Vector3(Math.cos(a) * 0.9, 9.8, Math.sin(a) * 0.9);
      const to = new THREE.Vector3(Math.cos(a) * d * 0.5, seat + 0.45, Math.sin(a) * d * 0.5);
      g.add(prong(from, to, 0.32, m));
    }
    // Basket ring under the girdle.
    const basket = mesh(new THREE.TorusGeometry(d * 0.36, 0.22, 12, 48), m);
    basket.rotation.x = Math.PI / 2;
    basket.position.y = seat - 1.1;
    g.add(basket);
    return g;
  },

  emeraldBezel({ metal, stone = "EMERALD" }) {
    const g = new THREE.Group();
    const m = metalMaterial(metal);
    g.add(mesh(band({ inner: 8.6, width: 2.4, thickness: 1.6 }), m));
    const l = 7, w = 5;
    const seat = 10.2 + 1.7;
    const gem = mesh(emeraldCut(l, w), gemMaterial(stone));
    gem.position.set(0, seat, 0);
    g.add(gem);
    // Bezel: a wall that wraps the girdle, from the band up to just above the girdle.
    const c = 0.22;
    const outline = [[1, 1 - c], [1 - c, 1], [-(1 - c), 1], [-1, 1 - c], [-1, -(1 - c)], [-(1 - c), -1], [1 - c, -1], [1, -(1 - c)]]
      .map(([x, z]) => [x * (l / 2 + 0.45), z * (w / 2 + 0.45)]);
    const bezel = mesh(loft(outline, [[0.72, 0.6, -1.7], [0.96, 0.95, -0.6], [1, 1, 0.32]]), m);
    bezel.material = metalMaterial(metal, { flatShading: false });
    bezel.position.y = seat;
    g.add(bezel);
    return g;
  },

  halfEternity({ metal, stone = "DIAMOND", count = 7 }) {
    const g = new THREE.Group();
    const m = metalMaterial(metal);
    g.add(mesh(band({ inner: 8.6, width: 2.6, thickness: 1.9 }), m));
    const d = 2.05;
    for (let i = 0; i < count; i++) {
      const a = Math.PI / 2 + (i - (count - 1) / 2) * 0.21;
      const r = 10.35;
      const gem = mesh(brilliant(d), gemMaterial(stone));
      gem.position.set(Math.cos(a) * r, Math.sin(a) * r, 0);
      gem.rotation.z = a - Math.PI / 2;
      g.add(gem);
    }
    // Channel walls either side of the stones.
    for (const side of [-1, 1]) {
      const wall = mesh(new THREE.TorusGeometry(10.25, 0.32, 12, 120, 1.75), m);
      wall.rotation.z = Math.PI / 2 - 0.875;
      wall.position.z = side * (d / 2 + 0.2);
      g.add(wall);
    }
    return g;
  },

  medal({ metal }) {
    const g = new THREE.Group();
    const m = metalMaterial(metal);
    // Satin face, polished rim: the face waits for an engraving.
    const disc = mesh(new THREE.CylinderGeometry(9, 9, 1.1, 128), metalMaterial(metal, { roughness: 0.34, clearcoat: 0 }));
    disc.rotation.x = Math.PI / 2;
    g.add(disc);
    const rim = mesh(new THREE.TorusGeometry(8.75, 0.55, 20, 128), m);
    g.add(rim);
    const inner = mesh(new THREE.TorusGeometry(7.6, 0.16, 12, 128), m);
    inner.position.z = 0.55;
    g.add(inner);
    g.rotation.y = -0.35;
    const bail = mesh(new THREE.TorusGeometry(1.5, 0.45, 16, 48), m);
    bail.position.y = 10.6;
    bail.rotation.y = Math.PI / 2;
    g.add(bail);
    const jump = mesh(new THREE.TorusGeometry(1.1, 0.35, 16, 48), m);
    jump.position.y = 9.3;
    g.add(jump);
    return g;
  },

  pearPendant({ metal, stone = "RUBY" }) {
    const g = new THREE.Group();
    const m = metalMaterial(metal);
    const l = 9, w = 6.4;
    // Stone: table toward the camera (+Z), tip down.
    const holder = new THREE.Group();
    const gem = mesh(pearCut(l, w), gemMaterial(stone));
    gem.rotation.x = -Math.PI / 2;
    holder.add(gem);
    holder.rotation.y = Math.PI;
    g.add(holder);
    // Bezel: a thin rounded wall swept around the girdle outline, slightly larger than the stone.
    const outline = pearOutline(l + 0.9, w + 0.9, 96);
    const curve = new THREE.CatmullRomCurve3(outline.map(([x, z]) => new THREE.Vector3(x, z, -0.25)), true);
    g.add(mesh(new THREE.TubeGeometry(curve, 240, 0.48, 16, true), m));
    const back = mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(outline.map(([x, z]) => new THREE.Vector3(x * 0.92, z * 0.94, -1.2)), true), 240, 0.42, 12, true), m);
    g.add(back);
    const bail = mesh(new THREE.TorusGeometry(1.5, 0.45, 16, 48), m);
    bail.position.y = l / 2 + 2.2;
    bail.rotation.y = Math.PI / 2;
    g.add(bail);
    const jump = mesh(new THREE.TorusGeometry(0.9, 0.32, 16, 48), m);
    jump.position.y = l / 2 + 0.9;
    g.add(jump);
    return g;
  },

  hoops({ metal }) {
    const g = new THREE.Group();
    const m = metalMaterial(metal);
    for (const [x, rot, z] of [[-8.5, 0.5, 2], [9.5, -0.6, -3]]) {
      const hoop = mesh(new THREE.TorusGeometry(9, 1.35, 32, 160, Math.PI * 1.86), m);
      hoop.rotation.set(0, rot, Math.PI / 2 + 0.07);
      hoop.position.set(x, 0, z);
      g.add(hoop);
    }
    return g;
  },

  studs({ metal, stone = "SAPPHIRE" }) {
    const g = new THREE.Group();
    const m = metalMaterial(metal);
    const d = 4.4;
    for (const [x, z, ry] of [[-3.6, 1.5, 0.2], [3.6, -1.5, -0.25]]) {
      const stud = new THREE.Group();
      const gem = mesh(brilliant(d), gemMaterial(stone));
      stud.add(gem);
      for (let k = 0; k < 4; k++) {
        const a = Math.PI / 4 + (k * Math.PI) / 2;
        stud.add(prong(new THREE.Vector3(Math.cos(a) * 1, -2.2, Math.sin(a) * 1), new THREE.Vector3(Math.cos(a) * d * 0.5, 0.45, Math.sin(a) * d * 0.5), 0.3, m));
      }
      const post = mesh(new THREE.CylinderGeometry(0.4, 0.4, 7, 16), m);
      post.position.y = -5.4;
      stud.add(post);
      stud.rotation.set(Math.PI / 2 - 0.35, 0, ry);
      stud.position.set(x, 0, z);
      g.add(stud);
    }
    return g;
  },

  cuff({ metal }) {
    const g = new THREE.Group();
    const a = 31, b = 25; // inner semi-axes of the oval
    const gap = 0.16; // open cuff: fraction of the turn left open
    const path = (t) => {
      const ang = Math.PI / 2 + Math.PI * gap + t * Math.PI * 2 * (1 - gap);
      return new THREE.Vector3(Math.cos(ang) * a, Math.sin(ang) * b, 0);
    };
    // Hand-hammered facets: low-frequency dimples on the outer face only.
    const hammer = (t, s) => {
      const outer = Math.max(0, Math.cos(s * Math.PI * 2));
      const v = Math.sin(t * 190) * Math.sin(s * 23 + t * 41) + 0.6 * Math.sin(t * 113 + s * 13);
      return -0.18 * outer * (0.5 + 0.5 * v);
    };
    g.add(mesh(sweep(path, { width: 3.2, height: 6, roundness: 0.35, segments: 520, sectionSegments: 40, displace: hammer }), metalMaterial(metal, { roughness: METALS[metal].roughness + 0.04 })));
    // Rounded terminals.
    for (const t of [0, 1]) {
      const p = path(t);
      const cap = mesh(new THREE.SphereGeometry(1.9, 24, 16), metalMaterial(metal));
      cap.scale.set(0.9, 0.9, 1.65);
      cap.position.copy(p);
      g.add(cap);
    }
    g.rotation.x = -0.55;
    return g;
  },

  venetianChain({ metal }) {
    const g = new THREE.Group();
    const m = metalMaterial(metal);
    // A draped loop seen from the front: catenary-like U with the clasp at the top.
    const pts = [];
    const n = 140;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = Math.sin(t * Math.PI * 2) * 22;
      const y = -Math.cos(t * Math.PI * 2) * 28 - 2 * Math.cos(t * Math.PI * 4);
      pts.push(new THREE.Vector3(x, y, Math.sin(t * Math.PI * 4) * 2));
    }
    const curve = new THREE.CatmullRomCurve3(pts, true);
    const linkLen = 1.4;
    const count = Math.floor(curve.getLength() / linkLen);
    const geo = new RoundedBoxGeometry(1.3, 1.25, 1.25, 2, 0.28);
    const inst = new THREE.InstancedMesh(geo, m, count);
    const q = new THREE.Quaternion();
    const tmp = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const t = i / count;
      const p = curve.getPointAt(t);
      const tan = curve.getTangentAt(t);
      tmp.position.copy(p);
      q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), tan);
      tmp.quaternion.copy(q);
      tmp.rotateX(i % 2 ? Math.PI / 4 : 0);
      tmp.updateMatrix();
      inst.setMatrixAt(i, tmp.matrix);
    }
    g.add(inst);
    const clasp = mesh(new THREE.CapsuleGeometry(0.9, 3.2, 8, 16), m);
    clasp.rotation.z = Math.PI / 2;
    clasp.position.copy(curve.getPointAt(0.5));
    g.add(clasp);
    return g;
  },
};

// --- studio -------------------------------------------------------------------------------------
function backdrop(size) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const x = c.getContext("2d");
  const grd = x.createRadialGradient(size * 0.5, size * 0.42, size * 0.05, size * 0.5, size * 0.5, size * 0.75);
  grd.addColorStop(0, "#2c2a2e");
  grd.addColorStop(0.55, "#1b1a1d");
  grd.addColorStop(1, "#111113");
  x.fillStyle = grd;
  x.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function contactShadow(radius) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const x = c.getContext("2d");
  const grd = x.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, "rgba(0,0,0,0.55)");
  grd.addColorStop(1, "rgba(0,0,0,0)");
  x.fillStyle = grd;
  x.fillRect(0, 0, 256, 256);
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2.2, radius * 0.7),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, toneMapped: false }));
  plane.rotation.x = -Math.PI / 2;
  return plane;
}

const VIEWS = {
  // yaw, pitch (radians), framing margin
  ring: [0.5, 0.42, 1.06, 0.32],
  front: [0.18, 0.16, 1.12],
  top: [0.3, 0.75, 1.1],
};

function renderObject(obj, { view = "ring", size = 900, quality = 0.9, background = true }) {
  renderer.setSize(size, size, false);
  const scene = new THREE.Scene();
  scene.background = background ? backdrop(size) : null;
  renderer.setClearColor(0x000000, background ? 1 : 0);
  scene.environment = envTexture;
  const key = new THREE.DirectionalLight("#ffffff", 1.4);
  const rim = new THREE.DirectionalLight("#ffe7c2", 0.8);
  scene.add(key, rim);
  const [yaw, pitch, margin, tilt = 0] = VIEWS[view];
  if (tilt) obj.rotation.x += tilt; // head of the ring toward the camera, like a product shot
  scene.add(obj);
  const box = new THREE.Box3().setFromObject(obj);
  const center = box.getCenter(new THREE.Vector3());
  obj.position.sub(center);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const camera = new THREE.PerspectiveCamera(28, 1, 1, 1000);
  const dist = (sphere.radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * margin;
  camera.near = dist / 100;
  camera.far = dist * 10;
  camera.updateProjectionMatrix();
  camera.position.set(dist * Math.cos(pitch) * Math.sin(yaw), dist * Math.sin(pitch), dist * Math.cos(pitch) * Math.cos(yaw));
  camera.lookAt(0, 0, 0);
  key.position.set(dist, dist * 1.2, dist * 0.6);
  rim.position.set(-dist, dist * 0.4, -dist);
  if (background) {
    const shadow = contactShadow(sphere.radius);
    shadow.position.y = -(box.max.y - box.min.y) / 2 - sphere.radius * 0.04;
    scene.add(shadow);
  }
  renderer.render(scene, camera);
  renderer.render(scene, camera); // second pass: transmission buffer warmed up
  const url = canvas.toDataURL(background ? "image/jpeg" : "image/png", quality);
  scene.traverse((o) => { o.geometry?.dispose(); if (o.material) [].concat(o.material).forEach((mm) => mm.dispose()); });
  return url;
}

window.renderPiece = async function renderPiece({ piece, metal, stone, ...opts }) {
  const build = PIECES[piece];
  if (!build) throw new Error(`unknown piece ${piece}`);
  if (!METALS[metal]) throw new Error(`unknown metal ${metal}`);
  return renderObject(build({ metal, stone }), opts);
};

/** Renders a GLB_PREVIEW from the geometry service (real CAD mesh) in the given alloy. */
window.renderGlb = async function renderGlb({ glb, metal, ...opts }) {
  if (!METALS[metal]) throw new Error(`unknown metal ${metal}`);
  const bin = Uint8Array.from(atob(glb), (ch) => ch.charCodeAt(0)).buffer;
  const gltf = await new GLTFLoader().parseAsync(bin, "");
  const m = metalMaterial(metal);
  gltf.scene.traverse((o) => { if (o.isMesh) o.material = m; });
  // CAD is Z-up (glTF turns it Y-up): rings and pendants arrive lying flat. Stand them up to face the
  // camera like the catalog shots.
  gltf.scene.rotation.x = Math.PI / 2;
  const holder = new THREE.Group();
  holder.add(gltf.scene);
  return renderObject(holder, opts);
};
window.rendererReady = true;
