import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "@weft/db";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const up = { database: async () => {}, storage: async () => {} };

function appWithLog(health = up) {
  const lines: Record<string, unknown>[] = [];
  const app = createApp(undefined, db, { allowSignup: true, allowWorkspaceCreation: true }, undefined, undefined, {}, {}, { health, log: (line) => lines.push(JSON.parse(line)) });
  return { app, lines };
}

test.concurrent("every API request gets a request id: the caller's id is kept and echoed, and its log line carries it", async () => {
  const { app, lines } = appWithLog();
  const response = await app.handle(new Request("http://localhost/api/health/live?token=should-not-be-logged", { headers: { "x-request-id": "trace-abc.123" } }));
  expect(response.headers.get("x-request-id")).toBe("trace-abc.123");
  expect(lines).toContainEqual(expect.objectContaining({ level: "info", requestId: "trace-abc.123", method: "GET", path: "/api/health/live", status: 200 }));
  expect(JSON.stringify(lines)).not.toContain("should-not-be-logged");
});

test.concurrent("a request id with unsafe characters is replaced, so a caller cannot forge a log line", async () => {
  const { app, lines } = appWithLog();
  const hostile = "bad id \"}{\"level\":\"info\"";
  const response = await app.handle(new Request("http://localhost/api/health/live", { headers: { "x-request-id": hostile } }));
  const id = response.headers.get("x-request-id")!;
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(lines.at(-1)).toMatchObject({ requestId: id });
  expect(JSON.stringify(lines)).not.toContain("bad id");
});

test.concurrent("an error response is logged with the same request id, without the error message", async () => {
  const { app, lines } = appWithLog();
  const response = await app.handle(new Request("http://localhost/actions/hello", {
    method: "POST", headers: { "content-type": "application/json", "x-request-id": "err-search-7" }, body: JSON.stringify({ name: 42 }),
  }));
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(lines).toContainEqual(expect.objectContaining({ requestId: "err-search-7", status: response.status, path: "/actions/hello" }));
  expect(lines.filter((line) => line.requestId === "err-search-7").every((line) => !("message" in line))).toBe(true);
});

test.concurrent("a published link token in the path is never written to the log", async () => {
  const { app, lines } = appWithLog();
  await app.handle(new Request("http://localhost/published/SECRET-PUBLISHED-TOKEN"));
  expect(lines.at(-1)).toMatchObject({ path: "/published/:token" });
  expect(JSON.stringify(lines)).not.toContain("SECRET-PUBLISHED-TOKEN");
});

test.concurrent("liveness answers ok even when a dependency is down", async () => {
  const { app } = appWithLog({ database: async () => { throw new Error("down"); }, storage: async () => { throw new Error("down"); } });
  const response = await app.handle(new Request("http://localhost/api/health/live"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});

test.concurrent("readiness is ok when the database and storage answer", async () => {
  const { app } = appWithLog();
  const response = await app.handle(new Request("http://localhost/api/health/ready"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok", checks: { database: "ok", storage: "ok" } });
});

test.concurrent("readiness names only the failing dependency and never echoes its error text", async () => {
  const secret = "S3-SECRET-VALUE-123";
  const { app } = appWithLog({ database: async () => {}, storage: async () => { throw new Error(`denied for key ${secret}`); } });
  const response = await app.handle(new Request("http://localhost/api/health/ready"));
  const body = await response.text();
  expect(response.status).toBe(503);
  expect(JSON.parse(body)).toEqual({ status: "unavailable", checks: { database: "ok", storage: "unreachable" } });
  expect(body).not.toContain(secret);
});

test.concurrent("readiness reports a probe that hangs as unreachable instead of waiting forever", async () => {
  const { app } = appWithLog({ database: () => new Promise<void>(() => {}), storage: async () => {} });
  const response = await app.handle(new Request("http://localhost/api/health/ready"));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ status: "unavailable", checks: { database: "unreachable", storage: "ok" } });
}, 10_000);
