// Runs the production build (`next start`) and checks what a browser receives.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { after, before, describe, test } from "node:test";

const messages = (l) => JSON.parse(readFileSync(new URL(`../messages/${l}.json`, import.meta.url), "utf8"));
const keys = (o, p = "") => Object.entries(o).flatMap(([k, v]) => (typeof v === "string" ? [p + k] : keys(v, `${p}${k}.`))).sort();

const freePort = () => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); }); });

describe("web skeleton (production build)", () => {
  let proc, base;
  before(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const bin = new URL("../node_modules/next/dist/bin/next", import.meta.url).pathname;
    proc = spawn(process.execPath, [bin, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", AUREA_ENV: "ci" },
      stdio: "ignore",
    });
    for (let i = 0; i < 100; i++) {
      try { await fetch(base); return; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    throw new Error("next start did not come up");
  });
  after(() => proc?.kill());

  test("Spanish by default, landmarks and skip link present", async () => {
    const r = await fetch(base);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /<html lang="es" data-theme="dark"/);
    assert.match(html, /href="#main"[^>]*>Saltar al contenido</);
    assert.match(html, /<nav aria-label="Secciones"/);
    assert.match(html, /<main id="main"/);
    assert.match(html, /<h1>Centro de mando<\/h1>/);
  });

  test("English when the browser asks for it", async () => {
    const html = await (await fetch(base, { headers: { "accept-language": "en-US,en;q=0.9" } })).text();
    assert.match(html, /<html lang="en"/);
    assert.match(html, /<h1>Command center<\/h1>/);
  });

  test("outside production a demo banner is always shown", async () => {
    assert.match(await (await fetch(base)).text(), /role="status"[^>]*>Entorno ci: datos de demostración, no reales</);
  });

  test("security headers are set and the framework is not announced", async () => {
    const r = await fetch(base);
    assert.equal(r.headers.get("x-powered-by"), null);
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    const csp = r.headers.get("content-security-policy");
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-eval/);
  });

  test("the design tokens stylesheet is served", async () => {
    const html = await (await fetch(base)).text();
    const hrefs = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
    const css = (await Promise.all(hrefs.map((h) => fetch(base + h).then((r) => r.text())))).join("\n");
    assert.match(css, /--aurea-color-background:\s*#0C0C0D/i);
  });
});

test("Spanish and English catalogs have the same keys", () => {
  assert.deepEqual(keys(messages("en")), keys(messages("es")));
});
