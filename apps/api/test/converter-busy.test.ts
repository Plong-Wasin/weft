import { afterAll, expect, test } from "bun:test";
import { configureWrittenFormPool, resetWrittenFormPoolConfig } from "@weft/actions";
import { createDatabase } from "@weft/db";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

test.serial("one caller flooding the converter gets 429 with Retry-After and cannot block another caller", async () => {
  configureWrittenFormPool({ perKeyQueued: 1 });
  try {
    await withRollback(db, async (transaction) => {
      const app = createApp(undefined, transaction);
      const post = (name: string, body: unknown, cookie: string) => app.handle(new Request(`http://localhost/actions/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
      const signUp = async (name: string) => (await app.handle(new Request("http://localhost/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" }) }))).headers.get("set-cookie")!.split(";")[0]!;
      const owner = await signUp("Owner");
      const workspace = await (await post("create_workspace", { name: "Team", slug: `busy-${crypto.randomUUID()}` }, owner)).json() as { id: string };
      const invite = await (await post("create_invite", { workspaceId: workspace.id, role: "Member" }, owner)).json() as { token: string };
      const member = await signUp("Member");
      await post("accept_invite", { token: invite.token }, member);
      const project = await (await post("create_project", { workspaceId: workspace.id, name: "Busy", key: "BSY", visibility: "public" }, owner)).json() as { id: string };
      const hostile = "www.a_".repeat(8_000);
      const flood = Array.from({ length: 8 }, (_, index) => post("create_work_item", { projectId: project.id, title: `Flood ${index}`, descriptionMarkdown: hostile }, owner));
      await Bun.sleep(100);
      const polite = await post("create_wiki_page", { workspaceId: workspace.id, title: "Polite", contentMarkdown: "See www.example.com. ".repeat(200) }, member);
      expect(polite.status).toBe(200);
      const answers = await Promise.all(flood);
      const busy = answers.filter((response) => response.status === 429);
      expect(busy.length).toBeGreaterThanOrEqual(5);
      for (const response of busy) { expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0); expect((await response.json() as { code: string }).code).toBe("busy"); }
    });
  } finally { resetWrittenFormPoolConfig(); }
}, 60_000);
