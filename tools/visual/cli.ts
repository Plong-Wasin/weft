// Reference capture and screenshot comparison. See tools/visual/README.md.
//   bun tools/visual/cli.ts plane                      start Plane if needed, seed it, capture the reference set
//   bun tools/visual/cli.ts weft [--routes f.json]     capture Weft at 1440px and 390px
//   bun tools/visual/cli.ts weft --compare             capture, then fail on pixel drift against docs/reference/goldens
//   bun tools/visual/cli.ts weft --update-goldens      capture, then replace the goldens
//   bun tools/visual/cli.ts external                   download the Wiki and AI reference images with their source URLs
//   bun tools/visual/cli.ts review                     write docs/reference/review.html (Plane left, Weft right)
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PlaneClient } from "./plane-client";
import { seedPlane } from "./plane-seed";
import { WeftClient, seedWeft } from "./weft-client";
import { comparePngs, fillPath, launch, loadRoutes, refDir, root, shoot } from "./lib";
import { writeReview } from "./review";

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(`--${name}`);
const option = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const dirs = { plane: join(refDir, "plane"), weft: join(refDir, "weft"), goldens: join(refDir, "goldens"), external: join(refDir, "external") };

async function reachable(url: string) { try { return (await fetch(url)).status < 500; } catch { return false; } }

async function waitFor(url: string, tries = 150) {
  for (let i = 0; i < tries; i += 1) { if (await reachable(url)) return; await Bun.sleep(1000); }
  throw new Error(`${url} did not come up`);
}

async function capturePlane() {
  const base = Bun.env.PLANE_URL ?? "http://localhost:8088";
  if (!(await reachable(base))) {
    const dir = Bun.env.PLANE_DIR ?? [join(Bun.env.HOME ?? "", "plane-try"), resolve(root, "..", "plane")].find((d) => existsSync(join(d, "docker-compose.yml")));
    if (!dir) throw new Error(`Plane is not running at ${base}. Set PLANE_DIR to a folder with Plane's docker-compose.yml and .env (the output of Plane's setup.sh).`);
    console.log(`starting Plane from ${dir}`);
    const up = Bun.spawnSync(["docker", "compose", "--project-directory", dir, "up", "-d"], { stdout: "inherit", stderr: "inherit" });
    if (up.exitCode !== 0) throw new Error("docker compose up failed");
    await waitFor(`${base}/api/instances/`, 300);
  }
  const email = Bun.env.PLANE_EMAIL ?? "ref01@weft.test";
  const password = Bun.env.PLANE_PASSWORD ?? "Weft-ref-pass-123";
  const client = new PlaneClient(base);
  await client.signIn(email, password);
  const seed = await seedPlane(client);
  const values = { slug: seed.slug, projectId: seed.projectId, key: seed.projectIdentifier, workItem: `${seed.projectIdentifier}-${seed.issueSequence}`, cycleId: seed.cycleId, moduleId: seed.moduleId, viewId: seed.viewId, pageId: seed.pageId };
  const { viewports, routes } = loadRoutes();
  mkdirSync(dirs.plane, { recursive: true });
  const browser = await launch();
  const taken: string[] = [], skipped: string[] = [];
  try {
    for (const route of routes) {
      const path = route.plane ? fillPath(route.plane, values) : null;
      if (!path) { skipped.push(route.name); continue; }
      for (const viewport of viewports) {
        await shoot(browser, { url: `${base}${path}`, file: join(dirs.plane, `${route.name}-${viewport.suffix}.png`), viewport, cookies: route.auth === false ? [] : client.browserCookies(), init: viewport.width < 768 ? `try{localStorage.setItem("app_sidebar_collapsed","true")}catch(e){}` : undefined });
        taken.push(`${route.name}-${viewport.suffix}`);
      }
    }
  } finally { await browser.close(); }
  writeFileSync(join(dirs.plane, "manifest.json"), JSON.stringify({ source: base, capturedAt: new Date().toISOString(), shots: taken, noPlaneRoute: skipped }, null, 2) + "\n");
  console.log(`plane: ${taken.length} shots in ${dirs.plane}; no Plane route for: ${skipped.join(", ") || "none"}`);
}

async function captureWeft() {
  const apiPort = Number(Bun.env.E2E_API_PORT ?? 3199), webPort = Number(Bun.env.E2E_WEB_PORT ?? 5299);
  const api = `http://localhost:${apiPort}`, web = `http://localhost:${webPort}`;
  const external = Bun.env.WEFT_WEB_URL && Bun.env.WEFT_API_URL;
  const servers = external ? [] : [
    Bun.spawn(["bun", "apps/api/src/index.ts"], { cwd: root, env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "ignore", stderr: "inherit" }),
    Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: join(root, "apps", "web"), env: { ...Bun.env, VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" }),
  ];
  const apiUrl = Bun.env.WEFT_API_URL ?? api, webUrl = Bun.env.WEFT_WEB_URL ?? web;
  const browser = await launch();
  const outDir = dirs.weft;
  try {
    await Promise.all([waitFor(`${apiUrl}/api/me`, 100), waitFor(webUrl, 100)]);
    const slug = `ref-${crypto.randomUUID().slice(0, 8)}`;
    const client = new WeftClient(apiUrl, webUrl);
    const seed = await seedWeft(client, slug);
    const { viewports, routes } = loadRoutes(option("routes") ? resolve(option("routes")!) : undefined);
    mkdirSync(outDir, { recursive: true });
    const taken: string[] = [], skipped: string[] = [];
    for (const route of routes) {
      const path = route.weft ? fillPath(route.weft, seed) : null;
      if (!path) { skipped.push(route.name); continue; }
      for (const viewport of viewports) {
        await shoot(browser, { url: `${webUrl}${path}`, file: join(outDir, `${route.name}-${viewport.suffix}.png`), viewport, cookies: route.auth === false ? [] : client.cookies() });
        taken.push(`${route.name}-${viewport.suffix}`);
      }
    }
    writeFileSync(join(outDir, "manifest.json"), JSON.stringify({ capturedAt: new Date().toISOString(), shots: taken, noWeftRoute: skipped }, null, 2) + "\n");
    console.log(`weft: ${taken.length} shots in ${outDir}; no Weft route for: ${skipped.join(", ") || "none"}`);

    if (flag("update-goldens")) {
      mkdirSync(dirs.goldens, { recursive: true });
      for (const name of taken) copyFileSync(join(outDir, `${name}.png`), join(dirs.goldens, `${name}.png`));
      console.log(`goldens updated: ${taken.length} files in ${dirs.goldens}`);
    }
    if (flag("compare")) {
      const threshold = Number(option("threshold") ?? 0.005);
      let failures = 0;
      for (const name of taken) {
        const golden = join(dirs.goldens, `${name}.png`);
        if (!existsSync(golden)) { console.log(`NEW   ${name} (no golden; run --update-goldens)`); failures += 1; continue; }
        const r = await comparePngs(browser, golden, join(outDir, `${name}.png`));
        const ok = r.sameSize && r.ratio <= threshold;
        if (!ok) failures += 1;
        console.log(`${ok ? "PASS" : "FAIL"}  ${name}  drift ${(r.ratio * 100).toFixed(3)}%${r.sameSize ? "" : " (size changed)"} (limit ${(threshold * 100).toFixed(3)}%)`);
      }
      if (failures > 0) { console.error(`${failures} shot(s) drifted past the threshold`); process.exitCode = 1; }
    }
  } finally {
    await browser.close();
    for (const server of servers) server.kill();
  }
}

async function downloadExternal() {
  const sources: { name: string; url: string; note: string }[] = JSON.parse(readFileSync(join(import.meta.dir, "external-sources.json"), "utf8"));
  mkdirSync(dirs.external, { recursive: true });
  const stored: Record<string, unknown>[] = [];
  for (const source of sources) {
    const res = await fetch(source.url);
    if (!res.ok) throw new Error(`${source.url} -> ${res.status}`);
    const file = `${source.name}${source.url.slice(source.url.lastIndexOf("."))}`;
    writeFileSync(join(dirs.external, file), new Uint8Array(await res.arrayBuffer()));
    stored.push({ file, sourceUrl: source.url, note: source.note, fetchedAt: new Date().toISOString() });
  }
  writeFileSync(join(dirs.external, "sources.json"), JSON.stringify(stored, null, 2) + "\n");
  console.log(`external: ${stored.length} images in ${dirs.external}`);
}

if (command === "plane") await capturePlane();
else if (command === "weft") await captureWeft();
else if (command === "external") await downloadExternal();
else if (command === "review") console.log(`review page: ${writeReview(refDir, loadRoutes())}`);
else { console.error("usage: cli.ts plane | weft [--routes f] [--compare] [--update-goldens] [--threshold 0.005] | external | review"); process.exit(2); }
