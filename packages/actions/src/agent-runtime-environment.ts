import { Type } from "@sinclair/typebox";
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "@weft/db";
import { agents, runtimes } from "@weft/db";
import { ActionError, requireWorkspaceRole } from "./members";
import { openSecret, sealSecret } from "./integration-secrets";

const uuid = () => Type.String({ format: "uuid" });
const variablesSchema = Type.Record(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$", maxLength: 100 }), Type.String({ maxLength: 8192, pattern: "^[^\\r\\n]*$" }), { maxProperties: 50 });
const classificationsSchema = Type.Record(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$", maxLength: 100 }), Type.Union([Type.Literal("secret"), Type.Literal("non-secret")]), { maxProperties: 50 });
type Context = { userId: string };
type Entry = { value: string; classification: "secret" | "non-secret" };
type Stored = { format: "weft-runtime-environment-v2"; variables: Record<string, Entry> };
const reserved = (key: string) => key.startsWith("WEFT_") || ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "GIT_ASKPASS", "SSH_AUTH_SOCK"].includes(key);

/** Old encrypted maps remain readable and are interpreted as secret until explicitly classified. */
export function readRuntimeEnvironment(sealed: string): Record<string, Entry> {
  const decoded = JSON.parse(openSecret(sealed)) as Record<string, string> | Stored;
  if ((decoded as Stored).format === "weft-runtime-environment-v2") return (decoded as Stored).variables;
  return Object.fromEntries(Object.entries(decoded).map(([name, value]) => [name, { value: value as string, classification: "secret" as const }]));
}
export function runtimeEnvironmentValues(sealed: string): Record<string, string> {
  return Object.fromEntries(Object.entries(readRuntimeEnvironment(sealed)).map(([name, entry]) => [name, entry.value]));
}
export function runtimeEnvironmentSecretValues(sealed: string): Record<string, string> {
  return Object.fromEntries(Object.entries(readRuntimeEnvironment(sealed)).filter(([, entry]) => entry.classification === "secret").map(([name, entry]) => [name, entry.value]));
}
function sealEntries(variables: Record<string, Entry>) { return Object.keys(variables).length ? sealSecret(JSON.stringify({ format: "weft-runtime-environment-v2", variables } satisfies Stored)) : null; }

/** Runtime owner controls for per-Agent environment; only encrypted values are persisted. */
export function createAgentRuntimeEnvironmentActions(db: Database) {
  async function ownedAgent(userId: string, agentId: string) {
    const [row] = await db.select({ id: agents.id, runtimeId: agents.runtimeId, workspaceId: agents.workspaceId, runtimeEnvironment: agents.runtimeEnvironment }).from(agents).where(eq(agents.id, agentId));
    const [runtime] = row?.runtimeId ? await db.select({ id: runtimes.id, ownerId: runtimes.ownerId }).from(runtimes).where(eq(runtimes.id, row.runtimeId)) : [];
    if (!row || !runtime || runtime.ownerId !== userId) throw new ActionError("Only the Runtime owner can manage this Agent's environment", 403);
    const role = await requireWorkspaceRole(db, userId, row.workspaceId, "read");
    if (role === "Guest") throw new ActionError("Guests cannot manage Agent settings", 403);
    return row;
  }
  const summaries = (entries: Record<string, Entry>) => Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) => ({ name, classification: entry.classification }));
  const names = (entries: Record<string, Entry>) => Object.keys(entries).sort();
  const classificationOutput = Type.Array(Type.Object({ name: Type.String(), classification: Type.Union([Type.Literal("secret"), Type.Literal("non-secret")]) }));
  return {
    getAgentRuntimeEnvironment: {
      name: "get_agent_runtime_environment", kind: "read" as const,
      input: Type.Object({ agentId: uuid() }), output: Type.Object({ variables: Type.Array(Type.String()) }),
      handler: async (context: Context, input: { agentId: string }) => {
        const row = await ownedAgent(context.userId, input.agentId);
        return { variables: row.runtimeEnvironment ? names(readRuntimeEnvironment(row.runtimeEnvironment)) : [] };
      },
    },
    getAgentRuntimeEnvironmentClassifications: {
      name: "get_agent_runtime_environment_classifications", kind: "read" as const,
      input: Type.Object({ agentId: uuid() }), output: Type.Object({ variables: classificationOutput }),
      handler: async (context: Context, input: { agentId: string }) => {
        const row = await ownedAgent(context.userId, input.agentId);
        return { variables: row.runtimeEnvironment ? summaries(readRuntimeEnvironment(row.runtimeEnvironment)) : [] };
      },
    },
    setAgentRuntimeEnvironment: {
      name: "set_agent_runtime_environment", kind: "write" as const,
      input: Type.Object({ agentId: uuid(), variables: variablesSchema }), output: Type.Object({ saved: Type.Boolean(), variables: Type.Array(Type.String()) }),
      handler: async (context: Context, input: { agentId: string; variables: Record<string, string> }) => {
        const row = await ownedAgent(context.userId, input.agentId);
        if (Object.entries(input.variables).some(([key]) => reserved(key))) throw new ActionError("That environment variable is reserved by the Runtime platform", 400);
        const entries = Object.fromEntries(Object.entries(input.variables).map(([name, value]) => [name, { value, classification: "secret" as const }]));
        if (Buffer.byteLength(JSON.stringify(entries)) > 32_000) throw new ActionError("Environment settings are too large", 400);
        const updated = await db.update(agents).set({ runtimeEnvironment: sealEntries(entries) })
          .where(and(eq(agents.id, row.id), eq(agents.runtimeId, row.runtimeId!), row.runtimeEnvironment === null ? isNull(agents.runtimeEnvironment) : eq(agents.runtimeEnvironment, row.runtimeEnvironment))).returning({ id: agents.id });
        if (!updated.length) throw new ActionError("The Agent's Runtime changed; reload before saving its environment", 409);
        return { saved: true, variables: names(entries) };
      },
    },
    classifyAgentRuntimeEnvironment: {
      name: "classify_agent_runtime_environment", kind: "write" as const,
      input: Type.Object({ agentId: uuid(), classifications: classificationsSchema }), output: Type.Object({ saved: Type.Boolean(), variables: classificationOutput }),
      handler: async (context: Context, input: { agentId: string; classifications: Record<string, "secret" | "non-secret"> }) => {
        const row = await ownedAgent(context.userId, input.agentId);
        const entries = row.runtimeEnvironment ? readRuntimeEnvironment(row.runtimeEnvironment) : {};
        for (const [name, classification] of Object.entries(input.classifications)) {
          if (!entries[name]) throw new ActionError("The environment variable no longer exists; reload before classifying it", 409);
          entries[name] = { ...entries[name]!, classification };
        }
        const updated = await db.update(agents).set({ runtimeEnvironment: sealEntries(entries) })
          .where(and(eq(agents.id, row.id), eq(agents.runtimeId, row.runtimeId!), row.runtimeEnvironment === null ? isNull(agents.runtimeEnvironment) : eq(agents.runtimeEnvironment, row.runtimeEnvironment))).returning({ id: agents.id });
        if (!updated.length) throw new ActionError("The Agent's Runtime or environment changed; reload before saving its environment", 409);
        return { saved: true, variables: summaries(entries) };
      },
    },
  };
}
