import { describe, expect, test } from "bun:test";
import { defaultPortBase, ephemeralPortFloor, listenerOn, maxPortBase, resolvePortBase, workerPorts } from "./ports";

describe("E2E_PORT_BASE", () => {
  test("the highest accepted base keeps every port below the ephemeral range", () => {
    expect(maxPortBase(1)).toBe(12_767);
    expect(resolvePortBase("12767", "weft")).toBe(12_767);
    expect(workerPorts(12_767, 0).web).toBeLessThan(ephemeralPortFloor);
  });

  test("a base inside the ephemeral range, or whose web port would reach it, is refused with a message naming the value", () => {
    expect(() => resolvePortBase("12768", "weft")).toThrow("E2E_PORT_BASE=12768 refused");
    expect(() => resolvePortBase("41000", "weft")).toThrow("ephemeral");
    expect(() => resolvePortBase("45535", "weft")).toThrow("refused");
  });

  test("the last worker's web port must stay below the ephemeral range", () => {
    expect(maxPortBase(3)).toBe(12_763);
    expect(resolvePortBase("12763", "weft", 3)).toBe(12_763);
    expect(workerPorts(12_763, 2).web).toBe(32_767);
    expect(() => resolvePortBase("12765", "weft", 3)).toThrow("E2E_PORT_BASE=12765 refused");
  });

  test("a value that is not a whole number in range is refused", () => {
    for (const value of ["abc", "1.5", "1000", "-3"]) expect(() => resolvePortBase(value, "weft")).toThrow("refused");
  });

  test("an empty or unset base takes the directory default", () => {
    expect(resolvePortBase(undefined, "e2e-speed")).toBe(defaultPortBase("e2e-speed"));
    expect(resolvePortBase("  ", "e2e-speed")).toBe(defaultPortBase("e2e-speed"));
  });

  test("every port derived from a default base, for any directory name and up to 32 workers, is below the ephemeral range", () => {
    expect(defaultPortBase("e2e-speed")).toBe(defaultPortBase("e2e-speed"));
    for (let n = 0; n < 2000; n += 1) {
      const base = defaultPortBase(`checkout-${n}`);
      expect(base).toBeGreaterThanOrEqual(2_000);
      expect(base).toBeLessThan(10_000);
      expect(resolvePortBase(undefined, `checkout-${n}`, 32)).toBe(base);
      const { api, web, live } = workerPorts(base, 31);
      expect(Math.max(api, web, live)).toBeLessThan(ephemeralPortFloor);
    }
    for (const name of ["e2e-speed", "e2e-speed-2", "nerite", "weft", "spurdog"]) expect(workerPorts(defaultPortBase(name), 31).web).toBeLessThan(ephemeralPortFloor);
  });

  test("each worker gets its own API, web and live port", () => {
    expect(workerPorts(25000, 0)).toEqual({ api: 25000, web: 45000, live: 35000 });
    expect(workerPorts(25000, 1)).toEqual({ api: 25002, web: 45002, live: 35002 });
  });

  test("no port of one worker is a port of another, for the default bases and up to 32 workers", () => {
    for (const base of [1024, 5_000, 9_999]) {
      const seen = new Set<number>();
      for (let worker = 0; worker < 32; worker += 1) {
        const { api, web, live } = workerPorts(base, worker);
        for (const port of [api, web, live]) { expect(seen.has(port)).toBe(false); expect(port).toBeLessThan(65_535); seen.add(port); }
      }
    }
  });
});

describe("listenerOn", () => {
  test("reports the process listening on a busy port and returns undefined for a free one", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("busy") });
    try {
      const listener = listenerOn(server.port);
      expect(listener).toContain(`(pid ${process.pid})`);
      // the probe only reads: the listener still answers afterwards
      expect(await (await fetch(`http://localhost:${server.port}/`)).text()).toBe("busy");
    } finally {
      server.stop(true);
    }
    expect(listenerOn(server.port)).toBeUndefined();
  });
});
