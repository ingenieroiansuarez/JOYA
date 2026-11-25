// The editor as a person uses it, against an in-memory API and a real SQLite store (node:sqlite):
// invalid input refused, offline save, restart offline, sync, conflict decision, online preview and
// explicit acceptance. Auth is mocked as a signed-in customer.
import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import en from "../src/messages/en.json";
import { DesignApi, FakeDesignServer, GLB_BYTES, sqlite, uuid } from "./designFakes";

jest.mock("../src/auth", () => ({
  discover: async () => ({ authorizationEndpoint: "a", tokenEndpoint: "t" }),
  refresh: async () => ((globalThis as { __guest?: boolean }).__guest ? null : { accessToken: "tok", refreshToken: "r", expiresAt: Date.now() + 3_600_000 }),
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
import { posted } from "./webviewMock";

const config = { env: "ci" as const, issuer: "http://127.0.0.1:8080/realms/aurea-local", apiUrl: "http://127.0.0.1:3000" };
const OWNER = "3c1e9f50-0000-4000-8000-00000000a11c";
const dir = mkdtempSync(join(tmpdir(), "aurea-editor-"));

(globalThis as { fetch: unknown }).fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => GLB_BYTES.buffer.slice(0) });

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

beforeEach(() => { (globalThis as { __guest?: boolean }).__guest = false; posted.length = 0; });

describe("design editor", () => {
  it("a guest is asked to sign in", async () => {
    (globalThis as { __guest?: boolean }).__guest = true;
    await app(new FakeDesignServer(), join(dir, `${uuid()}.db`), <DesignsScreen onOpen={() => undefined} onNew={() => undefined} />);
    expect(await screen.findByText(en.designsGuest)).toBeTruthy();
    expect(screen.getByRole("button", { name: en.signIn })).toBeTruthy();
  });

  it("refuses out-of-range input without adjusting it, saves offline, survives a restart and syncs", async () => {
    const server = new FakeDesignServer();
    const file = join(dir, `${uuid()}.db`);
    const p = await stored(server, file);
    server.online = false;
    const first = await app(server, file, <EditorScreen id={p.id} onBack={() => undefined} />);
    await screen.findByText("Revision 1", { exact: false });

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

    // Restart, still offline: the change is still there, nothing was sent.
    const second = await app(server, file, <EditorScreen id={p.id} onBack={() => undefined} />);
    expect(await screen.findByText("Inner diameter → 19.5 mm · pending")).toBeTruthy();
    expect(server.pushes).toEqual([]);
    expect(screen.getByText(en.offlineBanner)).toBeTruthy();

    server.online = true;
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
    await fireEvent.press(await screen.findByRole("button", { name: en.preview }));
    expect(await screen.findByText("Band width: 4 mm → 5 mm")).toBeTruthy();
    expect(screen.getByLabelText("Solid volume: 481.795 mm³")).toBeTruthy();
    expect(screen.getByLabelText("Estimated weight: 7.468 g")).toBeTruthy();
    expect(screen.getByText(en.dfmReview)).toBeTruthy();
    expect(server.head(p.id).number).toBe(1); // a preview never moves the head
    await fireEvent.press(screen.getByRole("button", { name: en.accept }));
    expect(await screen.findByText(/Revision 2/)).toBeTruthy();
    expect(server.head(p.id).document.components[0].parameters.bandWidth).toBe(5);
    const db = sqlite(file);
    const store = await SqliteDesignStore.open(db, OWNER);
    expect(await store.glb(server.head(p.id).digest)).toBe(Buffer.from(GLB_BYTES).toString("base64"));
    expect(createHash("sha256").update(GLB_BYTES).digest("hex")).toHaveLength(64);
    db.close();
    await r.unmount();
    r.db.close();
  });
});
