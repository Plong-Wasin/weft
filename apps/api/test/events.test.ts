import { afterAll, expect, test } from "bun:test";
import { createDatabase, type Database } from "@weft/db";
import { type Signal, type SignalBus } from "@weft/actions";
import { withRollback } from "../../../packages/db/src/test-helpers";
import { createApp } from "../src/app";

const { client, db } = createDatabase();
afterAll(async () => client.end());

/** In-memory bus: the transaction-scoped test database cannot deliver NOTIFY. */
function memoryBus(): SignalBus & { published: Signal[] } {
  const listeners = new Set<(signal: Signal) => void>();
  const published: Signal[] = [];
  return {
    published,
    async publish(signal) { published.push(signal); for (const listener of listeners) listener(signal); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async ready() {}, async close() {},
  };
}

async function readEvents(response: Response, count: number, waitMs = 3_000) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const events: string[] = [];
  const deadline = Date.now() + waitMs;
  while (events.length < count && Date.now() < deadline) {
    const { value, done } = await Promise.race([reader.read(), Bun.sleep(200).then(() => ({ value: undefined, done: false }))]);
    if (done) break;
    if (value) text += decoder.decode(value);
    for (const block of text.split("\n\n").slice(0, -1)) if (block.includes("data:") && !events.includes(block)) events.push(block);
  }
  await reader.cancel();
  const field = (block: string, name: string) => block.split("\n").find((line) => line.startsWith(`${name}:`))!.slice(name.length + 1).trim();
  return events.map((block) => ({ type: field(block, "event"), ...JSON.parse(field(block, "data")) as { workspaceId: string } }));
}

async function boot(transaction: Database) {
  const bus = memoryBus();
  const app = createApp(undefined, transaction, undefined, undefined, bus);
  const post = (path: string, body: unknown, cookie?: string) => app.handle(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  }));
  const signUp = async () => {
    const response = await post("/api/auth/sign-up/email", { name: "U", email: `${crypto.randomUUID()}@example.test`, password: "a-secure-password" });
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const me = await (await app.handle(new Request("http://localhost/api/me", { headers: { cookie } }))).json() as { user: { id: string } };
    return { cookie, id: me.user.id };
  };
  return { app, bus, post, signUp };
}

test.concurrent("GET /api/events requires a session", async () => {
  await withRollback(db, async (transaction) => {
    const { app } = await boot(transaction);
    expect((await app.handle(new Request("http://localhost/api/events"))).status).toBe(401);
  });
});

test.concurrent("a write Action publishes a change signal with ids only, and members of that workspace receive it", async () => {
  await withRollback(db, async (transaction) => {
    const { app, bus, post, signUp } = await boot(transaction);
    const owner = await signUp();
    const outsider = await signUp();
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `t-${crypto.randomUUID()}` }, owner.cookie)).json() as { id: string };
    const stream = await app.handle(new Request("http://localhost/api/events", { headers: { cookie: owner.cookie } }));
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const outsiderStream = await app.handle(new Request("http://localhost/api/events", { headers: { cookie: outsider.cookie } }));
    await post("/actions/create_wiki_page", { workspaceId: workspace.id, title: "Secret title" }, owner.cookie);
    const [event] = await readEvents(stream, 1);
    expect(event).toEqual({ type: "change", workspaceId: workspace.id });
    // The outsider's stream stays silent: a notification for the owner is not theirs either.
    await bus.publish({ type: "notification", workspaceId: workspace.id, userId: owner.id });
    const heard = await readEvents(outsiderStream, 1, 600);
    expect(heard).toEqual([]);
  });
});

test.concurrent("a read Action publishes nothing; a notification signal reaches only its user", async () => {
  await withRollback(db, async (transaction) => {
    const { app, bus, post, signUp } = await boot(transaction);
    const owner = await signUp();
    const workspace = await (await post("/actions/create_workspace", { name: "Team", slug: `t-${crypto.randomUUID()}` }, owner.cookie)).json() as { id: string };
    bus.published.length = 0;
    await post("/actions/list_wiki_pages", { workspaceId: workspace.id }, owner.cookie);
    expect(bus.published).toEqual([]);
    const stream = await app.handle(new Request("http://localhost/api/events", { headers: { cookie: owner.cookie } }));
    await bus.publish({ type: "notification", workspaceId: workspace.id, userId: crypto.randomUUID() });
    await bus.publish({ type: "notification", workspaceId: workspace.id, userId: owner.id });
    const events = await readEvents(stream, 1);
    expect(events).toEqual([{ type: "notification", workspaceId: workspace.id }]);
  });
});
