import { expect, test } from "bun:test";

// A command that only warms the pool (the API at boot, the migrate command) must not be held open by the pool's own timers.
test.serial("a script that only warms the pool exits in under 1 s", async () => {
  const entry = new URL("../src/index.ts", import.meta.url).pathname;
  const script = `import { warmWrittenFormPool } from ${JSON.stringify(entry)}; await warmWrittenFormPool(); console.log("warmed");`;
  const started = performance.now();
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  const seconds = (performance.now() - started) / 1000;
  expect({ code, out: out.trim() }).toEqual({ code: 0, out: "warmed" });
  expect(seconds).toBeLessThan(2.5);
  // The process start and module load are included above; the warm-up itself must add no fixed wait: compare with a run that never touches the pool.
  const baseline = performance.now();
  const idle = Bun.spawn([process.execPath, "-e", `import ${JSON.stringify(entry)}; console.log("idle");`], { stdout: "pipe", stderr: "pipe" });
  await idle.exited;
  const idleSeconds = (performance.now() - baseline) / 1000;
  expect(seconds - idleSeconds).toBeLessThan(1);
}, 30_000);
