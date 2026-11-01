import { expect, test } from "bun:test";
import { treaty } from "@elysiajs/eden";
import { createApp } from "../src/app";

const app = createApp();
const client = treaty(app);

test.concurrent("web client calls the registered example Action through its typed REST route", async () => {
  const { data, error } = await client.actions.hello.post({ name: "Ada" });
  expect(error).toBeNull();
  expect(data).toEqual({ greeting: "Hello, Ada!" });
});

test.concurrent("the permission hook rejects callers without permission", async () => {
  const denied = treaty(createApp({ userId: "" }));
  const { data, error } = await denied.actions.hello.post({ name: "Ada" });
  expect(data).toBeNull();
  expect(error?.status).toBe(403);
});
