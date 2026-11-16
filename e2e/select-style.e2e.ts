// Browser check for the shared native select style: a visible chevron, a hover ring, a focus ring and a clearly disabled state.
import { chromium } from "playwright";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31420);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52420);
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

type Look = { backgroundImage: string; borderColor: string; backgroundColor: string; color: string; cursor: string; boxShadow: string };
const lookOf = (locator: import("playwright").Locator) => locator.evaluate((element): Look => {
  const style = getComputedStyle(element);
  return { backgroundImage: style.backgroundImage, borderColor: style.borderTopColor, backgroundColor: style.backgroundColor, color: style.color, cursor: style.cursor, boxShadow: style.boxShadow };
});

let failed = false;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Select Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Select team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByRole("button", { name: translate("projects.new"), exact: true }).click();
  await page.getByLabel(translate("projects.name")).fill("Mobile");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("SEL");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /SEL · Mobile/ }).waitFor();

  const me = await (await page.request.get(`${api}/api/me`)).json() as any;
  const workspaceId = me.workspaces.find((workspace: any) => workspace.slug === slug).id;
  const call = async (name: string, data: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data })).json() as any;
  const project = (await call("list_projects", { workspaceId, archived: false })).find((entry: any) => entry.key === "SEL");
  const live = await call("create_wiki_page", { workspaceId, projectId: project.id, title: "Release plan" });
  const old = await call("create_wiki_page", { workspaceId, projectId: project.id, title: "Old notes" });
  await call("archive_wiki_page", { pageId: old.id });

  const t = (key: string) => translate(key as never);
  const enabledOrder = page.getByLabel(t("pages.order"));
  await page.goto(`${web}/${slug}/projects/SEL/pages`);
  await enabledOrder.waitFor();

  // Rest state: a chevron, a border, and a surface that reads as a control.
  const rest = await lookOf(enabledOrder);
  check(rest.backgroundImage.includes("url("), "select should draw its own chevron (background-image)");
  check(rest.borderColor !== "rgba(0, 0, 0, 0)", "select should have a visible border");

  // Hover: the border changes, and the surface stays a control.
  await page.mouse.move(0, 0);
  const idle = await lookOf(enabledOrder);
  await enabledOrder.hover();
  const hovered = await lookOf(enabledOrder);
  check(hovered.borderColor !== idle.borderColor, "hover should change the select border colour");
  await page.mouse.move(0, 0);

  // Focus: keyboard focus draws a ring (box-shadow), distinct from hover.
  await enabledOrder.focus();
  await page.keyboard.press("Shift");
  check(await enabledOrder.evaluate((element) => element.matches(":focus-visible")), "keyboard focus should match :focus-visible");
  const focused = await lookOf(enabledOrder);
  check(focused.boxShadow !== "none", "focus should draw a ring (box-shadow)");
  check(focused.boxShadow !== hovered.boxShadow, "focus ring should differ from hover");
  await page.locator("body").click({ position: { x: 1, y: 1 } });

  // Disabled: an archived page locks its Parent page select; it must look different from an enabled select.
  await page.goto(`${web}/${slug}/projects/SEL/pages/${live.id}`);
  const enabledAccess = page.locator("label", { hasText: t("wiki.access") }).locator("select").first();
  await enabledAccess.waitFor();
  const enabled = await lookOf(enabledAccess);
  await page.goto(`${web}/${slug}/projects/SEL/pages/${old.id}`);
  const disabledParent = page.locator("label", { hasText: t("wiki.parent") }).locator("select");
  await disabledParent.waitFor();
  check(await disabledParent.isDisabled(), "archived page parent select should be disabled");
  const disabled = await lookOf(disabledParent);
  check(disabled.cursor === "not-allowed", "disabled select should show a not-allowed cursor");
  check(disabled.backgroundColor !== enabled.backgroundColor || disabled.color !== enabled.color, "disabled select should look different from an enabled one");

  console.log("e2e select style: chevron, hover, focus ring and disabled state ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
}
process.exit(failed ? 1 : 0);
