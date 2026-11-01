import { and, eq } from "drizzle-orm";
import type { Elysia } from "elysia";
import { createSignalBus, resolveSignalScope, type ActionContext, type Signal, type SignalBus } from "@weft/actions";
import { workspaceMembers, type Database } from "@weft/db";

interface EventRoutesOptions {
  db: Database;
  resolveCaller: (request: Request) => Promise<ActionContext | null>;
  bus: SignalBus;
}

const encoder = new TextEncoder();
const HEARTBEAT_MS = Number(Bun.env.SSE_HEARTBEAT_MS ?? 25_000);

/** Lazily created so an app that never serves SSE opens no LISTEN connection. */
export function lazySignalBus(): SignalBus {
  let bus: SignalBus | null = null;
  const get = () => (bus ??= createSignalBus());
  return {
    publish: (signal) => get().publish(signal),
    subscribe: (listener) => get().subscribe(listener),
    ready: () => get().ready(),
    close: async () => { await bus?.close(); },
  };
}

/** Tells every API instance that a write Action changed data; a failure never fails the write. */
export async function publishChange(db: Database, bus: SignalBus, input: unknown, output: unknown) {
  try {
    const scope = await resolveSignalScope(db, input, output);
    if (scope) await bus.publish({ type: "change", ...scope });
  } catch (error) {
    console.error("Failed to publish change signal", error);
  }
}

/**
 * `GET /api/events`: Server-Sent Events carrying `notification` and `change` signals.
 * A signal holds ids only; the client refetches through Actions, which enforce permissions.
 */
export function registerEventRoutes(app: Elysia<any, any, any, any, any, any, any>, { db, resolveCaller, bus }: EventRoutesOptions): void {
  app.get("/api/events", async ({ request, set }) => {
    const caller = await resolveCaller(request);
    if (!caller) { set.status = 401; return { error: "Unauthenticated" }; }
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (text: string) => { try { controller.enqueue(encoder.encode(text)); } catch { cleanup(); } };
        const isMember = async (workspaceId: string) => {
          const [row] = await db.select({ id: workspaceMembers.userId }).from(workspaceMembers)
            .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, caller.userId))).limit(1);
          return Boolean(row);
        };
        const deliver = async (signal: Signal) => {
          if (signal.type === "notification" && signal.userId !== caller.userId) return;
          if (!(await isMember(signal.workspaceId))) return;
          send(`event: ${signal.type}\ndata: ${JSON.stringify({ workspaceId: signal.workspaceId })}\n\n`);
        };
        const off = bus.subscribe((signal) => { void deliver(signal).catch(() => {}); });
        const heartbeat = setInterval(() => send(": heartbeat\n\n"), HEARTBEAT_MS);
        cleanup = () => { off(); clearInterval(heartbeat); request.signal.removeEventListener("abort", onAbort); };
        const onAbort = () => { cleanup(); try { controller.close(); } catch {} };
        request.signal.addEventListener("abort", onAbort);
        send("retry: 3000\n\n: connected\n\n");
      },
      cancel() { cleanup(); },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
  });
}
