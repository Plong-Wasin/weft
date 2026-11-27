import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { cleanUp, flowOwnerKey, runWithTimeout, stopProcess, withDeadline } from "./shutdown";

describe("e2e shutdown", () => {
  test("timeout kills a reparented process and its late detached child while another flow's detached process survives", async () => {
    const sleeper = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)';
    const detached = `
      import { spawn } from "node:child_process";
      const start = () => spawn(process.execPath, ["-e", ${JSON.stringify(sleeper)}], { detached: true, stdio: "ignore" });
      process.on("SIGTERM", () => console.log("late", start().pid));
      console.log("ready", process.pid);
      setInterval(() => {}, 1000);
    `;
    const launcher = `
      import { spawn } from "node:child_process";
      spawn(process.execPath, ["-e", ${JSON.stringify(detached)}], { detached: true, stdio: ["ignore", 1, 2] }).unref();
    `;
    const flowScript = `
      import { spawn } from "node:child_process";
      spawn(process.execPath, ["-e", ${JSON.stringify(launcher)}], { stdio: ["ignore", 1, 2] });
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `;
    const start = (script: string, owner: string) => spawn(process.execPath, ["-e", script], {
      detached: true, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, [flowOwnerKey]: owner },
    });
    const owner = crypto.randomUUID();
    const flow = start(flowScript, owner);
    const sibling = start(flowScript, crypto.randomUUID());
    const pids: number[] = [];
    const line = (child: typeof flow, label: string) => withDeadline(new Promise<number>((resolve) => {
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        const pid = Number(output.match(new RegExp(`^${label} (\\d+)$`, "m"))?.[1]);
        if (pid) {
          pids.push(pid);
          resolve(pid);
        }
      });
    }), 2_000, label);
    const status = (pid: number) => Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim();
    try {
      const [orphan, siblingPid] = await Promise.all([line(flow, "ready"), line(sibling, "ready")]);
      const late = line(flow, "late");
      void late.catch(() => {});
      await expect(runWithTimeout(flow, "late-fork.e2e.ts", 50, owner)).rejects.toThrow("late-fork.e2e.ts timed out after 50ms");
      expect(flow.signalCode).toBe("SIGKILL");
      expect(status(orphan)).toMatch(/^(?:Z.*)?$/);
      expect(status(await late)).toMatch(/^(?:Z.*)?$/);
      expect(sibling.exitCode).toBeNull();
      expect(status(siblingPid)).toMatch(/^[^Z]/);
    } finally {
      for (const pid of [flow.pid!, sibling.pid!, ...pids]) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
      }
    }
  }, 7_000);

  test("a timed-out flow is named and its detached child stops while a sibling flow continues", async () => {
    const childScript = "setInterval(() => {}, 1000)";
    const sibling = Bun.spawn(["bun", "-e", childScript], { stdout: "ignore", stderr: "ignore" });
    const fixture = `
      import { spawn } from "node:child_process";
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { detached: true, stdio: "ignore" });
      child.on("spawn", () => console.log(child.pid));
      setInterval(() => {}, 1000);
    `;
    const owner = crypto.randomUUID();
    const flow = spawn(process.execPath, ["-e", fixture], { detached: true, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, [flowOwnerKey]: owner } });
    let childPid: number | undefined;
    const deadline = async () => {
      childPid = Number(await new Promise<string>((resolve) => flow.stdout.once("data", (chunk) => resolve(String(chunk)))));
      expect(childPid).toBeGreaterThan(0);
      await expect(runWithTimeout(flow, "hung-example.e2e.ts", 20, owner)).rejects.toThrow("hung-example.e2e.ts timed out after 20ms");
      expect(flow.exitCode !== null || flow.signalCode !== null).toBe(true);
      // A killed orphan can remain as a zombie until the OS reaps it.
      const { stdout } = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(childPid)]);
      expect(stdout.toString().trim()).toMatch(/^(?:Z.*)?$/);
      expect(sibling.exitCode).toBeNull();
    };
    try {
      await withDeadline(deadline(), 4_000, "timeout test");
    } finally {
      flow.kill("SIGKILL");
      if (childPid) {
        try { process.kill(childPid, "SIGKILL"); } catch { /* already stopped */ }
      }
      await stopProcess(sibling, 100);
    }
  });

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
