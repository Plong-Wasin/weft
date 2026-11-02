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

let nextCleanup = 0;
console.log("Weft worker started");
while (!stopping) {
  try {
    if (Date.now() >= nextCleanup) { await scheduleCleanupJobs(db); nextCleanup = Date.now() + cleanupEveryMs; }
    const result = await runNextJob(db, handlers);
    if (result.status === "idle") await Bun.sleep(pollMs);
    else if (result.status !== "succeeded") console.error(`Job ${result.jobId} (${result.type}) ${result.status}`);
  } catch (error) {
    console.error("Worker loop error", error);
    await Bun.sleep(pollMs);
  }
}
await client.end();
