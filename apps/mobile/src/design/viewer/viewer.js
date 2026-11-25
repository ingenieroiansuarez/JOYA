// Preview viewer that runs inside the WebView (ADR-0003: WebView + Three.js). It shows the GLB_PREVIEW
// mesh of a job, never the technical solid: STEP/STL stay separate and the screen says so. It has no
// network: three.js is inlined and the mesh arrives as base64 through postMessage.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const post = (msg) => window.ReactNativeWebView?.postMessage(JSON.stringify(msg));
const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

const canvas = document.getElementById("c");
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
} catch {
  post({ type: "error", code: "WEBGL_UNAVAILABLE" });
  throw new Error("webgl");
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
// Studio look shared with the catalog renders (tools/jewel-renders): neutral tone mapping keeps the
// alloy's hue, a soft radial backdrop, a key and a warm rim light, and a contact shadow.
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = backdrop();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
const key = new THREE.DirectionalLight("#ffffff", 1.4);
const rim = new THREE.DirectionalLight("#ffe7c2", 0.8);
scene.add(key, rim);
const shadow = contactShadow();
scene.add(shadow);

function backdrop() {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const x = c.getContext("2d");
  const g = x.createRadialGradient(256, 215, 25, 256, 256, 384);
  g.addColorStop(0, "#2c2a2e");
  g.addColorStop(0.55, "#1b1a1d");
  g.addColorStop(1, "#111113");
  x.fillStyle = g;
  x.fillRect(0, 0, 512, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function contactShadow() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const x = c.getContext("2d");
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(0,0,0,0.55)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, toneMapped: false }));
  plane.rotation.x = -Math.PI / 2;
  plane.visible = false;
  return plane;
}
const camera = new THREE.PerspectiveCamera(35, 1, 0.0001, 10);
const pivot = new THREE.Group();
scene.add(pivot);
let current = null;
let yaw = 0.5, pitch = 0.3, distance = 0.05, dragging = null, idle = 0;

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

canvas.addEventListener("pointerdown", (e) => { dragging = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  yaw -= (e.clientX - dragging.x) * 0.01;
  pitch = Math.max(-1.2, Math.min(1.2, pitch + (e.clientY - dragging.y) * 0.01));
  dragging = { x: e.clientX, y: e.clientY };
  idle = 0;
});
canvas.addEventListener("pointerup", () => { dragging = null; });
canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); post({ type: "error", code: "CONTEXT_LOST" }); });

function place(y, p) {
  camera.position.set(distance * Math.cos(p) * Math.sin(y), distance * Math.sin(p), distance * Math.cos(p) * Math.cos(y));
  camera.lookAt(0, 0, 0);
  key.position.set(distance, distance * 1.2, distance * 0.6);
  rim.position.set(-distance, distance * 0.4, -distance);
}

function frame() {
  if (!dragging && !reduced && current && ++idle > 90) yaw += 0.004; // slow turn after 1.5 s without touch
  place(yaw, pitch);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// Square picture of the shown mesh from the starting pose, for the designs list. Rendered and read in
// the same task (the drawing buffer is not preserved), cropped to the centre and scaled down.
const SNAPSHOT_PX = 256;
function snapshot() {
  place(0.5, 0.3);
  renderer.render(scene, camera);
  const w = canvas.width, h = canvas.height, side = Math.min(w, h);
  const out = document.createElement("canvas");
  out.width = out.height = SNAPSHOT_PX;
  out.getContext("2d").drawImage(canvas, (w - side) / 2, (h - side) / 2, side, side, 0, 0, SNAPSHOT_PX, SNAPSHOT_PX);
  return out.toDataURL("image/jpeg", 0.82);
}
requestAnimationFrame(frame);

function bytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

function show({ glb, color, snap, seq }) {
  try {
    parse(bytes(glb), color, snap === true ? seq : null);
  } catch {
    post({ type: "error", code: "GLB_INVALID" }); // the loader throws synchronously on a non-glTF buffer
  }
}

function parse(buffer, color, snap) {
  new GLTFLoader().parse(buffer, "", (gltf) => {
    if (current) {
      pivot.remove(current);
      current.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
    }
    const metal = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(color), metalness: 1, roughness: 0.16, clearcoat: 0.15, clearcoatRoughness: 0.1, envMapIntensity: 1.35,
    });
    let triangles = 0;
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.material = metal;
      const g = o.geometry;
      triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
    });
    const box = new THREE.Box3().setFromObject(gltf.scene); // CAD axes: sizes are reported as modelled
    // CAD is Z-up (glTF makes it Y-up), so rings and pendants arrive lying flat: stand them up facing
    // the camera, like a jewel in a showcase. Only the presentation turns; the mesh is untouched.
    gltf.scene.rotation.x = Math.PI / 2;
    gltf.scene.updateMatrixWorld(true);
    const shown = new THREE.Box3().setFromObject(gltf.scene);
    const center = shown.getCenter(new THREE.Vector3());
    gltf.scene.position.sub(center);
    const radius = shown.getBoundingSphere(new THREE.Sphere()).radius || 0.01;
    shadow.scale.set(radius * 2.2, radius * 0.7, 1);
    shadow.position.y = -(shown.max.y - shown.min.y) / 2 - radius * 0.04;
    shadow.visible = true;
    distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.15;
    camera.near = distance / 100;
    camera.far = distance * 10;
    camera.updateProjectionMatrix();
    current = gltf.scene;
    pivot.add(current);
    idle = 0;
    post({ type: "shown", triangles: Math.round(triangles), sizeM: box.getSize(new THREE.Vector3()).toArray() });
    if (snap !== null) {
      try { post({ type: "snapshot", seq: snap, data: snapshot() }); } catch { /* a missing picture is not an error of the viewer */ }
    }
  }, () => post({ type: "error", code: "GLB_INVALID" }));
}

function onMessage(e) {
  let msg;
  try { msg = JSON.parse(e.data); } catch { return; }
  if (msg?.type === "show" && typeof msg.glb === "string" && /^#[0-9a-f]{6}$/i.test(msg.color)) show(msg);
}
window.addEventListener("message", onMessage);
document.addEventListener("message", onMessage); // Android WebView delivers here
post({ type: "ready" });
