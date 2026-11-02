import { afterAll, expect, test } from "bun:test";
import { apiTokens, createDatabase } from "@weft/db";
import { eq } from "drizzle-orm";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

test.concurrent("token auth reaches Actions as its owner with source cli; revoked and foreign tokens fail; sessions unaffected", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const call = async (path: string, body: unknown, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    }));
    const signUp = async (name: string) => {
      const response = await call("/api/auth/sign-up/email", { name, email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
      return { cookie: response.headers.get("set-cookie")!.split(";")[0]! };
    };
    const owner = await signUp("Owner");
    const stranger = await signUp("Stranger");
    const workspace = await (await call("/actions/create_workspace", { name: "Team", slug: `t-${crypto.randomUUID()}` }, { cookie: owner.cookie })).json() as { id: string };
    const created = await (await call("/actions/create_api_token", { name: "cli" }, { cookie: owner.cookie })).json() as { id: string; token: string };
    const bearer = { authorization: `Bearer ${created.token}` };

    const project = await (await call("/actions/create_project", { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" }, bearer)).json() as { id: string };
    expect(project.id).toBeString();
    const item = await (await call("/actions/create_work_item", { projectId: project.id, title: "From CLI" }, bearer)).json() as { id: string };
    const log = await (await call("/actions/list_work_item_activities", { workItemId: item.id }, { cookie: owner.cookie })).json() as Array<{ source: string }>;
    expect(log.length).toBeGreaterThan(0);
    expect(log.every((row) => row.source === "cli")).toBe(true);

    expect((await call("/actions/list_projects", { workspaceId: workspace.id }, { authorization: "Bearer weft_bogus" })).status).toBe(401);
    expect((await call("/actions/list_projects", { workspaceId: workspace.id }, { cookie: owner.cookie })).status).toBe(200);
    const strangerToken = await (await call("/actions/create_api_token", { name: "x" }, { cookie: stranger.cookie })).json() as { token: string };
    expect((await call("/actions/list_projects", { workspaceId: workspace.id }, { authorization: `Bearer ${strangerToken.token}` })).status).toBe(403);
    expect((await call("/actions/list_api_tokens", {}, bearer)).status).toBe(403);
    expect((await call("/actions/revoke_api_token", { tokenId: created.id }, { cookie: stranger.cookie })).status).toBe(404);
    expect((await call("/actions/list_projects", { workspaceId: workspace.id }, bearer)).status).toBe(200);

    expect((await call("/actions/revoke_api_token", { tokenId: created.id }, { cookie: owner.cookie })).status).toBe(200);
    expect((await call("/actions/list_projects", { workspaceId: workspace.id }, bearer)).status).toBe(401);
    const tokenList = await (await call("/actions/list_api_tokens", {}, { cookie: owner.cookie })).json() as Array<Record<string, unknown>>;
    expect(tokenList.find((row) => row.id === created.id)).toMatchObject({ status: "revoked" });
  });
});

test.concurrent("token descriptions and expiry are returned by the HTTP Actions", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const call = async (path: string, body: unknown, cookie?: string) => app.handle(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
    }));
    const signUp = await call("/api/auth/sign-up/email", {
      name: "Token owner", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password",
    });
    const cookie = signUp.headers.get("set-cookie")!.split(";")[0]!;
    const expiry = "2035-06-01T00:00:00.000Z";
    const createdResponse = await call("/actions/create_api_token", {
      name: "Build agent", description: "For nightly deployments", expiresAt: expiry,
    }, cookie);
    expect(createdResponse.status).toBe(200);
    const created = await createdResponse.json() as { id: string; token: string };
    const listResponse = await call("/actions/list_api_tokens", {}, cookie);
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toMatchObject([{
      id: created.id, name: "Build agent", description: "For nightly deployments", expiresAt: expiry, status: "active",
    }]);

    const neverResponse = await call("/actions/create_api_token", { name: "Legacy compatible" }, cookie);
    const never = await neverResponse.json() as { id: string };
    const rows = await (await call("/actions/list_api_tokens", {}, cookie)).json() as Array<Record<string, unknown>>;
    expect(rows.find((row) => row.id === never.id)).toMatchObject({ description: null, expiresAt: null, status: "active" });
  });
});

test.concurrent("expired tokens fail authentication and past or invalid expiry dates are rejected", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const call = async (path: string, body: unknown, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    }));
    const signUp = await call("/api/auth/sign-up/email", {
      name: "Token owner", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password",
    });
    const cookie = signUp.headers.get("set-cookie")!.split(";")[0]!;
    for (const expiresAt of ["2000-01-01T00:00:00.000Z", "not-a-date", "2035-02-30"]) {
      expect((await call("/actions/create_api_token", { name: "Invalid", expiresAt }, { cookie })).status).toBe(400);
    }
    const created = await (await call("/actions/create_api_token", { name: "Soon expires" }, { cookie })).json() as { id: string; token: string };
    await transaction.update(apiTokens).set({ expiresAt: new Date("2000-01-01T00:00:00.000Z") })
      .where(eq(apiTokens.id, created.id));
    expect((await call("/actions/list_api_tokens", {}, { authorization: `Bearer ${created.token}` })).status).toBe(401);
    const list = await (await call("/actions/list_api_tokens", {}, { cookie })).json() as Array<Record<string, unknown>>;
    expect(list.find((row) => row.id === created.id)).toMatchObject({ status: "expired" });
  });
});
