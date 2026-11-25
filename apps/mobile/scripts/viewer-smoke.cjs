// Loads the generated viewer in headless Chromium (software WebGL), sends it a real GLB and a
// broken one, and checks: it reports `shown` with triangles, rejects the broken one with
// GLB_INVALID, and makes no network request. Evidence for the viewer, not for a phone.
//   node scripts/viewer-html.mjs --html /tmp/viewer.html
//   node scripts/viewer-smoke.cjs /tmp/viewer.html ../../tools/render-bench/ring-base.glb [out.png]
const { chromium } = require("playwright");
const fs = require("node:fs");
const assert = require("node:assert/strict");

(async () => {
  const [html, glbFile, png] = process.argv.slice(2);
  const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
  const errors = [];
  const requests = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => { if (!/^(blob:|data:|about:blank)/.test(r.url())) requests.push(r.url()); });
  const bridge = "<script>window.__msgs=[];window.ReactNativeWebView={postMessage:(m)=>window.__msgs.push(JSON.parse(m))};</script>";
  await page.setContent(fs.readFileSync(html, "utf8").replace("<body>", `<body>${bridge}`));
  const has = (pred) => page.waitForFunction(pred, null, { timeout: 30000 });
  const send = (msg) => page.evaluate((m) => window.dispatchEvent(new MessageEvent("message", { data: m })), JSON.stringify(msg));
  await has(() => window.__msgs.some((m) => m.type === "ready" || m.type === "error"));
  await send({ type: "show", glb: fs.readFileSync(glbFile).toString("base64"), color: "#d4af37" });
  await has(() => window.__msgs.some((m) => m.type === "shown" || m.type === "error"));
  if (png) await page.screenshot({ path: png });
  await send({ type: "show", glb: Buffer.from("not a glb").toString("base64"), color: "#d4af37" });
  await has(() => window.__msgs.some((m) => m.type === "error"));
  const msgs = await page.evaluate(() => window.__msgs);
  await browser.close();
  console.log(JSON.stringify({ msgs, errors, requests }));
  const shown = msgs.find((m) => m.type === "shown");
  assert.ok(shown && shown.triangles > 0, "viewer did not show the GLB");
  assert.equal(msgs.find((m) => m.type === "error")?.code, "GLB_INVALID");
  assert.deepEqual(requests, [], "viewer made network requests");
  console.log(`viewer smoke OK: ${shown.triangles} triangles, no network`);
})().catch((e) => { console.error(e); process.exit(1); });
