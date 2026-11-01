import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "@weft/db";
import { createSignalBus, parseSignal, type Signal } from "../src";

const { client } = createDatabase();
afterAll(async () => client.end());

const url = Bun.env.DATABASE_URL ?? "postgres://weft:weft@localhost:54329/weft";

async function next(received: Signal[], count: number) {
  for (let i = 0; i < 100 && received.length < count; i++) await Bun.sleep(50);
  return received;
}

test.concurrent("a signal published by one bus instance reaches subscribers of another through LISTEN/NOTIFY", async () => {
  const a = createSignalBus(url);
  const b = createSignalBus(url);
  try {
    const received: Signal[] = [];
    const workspaceId = crypto.randomUUID();
    b.subscribe((signal) => { if (signal.workspaceId === workspaceId) received.push(signal); });
    await b.ready();
    await a.publish({ type: "change", workspaceId, projectId: "p1" });
    expect(await next(received, 1)).toEqual([{ type: "change", workspaceId, projectId: "p1" }]);
  } finally {
    await a.close();
    await b.close();
  }
});

test.concurrent("an unsubscribed listener hears nothing more", async () => {
  const bus = createSignalBus(url);
  try {
    const received: Signal[] = [];
    const workspaceId = crypto.randomUUID();
    const off = bus.subscribe((signal) => { if (signal.workspaceId === workspaceId) received.push(signal); });
    await bus.ready();
    await bus.publish({ type: "notification", workspaceId, userId: "u1" });
    await next(received, 1);
    off();
    await bus.publish({ type: "notification", workspaceId, userId: "u2" });
    await Bun.sleep(300);
    expect(received).toEqual([{ type: "notification", workspaceId, userId: "u1" }]);
  } finally {
    await bus.close();
  }
});

test("signals carry only routing ids: parseSignal drops extra fields and rejects junk", () => {
  expect(parseSignal(JSON.stringify({ type: "change", workspaceId: "w", title: "secret" }))).toEqual({ type: "change", workspaceId: "w" });
  expect(parseSignal(JSON.stringify({ type: "notification", workspaceId: "w", userId: "u", body: "x" }))).toEqual({ type: "notification", workspaceId: "w", userId: "u" });
  expect(parseSignal("not json")).toBeNull();
  expect(parseSignal(JSON.stringify({ type: "other" }))).toBeNull();
});
