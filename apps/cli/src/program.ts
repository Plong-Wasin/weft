import { Command, Option } from "commander";
import { createActionList, describeAction } from "@weft/actions";
import type { Database } from "@weft/db";
import { daemonStatus, login, readCliConfig, startDaemon, startDaemonBackground, stopDaemon } from "./daemon";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CliEnvironment {
  fetch?: FetchLike;
  env?: Record<string, string | undefined>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  stdin?: ReadableStream<Uint8Array>;
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

  program.command("login").description("Sign in through your browser and save a Daemon token").action(async () => login({ env, fetch: doFetch, stdout, stderr }));
  const daemon = program.command("daemon").description("Manage the local Daemon");
  daemon.command("start").description("Start the Daemon in the background").option("--foreground", "Keep the Daemon attached to this terminal for debugging").action(async (options: { foreground?: boolean }) => {
    const runtime = { env, fetch: doFetch, stdout, stderr };
    if (options.foreground) await startDaemon(runtime); else await startDaemonBackground(runtime);
  });
  daemon.command("stop").description("Stop the background Daemon and its active Runs").action(async () => { await stopDaemon({ env, stdout, stderr }); });
  daemon.command("status").description("Show whether the background Daemon is running").option("--json", "Print status as JSON").action(async (options: { json?: boolean }) => {
    const status = await daemonStatus({ env });
    if (options.json) { stdout(`${JSON.stringify(status)}\n`); return; }
    if (!status.running) { stdout(`Daemon is not running. Log file: ${status.logPath}. Run \`weft daemon start\` to start it.\n`); return; }
    stdout(`Daemon is running as process ${status.pid} (up ${Math.floor(status.uptimeSeconds / 60)}m ${status.uptimeSeconds % 60}s).\nAgent CLIs: ${status.agentClis.length ? status.agentClis.join(", ") : "none detected"}.\nSigned in to: ${status.server}.\nLog file: ${status.logPath}.\nRun \`weft daemon stop\` to stop it.\n`);
  });

  async function request(path: string, token: string, apiUrl: string, body?: unknown) {
    const response = await doFetch(`${apiUrl.replace(/\/$/, "")}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "x-weft-source": "cli", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(`${response.status}: ${(data as { error?: string } | null)?.error ?? response.statusText}`);
    return data;
  }

  for (const action of createActionList({} as Database)) {
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
