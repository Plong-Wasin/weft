/** `bun run eval:ai`: runs the AI eval suite against the provider configured by AI_PROVIDER / AI_MODEL. */
import { createDatabase } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { DEFAULT_MODEL, resolveModel } from "../src/ai";
import { DEFAULT_PASS_THRESHOLD, runEval } from "../src/ai-eval";

const { client, db } = createDatabase();
const threshold = Number(Bun.env.EVAL_PASS_THRESHOLD ?? DEFAULT_PASS_THRESHOLD);
const runs = Number(Bun.env.EVAL_RUNS ?? 1);
const modelName = `${Bun.env.AI_PROVIDER ?? "openai"}:${Bun.env.AI_MODEL ?? DEFAULT_MODEL}`;
let exitCode = 1;
try {
  const report = await withRollback(db, (transaction) => runEval(transaction, resolveModel(), { runs, threshold, modelName }));
  for (const result of report.results) console.log(`${result.passed ? "PASS" : "FAIL"} ${result.id}#${result.run} [${result.tools.join(", ") || "-"}]${result.reason ? ` ${result.reason}` : ""}`);
  console.log(`\nmodel ${report.model}: ${report.passed}/${report.total} passed (${(report.rate * 100).toFixed(1)}%), threshold ${(report.threshold * 100).toFixed(0)}%, injection cases ${report.injectionPassed ? "all passed" : "FAILED"}`);
  console.log(report.ok ? "EVAL PASSED" : "EVAL FAILED");
  exitCode = report.ok ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  await client.end();
}
process.exit(exitCode);
