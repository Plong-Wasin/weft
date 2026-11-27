import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, request, type Browser, type BrowserType, type LaunchOptions, type BrowserContextOptions, type Page } from "playwright";
import { buildWeb } from "./web-build";
import { listenersOn } from "./ports";

const repo = join(import.meta.dir, "..");
type ServerOptions = { env?: typeof Bun.env; stdout?: "inherit" | "ignore" };
type Server = Pick<ReturnType<typeof Bun.spawn>, "pid" | "exitCode" | "signalCode">;
const servers = new Map<number, Server>();

function trackServer<T extends Server>(port: number, server: T): T {
  servers.set(port, server);
  return server;
}

export function startApi(port: number, web: string, { env = Bun.env, stdout = "inherit" }: ServerOptions = {}) {
  return trackServer(port, Bun.spawn(["bun", "apps/api/src/index.ts"], {
    cwd: repo, env: { ...env, PORT: String(port), WEB_ORIGIN: web, BETTER_AUTH_URL: `http://localhost:${port}` },
    stdout, stderr: "inherit",
  }));
}

export function startLive(port: number, web: string, { env = Bun.env, stdout = "inherit" }: ServerOptions = {}) {
  return trackServer(port, Bun.spawn(["bun", "apps/live/src/index.ts"], {
    cwd: repo, env: { ...env, LIVE_PORT: String(port), WEB_ORIGIN: web }, stdout, stderr: "inherit",
  }));
}

type WebOptions = ServerOptions & { api: string; live?: string; host?: string };

export function startWeb(port: number, { api, live, env = Bun.env, host, stdout = "ignore" }: WebOptions) {
  if (Bun.env.E2E_WEB_DIR) return serveWeb(port, Bun.env.E2E_WEB_DIR, host, stdout);
  const args = ["node", "node_modules/vite/bin/vite.js", "--port", String(port), "--strictPort"];
  if (host) args.push("--host", host);
  return trackServer(port, Bun.spawn(args, {
    cwd: join(repo, "apps/web"), env: { ...env, VITE_API_URL: api, VITE_LIVE_URL: live ?? env.VITE_LIVE_URL },
    stdout, stderr: "inherit",
  }));
}

export function serveWeb(port: number, directory: string, host = "127.0.0.1", stdout: "inherit" | "ignore" = "ignore") {
  return trackServer(port, Bun.spawn(["bun", join(import.meta.dir, "serve-web.ts"), directory, String(port), host], {
    cwd: repo, stdout, stderr: "inherit",
  }));
}

/** For flows that explicitly require the production build, even with --dev. */
export async function productionWeb(api: string, live?: string, { unmodified = false } = {}) {
  const shared = Bun.env.E2E_PRODUCTION_WEB_DIR;
  if (shared && !unmodified) return { directory: shared, clean: async () => {} };
  const directory = await mkdtemp(join(tmpdir(), "weft-e2e-web-"));
  const clean = () => rm(directory, { recursive: true, force: true });
  try {
    await buildWeb(directory, api, live);
    return { directory, clean };
  } catch (error) {
    await clean();
    throw error;
  }
}

export async function waitUntil(condition: () => boolean | Promise<boolean>, message: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(50);
  }
  throw new Error(message);
}

export async function waitFor(url: string, child?: Server) {
  const address = new URL(url);
  const port = Number(address.port || (address.protocol === "https:" ? 443 : 80));
  const server = child ?? servers.get(port);
  if (!server) throw new Error(`${url} did not start: no server was registered for port ${port}`);
  const checkExit = () => {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`${url} did not start: server pid ${server.pid} exited (${server.exitCode ?? server.signalCode})`);
    }
  };
  return waitUntil(async () => {
    checkExit();
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(500), redirect: "manual" });
      await response.body?.cancel();
    } catch { return false; }
    checkExit();
    const listeners = listenersOn(port);
    const foreign = listeners.find(({ pid }) => pid !== server.pid);
    if (foreign) throw new Error(`${url} did not start: port ${port} is owned by ${foreign.command} (pid ${foreign.pid}), expected server pid ${server.pid}`);
    return listeners.length > 0 && response.status < 500;
  }, `${url} did not start`, 20_000);
}

export function check(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

export function launchBrowser({ executablePath, ...options }: LaunchOptions = {}, type: BrowserType = chromium) {
  return type.launch({ executablePath: executablePath ?? (type === chromium ? Bun.env.CHROMIUM_PATH : undefined), ...options });
}

export async function newContext(browser: Browser, options?: BrowserContextOptions) {
  const context = await browser.newContext({ serviceWorkers: "block", ...options });
  context.setDefaultTimeout(30_000);
  return context;
}

export async function newPage(browser: Browser, options?: BrowserContextOptions) {
  // Browser.newPage owns its context, so page.close() also releases it.
  const page = await browser.newPage({ serviceWorkers: "block", ...options });
  page.setDefaultTimeout(30_000);
  return page;
}

/**
 * Runs `open` and returns once the page has the action's answer and has rendered it.
 * An "@" typed before the member list is in the editor opens an empty, hidden popup that never refreshes.
 */
export async function openWithAction(page: Page, action: string, open: () => Promise<unknown>) {
  const answered = page.waitForResponse((response) => response.url().endsWith(`/actions/${action}`) && response.request().method() === "POST");
  await open();
  await (await answered).finished();
  // React commits the answer before the second frame.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** Sets up a browser session for flows whose assertions start after onboarding. */
export async function createSignedInContext(browser: Browser, options: BrowserContextOptions, api: string, web: string, fixture: {
  account: { name: string; email: string; password?: string };
  workspace: { name: string; slug: string };
  project?: { name: string; key: string; visibility: "private" | "public"; shape?: "simple" | "full" };
}) {
  const session = await request.newContext({ extraHTTPHeaders: { origin: web } });
  const post = async <T>(path: string, data: unknown): Promise<T> => {
    const response = await session.post(`${api}${path}`, { data });
    if (!response.ok()) throw new Error(`${path} failed (${response.status()}): ${await response.text()}`);
    return response.json();
  };

  try {
    await post("/api/auth/sign-up/email", { password: "a-secure-password", ...fixture.account });
    const workspace = await post<{ id: string }>("/actions/create_workspace", fixture.workspace);
    if (fixture.project) await post("/actions/create_project", { ...fixture.project, workspaceId: workspace.id });
    return await newContext(browser, { ...options, storageState: await session.storageState() });
  } finally {
    await session.dispose();
  }
}
