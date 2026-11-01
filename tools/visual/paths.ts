import { dirname, join, resolve } from "node:path";

/**
 * Where UI screenshots live: `.local/visual/` in the MAIN checkout (the parent of the shared `.git`), so every
 * worktree reads and writes the same folder and nothing is committed. Override with VISUAL_DIR.
 */
export function visualDir(): string {
  if (Bun.env.VISUAL_DIR) return resolve(Bun.env.VISUAL_DIR);
  const common = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: import.meta.dir }).stdout.toString().trim();
  const repo = common ? dirname(common) : join(import.meta.dir, "..", "..");
  return join(repo, ".local", "visual");
}

/** Per-ticket review screenshots written by the e2e flows, e.g. reviewShots("03-app-shell"). */
export const reviewShots = (name: string) => join(visualDir(), "review", name);
