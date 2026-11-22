import { Type } from "@sinclair/typebox";
import { and, eq } from "drizzle-orm";
import type { Database } from "@weft/db";
import { agents, runtimes } from "@weft/db";
import { ActionError } from "./members";
import { openSecret, sealSecret } from "./integration-secrets";

const uuid = () => Type.String({ format: "uuid" });
const variablesSchema = Type.Record(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$", maxLength: 100 }), Type.String({ maxLength: 8192, pattern: "^[^\\r\\n]*$" }), { maxProperties: 50 });
type Context = { userId: string };
const reserved = (key: string) => key.startsWith("WEFT_") || ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "GIT_ASKPASS", "SSH_AUTH_SOCK"].includes(key);

/** Runtime owner controls for per-Agent environment; only encrypted values are persisted. */
export function createAgentRuntimeEnvironmentActions(db: Database) {
  async function ownedAgent(userId: string, agentId: string) {
    const [row] = await db.select({ id: agents.id, runtimeId: agents.runtimeId, runtimeEnvironment: agents.runtimeEnvironment }).from(agents).where(eq(agents.id, agentId));
    const [runtime] = row?.runtimeId ? await db.select({ id: runtimes.id, ownerId: runtimes.ownerId }).from(runtimes).where(eq(runtimes.id, row.runtimeId)) : [];
    if (!row || !runtime || runtime.ownerId !== userId) throw new ActionError("Only the Runtime owner can manage this Agent's environment", 403);
    return row;
  }
  return {
    getAgentRuntimeEnvironment: {
      name: "get_agent_runtime_environment", kind: "read" as const,
      input: Type.Object({ agentId: uuid() }), output: Type.Object({ variables: Type.Array(Type.String()) }),
      handler: async (context: Context, input: { agentId: string }) => {
        const row = await ownedAgent(context.userId, input.agentId);
        if (!row.runtimeEnvironment) return { variables: [] };
        return { variables: Object.keys(JSON.parse(openSecret(row.runtimeEnvironment))).sort() };
      },
    },
    setAgentRuntimeEnvironment: {
      name: "set_agent_runtime_environment", kind: "write" as const,
      input: Type.Object({ agentId: uuid(), variables: variablesSchema }), output: Type.Object({ saved: Type.Boolean(), variables: Type.Array(Type.String()) }),
      handler: async (context: Context, input: { agentId: string; variables: Record<string, string> }) => {
        const row = await ownedAgent(context.userId, input.agentId);
        if (Object.entries(input.variables).some(([key]) => reserved(key))) throw new ActionError("That environment variable is reserved by the Runtime platform", 400);
        const encoded = JSON.stringify(input.variables);
        if (Buffer.byteLength(encoded) > 32_000) throw new ActionError("Environment settings are too large", 400);
        const updated = await db.update(agents).set({ runtimeEnvironment: Object.keys(input.variables).length ? sealSecret(encoded) : null })
          .where(and(eq(agents.id, row.id), eq(agents.runtimeId, row.runtimeId!))).returning({ id: agents.id });
        if (!updated.length) throw new ActionError("The Agent's Runtime changed; reload before saving its environment", 409);
        return { saved: true, variables: Object.keys(input.variables).sort() };
      },
    },
  };
}
