import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("../migrations", import.meta.url).pathname;
const entries: { idx: number; when: number; tag: string }[] = JSON.parse(readFileSync(`${dir}/meta/_journal.json`, "utf8")).entries;

// Drizzle runs only entries newer than the newest applied `when`, so an out-of-order timestamp silently skips a migration on upgraded databases.
test("the migration journal is ordered by timestamp, index and tag", () => {
  entries.forEach((entry, position) => {
    expect(entry.idx).toBe(position);
    if (position > 0) expect(entry.when).toBeGreaterThan(entries[position - 1]!.when);
  });
  const tags = readdirSync(dir).filter((file) => file.endsWith(".sql")).map((file) => file.slice(0, -4)).sort();
  expect(entries.map((entry) => entry.tag)).toEqual(tags);
});
