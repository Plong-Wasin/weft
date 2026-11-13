import { expect, test } from "bun:test";
import { startupWarnings } from "../src/startup-warnings";

test("production with TRUSTED_PROXY_HOPS unset or 0 warns; development and a set value do not", () => {
  expect(startupWarnings({ NODE_ENV: "production" })).toEqual([expect.stringContaining("TRUSTED_PROXY_HOPS")]);
  expect(startupWarnings({ NODE_ENV: "production", TRUSTED_PROXY_HOPS: "0" })).toHaveLength(1);
  expect(startupWarnings({ NODE_ENV: "production", TRUSTED_PROXY_HOPS: "1" })).toEqual([]);
  expect(startupWarnings({ NODE_ENV: "development" })).toEqual([]);
  expect(startupWarnings({})).toEqual([]);
});
