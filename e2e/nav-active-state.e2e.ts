// Every navigation entry that points at the open screen says so (aria-current=page and the active background), and loses both elsewhere.
// Failures are collected so one run lists every broken entry and still writes the screenshots. Set NAV_SHOTS to choose their folder.
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { eq, like } from "drizzle-orm";
import { createDatabase, notifications, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";
import { WeftClient } from "../tools/visual/weft-client";
import { saveShot } from "./shots";
// AI is on only with a provider key: a placeholder keeps the AI entries shown, and no model is called.
Bun.env.OPENAI_API_KEY ??= "sk-e2e-placeholder-no-call";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31161);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52161);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = Bun.env.NAV_SHOTS ?? reviewShots("nav-active-state");
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" }),
];

async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* starting */ }
    await Bun.sleep(200);
  }
  throw new Error(`${url} did not start`);
}

/** The phone drawer slides in: a screenshot taken before it stops shows it half off screen. */
async function shot(page: Page, name: string) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
  await saveShot(page, { path: `${shots}/${name}.png` }, { failed: failures.length > 0 });
}

const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
const failures: string[] = [];
const transparent = "rgba(0, 0, 0, 0)";

/** The entry's aria-current and background, read at rest: the pointer is moved away and the colour transition has ended. */
async function stateOf(entry: Locator) {
  await entry.page().mouse.move(700, 500);
  await entry.waitFor();
  return entry.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
    return { current: element.getAttribute("aria-current"), background: getComputedStyle(element).backgroundColor };
  });
}
/** `background` is the sibling's active colour, so "same look" is compared and not guessed. */
async function expectEntry(entry: Locator, active: boolean, background: string, label: string) {
  const state = await stateOf(entry);
  const ok = active ? state.current === "page" && state.background === background : state.current === null && state.background === transparent;
  if (!ok) failures.push(`${label}: expected ${active ? `aria-current=page on ${background}` : "no aria-current and no background"}, got aria-current=${state.current} on ${state.background}`);
}

let browser: Browser | undefined;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  await Bun.$`mkdir -p ${shots}`;
  browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const operator = new WeftClient(api, web);
  await operator.signUp("Nav Tester", `${slug}@example.test`, "a-secure-password");
  const workspace = await operator.action<{ id: string }>("create_workspace", { name: "Nav team", slug });
  await operator.action("create_project", { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" });
  const wiki = await operator.action<{ id: string }>("create_wiki_page", { workspaceId: workspace.id, title: "Nav handbook" });
  const me = (await operator.action<Array<{ userId: string }>>("list_members", { workspaceId: workspace.id }))[0]!.userId;
  const database = createDatabase();
  let noticeId: string;
  try {
    const [row] = await database.db.insert(notifications).values({ workspaceId: workspace.id, userId: me, actorId: me, kind: "mention", wikiPageId: wiki.id, jobId: crypto.randomUUID() }).returning({ id: notifications.id });
    noticeId = row!.id;
  } finally { await database.client.end(); }
  const cookies = operator.cookies().map((cookie) => ({ ...cookie, domain: "localhost", path: "/" }));

  const open = async (page: Page, path: string) => {
    await page.goto(`${web}/${slug}${path}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: translate("profile.menu") }).waitFor();
  };

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const phone = viewport.width < 768;
    const size = `${viewport.width}px`;
    const context = await browser.newContext({ viewport, locale: "en-US", reducedMotion: "reduce" });
    await context.addCookies(cookies);
    const page = await context.newPage();
    // The sidebar and the rail: in the page on desktop, inside the drawer on a phone.
    const scope = () => phone ? page.getByRole("dialog") : page.locator("body");
    const sidebar = () => scope().getByRole("navigation", { name: translate("shell.sidebar"), exact: true }).last();
    const rail = () => scope().getByRole("navigation", { name: translate("shell.rail") });
    const link = (name: string) => sidebar().getByRole("link", { name, exact: true });
    const inbox = () => sidebar().getByRole("link", { name: new RegExp(`^${translate("inbox.navLabel")}`) });
    const visit = async (path: string) => {
      await open(page, path);
      if (phone) await page.getByRole("button", { name: translate("shell.openMenu") }).click();
      await sidebar().waitFor();
    };
    /** Exactly the named rail entry is current: a prefix match must not mark Work on every screen. */
    const expectRail = async (name: string, path: string) => {
      await rail().getByRole("link").first().waitFor();
      const current = await rail().locator("a[aria-current]").allInnerTexts();
      if (current.join("|") !== name) failures.push(`${size} rail on ${path}: expected only ${name} current, got [${current.join(", ")}]`);
    };

    await visit("");
    const home = link(translate("nav.home"));
    const active = (await stateOf(home)).background;
    if (active === transparent) failures.push(`${size}: Home has no active background to compare with`);
    await expectEntry(inbox(), false, active, `${size} sidebar Inbox on home`);

    for (const path of ["/notifications", "/notifications?filter=all", `/notifications?notification=${noticeId}`]) {
      await visit(path);
      await expectEntry(inbox(), true, active, `${size} sidebar Inbox on ${path}`);
      await expectEntry(link(translate("nav.home")), false, active, `${size} sidebar Home on ${path}`);
    }
    await shot(page, `inbox-${size}`);
    await expectRail(translate("rail.work"), "/notifications");

    // Leaving through the app (no reload) takes the state off again.
    await link(translate("nav.home")).click();
    await page.waitForURL(`${web}/${slug}`);
    if (phone) await page.getByRole("button", { name: translate("shell.openMenu") }).click();
    await expectEntry(inbox(), false, active, `${size} sidebar Inbox after leaving`);

    const bell = page.getByRole("banner").getByRole("link", { name: translate("topbar.notifications") });
    await open(page, "/notifications");
    await expectEntry(bell, true, active, `${size} top bar bell on /notifications`);
    await shot(page, `bell-${size}`);
    await open(page, "");
    await expectEntry(bell, false, active, `${size} top bar bell on home`);

    await visit("/projects");
    await expectEntry(link(translate("sidebar.allProjects")), true, active, `${size} sidebar All projects on /projects`);
    await shot(page, `projects-${size}`);
    await visit("");
    await expectEntry(link(translate("sidebar.allProjects")), false, active, `${size} sidebar All projects on home`);

    await visit("/settings/projects/MOB");
    await expectEntry(link(translate("sidebar.backToWorkspace")), false, active, `${size} sidebar back link in project settings`);
    await expectEntry(link(translate("settings.general")), true, active, `${size} project settings General`);
    await expectRail(translate("nav.settings"), "/settings/projects/MOB");
    await shot(page, `project-settings-${size}`);

    const allPages = () => link(translate("sidebar.allPages"));
    const archived = () => link(translate("pages.tab.archived"));
    await visit("/wiki");
    await expectEntry(allPages(), true, active, `${size} wiki All pages on /wiki`);
    await expectEntry(archived(), false, active, `${size} wiki Archived on /wiki`);
    await expectRail(translate("wiki.title"), "/wiki");
    await visit("/wiki?tab=archived");
    await expectEntry(allPages(), false, active, `${size} wiki All pages on the archived tab`);
    await expectEntry(archived(), true, active, `${size} wiki Archived on the archived tab`);
    await shot(page, `wiki-archived-${size}`);
    await visit(`/wiki/${wiki.id}`);
    await expectEntry(archived(), false, active, `${size} wiki Archived on a page`);

    await visit("/ai");
    await expectEntry(link(translate("ai.new")), true, active, `${size} AI New chat on /ai`);
    await expectRail(translate("rail.ai"), "/ai");
    await shot(page, `ai-${size}`);
    await context.close();
  }
  if (!failures.length) console.log("e2e nav active state: sidebar, rail, drawer and top bar mark only the open screen, at 1440 and 390px");
} catch (error) {
  failures.push(String(error instanceof Error ? error.stack : error));
} finally {
  await browser?.close();
  for (const server of servers) server.kill();
  const database = createDatabase();
  try {
    await database.db.delete(workspaces).where(eq(workspaces.slug, slug));
    await database.db.delete(users).where(like(users.email, `${slug}%@example.test`));
  } finally { await database.client.end(); }
}
if (failures.length) console.error(failures.join("\n"));
process.exit(failures.length ? 1 : 0);
