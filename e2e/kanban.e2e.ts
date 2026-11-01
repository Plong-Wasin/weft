// Browser end-to-end flow: sign up, create work items, drag a card on the kanban board, check it persists.
// Run with `bun run e2e` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { chromium, type Page } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3107);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5207);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" }),
];

async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await Bun.sleep(200);
  }
  throw new Error(`${url} did not start`);
}

async function titlesIn(page: Page, column: string) {
  return page.locator(`[data-testid="column-${column}"] article`).evaluateAll((cards) => cards.map((card) => card.textContent!.replace(/^\S+\s/, "").replace(/No priority$/, "").trim()));
}

let failed = false;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const page = await browser.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  await page.goto(web);
  await page.getByLabel(translate("auth.name")).fill("Kanban Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password")).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("E2E team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByLabel(translate("projects.name")).fill("Mobile");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("MOB");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /MOB · Mobile/ }).click();
  for (const title of ["Alpha", "Bravo", "Charlie"]) {
    await page.getByRole("textbox", { name: translate("workItems.titleField") }).fill(title);
    await page.getByRole("button", { name: translate("workItems.create") }).click();
    await page.getByRole("link", { name: new RegExp(title) }).waitFor();
  }

  await page.getByRole("tab", { name: translate("views.kanban") }).click();
  if (!page.url().includes("view=kanban")) throw new Error("view is not in the URL");
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  check(JSON.stringify(await titlesIn(page, "Backlog")) === JSON.stringify(["Alpha", "Bravo", "Charlie"]), "expected three cards in Backlog");

  // Drag Charlie to the Todo column, then reorder inside Backlog (Bravo above Alpha).
  await page.getByTestId("card-MOB-3").dragTo(page.getByTestId("column-Todo"));
  await page.waitForFunction(() => document.querySelector('[data-testid="column-Todo"] [data-testid="card-MOB-3"]'));
  await page.getByTestId("card-MOB-2").dragTo(page.getByTestId("card-MOB-1"));
  await page.waitForFunction(() => document.querySelector('[data-testid="column-Backlog"] article')?.getAttribute("data-testid") === "card-MOB-2");

  await page.reload();
  await page.getByTestId("card-MOB-3").waitFor();
  check(JSON.stringify(await titlesIn(page, "Todo")) === JSON.stringify(["Charlie"]), "Charlie did not stay in Todo after reload");
  check(JSON.stringify(await titlesIn(page, "Backlog")) === JSON.stringify(["Bravo", "Alpha"]), "reorder did not persist");

  // Filters and grouping are in the URL and survive a reload.
  await page.getByRole("tab", { name: translate("views.list") }).click();
  await page.getByLabel(translate("views.group")).selectOption("state");
  await page.locator("summary", { hasText: translate("views.filters") }).click();
  await page.getByRole("group", { name: translate("views.filter.state") }).getByLabel("Todo").check();
  check(page.url().includes("group=state") && page.url().includes("state="), "filters are not in the URL");
  await page.reload();
  await page.getByRole("link", { name: /Charlie/ }).waitFor();
  check(await page.getByRole("link", { name: /Alpha/ }).count() === 0, "filter did not survive reload");

  // The drag wrote an Activity on the card.
  await page.getByRole("link", { name: /Charlie/ }).click();
  await page.getByText(translate("workItems.activity.changed").replace("{field}", "state")).waitFor();
  console.log("e2e kanban: ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  // The flow commits real rows (the servers use their own connections), so remove them: other tests expect an empty instance.
  const { client, db } = createDatabase();
  await db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
