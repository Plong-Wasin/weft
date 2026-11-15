import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../../api/src/app";
import { main } from "../src/program";

const { client, db } = createDatabase();
afterAll(async () => client.end());

async function run(app: ReturnType<typeof createApp>, args: string[], token: string) {
  const out: string[] = [];
  const err: string[] = [];
  const failed = (await main(["node", "weft", ...args], {
    fetch: (input, init) => app.handle(new Request(input as string, init)), env: { WEFT_API_URL: "http://localhost", WEFT_TOKEN: token },
    stdout: (text) => out.push(text), stderr: (text) => err.push(text),
  })) !== 0;
  return { out: out.join(""), err: err.join(""), failed };
}

test.concurrent("CLI Backlinks hide a source in a private project from a workspace member", async () => {
  await withRollback(db, async (transaction) => {
    const app = createApp(undefined, transaction);
    const post = (name: string, body: unknown, cookie: string) => app.handle(new Request(`http://localhost/actions/${name}`, {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body),
    }));
    const signUp = async (name: string) => (await app.handle(new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" }),
    }))).headers.get("set-cookie")!.split(";")[0]!;
    const owner = await signUp("Owner");
    const workspace = await (await post("create_workspace", { name: "Team", slug: `cliout-${crypto.randomUUID()}` }, owner)).json() as { id: string };
    const invite = await (await post("create_invite", { workspaceId: workspace.id, role: "Member" }, owner)).json() as { token: string };
    const member = await signUp("Member");
    await post("accept_invite", { token: invite.token }, member);
    const memberToken = (await post("create_api_token", { name: "member cli" }, member).then((response) => response.json())) as { token: string };
    const publicProject = await (await post("create_project", { workspaceId: workspace.id, name: "Public", key: "PUB", visibility: "public" }, owner)).json() as { id: string };
    const privateProject = await (await post("create_project", { workspaceId: workspace.id, name: "Private", key: "SEC", visibility: "private" }, owner)).json() as { id: string };
    const target = await (await post("create_work_item", { projectId: publicProject.id, title: "Visible" }, owner)).json() as { id: string };
    await post("create_work_item", { projectId: privateProject.id, title: "Hidden", descriptionMarkdown: `[[PUB-1|work-item:${target.id}]]` }, owner);
    const privateCollection = await (await post("create_collection", { workspaceId: workspace.id, name: "Private collection", visibility: "private" }, owner)).json() as { id: string };
    await post("create_wiki_page", { workspaceId: workspace.id, collectionId: privateCollection.id, title: "Hidden collection source", contentMarkdown: `[[Visible|work-item:${target.id}]]` }, owner);
    const result = await run(app, ["list-backlinks", "--kind", "work-item", "--id", target.id], memberToken.token);
    expect(result.failed).toBe(false);
    expect(JSON.parse(result.out)).toEqual([]);
  });
});
