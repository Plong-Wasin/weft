import { afterAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSandbox, type SandboxProfile } from "../src/sandbox";

const scratch: string[] = [];
afterAll(async () => { await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true }))); });

test("a restricted Runtime profile uses a version-checked fake SRT and a complete per-Run policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "weft-sandbox-test-")); scratch.push(root);
  const bin = join(root, "bin"); await Bun.$`mkdir -p ${bin}`;
  const settingsCapture = join(root, "captured-settings.json");
  const srt = join(bin, "srt");
  await writeFile(srt, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '0.0.83'; exit 0; fi\ncp "$2" '${settingsCapture}'\nexit 0\n`); await chmod(srt, 0o755);
  for (const name of ["bwrap", "socat", "rg"]) { const dependency = join(bin, name); await writeFile(dependency, "#!/bin/sh\nexit 0\n"); await chmod(dependency, 0o755); }
  const run = join(root, "run"); await Bun.$`mkdir -p ${run}`;
  const profile: SandboxProfile = { id: "p", name: "Read only", mode: "read-only", filesystemAllowlist: ["/workspace/project"], networkAllowlist: ["gitlab.example"], enforce: true };
  const prepared = await prepareSandbox(profile, run, "https://weft.example:3443/api", { PATH: `${bin}:/usr/bin:/bin`, WEFT_SRT_BIN: srt });
  expect(prepared.command).toEqual([srt, "--settings", expect.any(String), "--"]);
  expect(JSON.parse(await readFile(settingsCapture, "utf8"))).toEqual({
    network: { allowedDomains: expect.arrayContaining(["weft.example:3443", "gitlab.example", "api.openai.com"]), deniedDomains: [] },
    filesystem: { denyRead: expect.arrayContaining([join(process.env.HOME ?? ".", ".ssh"), join(process.env.HOME ?? ".", ".config/weft")]), allowRead: [run, "/workspace/project"], allowWrite: [], denyWrite: [] },
  });
  await prepared.cleanup();
});

test("missing SRT fails before a restricted profile can start", async () => {
  const root = await mkdtemp(join(tmpdir(), "weft-sandbox-missing-")); scratch.push(root);
  const profile: SandboxProfile = { id: "p", name: "Sandbox", mode: "run-folder", filesystemAllowlist: [], networkAllowlist: [], enforce: true };
  await expect(prepareSandbox(profile, root, "https://weft.example", { PATH: "", WEFT_SRT_BIN: join(root, "missing-srt") })).rejects.toThrow("Sandbox Runtime (SRT) 0.0.83 or newer is required");
});

test("full access profiles do not invoke the sandbox executable", async () => {
  const profile: SandboxProfile = { id: "p", name: "Full access", mode: "full", filesystemAllowlist: [], networkAllowlist: [], enforce: false };
  const prepared = await prepareSandbox(profile, "/tmp/run", "http://localhost:3000", {}, async () => { throw new Error("must not invoke SRT"); });
  expect(prepared.command).toEqual([]);
});

test("two Agents on one Runtime use separate profiles: sandboxed writes stay in the Run folder while full access can write outside", async () => {
  const root = await mkdtemp(join(tmpdir(), "weft-sandbox-pair-")); scratch.push(root);
  const bin = join(root, "bin"); await Bun.$`mkdir -p ${bin}`;
  const fakeSrt = join(bin, "srt");
  await writeFile(fakeSrt, `#!/usr/bin/python3\nimport json, os, sys\nif sys.argv[1:] == ['--version']:\n print('0.0.83'); raise SystemExit(0)\nsettings=json.load(open(sys.argv[2]))\ncommand=sys.argv[4:]\nif command[0:3] == ['sh', '-c', 'true']:\n raise SystemExit(0)\npath=command[-1]\nif not any(path == allowed or path.startswith(allowed.rstrip('/') + '/') for allowed in settings['filesystem']['allowWrite']):\n print('sandbox denied write outside allowed paths', file=sys.stderr); raise SystemExit(13)\nos.execvp(command[0], command)\n`); await chmod(fakeSrt, 0o755);
  for (const name of ["bwrap", "socat", "rg"]) { const dependency = join(bin, name); await writeFile(dependency, "#!/bin/sh\nexit 0\n"); await chmod(dependency, 0o755); }
  const run = join(root, "run"); await Bun.$`mkdir -p ${run}`;
  const env = { PATH: `${bin}:/usr/bin:/bin`, WEFT_SRT_BIN: fakeSrt };
  const sandboxed = await prepareSandbox({ id: "sandbox", name: "Run folder", mode: "run-folder", filesystemAllowlist: [], networkAllowlist: [], enforce: true }, run, "http://weft.example", env);
  const sandboxWrite = Bun.spawnSync([...sandboxed.command, "sh", "-c", 'printf sandboxed > "$1"', "sh", join(run, "inside.txt")], { env });
  const deniedWrite = Bun.spawnSync([...sandboxed.command, "sh", "-c", 'printf denied > "$1"', "sh", join(root, "outside-sandbox.txt")], { env });
  expect(sandboxWrite.exitCode).toBe(0);
  expect(deniedWrite.exitCode).not.toBe(0);
  const full = await prepareSandbox({ id: "full", name: "Full access", mode: "full", filesystemAllowlist: [], networkAllowlist: [], enforce: false }, run, "http://weft.example", env);
  const fullWrite = Bun.spawnSync([...full.command, "sh", "-c", 'printf full > "$1"', "sh", join(root, "outside-full.txt")], { env });
  expect(fullWrite.exitCode).toBe(0);
  await sandboxed.cleanup();
});

test("a Runtime that enforces a sandbox refuses a Full access Run, and the policy hides credential folders and GitHub unless the profile lists it", async () => {
  await expect(prepareSandbox({ id: "full", name: "Full access", mode: "full", filesystemAllowlist: [], networkAllowlist: [], enforce: true }, "/tmp/run", "http://weft.example", {}, async () => { throw new Error("must not invoke SRT"); }))
    .rejects.toThrow("requires a sandbox");
  const root = await mkdtemp(join(tmpdir(), "weft-sandbox-policy-")); scratch.push(root);
  const bin = join(root, "bin"); await Bun.$`mkdir -p ${bin}`;
  const capture = join(root, "settings.json");
  const srt = join(bin, "srt");
  await writeFile(srt, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '0.0.83'; exit 0; fi\ncp "$2" '${capture}'\nexit 0\n`); await chmod(srt, 0o755);
  for (const name of ["bwrap", "socat", "rg"]) { const dependency = join(bin, name); await writeFile(dependency, "#!/bin/sh\nexit 0\n"); await chmod(dependency, 0o755); }
  const env = { PATH: `${bin}:/usr/bin:/bin`, WEFT_SRT_BIN: srt };
  const settingsFor = async (networkAllowlist: string[]) => {
    await (await prepareSandbox({ id: "p", name: "Sandbox", mode: "run-folder", filesystemAllowlist: [], networkAllowlist, enforce: true }, join(root, "run"), "http://weft.example", env)).cleanup();
    return JSON.parse(await readFile(capture, "utf8")) as { network: { allowedDomains: string[] }; filesystem: { denyRead: string[] } };
  };
  const home = process.env.HOME ?? ".";
  const closed = await settingsFor([]);
  for (const path of [".claude", ".codex", ".git-credentials", ".config/gh", ".netrc", ".docker", ".kube", ".npmrc", ".gnupg"]) expect(closed.filesystem.denyRead).toContain(join(home, path));
  expect(closed.network.allowedDomains.filter((host) => host.includes("github"))).toEqual([]);
  expect((await settingsFor(["github.com"])).network.allowedDomains).toContain("github.com");
});
