import { Elysia } from "elysia";
import { randomUUID } from "node:crypto";

/** A caller may pass its own request id (for example from a proxy); anything else is replaced, so a log line cannot be forged with stray characters. */
const acceptedRequestId = /^[A-Za-z0-9._-]{1,128}$/;
const started = new WeakMap<Request, { id: string; startedAt: number }>();

/** The path as it goes into logs. A published link carries its secret token in the path, so that segment is never written. */
export function loggedPath(url: string): string {
  return new URL(url).pathname.replace(/^\/published\/.+$/, "/published/:token");
}

/**
 * Adds the hooks to the app itself: one JSON line per API request, each with the request id that is also returned in the `x-request-id`
 * response header. Search the logs for that id to find every line of one request. Error lines carry the error name and code only, never
 * the message, because database errors can echo query parameters. The hooks do not work when passed in with `.use(plugin)` in this
 * Elysia version (mapResponse never runs), so call this on the root app, before its routes.
 */
export function withRequestLog<App extends Elysia>(app: App, write: (line: string) => void = (line) => console.log(line)): App {
  const emit = (entry: Record<string, unknown>) => write(JSON.stringify({ time: new Date().toISOString(), service: "api", ...entry }));
  return app
    .onRequest(({ request, set }) => {
      const passed = request.headers.get("x-request-id");
      const id = passed && acceptedRequestId.test(passed) ? passed : randomUUID();
      started.set(request, { id, startedAt: performance.now() });
      set.headers["x-request-id"] = id;
    })
    .onError(({ request, error, code }) => {
      const requestId = started.get(request)?.id;
      emit({ level: "error", requestId, method: request.method, path: loggedPath(request.url), errorName: error instanceof Error ? error.name : "unknown", code: String(code) });
    })
    // mapResponse runs for successful and failed responses alike and returns undefined, which leaves the response as it is.
    // (onAfterResponse does not fire for app.handle() in this Elysia version.)
    .mapResponse(({ request, set }) => {
      const entry = started.get(request);
      const status = typeof set.status === "number" ? set.status : 200;
      emit({
        level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
        requestId: entry?.id,
        method: request.method,
        path: loggedPath(request.url),
        status,
        durationMs: entry ? Math.round(performance.now() - entry.startedAt) : undefined,
      });
    }) as unknown as App;
}
