// Browser end-to-end flow: sign up, create work items, drag a card on the kanban board, check it persists.
// Run with `bun run e2e` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { chromium, type Page } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

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
  return page.locator(`[data-testid="column-${column}"] article [data-testid="card-title"]`).allTextContents();
}

let failed = false;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true });
  const page = await context.newPage();
  const shots = reviewShots("06-board-layout");
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
    if (title === "Alpha") await page.getByRole("button", { name: translate("workItems.new"), exact: true }).click();
    await page.getByRole("textbox", { name: translate("workItems.titleField") }).fill(title);
    await page.getByRole("button", { name: translate("workItems.create") }).click();
    await page.getByRole("link", { name: new RegExp(title) }).waitFor();
  }

  await page.getByRole("tab", { name: translate("layout.board") }).click();
  if (!page.url().includes("layout=board")) throw new Error("layout is not in the URL");
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  await page.getByRole("button", { name: translate("layout.display") }).click();
  check(await page.getByLabel(translate("layout.subGroup")).count() === 1, "board Sub-group control is missing");
  await page.getByLabel(translate("layout.subGroup")).selectOption("priority");
  await page.getByRole("button", { name: translate("layout.display") }).click();
  check(page.url().includes("subgroup=priority"), "Sub-group is not in the URL");
  await page.getByTestId("board-swimlanes").waitFor();
  check(JSON.stringify(await titlesIn(page, "Backlog")) === JSON.stringify(["Alpha", "Bravo", "Charlie"]), "expected three cards in Backlog");

  await page.getByRole("tab", { name: translate("layout.list") }).click();
  await page.getByRole("button", { name: translate("layout.display") }).click();
  check(await page.getByLabel(translate("layout.subGroup")).count() === 1, "list Sub-group control is missing");
  await page.getByLabel(translate("layout.subGroup")).selectOption("priority");
  await page.getByRole("button", { name: translate("layout.display") }).click();
  await page.locator(`section[aria-label="${translate("workItems.priority.none")}"]`).first().waitFor();
  await page.getByRole("tab", { name: translate("layout.spreadsheet") }).click();
  await page.getByRole("button", { name: translate("layout.display") }).click();
  check(await page.getByLabel(translate("layout.subGroup")).count() === 0, "spreadsheet shows the Sub-group control");
  await page.getByRole("button", { name: translate("layout.display") }).click();
  await page.getByRole("tab", { name: translate("layout.board") }).click();
  await page.getByTestId("board-swimlanes").waitFor();

  // Drag Charlie to the Todo column, then reorder inside Backlog (Bravo above Alpha).
  await page.getByTestId("card-MOB-3").dragTo(page.getByTestId("column-Todo"));
  await page.waitForFunction(() => document.querySelector('[data-testid="column-Todo"] [data-testid="card-MOB-3"]'));
  await page.getByTestId("card-MOB-2").dragTo(page.getByTestId("card-MOB-1"));
  await page.waitForFunction(() => document.querySelector('[data-testid="column-Backlog"] article')?.getAttribute("data-testid") === "card-MOB-2");

  await page.reload();
  await page.getByTestId("card-MOB-3").waitFor();
  check(JSON.stringify(await titlesIn(page, "Todo")) === JSON.stringify(["Charlie"]), "Charlie did not stay in Todo after reload");
  check(JSON.stringify(await titlesIn(page, "Backlog")) === JSON.stringify(["Bravo", "Alpha"]), "reorder did not persist");

  // Quick add in a column creates the card in that column (State group).
  await page.getByRole("button", { name: translate("layout.addToGroup").replace("{group}", "Backlog") }).first().click();
  await page.getByRole("textbox", { name: translate("workItems.titleField") }).fill("Delta");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('[data-testid="column-Backlog"] [data-testid="card-MOB-4"]'));
  check((await titlesIn(page, "Backlog")).includes("Delta"), "quick add did not land in Backlog");

  // A column collapses to a narrow strip and expands again.
  await page.getByRole("button", { name: `${translate("layout.toggleGroup")}: Todo` }).click();
  check(await page.locator('[data-testid="column-Todo"][data-collapsed]').count() === 1, "Todo did not collapse");
  await page.getByRole("button", { name: `${translate("layout.toggleGroup")}: Todo` }).click();
  await page.getByTestId("card-MOB-3").waitFor();

  // Board grouped by priority: dragging a card into a column changes its priority.
  await page.getByRole("button", { name: translate("layout.display") }).click();
  await page.getByLabel(translate("layout.group")).selectOption("priority");
  await page.getByRole("button", { name: translate("layout.display") }).click();
  check(page.url().includes("layout=board") && page.url().includes("group=priority"), "board group is not in the URL");
  const high = translate("workItems.priority.high");
  await page.getByTestId("card-MOB-1").dragTo(page.getByTestId(`column-${high}`));
  await page.waitForFunction((name) => document.querySelector(`[data-testid="column-${name}"] [data-testid="card-MOB-1"]`), high);
  await page.reload();
  await page.getByTestId("card-MOB-1").waitFor();
  check((await titlesIn(page, high)).join() === "Alpha", "priority drag did not persist");
  await page.screenshot({ path: `${shots}/board-priority-1440.png` });
  await page.goto(page.url().replace(/[?].*/, "?layout=board"));
  await page.getByTestId("card-MOB-2").waitFor();
  await page.screenshot({ path: `${shots}/board-state-1440.png` });

  // Touch at 390px: a long-press picks the card up, the board scrolls at its edge, lifting drops it in that column.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByTestId("card-MOB-2").waitFor();
  const cdp = await context.newCDPSession(page);
  const touch = (type: string, x?: number, y?: number) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: x!, y: y! }] });
  const centre = async (testId: string) => { const box = (await page.getByTestId(testId).boundingBox())!; return { x: box.x + box.width / 2, y: box.y + 14 }; };
  await page.screenshot({ path: `${shots}/board-state-390.png` });
  const from = await centre("card-MOB-2");
  await touch("touchStart", from.x, from.y);
  await Bun.sleep(450);
  for (let step = 1; step <= 10; step += 1) { await touch("touchMove", from.x + ((375 - from.x) * step) / 10, from.y); await Bun.sleep(30); }
  await page.getByTestId("column-Todo").waitFor();
  for (let attempt = 0; attempt < 40; attempt += 1) { const todo = (await page.getByTestId("column-Todo").boundingBox())!; if (todo.x + 40 < 350) break; await Bun.sleep(100); }
  const todo = (await page.getByTestId("column-Todo").boundingBox())!;
  await touch("touchMove", Math.min(todo.x + 60, 340), todo.y + 30);
  await Bun.sleep(100);
  await page.screenshot({ path: `${shots}/board-touch-drag-390.png` });
  await touch("touchEnd");
  await page.waitForFunction(() => document.querySelector('[data-testid="column-Todo"] [data-testid="card-MOB-2"]'));
  await page.reload();
  await page.getByTestId("card-MOB-2").waitFor();
  check((await titlesIn(page, "Todo")).includes("Bravo"), "touch drag did not persist");
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "page scrolls sideways at 390px");
  await page.setViewportSize({ width: 1440, height: 900 });

  // Filters and grouping are in the URL and survive a reload.
  await page.getByRole("tab", { name: translate("layout.list") }).click();
  await page.getByRole("button", { name: translate("layout.display") }).click();
  await page.getByLabel(translate("layout.group")).selectOption("priority");
  await page.getByRole("button", { name: translate("layout.display") }).click();
  await page.getByRole("button", { name: translate("layout.filters") }).click();
  await page.getByRole("dialog", { name: translate("layout.filters") }).getByRole("button", { name: translate("layout.filter.state") }).click();
  await page.getByRole("group", { name: translate("layout.filter.state") }).getByLabel("Todo").check();
  check(page.url().includes("group=priority") && page.url().includes("q="), "filters are not in the URL");
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
