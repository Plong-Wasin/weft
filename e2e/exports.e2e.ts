// Browser flow for Exports settings: request a CSV Export of one project, watch the worker finish it, and download it. Run with `bun e2e/exports.e2e.ts`.
// The Asset storage is a tiny in-process S3 stand-in, so the flow needs only the database named by DATABASE_URL (use your own, never a shared one).
import { chromium, type Page } from "playwright";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { like } from "drizzle-orm";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31170);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52170);
const s3Port = Number(Bun.env.E2E_S3_PORT ?? 39170);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;

const objects = new Map<string, { body: Uint8Array; type: string }>();
const s3 = Bun.serve({
  port: s3Port,
  async fetch(request) {
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname);
    if (request.method === "PUT") { objects.set(key, { body: new Uint8Array(await request.arrayBuffer()), type: request.headers.get("content-type") ?? "application/octet-stream" }); return new Response(null, { status: 200 }); }
    const object = objects.get(key);
    if (!object) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    if (request.method === "DELETE") { objects.delete(key); return new Response(null, { status: 204 }); }
    const headers: Record<string, string> = { "content-type": url.searchParams.get("response-content-type") ?? object.type, "content-length": String(object.body.byteLength) };
    const disposition = url.searchParams.get("response-content-disposition");
    if (disposition) headers["content-disposition"] = disposition;
    return new Response(request.method === "HEAD" ? null : object.body, { headers });
  },
});
const storageEnv = { S3_ENDPOINT: `http://localhost:${s3Port}`, S3_PUBLIC_ENDPOINT: `http://localhost:${s3Port}`, S3_BUCKET: "e2e-bucket" };
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, ...storageEnv, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "apps/worker/src/index.ts"], { env: { ...Bun.env, ...storageEnv, WORKER_POLL_MS: "200" }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["node", "node_modules/vite/bin/vite.js", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" }),
];
async function waitFor(url: string) { for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).status < 500) return; } catch { /* startup */ } await Bun.sleep(200); } throw new Error(`${url} did not start`); }
const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
async function signup(page: Page, slug: string, name: string, email: string, invite?: string) {
  await page.goto(invite ?? web);
  await page.getByLabel(translate("auth.name")).fill(name);
  await page.getByLabel(translate("auth.email")).fill(email);
  await page.getByLabel(translate("auth.password")).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  if (!invite) {
    await page.getByLabel(translate("workspace.name")).fill("Exports E2E");
    await page.getByLabel(translate("workspace.slug")).fill(slug);
    await page.getByRole("button", { name: translate("workspace.create") }).click();
  }
  await page.waitForURL(`${web}/${slug}`);
}
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const adminContext = await browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const admin = await adminContext.newPage();
  const slug = `exports-${crypto.randomUUID().slice(0, 8)}`;
  await signup(admin, slug, "Exports Admin", `${slug}@example.test`);
  const { client, db } = createDatabase();
  const workspace = await db.query.workspaces.findFirst({ where: (table, { eq }) => eq(table.slug, slug) });
  check(!!workspace, "created workspace missing");
  const request = async <T>(name: string, body: unknown) => await (await admin.request.post(`${api}/actions/${name}`, { data: body })).json() as T;
  const project = await request<{ id: string }>("create_project", { workspaceId: workspace!.id, name: "Mobile", key: "MOB", visibility: "public" });
  await request("create_work_item", { projectId: project.id, title: 'Fix "login", then logout' });
  await request("create_work_item", { projectId: project.id, title: "=SUM(1+1)" });

  await admin.goto(`${web}/${slug}/settings`);
  const sidebar = admin.getByRole("navigation", { name: translate("shell.sidebar") });
  await sidebar.getByRole("link", { name: translate("settings.exports"), exact: true }).click();
  await admin.waitForURL(`${web}/${slug}/settings/exports`);
  await admin.getByText(translate("exports.none")).waitFor();
  const fits = async (page: Page, label: string) => check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${label}: page scrolls sideways`);
  await fits(admin, "1440px");

  await admin.getByRole("checkbox", { name: "MOB · Mobile" }).check();
  await admin.getByRole("button", { name: translate("exports.request"), exact: true }).click();
  await admin.getByText(translate("exports.status.completed"), { exact: true }).waitFor({ timeout: 30_000 });
  const [download] = await Promise.all([admin.waitForEvent("download"), admin.getByRole("button", { name: translate("exports.download") }).click()]);
  check(/^MOB-work-items-\d{4}-\d{2}-\d{2}\.csv$/.test(download.suggestedFilename()), `download name is ${download.suggestedFilename()}`);
  const text = await Bun.file((await download.path())!).text();
  const rows = text.replace(/^﻿/, "").split("\r\n");
  check(rows[0]!.startsWith("project,key,title,state,state_group,priority"), "CSV header is wrong");
  check(text.includes('Mobile,MOB-1,"Fix ""login"", then logout"'), "CSV did not escape the title");
  check(text.includes("Mobile,MOB-2,'=SUM(1+1)"), "CSV did not guard the formula");

  // No project picked and JSON: every project of the caller, as a ZIP with one JSON file per project.
  const second = await request<{ id: string }>("create_project", { workspaceId: workspace!.id, name: "Web", key: "WEB", visibility: "public" });
  await request("create_work_item", { projectId: second.id, title: "Web one" });
  await admin.reload();
  await admin.getByRole("combobox", { name: translate("exports.format") }).selectOption("json");
  await admin.getByRole("button", { name: translate("exports.request"), exact: true }).click();
  await admin.getByRole("button", { name: translate("exports.download") }).nth(1).waitFor({ timeout: 30_000 });
  const [archive] = await Promise.all([admin.waitForEvent("download"), admin.getByRole("button", { name: translate("exports.download") }).first().click()]);
  check(/^work-items-\d{4}-\d{2}-\d{2}\.zip$/.test(archive.suggestedFilename()), `ZIP name is ${archive.suggestedFilename()}`);
  const zip = new Uint8Array(await Bun.file((await archive.path())!).arrayBuffer());
  const names = [...new TextDecoder("latin1").decode(zip).matchAll(/(MOB|WEB)\.json/g)].map((match) => match[0]);
  check(names.includes("MOB.json") && names.includes("WEB.json"), "ZIP is missing a project file");

  // The same page works on a phone.
  await admin.setViewportSize({ width: 390, height: 844 });
  await admin.getByRole("button", { name: translate("exports.download") }).first().waitFor();
  await fits(admin, "390px");
  await adminContext.close(); await browser.close();
  await client.end();
  console.log("exports ok: request, worker build, status, download, CSV content, JSON ZIP of all projects, 1440px and 390px");
} finally {
  for (const server of servers) server.kill();
  s3.stop(true);
  const { client, db } = createDatabase();
  await db.delete(workspaces).where(like(workspaces.slug, "exports-%"));
  await db.delete(users).where(like(users.email, "exports-%@example.test"));
  await client.end();
}
