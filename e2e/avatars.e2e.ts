import { chromium, type Page } from "playwright";
import { createAgentActions, createCommentActions, createProjectActions } from "../packages/actions/src";
import { createDatabase } from "../packages/db/src";
import { translate } from "../packages/shared/src";

// One Avatar for people and Agents. Checks the assignee picker, the @mention list, the work item detail (assignee, comments, timeline),
// the peek panel, the profile menu, the members pages and the Agents page, at 1440 and 390 px in light and dark.
const apiPort = Number(Bun.env.E2E_API_PORT ?? 31191);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52191);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["node", "node_modules/vite/bin/vite.js", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" }),
];
async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) { try { if ((await fetch(url)).status < 500) return; } catch { /* starting */ } await Bun.sleep(200); }
  throw new Error(`${url} did not start`);
}

const viewports = [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }] as const;
const evidence = Bun.env.AVATAR_SCREENSHOTS ?? "/tmp/avatars-shots";
const captured: string[] = [];
const problems: string[] = [];
const check = (ok: boolean, message: string) => { if (!ok) problems.push(message); };

let failed = false;
const { client, db } = createDatabase();
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  const slug = `avatar-${crypto.randomUUID().slice(0, 7)}`;
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Workspace Admin");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Avatar E2E");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.waitForURL(`${web}/${slug}`, { waitUntil: "domcontentloaded", timeout: 8000 });

  const me = await (await page.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((entry) => entry.slug === slug)!.id;
  const project = await createProjectActions(db).createProject.handler({ userId: me.user.id }, { workspaceId, name: "Mobile", key: "MOB", visibility: "public" });
  const agents = createAgentActions(db);
  const reviewer = await agents.createAgent.handler({ userId: me.user.id }, { workspaceId, name: "Reviewer Bot", model: "default" });
  await agents.setAgentProjectAccess.handler({ userId: me.user.id }, { agentId: reviewer.id, allProjects: true, projectIds: [] });
  const item = await page.request.post(`${api}/actions/create_work_item`, { data: { projectId: project.id, title: "Avatar check" } }).then((response) => response.json() as Promise<{ id: string }>);
  await page.request.post(`${api}/actions/update_work_item`, { data: { workItemId: item.id, assigneeIds: [reviewer.userId] } });
  const comments = createCommentActions(db);
  const agentComment = await comments.createComment.handler({ userId: reviewer.userId, source: "agent" }, { workItemId: item.id, bodyMarkdown: "Reviewed. **Two** findings:\n\n| Area | Result |\n|---|---|\n| Tests | pass |\n| Lint | warn |" });
  await comments.createComment.handler({ userId: me.user.id, source: "ui" }, { workItemId: item.id, bodyMarkdown: "Thanks, looking at the warning." });

  const detailUrl = `${web}/${slug}/browse/MOB-1`;
  const setTheme = (theme: "light" | "dark") => page.evaluate((value) => { localStorage.setItem("weft.theme", value); document.documentElement.setAttribute("data-theme", value); }, theme);
  const shoot = async (name: string) => {
    for (const viewport of viewports) for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize(viewport);
      await setTheme(theme);
      await page.waitForTimeout(250);
      const path = `${evidence}/${name}-${viewport.width}-${theme}.png`;
      await page.screenshot({ path, fullPage: true });
      captured.push(path);
    }
  };

  // 1. Work item detail: assignee summary, the Agent comment with a table, the Person comment, the timeline.
  await page.goto(detailUrl);
  await page.getByRole("textbox", { name: translate("workItems.titleField") }).waitFor();
  const assigneeSummary = page.getByRole("complementary", { name: translate("workItems.properties") }).getByRole("button", { name: new RegExp(`^${translate("workItems.assignees")}:`) });
  await assigneeSummary.getByText("Reviewer Bot").waitFor();
  check(await assigneeSummary.locator("span.rounded-md svg").count() === 1, "detail assignee: Agent has no bot-mark square");
  const agentRow = page.locator(`#comment-${agentComment.id}`);
  await agentRow.waitFor();
  check(await agentRow.locator("span.rounded-md svg").count() >= 1, "comment: Agent author has no bot-mark square");
  check(await agentRow.locator("table").count() === 1, "comment: Agent markdown table did not render as a table");
  const personRow = page.locator("li", { hasText: "Thanks, looking at the warning." }).first();
  check(await personRow.locator("span.rounded-full").first().innerText() === "W", "comment: person author letter is not W");
  const createdActivity = page.locator("div, li", { hasText: /created the work item/ }).last();
  check(await createdActivity.locator("span.rounded-full").count() >= 1, "timeline: actor has no letter Avatar");
  await shoot("detail");

  // 2. Mention popup at 390 px with the caret at the bottom of the screen: it must flip above and stay inside the viewport.
  await page.setViewportSize({ width: 390, height: 844 });
  const editor = page.locator('[data-testid="comment-editor"] [contenteditable="true"]').first();
  await editor.evaluate((element) => element.scrollIntoView({ block: "end" }));
  await editor.click();
  await editor.pressSequentially("@Work");
  const listbox = page.getByRole("listbox").first();
  await listbox.waitFor();
  const mention = await listbox.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, height: window.innerHeight, options: element.querySelectorAll('[role="option"]').length };
  });
  console.log(`mention@390 bottom caret: ${JSON.stringify(mention)}`);
  check(mention.options >= 1, "mention popup has no options at 390 px");
  check(mention.top >= 0 && mention.bottom <= mention.height, `mention popup is outside the 390 px viewport: ${JSON.stringify(mention)}`);
  for (const theme of ["light", "dark"] as const) {
    await setTheme(theme);
    await page.waitForTimeout(200);
    const path = `${evidence}/mention-popup-390-${theme}.png`;
    await page.screenshot({ path });
    captured.push(path);
  }
  await page.keyboard.press("Escape");
  await editor.press("Control+A");
  await editor.press("Backspace");

  // 3. Peek panel from the list.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${web}/${slug}/projects/MOB/issues?peek=MOB-1`);
  const peek = page.getByRole("dialog", { name: translate("workItems.peek.title") });
  await peek.waitFor();
  const peekAssignees = peek.getByRole("button", { name: new RegExp(`^${translate("workItems.assignees")}:`) });
  await peekAssignees.getByText("Reviewer Bot").waitFor();
  check(await peekAssignees.locator("span.rounded-md svg").count() === 1, "peek assignee: Agent has no bot-mark square");
  await shoot("peek");
  await page.keyboard.press("Escape");
  await peek.waitFor({ state: "detached" }).catch(() => undefined);

  // 4. Profile menu (sidebar profile).
  await page.goto(detailUrl);
  await page.getByRole("textbox", { name: translate("workItems.titleField") }).waitFor();
  await page.getByRole("button", { name: translate("profile.menu") }).click();
  await page.getByRole("menu").first().waitFor().catch(() => undefined);
  await shoot("profile-menu");
  await page.keyboard.press("Escape");

  // 5. Members pages (workspace and project) and the Agents page.
  await page.goto(`${web}/${slug}/settings/members`);
  await page.getByText("Workspace Admin").first().waitFor();
  check(await page.locator("span.rounded-full", { hasText: /^W$/ }).count() >= 1, "workspace members: no letter Avatar");
  check(await page.locator("li, div").filter({ hasText: /^Reviewer Bot/ }).locator("span.rounded-md svg").count() >= 1, "workspace members: Agent has no bot-mark Avatar");
  await shoot("members");
  await page.goto(`${web}/${slug}/settings/projects/MOB/members`);
  await page.getByText("Reviewer Bot", { exact: true }).first().waitFor();
  check(await page.locator("span.rounded-md svg").count() >= 1, "project members: Agent has no bot-mark Avatar");
  await shoot("project-members");
  await page.goto(`${web}/${slug}/settings/agents`);
  await page.getByText("Reviewer Bot", { exact: true }).first().waitFor();
  check(await page.locator("span.rounded-md svg").count() >= 1, "agents page: no bot-mark Avatar");
  await shoot("agents");

  // 6. Work item list: assignee column avatars.
  await page.goto(`${web}/${slug}/projects/MOB/issues`);
  await page.getByRole("link", { name: "Avatar check" }).first().waitFor();
  await shoot("work-item-list");

  console.log(`avatars screens: ${captured.length} images in ${evidence}`);
  for (const path of captured) console.log(path);
  if (problems.length) { console.log(`avatars problems:\n${problems.join("\n")}`); failed = true; }
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  servers.forEach((server) => server.kill());
  await client.end();
}
process.exit(failed ? 1 : 0);
