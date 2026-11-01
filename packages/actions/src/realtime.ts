import { eq, sql } from "drizzle-orm";
import { createListener, workItems, projects, type Database } from "@weft/db";

/** Postgres channel that carries change signals between API instances and the worker. */
export const SIGNAL_CHANNEL = "weft_signals";

/** A signal says only what to refetch. It never carries titles, bodies, or other data. */
export type Signal =
  | { type: "notification"; workspaceId: string; userId: string }
  | { type: "change"; workspaceId: string; projectId?: string };

export function parseSignal(raw: string): Signal | null {
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw); } catch { return null; }
  if (typeof value !== "object" || value === null || typeof value.workspaceId !== "string") return null;
  if (value.type === "notification" && typeof value.userId === "string") return { type: "notification", workspaceId: value.workspaceId, userId: value.userId };
  if (value.type === "change") return typeof value.projectId === "string" ? { type: "change", workspaceId: value.workspaceId, projectId: value.projectId } : { type: "change", workspaceId: value.workspaceId };
  return null;
}

/** NOTIFY through the given database handle; inside a transaction it is delivered on commit. */
export async function publishSignal(database: Database, signal: Signal) {
  await database.execute(sql`select pg_notify(${SIGNAL_CHANNEL}, ${JSON.stringify(signal)})`);
}

export interface SignalBus {
  publish(signal: Signal): Promise<void>;
  subscribe(listener: (signal: Signal) => void): () => void;
  /** Resolves once LISTEN is active. */
  ready(): Promise<void>;
  close(): Promise<void>;
}

/** Signal bus over Postgres LISTEN/NOTIFY. LISTEN starts on the first subscriber, so an unused bus holds no extra connection work. */
export function createSignalBus(url?: string): SignalBus {
  const connection = createListener(url);
  const listeners = new Set<(signal: Signal) => void>();
  let listening: Promise<unknown> | null = null;
  const start = () => (listening ??= connection.listen(SIGNAL_CHANNEL, (payload) => {
    const signal = parseSignal(payload);
    if (signal) for (const listener of listeners) listener(signal);
  }));
  return {
    publish: async (signal) => { await connection.notify(SIGNAL_CHANNEL, JSON.stringify(signal)); },
    subscribe(listener) { listeners.add(listener); void start(); return () => { listeners.delete(listener); }; },
    ready: async () => { await listening; },
    close: async () => { await connection.close(); },
  };
}

/** Finds the workspace (and project) a write Action touched, from its input and output ids. */
export async function resolveSignalScope(database: Database, input: unknown, output: unknown): Promise<{ workspaceId: string; projectId?: string } | null> {
  const pick = (key: string) => {
    for (const source of [input, output]) {
      const value = (source as Record<string, unknown> | null | undefined)?.[key];
      if (typeof value === "string") return value;
    }
    return undefined;
  };
  let workspaceId = pick("workspaceId");
  let projectId = pick("projectId");
  const workItemId = pick("workItemId") ?? ((output as { projectId?: unknown } | null)?.projectId ? undefined : pick("id"));
  if (!projectId && workItemId && !workspaceId) {
    const [item] = await database.select({ projectId: workItems.projectId, workspaceId: workItems.workspaceId }).from(workItems).where(eq(workItems.id, workItemId)).limit(1).catch(() => []);
    if (item) { projectId = item.projectId; workspaceId = item.workspaceId; }
  }
  if (projectId && !workspaceId) {
    const [project] = await database.select({ workspaceId: projects.workspaceId }).from(projects).where(eq(projects.id, projectId)).limit(1).catch(() => []);
    workspaceId = project?.workspaceId;
  }
  if (!workspaceId) return null;
  return projectId ? { workspaceId, projectId } : { workspaceId };
}
