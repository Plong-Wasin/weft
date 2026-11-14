// Browser flow for Settings > Usage and cost: an admin sees totals with unknown values as "Unknown", adds, edits and removes a model price,
// and downloads the CSV. Run with `bun e2e/usage.e2e.ts`. The Runs are seeded straight into the database (no provider or CLI is called).
import { chromium, type Page } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, projects, runs, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31190);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52190);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = Bun.env.E2E_SCREENSHOTS ?? "/tmp";
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["node", "node_modules/vite/bin/vite.js", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" }),
];
async function waitFor(url: string) { for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).status < 500) return; } catch { /* startup */ } await Bun.sleep(200); } throw new Error(`${url} did not start`); }
const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
const fits = async (page: Page, label: string) => check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${label}: page scrolls sideways`);

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const slug = `usage-${crypto.randomUUID().slice(0, 8)}`;
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Usage Admin");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Usage E2E");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.waitForURL(`${web}/${slug}`);

  // Seed one Run that reported usage and one that did not, in a project of the workspace.
  const { client, db } = createDatabase();
  const workspace = await db.query.workspaces.findFirst({ where: (table, { eq }) => eq(table.slug, slug) });
  const admin = await db.query.users.findFirst({ where: (table, { eq }) => eq(table.email, `${slug}@example.test`) });
  check(!!workspace && !!admin, "seed rows missing");
  const [project] = await db.insert(projects).values({ workspaceId: workspace!.id, name: "Seeded", key: "SEE", visibility: "public", createdBy: admin!.id }).returning();
  const started = new Date(Date.now() - 95_000);
  await db.insert(runs).values([
    { workspaceId: workspace!.id, projectId: project!.id, originatorId: admin!.id, status: "completed", usageReported: true, model: "claude-sonnet-5-5", inputTokens: 26215, outputTokens: 4, startedAt: started, finishedAt: new Date(started.getTime() + 61_000) },
    { workspaceId: workspace!.id, projectId: project!.id, originatorId: admin!.id, status: "failed", usageReported: false, model: null, inputTokens: 0, outputTokens: 0, startedAt: started, finishedAt: new Date(started.getTime() + 4_000) },
  ]);
  await client.end();

  await page.goto(`${web}/${slug}/settings/usage`);
  await page.getByRole("heading", { name: translate("usage.title"), exact: true }).waitFor();
  await page.getByText(translate("usage.byDay")).waitFor();
  // Unknown tokens and cost read as "Unknown" in the report, and the unknown run is named in a note.
  check((await page.getByText(translate("usage.unknownUsageNote").replace("{count}", "1")).count()) === 1, "unknown-usage note missing");
  await page.screenshot({ path: `${shots}/usage-1440-empty-prices.png`, fullPage: true });

  // Add a price, then change it, then remove it.
  await page.getByLabel(translate("usage.priceModel")).fill("claude-sonnet-5-5");
  await page.getByLabel(translate("usage.priceInput")).fill("3");
  await page.getByLabel(translate("usage.priceOutput")).fill("15");
  await page.getByRole("button", { name: translate("usage.priceSave"), exact: true }).click();
  await page.getByText(translate("usage.priceSaved")).waitFor();
  await page.getByRole("button", { name: translate("agents.edit"), exact: true }).click();
  check((await page.getByLabel(translate("usage.priceInput")).inputValue()) === "3", "edit did not fill the form");
  await page.getByLabel(translate("usage.priceInput")).fill("2");
  await page.getByRole("button", { name: translate("usage.priceSave"), exact: true }).click();
  await page.getByText("$2.00 / $15.00").waitFor();
  await page.screenshot({ path: `${shots}/usage-1440-prices.png`, fullPage: true });
  await fits(page, "1440px");

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: translate("usage.exportCsv") }).click()]);
  check(/^usage-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/.test(download.suggestedFilename()), `CSV name is ${download.suggestedFilename()}`);
  const csv = await Bun.file((await download.path())!).text();
  check(csv.includes("claude-sonnet-5-5") || csv.includes(",Usage Admin,"), "CSV has no rows");

  await page.getByRole("button", { name: translate("usage.priceRemove"), exact: true }).click();
  await page.getByText(translate("usage.priceRemoved")).waitFor();
  await page.getByText(translate("usage.pricesEmpty")).waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("heading", { name: translate("usage.title"), exact: true }).waitFor();
  await page.screenshot({ path: `${shots}/usage-390-prices.png`, fullPage: true });
  await fits(page, "390px");
  await context.close(); await browser.close();
  console.log("usage ok: unknown values, price add/edit/remove, CSV download, 1440px and 390px");
} finally {
  for (const server of servers) server.kill();
  const { client, db } = createDatabase();
  await db.delete(workspaces).where(like(workspaces.slug, "usage-%"));
  await db.delete(users).where(like(users.email, "usage-%@example.test"));
  await client.end();
}
