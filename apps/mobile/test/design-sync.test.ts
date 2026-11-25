import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "@jest/globals";
import { SqliteDesignStore, type DesignStore } from "../src/design/store";
import { DesignSync } from "../src/design/sync";
import { FakeDesignServer, sqlite, uuid } from "./designFakes";

const dir = mkdtempSync(join(tmpdir(), "aurea-design-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const OWNER = "3c1e9f50-0000-4000-8000-00000000a11c";
const set = (name: string, value: number) => ({ type: "modify_parameter", componentId: "ring-base", name, value });

async function setup(file = join(dir, `${uuid()}.db`)) {
  const server = new FakeDesignServer();
  const db = sqlite(file);
  const store = await SqliteDesignStore.open(db, OWNER);
  const sync = new DesignSync(store, server.client(), uuid);
  const p = server.create();
  await sync.refresh(p.id);
  return { server, db, store, sync, p, file };
}

describe("offline design changes", () => {
  it("invalid input is rejected locally and never queued", async () => {
    const { sync, store, p } = await setup();
    for (const [op, code] of [
      [set("innerDiameter", 40), "OUT_OF_RANGE"],
      [set("bandWidth", Number.NaN), "NOT_FINITE"],
      [set("height", 3), "UNKNOWN_PARAMETER"],
      [set("bandWidth", 4), "NO_CHANGE"],
      [{ type: "boolean_union", componentIds: [] }, "UNSUPPORTED_OPERATION"],
    ] as const) {
      const r = await sync.saveOffline(p.id, op);
      expect(r.ok ? "ok" : r.issues[0].code).toBe(code);
    }
    expect(await store.outbox()).toEqual([]);
  });

  it("survives a restart offline and applies in order once back, with no duplicates", async () => {
    const { server, db, sync, p, file } = await setup();
    server.online = false;
    expect((await sync.saveOffline(p.id, set("innerDiameter", 19))).ok).toBe(true);
    expect((await sync.saveOffline(p.id, set("innerDiameter", 19.5))).ok).toBe(true); // same value again, on top of the first
    expect((await sync.saveOffline(p.id, set("bandWidth", 5))).ok).toBe(true);
    expect(await sync.flush()).toEqual({ state: "offline" });
    db.close();

    // App killed and opened again, still offline: the draft is what the person left.
    const db2 = sqlite(file);
    const store2 = await SqliteDesignStore.open(db2, OWNER);
    const sync2 = new DesignSync(store2, server.client(), uuid);
    const d = (await sync2.draft(p.id))!;
    expect(d.pending.map((e) => e.op.sequence)).toEqual([1, 2, 3]);
    expect(d.document.components[0].parameters).toEqual({ innerDiameter: 19.5, bandWidth: 5, radialThickness: 1.8 });
    expect(d.local.head.number).toBe(1);

    server.online = true;
    expect(await sync2.flush()).toEqual({ state: "done", applied: 3, conflicts: 0, rejected: 0 });
    expect(server.head(p.id).number).toBe(4);
    expect(server.head(p.id).document.components[0].parameters).toEqual({ innerDiameter: 19.5, bandWidth: 5, radialThickness: 1.8 });
    // The second change of the same value was sent on the first one's revision, so it was not a conflict with itself.
    expect(server.pushes.map((b) => b.length)).toEqual([1, 1, 1]);
    const after = (await sync2.draft(p.id))!;
    expect([after.pending.length, after.local.head.number]).toEqual([0, 4]);
    expect(await sync2.flush()).toEqual({ state: "idle" });
    db2.close();
  });

  it("a lost answer is resent with the same id and not applied twice", async () => {
    const { server, sync, p } = await setup();
    await sync.saveOffline(p.id, set("bandWidth", 6));
    server.dropNextAnswer = true;
    expect(await sync.flush()).toEqual({ state: "offline" });
    expect(server.head(p.id).number).toBe(2); // the server did apply it
    expect(await sync.flush()).toEqual({ state: "done", applied: 1, conflicts: 0, rejected: 0 });
    expect(server.head(p.id).number).toBe(2);
    expect(server.pushes[0][0].id).toBe(server.pushes[1][0].id);
  });

  it("same value changed on the server: conflict, nothing overwritten, later changes wait", async () => {
    const { server, sync, store, p } = await setup();
    server.online = false;
    await sync.saveOffline(p.id, set("bandWidth", 7));
    await sync.saveOffline(p.id, set("radialThickness", 2));
    server.online = true;
    server.change(p.id, set("bandWidth", 5));
    expect(await sync.flush()).toEqual({ state: "done", applied: 0, conflicts: 1, rejected: 0 });
    expect(server.head(p.id).document.components[0].parameters.bandWidth).toBe(5);
    const d = (await sync.draft(p.id))!;
    expect(d.problems.map((e) => [e.status, e.error?.code])).toEqual([["CONFLICT", "VERSION_CONFLICT"]]);
    expect(d.pending.map((e) => e.op.operation)).toEqual([set("radialThickness", 2)]);
    expect(server.pushes.length).toBe(1); // the second one was not sent behind the conflict

    // The person chooses to make the change again on the current version.
    expect((await sync.retryOnLatest(d.problems[0].op.id)).ok).toBe(true);
    expect(await sync.flush()).toEqual({ state: "done", applied: 2, conflicts: 0, rejected: 0 });
    expect(server.head(p.id).document.components[0].parameters).toEqual({ innerDiameter: 18, bandWidth: 7, radialThickness: 2 });
    expect(await store.outbox()).toEqual([]);
  });

  it("an independent value changed on the server is rebased; discarding a conflict drops only that change", async () => {
    const { server, sync, p } = await setup();
    server.online = false;
    await sync.saveOffline(p.id, set("innerDiameter", 20));
    server.online = true;
    server.change(p.id, set("bandWidth", 5));
    expect(await sync.flush()).toEqual({ state: "done", applied: 1, conflicts: 0, rejected: 0 });
    expect(server.head(p.id).document.components[0].parameters).toEqual({ innerDiameter: 20, bandWidth: 5, radialThickness: 1.8 });

    server.online = false;
    await sync.saveOffline(p.id, set("bandWidth", 9));
    server.online = true;
    server.change(p.id, set("bandWidth", 6));
    await sync.flush();
    const d = (await sync.draft(p.id))!;
    await sync.discard(d.problems[0].op.id);
    expect((await sync.draft(p.id))!.problems).toEqual([]);
    expect(server.head(p.id).document.components[0].parameters.bandWidth).toBe(6);
  });

  it("another customer on the same phone sees none of it", async () => {
    const { db, sync, p } = await setup(join(dir, "shared.db"));
    await sync.saveOffline(p.id, set("bandWidth", 6));
    const other: DesignStore = await SqliteDesignStore.open(db, "someone-else");
    expect([await other.projects(), await other.outbox()]).toEqual([[], []]);
  });
});
