import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

export type SandboxProfile = {
  id: string;
  name: string;
  mode: "full" | "read-only" | "run-folder";
  filesystemAllowlist: string[];
  networkAllowlist: string[];
  enforce: boolean;
};

export type PreparedSandbox = { command: string[]; cleanup: () => Promise<void> };
type ProcessResult = { exitCode: number; stdout: string; stderr: string };
type Runner = (argv: string[], options?: { env?: Record<string, string | undefined> }) => Promise<ProcessResult>;

async function runProcess(argv: string[], options: { env?: Record<string, string | undefined> } = {}): Promise<ProcessResult> {
  const child = Bun.spawn(argv, { env: options.env ?? Bun.env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, stdout, stderr };
}

function versionAtLeast(version: string, minimum = [0, 0, 83]) {
  const match = version.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  for (let i = 0; i < minimum.length; i++) if (actual[i] !== minimum[i]) return actual[i]! > minimum[i]!;
  return true;
}

function srtSettings(profile: SandboxProfile, runDirectory: string, apiUrl: string) {
  const api = new URL(apiUrl);
  const home = homedir();
  const baseDomains = ["api.anthropic.com", "statsig.anthropic.com", "api.openai.com", "auth.openai.com", "chatgpt.com", "*.chatgpt.com"];
  // GitHub is not allowed by default: an owner who wants Agents to reach it adds github.com to the profile's allowed hosts.
  const domains = [...new Set([...baseDomains, `${api.hostname}${api.port ? `:${api.port}` : ""}`, ...profile.networkAllowlist])];
  const run = runDirectory;
  return {
    network: { allowedDomains: domains, deniedDomains: [] },
    filesystem: {
      denyRead: [".config/weft", ".ssh", ".aws", ".azure", ".config/gcloud", ".claude", ".codex", ".git-credentials", ".config/gh", ".netrc", ".docker", ".kube", ".npmrc", ".gnupg"].map((path) => join(home, path)),
      allowRead: [run, ...profile.filesystemAllowlist.map((path) => resolve(path))],
      allowWrite: profile.mode === "run-folder" ? [run] : [],
      denyWrite: [],
    },
  };
}

/** Prepare a fail-closed SRT wrapper. Full access profiles intentionally use the unwrapped CLI. */
export async function prepareSandbox(profile: SandboxProfile, runDirectory: string, apiUrl: string, env: Record<string, string | undefined> = Bun.env, runner: Runner = runProcess): Promise<PreparedSandbox> {
  // An owner who turned enforcement on wants no Run outside a sandbox, whatever the server sent: refuse a full-access Run here too.
  if (profile.mode === "full" && profile.enforce) throw new Error("This Runtime requires a sandbox, so a Full access Run was refused. Ask the Runtime owner to choose a restricted profile for the Agent.");
  if (profile.mode === "full") return { command: [], cleanup: async () => {} };
  const executable = env.WEFT_SRT_BIN ?? "srt";
  let version: ProcessResult;
  try { version = await runner([executable, "--version"], { env }); }
  catch { throw new Error("Sandbox Runtime (SRT) 0.0.83 or newer is required. Install it with `npm install --global @anthropic-ai/sandbox-runtime`."); }
  const detectedVersion = `${version.stdout}\n${version.stderr}`;
  if (version.exitCode !== 0 || !versionAtLeast(detectedVersion)) throw new Error("Sandbox Runtime (SRT) 0.0.83 or newer is required. Install it with `npm install --global @anthropic-ai/sandbox-runtime`.");
  if (process.platform === "linux") {
    for (const dependency of ["bwrap", "socat", "rg"]) {
      const check = await runner(["sh", "-c", `command -v ${dependency}`], { env });
      if (check.exitCode !== 0) throw new Error(`Sandbox Runtime needs ${dependency}. Install ${dependency} or ask your administrator to enable Linux user namespaces.`);
    }
  }
  const control = await mkdtemp(join(tmpdir(), "weft-sandbox-settings-"));
  const settings = join(control, "settings.json");
  await writeFile(settings, JSON.stringify(srtSettings(profile, runDirectory, apiUrl)), { mode: 0o600 });
  await chmod(control, 0o700);
  try {
    const probe = await runner([executable, "--settings", settings, "--", "sh", "-c", "true"], { env });
    if (probe.exitCode !== 0) throw new Error(`Sandbox Runtime could not start safely: ${(probe.stderr || probe.stdout).trim() || "host sandbox policy rejected startup"}. Check the SRT dependencies and host user-namespace policy.`);
    return { command: [executable, "--settings", settings, "--"], cleanup: () => rm(control, { recursive: true, force: true }) };
  } catch (error) {
    await rm(control, { recursive: true, force: true });
    throw error;
  }
}

