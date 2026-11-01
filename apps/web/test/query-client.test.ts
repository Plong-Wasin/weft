import { expect, test } from "bun:test";
import { createQueryClient } from "../src/query-client";
import pkg from "../package.json";

test("query cache lives in memory only and writes nothing to device storage", async () => {
  const writes: string[] = [];
  const storage = { setItem: (key: string) => writes.push(key), getItem: () => null, removeItem() {}, clear() {} };
  Object.assign(globalThis, { localStorage: storage, sessionStorage: storage });
  const client = createQueryClient();
  const data = await client.fetchQuery({ queryKey: ["work-items"], queryFn: async () => ["WEFT-1"] });
  expect(data).toEqual(["WEFT-1"]);
  expect(client.getQueryData(["work-items"])).toEqual(["WEFT-1"]);
  expect(writes).toEqual([]);
  expect(createQueryClient().getQueryData(["work-items"])).toBeUndefined();
});

test("no query persistence package is installed", () => {
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  expect(deps.filter((name) => /persist/.test(name))).toEqual([]);
});
