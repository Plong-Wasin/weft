import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

test.concurrent("over HTTP a Simple project answers a Cycle call with the feature name and who can turn it on, and keeps Pages and Views usable", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const post = async (path: string, body: unknown, cookie?: string) => app.handle(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
    }));
    const signUp = async (name: string) => {
      const response = await post("/api/auth/sign-up/email", { name, email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
      const body = await response.json() as { user: { id: string } };
      return { cookie: response.headers.get("set-cookie")!.split(";")[0]!, id: body.user.id };
    };
    const owner = await signUp("Owner");
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `t-${crypto.randomUUID()}` }, owner.cookie)).json() as { id: string };
    const simple = await (await post("/actions/create_project", { workspaceId: workspace.id, name: "Simple", key: "SIM", visibility: "public", shape: "simple" }, owner.cookie)).json() as { id: string; features: Record<string, boolean> };
    expect(simple.features).toEqual({ cycles: false, modules: false, intake: false, pages: true, views: true });

    const cycle = await post("/actions/create_cycle", { projectId: simple.id, name: "Sprint", startDate: "2026-01-01", endDate: "2026-01-14" }, owner.cookie);
    expect(cycle.status).toBe(400);
    const refusal = await cycle.json() as { error: string };
    expect(refusal.error).toContain("The Cycles feature is turned off");
    expect(refusal.error).toContain("Project settings > Features");

    expect((await post("/actions/list_views", { projectId: simple.id }, owner.cookie)).status).toBe(200);
    expect((await post("/actions/list_project_wiki_pages", { projectId: simple.id }, owner.cookie)).status).toBe(200);

    // The admin turns Cycles on over the same API; the call then succeeds.
    const switched = await (await post("/actions/set_project_features", { projectId: simple.id, features: { cycles: true } }, owner.cookie)).json() as { features: Record<string, boolean> };
    expect(switched.features.cycles).toBe(true);
    expect((await post("/actions/create_cycle", { projectId: simple.id, name: "Sprint", startDate: "2026-01-01", endDate: "2026-01-14" }, owner.cookie)).status).toBe(200);
  });
});
