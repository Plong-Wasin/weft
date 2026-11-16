// Page and Wiki page header (ticket 03): one breadcrumb on a Page, no project Settings button in the editor,
// a Locked badge by the title instead of the large Lock button, and one page menu holding Lock or Unlock, Add subpage,
// Archive or Restore, Show text with symbols and Delete (last, after a line, with its confirmation).
import { chromium, type Browser } from "playwright";
import { createDatabase } from "../packages/db/src";
import { createProjectActions, createWikiActions } from "../packages/actions/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31268);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52268);
const livePort = Number(Bun.env.E2E_LIVE_PORT ?? 33268);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "apps/live/src/index.ts"], { env: { ...Bun.env, LIVE_PORT: String(livePort), WEB_ORIGIN: web }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api, VITE_LIVE_URL: `ws://localhost:${livePort}` }, stdout: "ignore", stderr: "inherit" }),
];
const { client, db } = createDatabase();
let browser: Browser | null = null;
async function waitFor(url: string) {
  for (let attempt = 0; attempt < 150; attempt += 1) { try { if ((await fetch(url)).status < 500) return; } catch { /* starting */ } await Bun.sleep(200); }
  throw new Error(`${url} did not start`);
}

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const slug = `pagemenu-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => {
    const response = await page.request.post(`${api}/actions/${name}`, { data: body });
    if (!response.ok()) throw new Error(`${name} failed (${response.status()}): ${await response.text()}`);
    return await response.json() as T;
  };

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Menu Writer");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Menu review");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.waitForURL(`${web}/${slug}`, { waitUntil: "domcontentloaded" });
  const me = await (await page.request.get(`${api}/api/me`)).json() as { user: { id: string }; workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((workspace) => workspace.slug === slug)!.id;
  const ownerId = me.user.id;
  const projects = createProjectActions(db);
  const wiki = createWikiActions(db);
  const project = await projects.createProject.handler({ userId: ownerId }, { workspaceId, name: "Mobile", key: "MOB", visibility: "public" });
  const handbook = await wiki.createWikiPage.handler({ userId: ownerId }, { workspaceId, title: "Handbook", contentMarkdown: "Intro paragraph for the menu." });
  const releasePlan = await wiki.createWikiPage.handler({ userId: ownerId }, { workspaceId, projectId: project.id, title: "Release plan", contentMarkdown: "Project page body." });
  await page.evaluate(() => localStorage.clear());

  const menuButton = () => page.getByRole("button", { name: translate("wiki.exports", "en"), exact: true });
  const menu = () => page.getByRole("menu");
  const item = (key: Parameters<typeof translate>[0]) => menu().getByRole("menuitem", { name: translate(key, "en"), exact: true });

  // Wiki page: header has no large Lock button; the page menu holds the moved actions in order, Delete last after a line.
  await page.goto(`${web}/${slug}/wiki/${handbook.id}`);
  await page.getByTestId("wiki-editor").locator(".ProseMirror").getByText("Intro paragraph for the menu.").waitFor();
  check(await page.getByTestId("wiki-page-lock").count() === 0, "the large Lock button is still on the Wiki page");
  check(await page.getByText("Lock the page so nobody can edit it until someone unlocks it.", { exact: true }).count() === 0, "the Lock help line is still on the Wiki page");
  check(await page.getByTestId("wiki-editor").getByRole("button", { name: translate("editor.sourceMode", "en"), exact: true }).count() === 0, "Show text with symbols still floats inside the writing area");
  check(await page.getByRole("navigation", { name: translate("wiki.breadcrumb", "en") }).count() === 1, "Wiki page does not show exactly one breadcrumb");
  await menuButton().click();
  await menu().waitFor();
  const lastItem = menu().getByRole("menuitem").last();
  check(await lastItem.textContent() === translate("wiki.delete", "en"), "Delete is not the last menu item");
  check(await item("wiki.delete").evaluate((element) => element.previousElementSibling?.getAttribute("role") === "separator"), "Delete is not separated from the other items by a line");
  for (const key of ["editor.sourceMode", "wiki.lock", "wiki.newChild", "pages.archive"] as const) check(await item(key).count() === 1, `page menu is missing ${key}`);
  console.log("PASS Wiki page header has no large Lock button and the page menu holds the moved actions, Delete last after a line");

  // Show text with symbols works from the menu and switches back the same way.
  await item("editor.sourceMode").click();
  await page.getByTestId("editor-source-text").waitFor();
  await menuButton().click();
  await item("editor.visualMode").click();
  await page.getByTestId("editor-source-text").waitFor({ state: "detached" });
  console.log("PASS Show text with symbols toggles from the page menu");

  // Lock from the menu: a small Locked badge beside the title; the menu then offers Unlock.
  await menuButton().click();
  await item("wiki.lock").click();
  await page.getByTestId("wiki-locked-badge").waitFor();
  check(await page.getByTestId("wiki-locked-badge").textContent() === translate("wiki.locked", "en"), "Locked badge text is wrong");
  await menuButton().click();
  check(await item("wiki.unlock").count() === 1, "owner cannot unlock from the page menu");
  await item("wiki.unlock").click();
  await page.getByTestId("wiki-locked-badge").waitFor({ state: "detached" });
  console.log("PASS lock from the page menu shows a Locked badge and unlock from the menu clears it");

  // Add subpage from the menu opens the new child.
  await menuButton().click();
  await item("wiki.newChild").click();
  await page.waitForURL((url) => url.pathname.startsWith(`/${slug}/wiki/`) && !url.pathname.endsWith(handbook.id), { timeout: 10_000 });
  console.log("PASS Add subpage from the page menu creates and opens a child page");

  // Archive and restore from the menu.
  await page.goto(`${web}/${slug}/wiki/${handbook.id}`);
  await page.getByTestId("wiki-editor").locator(".ProseMirror").getByText("Intro paragraph for the menu.").waitFor();
  await menuButton().click();
  await item("pages.archive").click();
  await page.getByText(translate("pages.archivedReadOnly", "en"), { exact: true }).waitFor();
  await menuButton().click();
  await item("pages.unarchive").click();
  await page.getByText(translate("pages.archivedReadOnly", "en"), { exact: true }).waitFor({ state: "detached" });
  console.log("PASS Archive and Restore work from the page menu");

  // Delete from the menu keeps its confirmation: dismissing keeps the page, accepting deletes it.
  const scratch = await wiki.createWikiPage.handler({ userId: ownerId }, { workspaceId, title: "Scratch", contentMarkdown: "To delete." });
  await page.goto(`${web}/${slug}/wiki/${scratch.id}`);
  await page.getByTestId("wiki-editor").locator(".ProseMirror").getByText("To delete.").waitFor();
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => { dialogs.push(dialog.message()); void (dialogs.length === 1 ? dialog.dismiss() : dialog.accept()); });
  await menuButton().click();
  await item("wiki.delete").click();
  await Bun.sleep(500);
  check(page.url().endsWith(scratch.id), "dismissing the delete confirmation still left the page");
  await menuButton().click();
  await item("wiki.delete").click();
  await page.waitForURL((url) => url.pathname === `/${slug}/wiki`, { timeout: 10_000 });
  check(dialogs.length === 2 && dialogs.every((message) => message === translate("wiki.deleteConfirm", "en")), `delete did not ask the confirmation (${dialogs.join(" | ")})`);
  console.log("PASS Delete from the page menu asks for confirmation and deletes only when accepted");

  // Page (inside a project): one breadcrumb, no project header or Settings button, and the title is the page's own heading.
  await page.goto(`${web}/${slug}/projects/MOB/pages/${releasePlan.id}`);
  await page.getByTestId("wiki-editor").locator(".ProseMirror").getByText("Project page body.").waitFor();
  check(await page.getByRole("navigation", { name: translate("wiki.breadcrumb", "en") }).count() === 1, "Page does not show exactly one breadcrumb");
  check(await page.getByRole("link", { name: translate("projects.back", "en"), exact: true }).count() === 0, "Page still repeats the project header");
  check(await page.locator(`a[href="/${slug}/projects/MOB/settings"]`).count() === 0, "Page still shows the project Settings button");
  check(await page.getByRole("heading", { level: 1, name: "Release plan", exact: true }).count() === 1, "Page has no single level-1 heading for its title");
  console.log("PASS a Page shows one breadcrumb with no project header or Settings button");

  // Narrow screen: the header, menu and writing area fit without sideways scrolling.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${web}/${slug}/projects/MOB/pages/${releasePlan.id}`);
  await page.getByTestId("wiki-editor").locator(".ProseMirror").getByText("Project page body.").waitFor();
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the Page overflows sideways at 390px");
  await page.getByRole("button", { name: translate("wiki.exports", "en"), exact: true }).click();
  await menu().waitFor();
  check(await item("wiki.delete").isVisible(), "Delete is not reachable from the page menu at 390px");
  console.log("PASS the page menu opens and fits at 390px");

  console.log("page menu e2e: ok");
} finally {
  await browser?.close();
  for (const server of servers) server.kill();
  await client.end?.();
}
process.exit(0);
