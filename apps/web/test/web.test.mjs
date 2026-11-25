// Runs the production build (`next start`) and checks what a browser receives.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { after, before, describe, test } from "node:test";

const messages = (l) => JSON.parse(readFileSync(new URL(`../messages/${l}.json`, import.meta.url), "utf8"));
const keys = (o, p = "") => Object.entries(o).flatMap(([k, v]) => (typeof v === "string" ? [p + k] : keys(v, `${p}${k}.`))).sort();

const freePort = () => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); }); });

// A stand-in identity provider and AUREA API on one port: enough to drive the BFF end to end.
const CLIENT_SECRET = "c".repeat(48);
const ACCESS = "access-token-that-must-never-reach-the-browser";
const fake = { codes: new Map(), calls: [], perms: ["quote.read", "quote.issue", "order.read", "inventory.read", "inventory.move", "pricing.internal"] };
const money = (amount) => ({ amount, currency: "COP" });
const QUOTE = {
  id: "11111111-1111-4111-8111-111111111111", projectTitle: "Anillo Aurora", revisionNumber: 2, state: "DRAFT",
  total: money("5036913"), subtotal: money("4232700"), tax: { code: "TAX_DEMO", rate: "0.19", amount: money("804213") },
  deposit: { rate: "0.30", amount: money("1511100") },
  lines: [{ code: "METAL:gold-18k-yellow", label: "Oro 18k amarillo", amount: money("3766000") }, { code: "WORKMANSHIP", label: "Hechura", amount: money("466700") }],
  bom: [{ componentId: "ring-base", materialId: "gold-18k-yellow", massGrams: "6.942" }],
  pricing: { ruleVersion: "demo-2026.11.0", termsVersion: "demo-terms-2026.11", simulated: true, ratesSource: "DEMO_SYNTHETIC", ratesDate: "2026-11-25" },
  digest: "a".repeat(64), expiresAt: "2026-12-02T00:00:00Z", createdAt: "2026-11-25T15:00:00Z", issuedAt: null, orderId: null,
  internal: { costLines: [{ code: "LABOR", label: "Mano de obra", amount: money("180000") }], cost: money("2539621"), margin: "0.40", grossProfit: money("1693079") },
};
const ORDER = {
  id: "22222222-2222-4222-8222-222222222222", projectTitle: "Anillo Aurora", revisionNumber: 2, state: "CONFIRMED", total: money("5036913"),
  deposit: { required: money("1511100"), paid: money("1511100"), outstanding: money("0") }, balance: money("3525813"),
  reservations: [{ id: "r1", itemKey: "gold-18k-yellow", lotLabel: "Oro 18k amarillo (demo)", unit: "g", quantity: "7.637", state: "ALLOCATED", expiresAt: "2026-11-27T00:00:00Z" }],
  payments: [{ id: "p1", kind: "DEPOSIT", amount: money("1511100"), state: "CONFIRMED", provider: { id: "simulated", simulated: true }, reviewReason: null, failureCode: null }],
  cancelReason: null, createdAt: "2026-11-25T15:10:00Z",
};
const LOT = { id: "33333333-3333-4333-8333-333333333333", itemKey: "gold-18k-yellow", label: "Oro 18k amarillo (demo)", unit: "g", location: { name: "Taller AUREA (demo)" },
  onHand: "30", reserved: "7.637", available: "22.363", held: "0", allocated: "7.637", demo: true };

function fakeServer() {
  return createHttpServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const issuer = `http://127.0.0.1:${req.socket.localPort}`;
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(200, { issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, end_session_endpoint: `${issuer}/logout` });
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const f = new URLSearchParams(raw);
      const code = fake.codes.get(f.get("code"));
      fake.codes.delete(f.get("code"));
      const basic = Buffer.from(`aurea-web:${CLIENT_SECRET}`).toString("base64");
      const verifierOk = code && createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") === code.challenge;
      if (req.headers.authorization !== `Basic ${basic}` || f.get("grant_type") !== "authorization_code" || !verifierOk) return json(400, { error: "invalid_grant" });
      const idToken = `x.${Buffer.from(JSON.stringify({ nonce: code.nonce })).toString("base64url")}.y`;
      return json(200, { access_token: ACCESS, refresh_token: "r", expires_in: 300, id_token: idToken });
    }
    if (url.pathname.startsWith("/v1/")) {
      fake.calls.push({ method: req.method, path: url.pathname + url.search, auth: req.headers.authorization });
      if (req.headers.authorization !== `Bearer ${ACCESS}`) return json(401, { code: "UNAUTHENTICATED", message: "" });
      if (url.pathname === "/v1/me") return json(200, { subject: "staff-1", roles: ["advisor", "finance", "stockkeeper"], permissions: fake.perms });
      if (url.pathname === "/v1/quotes") return json(200, { items: url.searchParams.get("state") === "DRAFT" ? [QUOTE] : [QUOTE, { ...QUOTE, id: "44444444-4444-4444-8444-444444444444", state: "ACCEPTED", internal: undefined }], nextCursor: null });
      if (url.pathname === "/v1/orders") return json(200, { items: [ORDER], nextCursor: null });
      if (url.pathname === "/v1/inventory/lots") return json(200, { items: [LOT], nextCursor: null });
    }
    json(404, { code: "NOT_FOUND", message: "" });
  });
}

const cookieHeader = (r, jar = new Map()) => {
  for (const c of r.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const [k, v] = pair.split("=");
    if (v) jar.set(k, v); else jar.delete(k);
  }
  return jar;
};
const text = async (r) => (await r.text()).replaceAll("<!-- -->", ""); // React's text-node separators
const asHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

describe("web skeleton (production build)", () => {
  let proc, base, fakeSrv, fakeBase;
  before(async () => {
    fakeSrv = fakeServer();
    await new Promise((r) => fakeSrv.listen(0, "127.0.0.1", r));
    fakeBase = `http://127.0.0.1:${fakeSrv.address().port}`;
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const bin = new URL("../node_modules/next/dist/bin/next", import.meta.url).pathname;
    proc = spawn(process.execPath, [bin, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env, NEXT_TELEMETRY_DISABLED: "1", AUREA_ENV: "ci",
        OIDC_ISSUER: fakeBase, KC_WEB_CLIENT_SECRET: CLIENT_SECRET, WEB_SESSION_SECRET: "s".repeat(40), WEB_ORIGIN: base, AUREA_API_URL: `${fakeBase}/v1`,
      },
      stdio: "ignore",
    });
    for (let i = 0; i < 100; i++) {
      try { await fetch(base); return; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    throw new Error("next start did not come up");
  });
  after(() => { proc?.kill(); fakeSrv?.close(); });

  /** Runs the login as a browser would: BFF → IdP (stand-in) → callback. Returns the cookie jar. */
  async function signIn(next = "/panel") {
    const start = await fetch(`${base}/auth/login?next=${encodeURIComponent(next)}`, { redirect: "manual" });
    assert.equal(start.status, 303);
    const jar = cookieHeader(start);
    const to = new URL(start.headers.get("location"));
    const code = `code-${Math.random()}`;
    fake.codes.set(code, { challenge: to.searchParams.get("code_challenge"), nonce: to.searchParams.get("nonce") });
    const back = await fetch(`${base}/auth/callback?code=${code}&state=${to.searchParams.get("state")}`, { redirect: "manual", headers: { cookie: asHeader(jar) } });
    return { start, to, back, jar: cookieHeader(back, jar) };
  }

  test("panel: no session → login; login is code + PKCE S256 with state and nonce, bound by an HttpOnly cookie", async () => {
    const r = await fetch(`${base}/panel/pedidos`, { redirect: "manual" });
    assert.equal(r.status, 307);
    assert.equal(r.headers.get("location"), "/auth/login?next=%2Fpanel");
    const { start, to, back, jar } = await signIn("/panel/pedidos");
    assert.equal(to.origin + to.pathname, `${fakeBase}/auth`);
    assert.equal(to.searchParams.get("response_type"), "code");
    assert.equal(to.searchParams.get("code_challenge_method"), "S256");
    assert.equal(to.searchParams.get("redirect_uri"), `${base}/auth/callback`);
    assert.match(start.headers.getSetCookie().join(), /aurea_login=[^;]+;.*HttpOnly/i);
    assert.match(start.headers.getSetCookie().join(), /SameSite=lax/i);
    assert.equal(back.status, 303);
    assert.equal(back.headers.get("location"), `${base}/panel/pedidos`);
    assert.ok(jar.get("aurea_sid"), "session cookie set");
    assert.match(back.headers.getSetCookie().join(), /aurea_sid=[^;]+;.*HttpOnly/i);
  });

  test("callback: a state from another browser, a replayed state or a wrong nonce never makes a session", async () => {
    const start = await fetch(`${base}/auth/login`, { redirect: "manual" });
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const noCookie = await fetch(`${base}/auth/callback?code=x&state=${state}`, { redirect: "manual" });
    assert.equal(noCookie.headers.get("location"), `${base}/auth/error?reason=state`);
    assert.ok(!noCookie.headers.getSetCookie().some((c) => c.startsWith("aurea_sid=") && !/aurea_sid=;/.test(c)));

    const { to, jar } = await signIn();
    const replay = await fetch(`${base}/auth/callback?code=x&state=${to.searchParams.get("state")}`, { redirect: "manual", headers: { cookie: asHeader(jar) } });
    assert.equal(replay.headers.get("location"), `${base}/auth/error?reason=state`);

    const s2 = await fetch(`${base}/auth/login`, { redirect: "manual" });
    const j2 = cookieHeader(s2);
    const t2 = new URL(s2.headers.get("location"));
    fake.codes.set("bad-nonce", { challenge: t2.searchParams.get("code_challenge"), nonce: "someone-else" });
    const r2 = await fetch(`${base}/auth/callback?code=bad-nonce&state=${t2.searchParams.get("state")}`, { redirect: "manual", headers: { cookie: asHeader(j2) } });
    assert.equal(r2.headers.get("location"), `${base}/auth/error?reason=nonce`);
    assert.match(await (await fetch(`${base}/auth/error?reason=nonce`)).text(), /role="alert"/);
  });

  test("login only sends staff back to panel paths (no open redirect)", async () => {
    const { back } = await signIn("https://evil.example/");
    assert.equal(back.headers.get("location"), `${base}/panel`);
  });

  test("quotes: the DRAFT queue with customer price, internal costs and the issue form; tokens stay on the server", async () => {
    const { jar } = await signIn();
    const html = await text(await fetch(`${base}/panel/cotizaciones`, { headers: { cookie: asHeader(jar) } }));
    assert.match(html, /Anillo Aurora · revisión 2/);
    assert.match(html, /COP 5\.036\.913/);
    assert.match(html, /Interno \(no se muestra al cliente\)/);
    assert.match(html, /COP 2\.539\.621/);
    assert.match(html, /Reglas de precio de demostración/);
    assert.match(html, /Emitir por COP 5\.036\.913/);
    assert.match(html, /<label for="exp-11111111[^"]*">Válida hasta<\/label>/);
    assert.match(html, /Aceptada/, "recent quotes list");
    assert.doesNotMatch(html, new RegExp(ACCESS));
    assert.ok(fake.calls.filter((c) => c.path.startsWith("/v1/quotes")).every((c) => c.auth === `Bearer ${ACCESS}`));
  });

  test("orders and inventory: deposit paid/outstanding, allocated metal, lots and the receipt form", async () => {
    const { jar } = await signIn();
    const orders = await text(await fetch(`${base}/panel/pedidos`, { headers: { cookie: asHeader(jar) } }));
    assert.match(orders, /Confirmado/);
    assert.match(orders, /Oro 18k amarillo \(demo\): 7\.637 g · Asignado/);
    assert.match(orders, /simulado/);
    const inv = await text(await fetch(`${base}/panel/inventario`, { headers: { cookie: asHeader(jar), "accept-language": "en" } }));
    assert.match(inv, /Metal lots/);
    assert.match(inv, /22\.363 g/);
    assert.match(inv, /<label for="delta">Quantity \(g\)<\/label>/);
  });

  test("without the permission a section says so instead of showing data", async () => {
    const { jar } = await signIn();
    fake.perms = ["quote.read"];
    try {
      const html = await text(await fetch(`${base}/panel/inventario`, { headers: { cookie: asHeader(jar) } }));
      assert.match(html, /Tu rol no tiene acceso a esta sección/);
      assert.doesNotMatch(html, /22\.363/);
    } finally {
      fake.perms = ["quote.read", "quote.issue", "order.read", "inventory.read", "inventory.move", "pricing.internal"];
    }
  });

  test("logout: POST from our own origin only; it ends the session here and at the IdP", async () => {
    const { jar } = await signIn();
    const cross = await fetch(`${base}/auth/logout`, { method: "POST", redirect: "manual", headers: { cookie: asHeader(jar), origin: "https://evil.example" } });
    assert.equal(cross.status, 403);
    const out = await fetch(`${base}/auth/logout`, { method: "POST", redirect: "manual", headers: { cookie: asHeader(jar), origin: base } });
    assert.equal(out.status, 303);
    const to = new URL(out.headers.get("location"));
    assert.equal(to.origin + to.pathname, `${fakeBase}/logout`);
    assert.equal(to.searchParams.get("post_logout_redirect_uri"), `${base}/`);
    const after = await fetch(`${base}/panel/cotizaciones`, { redirect: "manual", headers: { cookie: asHeader(jar) } });
    assert.equal(after.status, 307, "the old cookie no longer opens the panel");
  });

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
