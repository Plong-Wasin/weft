import { describe, expect, test } from "bun:test";
import { defaultPortBase, listenerOn, maxPortBase, resolvePortBase, workerPorts } from "./ports";

describe("E2E_PORT_BASE", () => {
  test("the highest accepted base keeps its web port below 65535", () => {
    expect(resolvePortBase("45534", "weft")).toBe(45534);
    expect(maxPortBase + 20_000).toBeLessThan(65535);
  });

  test("a base of 45535 or more is refused with a message naming the value", () => {
    expect(() => resolvePortBase("45535", "weft")).toThrow("E2E_PORT_BASE=45535 refused");
    expect(() => resolvePortBase("60000", "weft")).toThrow("refused");
  });

  test("a value that is not a whole number in range is refused", () => {
    for (const value of ["abc", "1.5", "1000", "-3"]) expect(() => resolvePortBase(value, "weft")).toThrow("refused");
  });

  test("an empty or unset base takes the directory default", () => {
    expect(resolvePortBase(undefined, "e2e-speed")).toBe(defaultPortBase("e2e-speed"));
    expect(resolvePortBase("  ", "e2e-speed")).toBe(defaultPortBase("e2e-speed"));
  });

  test("the default base comes from the directory name and stays in 30000-39999", () => {
    expect(defaultPortBase("e2e-speed")).toBe(defaultPortBase("e2e-speed"));
    for (const name of ["e2e-speed", "nerite", "weft", "spurdog"]) {
      const base = defaultPortBase(name);
      expect(base).toBeGreaterThanOrEqual(30_000);
      expect(base).toBeLessThan(40_000);
    }
  });

  test("each worker gets its own API and web port pair", () => {
    expect(workerPorts(25000, 0)).toEqual({ api: 25000, web: 45000 });
    expect(workerPorts(25000, 1)).toEqual({ api: 25002, web: 45002 });
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
