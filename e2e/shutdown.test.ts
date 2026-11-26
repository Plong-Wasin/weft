import { describe, expect, test } from "bun:test";
import { cleanUp, stopProcess, withDeadline } from "./shutdown";

describe("e2e shutdown", () => {
  test("a rejected browser close still stops servers and closes the database without replacing the primary error", async () => {
    const primary = new Error("browser assertion failed");
    const calls: string[] = [];
    const cleanupErrors: unknown[] = [];
    async function flow() {
      try {
        throw primary;
      } finally {
        await cleanUp([
          async () => { calls.push("browser"); throw new Error("browser disconnected"); },
          async () => { calls.push("servers"); },
          async () => {
            try { throw new Error("delete failed"); }
            finally { calls.push("database close"); }
          },
        ], (error) => cleanupErrors.push(error));
      }
    }
    await expect(flow()).rejects.toBe(primary);
    expect(calls).toEqual(["browser", "servers", "database close"]);
    expect(cleanupErrors).toHaveLength(2);
  });

  test("a child that ignores termination is killed and its exit is awaited", async () => {
    const stopped = Promise.withResolvers<number>();
    const signals: string[] = [];
    await stopProcess({
      exited: stopped.promise,
      kill(signal) {
        signals.push(signal);
        if (signal === "SIGKILL") stopped.resolve(137);
      },
    }, 10);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("a stalled cleanup is bounded and the next cleanup still runs", async () => {
    const called: string[] = [];
    await expect(cleanUp([
      () => withDeadline(new Promise<never>(() => {}), 10, "database cleanup"),
      async () => { called.push("close"); },
    ])).rejects.toThrow("database cleanup timed out");
    expect(called).toEqual(["close"]);
  });
});
