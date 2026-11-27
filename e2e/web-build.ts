import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const webRoot = join(import.meta.dir, "../apps/web");
const apiMarker = "__WEFT_E2E_API_PORT__";
const liveMarker = "__WEFT_E2E_LIVE_PORT__";

export async function buildWeb(directory: string, api: string, live?: string) {
  const build = Bun.spawn(["node", "node_modules/vite/bin/vite.js", "build", "--logLevel", "warn", "--outDir", directory, "--emptyOutDir"], {
    cwd: webRoot,
    env: { ...Bun.env, VITE_API_URL: api, VITE_LIVE_URL: live },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await build.exited !== 0) throw new Error("e2e web build failed");
}

export async function buildWorkerWeb(root: string, ports: { api: number; live: number }[]) {
  const template = join(root, "template");
  await buildWeb(template, `http://localhost:${apiMarker}`, `ws://localhost:${liveMarker}`);
  const assets = join(template, "assets");
  const substitutions: Array<{ name: string; source: string }> = [];
  for (const file of await readdir(assets)) {
    if (!file.endsWith(".js")) continue;
    const source = await readFile(join(assets, file), "utf8");
    if (source.includes(apiMarker) || source.includes(liveMarker)) substitutions.push({ name: file, source });
  }
  const source = substitutions.map((asset) => asset.source).join("");
  if (!source.includes(apiMarker) || !source.includes(liveMarker)) throw new Error("e2e web build is missing API or live URL placeholders");

  return Promise.all(ports.map(async ({ api, live }, worker) => {
    const directory = join(root, String(worker));
    await mkdir(directory);
    await cp(template, directory, { recursive: true });
    await Promise.all(substitutions.map(({ name, source }) => writeFile(
      join(directory, "assets", name),
      source.replaceAll(apiMarker, String(api)).replaceAll(liveMarker, String(live)),
    )));
    return directory;
  }));
}
