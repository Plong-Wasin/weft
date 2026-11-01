// Runs every e2e/*.e2e.ts flow one after another; add a flow by adding a file, no package.json edit needed.
// Usage: bun e2e/run-all.ts [name-filter]   (set CHROMIUM_PATH, DATABASE_URL, E2E_API_PORT, E2E_WEB_PORT as for a single flow)
import { readdirSync } from "node:fs";

const filter = process.argv[2];
const files = readdirSync(import.meta.dir).filter((name) => name.endsWith(".e2e.ts") && (!filter || name.includes(filter))).sort();
const failed: string[] = [];
for (const file of files) {
  console.log(`\n=== ${file}`);
  const run = Bun.spawnSync(["bun", `${import.meta.dir}/${file}`], { stdout: "inherit", stderr: "inherit", env: Bun.env });
  if (run.exitCode !== 0) failed.push(file);
}
console.log(failed.length ? `\ne2e FAILED: ${failed.join(", ")}` : `\ne2e all ok (${files.length} flows)`);
process.exit(failed.length ? 1 : 0);
