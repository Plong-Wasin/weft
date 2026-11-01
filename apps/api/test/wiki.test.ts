import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

test.concurrent("wiki routes over HTTP: auth, create, edit, lock conflict status", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const post = async (path: string, body: unknown, cookie?: string) => app.handle(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
    }));
    const signUp = async () => (await post("/api/auth/sign-up/email", { name: "U", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" })).headers.get("set-cookie")!.split(";")[0]!;
    const owner = await signUp();
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `t-${crypto.randomUUID()}` }, owner)).json() as { id: string };
    expect((await post("/actions/list_wiki_pages", { workspaceId: workspace.id })).status).toBe(401);
    const page = await (await post("/actions/create_wiki_page", { workspaceId: workspace.id, title: "Home" }, owner)).json() as { id: string };
    const saved = await post("/actions/update_wiki_page", { pageId: page.id, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] } }, owner);
    expect(saved.status).toBe(200);
    expect((await saved.json() as { contentText: string }).contentText).toBe("hi");
    const stranger = await signUp();
    expect((await post("/actions/get_wiki_page", { pageId: page.id }, stranger)).status).toBe(403);
  });
});
