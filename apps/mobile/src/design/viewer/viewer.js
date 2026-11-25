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
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color("#0c0c0d");
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
const camera = new THREE.PerspectiveCamera(35, 1, 0.0001, 10);
const pivot = new THREE.Group();
scene.add(pivot);
let current = null;
let yaw = 0.6, pitch = 0.35, distance = 0.05, dragging = null, idle = 0;

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

function frame() {
  if (!dragging && !reduced && current && ++idle > 90) yaw += 0.004; // slow turn after 1.5 s without touch
  camera.position.set(distance * Math.cos(pitch) * Math.sin(yaw), distance * Math.sin(pitch), distance * Math.cos(pitch) * Math.cos(yaw));
  camera.lookAt(0, 0, 0);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function bytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

function show({ glb, color }) {
  try {
    parse(bytes(glb), color);
  } catch {
    post({ type: "error", code: "GLB_INVALID" }); // the loader throws synchronously on a non-glTF buffer
  }
}

function parse(buffer, color) {
  new GLTFLoader().parse(buffer, "", (gltf) => {
    if (current) {
      pivot.remove(current);
      current.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
    }
    const metal = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(color), metalness: 1, roughness: 0.22, clearcoat: 0.3 });
    let triangles = 0;
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.material = metal;
      const g = o.geometry;
      triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
    });
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const center = box.getCenter(new THREE.Vector3());
    gltf.scene.position.sub(center);
    const radius = box.getBoundingSphere(new THREE.Sphere()).radius || 0.01;
    distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.15;
    camera.near = distance / 100;
    camera.far = distance * 10;
    camera.updateProjectionMatrix();
    current = gltf.scene;
    pivot.add(current);
    idle = 0;
    post({ type: "shown", triangles: Math.round(triangles), sizeM: box.getSize(new THREE.Vector3()).toArray() });
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
