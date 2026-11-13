import { Command, Option } from "commander";
import { createActionList, describeAction, integrationsEnabled } from "@weft/actions";
import type { Database } from "@weft/db";
import { daemonPaths, daemonStatus, login, readCliConfig, startDaemon, stopDaemon } from "./daemon";
import { autostartStatus, disableAutostart, enableAutostart, followLog, probeAgentClis, readLogTail, recordServiceDaemon, restartDaemon, startDaemonForUser } from "./daemon-ops";
import { checkForNewerCli } from "./version";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CliEnvironment {
  fetch?: FetchLike;
  env?: Record<string, string | undefined>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  stdin?: ReadableStream<Uint8Array>;
  signal?: AbortSignal;
}

interface Schema { type?: string; description?: string; properties?: Record<string, Schema>; required?: string[]; anyOf?: Schema[]; const?: unknown }

const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/_/g, "-").toLowerCase();

function parseValue(schema: Schema, raw: string): unknown {
  if (schema.type === "string") return raw;
  if (schema.type === "number" || schema.type === "integer") {
    const value = Number(raw);
    if (Number.isNaN(value)) throw new Error(`Expected a number, got "${raw}"`);
    return value;
  }
  // arrays, objects, nullable and union fields take JSON; a bare word stays a string (enum literals)
  try { return JSON.parse(raw); } catch { return raw; }
}

/**
 * Commander program derived from the Action registry: one command per Action, one option per input
 * field. Handlers never run here (the Action list gets a database stub); every call goes to the API.
 */
export function buildProgram(environment: CliEnvironment = {}) {
  const env = environment.env ?? Bun.env;
  const doFetch: FetchLike = environment.fetch ?? fetch;
  const stdout = environment.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = environment.stderr ?? ((text: string) => process.stderr.write(text));

  const program = new Command("weft")
    .description("Weft command line, derived from the Action registry: one command per Action (work items, wiki, Cycles, Modules, Intake, Relations, comments, queries, ...). Run `weft <command> --help` for a command's options; `weft --help` lists them all. Write commands run at once (no Confirmation card).")
    .option("--api-url <url>", "API base URL (env WEFT_API_URL)")
    .option("--token <token>", "personal API token (env WEFT_TOKEN)")
    .option("-w, --workspace <slug>", "workspace slug (env WEFT_WORKSPACE)")
    .exitOverride()
    .configureOutput({ writeOut: stdout, writeErr: stderr });

  program.command("login").description("Sign in through your browser and save your CLI token").action(async () => login({ env, fetch: doFetch, stdout, stderr }));
  const daemon = program.command("daemon").description("Manage the local Daemon");
  daemon.command("start").description("Start the Daemon in the background").addHelpText("after", "\nEach machine that runs a Daemon needs its own hostname: two machines with the same hostname share one Daemon and lock each other out.\nSet WEFT_HOSTNAME to a distinct name on each machine (the default is this computer's hostname).\n").option("--foreground", "Keep the Daemon attached to this terminal for debugging").action(async (options: { foreground?: boolean }) => {
    const runtime = { env, fetch: doFetch, stdout, stderr };
    if (!options.foreground) {
      const started = await startDaemonForUser(runtime);
      if ("managedBy" in started && started.managedBy === "autostart") stdout(`Daemon started by autostart${started.pid ? ` (process ${started.pid})` : ""}. Run \`weft daemon status\` to check it.\n`);
      const notice = await checkForNewerCli({ fetch: doFetch, apiUrl: (await readCliConfig(env)).apiUrl ?? env.WEFT_API_URL ?? "http://localhost:3000" });
      if (notice) stdout(`${notice}\n`);
      return;
    }
    // The autostart service runs the foreground Daemon and must record its own process so status and stop can find it.
    const serviced = env.WEFT_DAEMON_SERVICE === "1";
    const release = serviced ? await recordServiceDaemon({ env, apiUrl: (env.WEFT_API_URL ?? (await readCliConfig(env)).apiUrl ?? "http://localhost:3000").replace(/\/$/, "") }) : undefined;
    try { await startDaemon(runtime); } finally { await release?.(); }
  });
  daemon.command("stop").description("Stop the background Daemon and its active Runs").action(async () => { await stopDaemon({ env, stdout, stderr }); });
  daemon.command("restart").description("Stop the Daemon if it runs, then start it again").option("--json", "Print the result as JSON").action(async (options: { json?: boolean }) => {
    const result = await restartDaemon({ env, stdout: () => {}, stderr });
    if (options.json) { stdout(`${JSON.stringify(result)}\n`); return; }
    const before = result.previousPid ? `Stopped process ${result.previousPid}. ` : "";
    stdout(`${before}Daemon restarted${result.pid ? ` (process ${result.pid})` : ""} ${result.managedBy === "autostart" ? "by autostart" : "in the background"}. Run \`weft daemon status\` to check it.\n`);
  });
  daemon.command("status").description("Show whether the background Daemon is running").option("--json", "Print status as JSON").action(async (options: { json?: boolean }) => {
    const status = await daemonStatus({ env });
    const autostart = await autostartStatus({ env });
    if (options.json) { stdout(`${JSON.stringify({ ...status, autostart: autostart.enabled })}\n`); return; }
    const autostartLine = `Start at login: ${autostart.enabled ? "on" : "off"} (change it with \`weft daemon autostart\`).\n`;
    if (!status.running) {
      stdout(`Daemon is not running. Log file: ${status.logPath}. Run \`weft daemon start\` to start it.\n${autostartLine}`);
    } else {
      stdout(`Daemon is running as process ${status.pid} (up ${Math.floor(status.uptimeSeconds / 60)}m ${status.uptimeSeconds % 60}s).\nAgent CLIs: ${status.agentClis.length ? status.agentClis.join(", ") : "none detected"}.\nSigned in to: ${status.server}.\nLog file: ${status.logPath}.\n${autostartLine}Run \`weft daemon stop\` to stop it.\n`);
    }
    const notice = await checkForNewerCli({ fetch: doFetch, apiUrl: status.running ? status.server : (await readCliConfig(env)).apiUrl ?? env.WEFT_API_URL ?? "http://localhost:3000" });
    if (notice) stdout(`${notice}\n`);
  });
  daemon.command("logs").description("Show the last lines of the Daemon log, or follow it").option("-n, --lines <count>", "How many lines to show (default 50)", "50").option("-f, --follow", "Keep showing new lines until you press Ctrl+C").option("--json", "Print the last lines as JSON").action(async (options: { lines: string; follow?: boolean; json?: boolean }) => {
    const count = Number(options.lines);
    if (!Number.isInteger(count) || count < 1) throw new Error("--lines must be a whole number of 1 or more.");
    if (options.json && options.follow) throw new Error("--json cannot be combined with --follow. Use --json alone to read the last lines.");
    const logPath = daemonPaths(env).log;
    const lines = await readLogTail(logPath, count);
    if (options.json) { stdout(`${JSON.stringify({ path: logPath, lines: lines ?? [] })}\n`); return; }
    if (lines === undefined) { stdout(`No log yet at ${logPath}. Run \`weft daemon start\` to create it.\n`); if (!options.follow) return; }
    else stdout(lines.length ? `${lines.join("\n")}\n` : "The log is empty so far.\n");
    if (options.follow) await followLog(logPath, { write: stdout, signal: environment.signal });
  });
  daemon.command("probe").description("Show which agent CLIs a Run can use, and why not").option("--json", "Print the result as JSON").action(async (options: { json?: boolean }) => {
    const clis = await probeAgentClis({ env });
    if (options.json) { stdout(`${JSON.stringify({ clis })}\n`); return; }
    for (const cli of clis) stdout(cli.usable ? `${cli.name}: ready (${cli.version ?? "version unknown"}) at ${cli.path}\n` : `${cli.name}: not ready. ${cli.reason}\n`);
    stdout(clis.some((cli) => cli.usable) ? "A usable CLI is registered the next time the Daemon starts or re-checks its CLIs.\n" : "No agent CLI can run here yet, so no Runtime is offered.\n");
  });
  const autostart = daemon.command("autostart").description("Start the Daemon when you sign in (off by default)");
  autostart.command("enable").alias("on").description("Turn on autostart for this user: no administrator rights needed").action(async () => { stdout(`${await enableAutostart({ env, stdout, stderr })}\n`); });
  autostart.command("disable").alias("off").description("Turn off autostart and stop the autostart Daemon").action(async () => { stdout(`${await disableAutostart({ env, stdout, stderr })}\n`); });
  autostart.command("status").description("Show whether autostart is on").option("--json", "Print status as JSON").action(async (options: { json?: boolean }) => {
    const status = await autostartStatus({ env });
    if (options.json) { stdout(`${JSON.stringify(status)}\n`); return; }
    if (!status.file) { stdout("Autostart is not available on this computer yet. Start the Daemon yourself with `weft daemon start`.\n"); return; }
    stdout(status.enabled ? `Autostart is on: the Daemon starts when you sign in. Unit: ${status.file}.\n` : "Autostart is off: the Daemon does not start by itself. Turn it on with `weft daemon autostart enable`.\n");
  });

  async function request(path: string, token: string, apiUrl: string, body?: unknown) {
    const response = await doFetch(`${apiUrl.replace(/\/$/, "")}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "x-weft-source": "cli", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (response.status === 401) throw new Error(`401: ${(data as { error?: string } | null)?.error ?? "Unauthenticated"}. The token is missing, wrong or expired: run \`weft login\` again, or pass --token or set WEFT_TOKEN.`);
    if (!response.ok) throw new Error(`${response.status}: ${(data as { error?: string } | null)?.error ?? response.statusText}`);
    return data;
  }

  for (const action of createActionList({} as Database, { integrations: integrationsEnabled(env) })) {
    const schema = action.input as unknown as Schema;
    const properties = schema.properties ?? {};
    const command = program.command(kebab(action.name)).description(describeAction(action, `${action.kind} action ${action.name}`))
      .option("--input <json>", "Full input as JSON; options override its fields. Markdown options accept '-' to read stdin.");
    const orderedProperties = Object.entries(properties).sort(([a], [b]) => Number(b.endsWith("Markdown")) - Number(a.endsWith("Markdown")));
    for (const [name, property] of orderedProperties) {
      if (name === "workspaceId") continue; // filled from --workspace
      const option = new Option(`--${kebab(name)} <value>`, property.description ? `Input field ${name}: ${property.description}` : `Input field ${name}`);
      command.addOption(option);
    }
    const markdownField = orderedProperties.find(([name]) => name.endsWith("Markdown"))?.[0];
    if (markdownField) command.addHelpText("after", `\nExample: weft ${kebab(action.name)} --${kebab(markdownField)} '## Plan\n\n- First step'\nOr pass '-' to read Markdown from stdin.`);
    command.action(async (_options, self: Command) => {
      const options = self.optsWithGlobals() as Record<string, string | undefined>;
      const saved = await readCliConfig(env);
      const apiUrl = options.apiUrl ?? env.WEFT_API_URL ?? saved.apiUrl ?? "http://localhost:3000";
      const token = options.token ?? env.WEFT_TOKEN ?? saved.token;
      if (!token) throw new Error("No API token: pass --token or set WEFT_TOKEN");
      const input: Record<string, unknown> = options.input ? JSON.parse(options.input) : {};
      for (const [name, property] of orderedProperties) {
        if (name === "workspaceId") continue;
        const raw = options[name];
        if (raw !== undefined) {
          if (raw === "-" && name.endsWith("Markdown")) input[name] = await new Response(environment.stdin ?? Bun.stdin.stream()).text();
          else input[name] = parseValue(property, raw);
        }
      }
      if ("workspaceId" in properties) {
        const slug = options.workspace ?? env.WEFT_WORKSPACE;
        if (!slug) throw new Error("This command needs --workspace <slug> (or WEFT_WORKSPACE)");
        const me = await request("/api/me", token, apiUrl) as { workspaces: Array<{ id: string; slug: string }> };
        const workspace = me.workspaces.find((candidate) => candidate.slug === slug);
        if (!workspace) throw new Error(`Workspace "${slug}" not found for this token's owner`);
        input.workspaceId = workspace.id;
      }
      stdout(`${JSON.stringify(await request(`/actions/${action.name}`, token, apiUrl, input), null, 2)}\n`);
    });
  }
  return program;
}

export async function main(argv: string[], environment: CliEnvironment = {}) {
  const stderr = environment.stderr ?? ((text: string) => process.stderr.write(text));
  try {
    await buildProgram(environment).parseAsync(argv);
    return 0;
  } catch (error) {
    if (error instanceof Error && "exitCode" in error) return Number((error as { exitCode: number }).exitCode);
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
