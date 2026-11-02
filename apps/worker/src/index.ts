import { createJobHandlers, runNextJob, scheduleCleanupJobs } from "@weft/actions";
import { createDatabase } from "@weft/db";
import { createRunModel, resolveWorkerModel } from "./model";

const pollMs = Number(Bun.env.WORKER_POLL_MS ?? 1_000);
const cleanupEveryMs = Number(Bun.env.WORKER_CLEANUP_INTERVAL_MS ?? 60 * 60 * 1000);

const { client, db } = createDatabase();
const model = resolveWorkerModel();
if (!model) console.warn("No AI provider key set: Agent Runs will fail as model_not_configured");
const handlers = createJobHandlers(undefined, { runModel: model ? createRunModel(model) : undefined });
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { stopping = true; });

// Several loops share the queue (jobs are claimed with SKIP LOCKED), so a long Agent Run does not hold up notifications or other Runs.
const concurrency = Math.max(1, Number(Bun.env.WORKER_CONCURRENCY ?? 4));
let nextCleanup = 0;
async function loop() {
  while (!stopping) {
    try {
      if (Date.now() >= nextCleanup) { nextCleanup = Date.now() + cleanupEveryMs; await scheduleCleanupJobs(db); }
      const result = await runNextJob(db, handlers);
      if (result.status === "idle") await Bun.sleep(pollMs);
      else if (result.status !== "succeeded") console.error(`Job ${result.jobId} (${result.type}) ${result.status}`);
    } catch (error) {
      console.error("Worker loop error", error);
      await Bun.sleep(pollMs);
    }
  }
}
console.log(`Weft worker started (${concurrency} loops)`);
await Promise.all(Array.from({ length: concurrency }, loop));
await client.end();
