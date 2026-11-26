import { afterEach, expect, test } from "bun:test";
import { fetchTargets } from "../src/ai-targets";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Body = { workspaceId: string; refs: Array<{ kind: string; id: string }>; displayIds: string[] };

/** Answers every asked reference, and refuses a request over the Action's limit of 200, as the API does. */
function serve(): Body[] {
  const bodies: Body[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body;
    bodies.push(body);
    if (body.refs.length > 200 || body.displayIds.length > 200) return new Response("{}", { status: 422 });
    return Response.json([...body.refs.map((ref) => ({ ref: ref.id })), ...body.displayIds.map((ref) => ({ ref }))]);
  }) as unknown as typeof fetch;
  return bodies;
}

const refs = Array.from({ length: 450 }, (_, index) => ({ kind: "work_item" as const, id: `id-${index}` }));
const displayIds = Array.from({ length: 201 }, (_, index) => `MOB-${index}`);

test("every reference past 200 is still resolved, in batches the Action accepts", async () => {
  const bodies = serve();
  const found = await fetchTargets("w", refs, displayIds);
  expect(found.map((target) => target.ref)).toEqual(expect.arrayContaining([...refs.map((ref) => ref.id), ...displayIds]));
  expect(found).toHaveLength(651);
  expect(bodies).toHaveLength(3);
});

test("one failed batch fails the whole resolve, so no row is shown as Not available by mistake", async () => {
  let calls = 0;
  globalThis.fetch = (async () => ++calls === 2 ? new Response("{}", { status: 500 }) : Response.json([])) as unknown as typeof fetch;
  await expect(fetchTargets("w", refs, [])).rejects.toThrow("resolve_targets failed");
});
