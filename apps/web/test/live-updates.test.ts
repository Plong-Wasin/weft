import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { connectLiveUpdates, backoffDelay } from "../src/live-updates";

class FakeSource {
  static all: FakeSource[] = [];
  listeners = new Map<string, (event: { data: string }) => void>();
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeSource.all.push(this); }
  addEventListener(name: string, listener: (event: { data: string }) => void) { this.listeners.set(name, listener); }
  close() { this.closed = true; }
  emit(name: string, data: unknown) { this.listeners.get(name)?.({ data: JSON.stringify(data) }); }
}

function setup() {
  FakeSource.all = [];
  const client = new QueryClient();
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const connection = connectLiveUpdates(client, {
    url: "http://api/api/events", createSource: (url) => new FakeSource(url) as never,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length as never; }, clearTimer: () => {},
  });
  return { client, timers, connection, source: () => FakeSource.all.at(-1)! };
}

test("a notification signal invalidates that workspace's inbox only", () => {
  const { client, source } = setup();
  client.setQueryData(["inbox", "w1"], 1); client.setQueryData(["inbox", "w2"], 1); client.setQueryData(["work-items", "w1"], 1);
  source().emit("notification", { workspaceId: "w1" });
  expect(client.getQueryState(["inbox", "w1"])!.isInvalidated).toBe(true);
  expect(client.getQueryState(["inbox", "w2"])!.isInvalidated).toBe(false);
  expect(client.getQueryState(["work-items", "w1"])!.isInvalidated).toBe(false);
});

test("a change signal invalidates cached data so active lists refetch", () => {
  const { client, source } = setup();
  client.setQueryData(["work-items", "p1"], 1); client.setQueryData(["wiki"], 1);
  source().emit("change", { workspaceId: "w1", projectId: "p1" });
  expect(client.getQueryState(["work-items", "p1"])!.isInvalidated).toBe(true);
  expect(client.getQueryState(["wiki"])!.isInvalidated).toBe(true);
});

test("reconnects with growing backoff, resets after a successful open, and refetches what was missed", () => {
  const { client, timers, source } = setup();
  client.setQueryData(["wiki"], 1);
  source().onerror!();
  expect(source().closed).toBe(true);
  expect(timers).toHaveLength(1);
  const first = timers[0]!.ms;
  timers[0]!.fn();
  expect(FakeSource.all).toHaveLength(2);
  source().onerror!();
  expect(timers[1]!.ms).toBeGreaterThan(1_000);
  timers[1]!.fn();
  source().onopen!();
  expect(client.getQueryState(["wiki"])!.isInvalidated).toBe(true);
  source().onerror!();
  expect(timers[2]!.ms).toBeLessThanOrEqual(1_000);
  expect(backoffDelay(50, () => 0.5)).toBeLessThanOrEqual(30_000);
});

test("close stops the connection and further reconnects", () => {
  const { timers, connection, source } = setup();
  const current = source();
  connection.close();
  expect(current.closed).toBe(true);
  current.onerror?.();
  expect(timers).toHaveLength(0);
});
