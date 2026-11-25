// The editor as a person uses it, against an in-memory API and a real SQLite store (node:sqlite):
// invalid input refused, offline save, restart offline, sync, conflict decision, online preview and
// explicit acceptance. Auth is mocked as a signed-in customer.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import en from "../src/messages/en.json";
import { DesignApi, FakeDesignServer, GLB_BYTES, PREVIEW_BYTES, PREVIEW_SHA, sqlite, uuid } from "./designFakes";

jest.mock("../src/auth", () => ({
  discover: async () => ({ authorizationEndpoint: "a", tokenEndpoint: "t" }),
  refresh: async () => {
    const g = globalThis as { __guest?: boolean; __offlineLaunch?: boolean };
    if (g.__offlineLaunch) throw new Error("network down"); // the IdP cannot be reached
    return g.__guest ? null : { accessToken: "tok", refreshToken: "r", expiresAt: Date.now() + 3_600_000 };
  },
  rememberSubject: async () => undefined,
  rememberedSubject: async () => ((globalThis as { __guest?: boolean }).__guest ? null : "3c1e9f50-0000-4000-8000-00000000a11c"),
  isFresh: (s: { accessToken?: string } | null) => !!s?.accessToken,
  signIn: async () => null,
  signOut: async () => undefined,
  fetchMe: async () => ({ subject: "3c1e9f50-0000-4000-8000-00000000a11c", roles: ["customer"], permissions: [] }),
}));
jest.mock("expo-crypto", () => ({
  randomUUID: () => require("node:crypto").randomUUID(),
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digest: async (_a: string, data: Uint8Array) => {
    const h = require("node:crypto").createHash("sha256").update(data).digest();
    return h.buffer.slice(h.byteOffset, h.byteOffset + h.length);
  },
}));
import { DesignProvider } from "../src/design/DesignContext";
import { SqliteDesignStore } from "../src/design/store";
import { SessionProvider } from "../src/session";
import { DesignsScreen } from "../src/screens/DesignsScreen";
import { EditorScreen } from "../src/screens/EditorScreen";
import { fromPage, posted } from "./webviewMock";

const config = { env: "ci" as const, issuer: "http://127.0.0.1:8080/realms/aurea-local", apiUrl: "http://127.0.0.1:3000" };
const OWNER = "3c1e9f50-0000-4000-8000-00000000a11c";
const dir = mkdtempSync(join(tmpdir(), "aurea-editor-"));

// The preview's mesh arrives well after its metrics, as on a slow connection.
const MESH_DELAY_MS = 1500;
const slow = { timeout: 4000 };
let previewMeshServed = false;
(globalThis as { fetch: unknown }).fetch = async (url: string) => {
  const preview = url.endsWith(PREVIEW_SHA);
  if (preview) await new Promise((r) => setTimeout(r, MESH_DELAY_MS));
  if (preview) previewMeshServed = true;
  const bytes = preview ? PREVIEW_BYTES : GLB_BYTES;
  return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(0) };
};

async function app(server: FakeDesignServer, file: string, ui: React.ReactElement) {
  const api = new DesignApi(server);
  const db = sqlite(file);
  const openStore = (owner: string) => SqliteDesignStore.open(db, owner);
  const r = await render(
    <SessionProvider config={config} apiOverride={api}>
      <DesignProvider openStore={openStore} newId={uuid}>{ui}</DesignProvider>
    </SessionProvider>,
  );
  return { ...r, api, db };
}

async function stored(server: FakeDesignServer, file: string) {
  const p = server.create("ring.02");
  const db = sqlite(file);
  const store = await SqliteDesignStore.open(db, OWNER);
  await store.putProject({ project: server.projects.get(p.id)!.project, head: server.head(p.id) });
  db.close();
  return p;
}
const input = (name: string) => screen.getByLabelText(`${name} in millimetres`);

beforeEach(() => {
  Object.assign(globalThis, { __guest: false, __offlineLaunch: false });
  previewMeshServed = false;
  posted.length = 0;
});

describe("design editor", () => {
  it("a guest is asked to sign in", async () => {
    (globalThis as { __guest?: boolean }).__guest = true;
    await app(new FakeDesignServer(), join(dir, `${uuid()}.db`), <DesignsScreen onOpen={() => undefined} onNew={() => undefined} />);
    expect(await screen.findByText(en.designsGuest)).toBeTruthy();
    expect(screen.getByRole("button", { name: en.signIn })).toBeTruthy();
  });

  it("after a launch without connection, the stored account's designs are still listed", async () => {
    const server = new FakeDesignServer();
    const file = join(dir, `${uuid()}.db`);
    await stored(server, file);
    server.online = false;
    (globalThis as { __offlineLaunch?: boolean }).__offlineLaunch = true;
    const r = await app(server, file, <DesignsScreen onOpen={() => undefined} onNew={() => undefined} />);
    expect(await screen.findByText(en.offlineBanner)).toBeTruthy();
    expect(screen.getAllByText(/Ring|Anillo/).length).toBeGreaterThan(0);
    expect(screen.queryByText(en.designsGuest)).toBeNull();
    await r.unmount();
    r.db.close();
  });

  it("refuses out-of-range input without adjusting it, saves offline, survives a restart and syncs", async () => {
    const server = new FakeDesignServer();
    const file = join(dir, `${uuid()}.db`);
    const p = await stored(server, file);
    server.online = false;
    const first = await app(server, file, <EditorScreen id={p.id} onBack={() => undefined} />);
    await screen.findByText("Revision 1", { exact: false });
    // No mesh cached and no connection: says so (and not "building").
    await act(async () => { fromPage({ type: "ready" }); });
    expect(await screen.findByText(en.viewerEmpty)).toBeTruthy();

    await fireEvent.changeText(input("Inner diameter"), "40");
    await fireEvent(input("Inner diameter"), "endEditing");
    expect((await screen.findByRole("alert", { name: /Out of range: 14–24 mm/ })) ?? null).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.saveOffline })).toBeNull();

    await fireEvent.changeText(input("Inner diameter"), "19.5");
    await fireEvent(input("Inner diameter"), "endEditing");
    await fireEvent.press(await screen.findByRole("button", { name: en.saveOffline }));
    expect(await screen.findByText("Inner diameter → 19.5 mm · pending")).toBeTruthy();
    expect(screen.getByText(/1 change not sent/)).toBeTruthy();
    await first.unmount();
    first.db.close();

    // Restart, still offline (the IdP cannot be reached either): the change is still there, nothing was sent.
    (globalThis as { __offlineLaunch?: boolean }).__offlineLaunch = true;
    const second = await app(server, file, <EditorScreen id={p.id} onBack={() => undefined} />);
    expect(await screen.findByText("Inner diameter → 19.5 mm · pending")).toBeTruthy();
    expect(server.pushes).toEqual([]);
    expect(screen.getByText(en.offlineBanner)).toBeTruthy();

    server.online = true;
    (globalThis as { __offlineLaunch?: boolean }).__offlineLaunch = false;
    await fireEvent.press(screen.getByRole("button", { name: en.syncNow }));
    await waitFor(() => expect(screen.queryByText(/pending/)).toBeNull());
    expect(await screen.findByText(/Revision 2/)).toBeTruthy();
    expect(server.head(p.id).document.components[0].parameters.innerDiameter).toBe(19.5);
    expect(server.pushes.length).toBe(1);
    await second.unmount();
    second.db.close();
  });

  it("a conflict waits for the person's decision; applying on the current version sends it again", async () => {
    const server = new FakeDesignServer();
    const file = join(dir, `${uuid()}.db`);
    const p = await stored(server, file);
    server.online = false;
    const r = await app(server, file, <EditorScreen id={p.id} onBack={() => undefined} />);
    await screen.findByText("Revision 1", { exact: false });
    await fireEvent.press(screen.getByRole("button", { name: "Increase Band width" }));
    await fireEvent.press(await screen.findByRole("button", { name: en.saveOffline }));
    server.change(p.id, { type: "modify_parameter", componentId: "ring-base", name: "bandWidth", value: 6 });
    server.online = true;
    await fireEvent.press(await screen.findByRole("button", { name: en.syncNow }));
    expect(await screen.findByText(/that value changed on another device/)).toBeTruthy();
    expect(server.head(p.id).document.components[0].parameters.bandWidth).toBe(6); // not overwritten
    await fireEvent.press(screen.getByRole("button", { name: en.retryOnLatest }));
    await waitFor(() => expect(server.head(p.id).document.components[0].parameters.bandWidth).toBe(4.1));
    await waitFor(() => expect(screen.queryByText(/another device/)).toBeNull());
    await r.unmount();
    r.db.close();
  });

  it("a lost acceptance answer is retried with the same key: one revision, not a conflict", async () => {
    const server = new FakeDesignServer();
    const file = join(dir, `${uuid()}.db`);
    const p = await stored(server, file);
    const r = await app(server, file, <EditorScreen id={p.id} onBack={() => undefined} />);
    await screen.findByText("Revision 1", { exact: false });
    await fireEvent.changeText(input("Band width"), "5");
    await fireEvent(input("Band width"), "endEditing");
    await fireEvent.press(await screen.findByRole("button", { name: en.preview }));
    r.api.dropNextAccept = true;
    await fireEvent.press(await screen.findByRole("button", { name: en.accept }, slow));
    expect(await screen.findByText(en.acceptFailed)).toBeTruthy();
    expect(server.head(p.id).number).toBe(2); // the server did commit it
    await fireEvent.press(screen.getByRole("button", { name: en.accept }));
    expect(await screen.findByText(/Revision 2/)).toBeTruthy();
    expect(screen.queryByText(en.acceptConflict)).toBeNull();
    expect(server.head(p.id).number).toBe(2);
    await r.unmount();
    r.db.close();
  });

  it("online: preview shows real metrics and the mesh, and only acceptance creates the revision", async () => {
    const server = new FakeDesignServer();
    const file = join(dir, `${uuid()}.db`);
    const p = await stored(server, file);
    const r = await app(server, file, <EditorScreen id={p.id} onBack={() => undefined} />);
    await screen.findByText("Revision 1", { exact: false });
    // The head's geometry is fetched once and cached for offline use.
    await waitFor(() => expect(r.api.calls.some((x) => x.startsWith("POST /geometry/jobs"))).toBe(true));
    await fireEvent.changeText(input("Band width"), "5");
    await fireEvent(input("Band width"), "endEditing");
    // Accept is offered only once the preview's own mesh is in: never with the previous head's.
    const pressing = fireEvent.press(await screen.findByRole("button", { name: en.preview }));
    await new Promise((r) => setTimeout(r, MESH_DELAY_MS / 3));
    expect(screen.queryByRole("button", { name: en.accept })).toBeNull();
    await pressing;
    expect(await screen.findByRole("button", { name: en.accept }, slow)).toBeTruthy();
    expect(previewMeshServed).toBe(true);
    expect(screen.getByText("Band width: 4 mm → 5 mm")).toBeTruthy();
    expect(screen.getByLabelText("Solid volume: 481.795 mm³")).toBeTruthy();
    expect(screen.getByLabelText("Estimated weight: 7.468 g")).toBeTruthy();
    expect(screen.getByText(en.dfmReview)).toBeTruthy();
    expect(server.head(p.id).number).toBe(1); // a preview never moves the head
    await fireEvent.press(screen.getByRole("button", { name: en.accept }));
    expect(await screen.findByText(/Revision 2/)).toBeTruthy();
    expect(server.head(p.id).document.components[0].parameters.bandWidth).toBe(5);
    const db = sqlite(file);
    const store = await SqliteDesignStore.open(db, OWNER);
    // The accepted revision is cached with the preview's own mesh, never the previous head's.
    expect(await store.glb(server.head(p.id).digest)).toBe(Buffer.from(PREVIEW_BYTES).toString("base64"));
    db.close();
    await r.unmount();
    r.db.close();
  });
});

describe("AURA in the editor", () => {
  it("prompt → three options without changes → preview → explicit acceptance creates the revision", async () => {
    const server = new FakeDesignServer();
    const file = join(dir, `${uuid()}.db`);
    const p = await stored(server, file);
    const r = await app(server, file, <EditorScreen id={p.id} onBack={() => undefined} />);
    await screen.findByText("Revision 1", { exact: false });
    expect(screen.getByText(en.auraSimulated)).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText(en.auraInput), "a bit wider, ancho");
    await fireEvent.press(screen.getByRole("button", { name: en.auraAsk }));
    expect(await screen.findByText("Option 2 · Balanced")).toBeTruthy();
    expect(screen.getByText("Band width: 4 mm → 4.5 mm")).toBeTruthy();
    expect(screen.getByText(en.auraNothingChanges)).toBeTruthy();
    expect(server.head(p.id).number).toBe(1); // a proposal changes nothing
    const previews = screen.getAllByRole("button", { name: en.preview });
    expect(previews).toHaveLength(3);
    await fireEvent.press(previews[1]);
    expect(await screen.findByRole("button", { name: en.accept }, slow)).toBeTruthy();
    expect(screen.getByText("AURA proposal, option 2. Accepting creates a new revision.")).toBeTruthy();
    expect(server.head(p.id).number).toBe(1); // nor does a preview
    await fireEvent.press(screen.getByRole("button", { name: en.accept }));
    expect(await screen.findByText(/Revision 2/)).toBeTruthy();
    expect(server.head(p.id).document.components[0].parameters.bandWidth).toBe(5);
    // The proposal was made on revision 1: once the head moves it is cleared.
    await waitFor(() => expect(screen.queryByText("Option 2 · Balanced")).toBeNull());
    await r.unmount();
    r.db.close();
  });

  it("notes are shown without options; a provider failure can be retried with the same key", async () => {
    const server = new FakeDesignServer();
    const file = join(dir, `${uuid()}.db`);
    const p = await stored(server, file);
    const r = await app(server, file, <EditorScreen id={p.id} onBack={() => undefined} />);
    await screen.findByText("Revision 1", { exact: false });
    await fireEvent.changeText(screen.getByLabelText(en.auraInput), "ponle un diamante");
    await fireEvent.press(screen.getByRole("button", { name: en.auraAsk }));
    expect(await screen.findByText("A jeweler reviews stones.")).toBeTruthy();
    expect(screen.getByText(en.auraNoOptions)).toBeTruthy();
    r.api.aiFailures = 1;
    await fireEvent.changeText(screen.getByLabelText(en.auraInput), "ancho, si falla reintenta");
    await fireEvent.press(screen.getByRole("button", { name: en.auraAsk }));
    expect(await screen.findByText(en.auraDown)).toBeTruthy();
    const keysBefore = r.api.calls.filter((c) => c === "POST /ai/proposals").length;
    await fireEvent.press(screen.getByRole("button", { name: en.retry }));
    expect(await screen.findByText("Option 1 · Subtle")).toBeTruthy();
    expect(r.api.calls.filter((c) => c === "POST /ai/proposals").length).toBe(keysBefore + 1);
    await r.unmount();
    r.db.close();
  });

  it("offline, AURA says it needs a connection and cannot be asked", async () => {
    const server = new FakeDesignServer();
    const file = join(dir, `${uuid()}.db`);
    const p = await stored(server, file);
    server.online = false;
    const r = await app(server, file, <EditorScreen id={p.id} onBack={() => undefined} />);
    await screen.findByText("Revision 1", { exact: false });
    await fireEvent.changeText(screen.getByLabelText(en.auraInput), "wider");
    await fireEvent.press(screen.getByRole("button", { name: en.auraAsk }));
    expect(await screen.findAllByText(en.auraOffline)).not.toHaveLength(0);
    expect(r.api.calls.includes("POST /ai/proposals")).toBe(false);
    await r.unmount();
    r.db.close();
  });
});

describe("design thumbnails", () => {
  const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";

  it("keeps the viewer's picture of the head and shows it in the list; a stale or foreign one is ignored", async () => {
    const server = new FakeDesignServer();
    const file = join(dir, `${uuid()}.db`);
    const p = await stored(server, file);
    const head = server.head(p.id);
    const seedDb = sqlite(file);
    await (await SqliteDesignStore.open(seedDb, OWNER)).putGlb(head.digest, "Z2xURg=="); // the phone already has the head's mesh
    seedDb.close();
    server.online = false;

    const editor = await app(server, file, <EditorScreen id={p.id} onBack={() => undefined} />);
    await screen.findByText("Revision 1", { exact: false });
    await act(async () => { fromPage({ type: "ready" }); });
    const show = posted.map((d) => JSON.parse(d)).find((m) => m.type === "show");
    expect(show).toMatchObject({ glb: "Z2xURg==", snap: true });
    await act(async () => {
      fromPage({ type: "shown" });
      fromPage({ type: "snapshot", seq: show.seq - 1, data: JPEG.replace("/9j", "OLD") }); // an earlier mesh's picture
      fromPage({ type: "snapshot", seq: show.seq, data: "data:text/html;base64,PHNjcmlwdD4=" }); // not a JPEG
    });
    const check = await SqliteDesignStore.open(editor.db, OWNER);
    expect(await check.thumb(p.id)).toBeNull();
    await act(async () => { fromPage({ type: "snapshot", seq: show.seq, data: JPEG }); });
    await waitFor(async () => expect(await check.thumb(p.id)).toEqual({ revisionId: head.id, jpeg: JPEG }));
    await editor.unmount();
    editor.db.close();

    const list = await app(server, file, <DesignsScreen onOpen={() => undefined} onNew={() => undefined} />);
    expect(await screen.findByTestId("design-thumb")).toBeTruthy();
    // Once the design has a newer revision than the picture, the list falls back to the family render.
    await (await SqliteDesignStore.open(list.db, OWNER)).putThumb(p.id, "another-revision", JPEG);
    await list.unmount();
    list.db.close();
    await app(server, file, <DesignsScreen onOpen={() => undefined} onNew={() => undefined} />);
    await screen.findAllByText(/Ring|Anillo/);
    expect(screen.queryByTestId("design-thumb")).toBeNull();
  });
});
