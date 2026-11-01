// Seeds a running Weft API (sign-up plus a few Actions) so screenshots have content. Uses only the public HTTP surface.
export class WeftClient {
  private cookie = "";
  constructor(readonly api: string, readonly web: string) {}

  private async send(path: string, body: unknown) {
    const res = await fetch(`${this.api}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: this.web, cookie: this.cookie }, body: JSON.stringify(body) });
    const jar = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    if (jar) this.cookie = jar;
    return res;
  }

  async signUp(name: string, email: string, password: string) {
    const res = await this.send("/api/auth/sign-up/email", { name, email, password });
    if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  }

  async action<T = any>(name: string, input: unknown): Promise<T> {
    const res = await this.send(`/actions/${name}`, input);
    if (!res.ok) throw new Error(`${name} failed: ${res.status} ${(await res.text()).replace(/\s+/g, " ").slice(0, 400)}`);
    return res.json() as Promise<T>;
  }

  /** The session cookies, for handing to a browser context. */
  cookies() {
    return this.cookie.split("; ").filter(Boolean).map((pair) => { const i = pair.indexOf("="); return { name: pair.slice(0, i), value: pair.slice(i + 1) }; });
  }
}

export type WeftSeed = { slug: string; key: string; workItem: string; cycleId?: string; moduleId?: string; viewId?: string; wikiPageId?: string; workItemId?: string };

export async function seedWeft(client: WeftClient, slug: string): Promise<WeftSeed> {
  await client.signUp("Reference User", `${slug}@example.test`, "a-secure-password");
  const workspace = await client.action("create_workspace", { name: "Weft reference", slug });
  const project = await client.action("create_project", { workspaceId: workspace.id, name: "Reference", key: "REF", visibility: "public" });
  const states = await client.action<any[]>("list_states", { projectId: project.id });
  const stateFor = (n: number) => states[Math.min(n, states.length - 1)].id;
  const titles = ["Set up CI pipeline", "Fix login redirect", "Write onboarding guide", "Design settings page", "Upgrade dependencies", "Add export button"];
  const items: any[] = [];
  for (const [i, title] of titles.entries()) items.push(await client.action("create_work_item", { projectId: project.id, title, stateId: stateFor(i % 3), priority: (["high", "urgent", "medium", "low", "none", "medium"] as const)[i] }));
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const seed: WeftSeed = { slug, key: "REF", workItem: items[0].displayId ?? `REF-${items[0].sequence ?? 1}`, workItemId: items[0].id };
  const best = async <T>(fn: () => Promise<T>) => { try { return await fn(); } catch (e) { console.warn(`weft seed (optional) skipped: ${(e as Error).message.slice(0, 160)}`); } };
  const cycle = await best(() => client.action("create_cycle", { projectId: project.id, name: "Sprint 1", startDate: day(-3), endDate: day(10) }));
  seed.cycleId = cycle?.id;
  if (cycle) await best(() => client.action("add_cycle_items", { cycleId: cycle.id, workItemIds: items.slice(0, 4).map((i) => i.id) }));
  const module = await best(() => client.action("create_module", { projectId: project.id, name: "Authentication" }));
  seed.moduleId = module?.id;
  const view = await best(() => client.action("create_view", { projectId: project.id, name: "High priority", query: "priority = high", layout: "list" }));
  seed.viewId = view?.id;
  await best(() => client.action("submit_intake_item", { projectId: project.id, title: "Customer asks for CSV export", priority: "medium" }));
  const page = await best(() => client.action("create_wiki_page", { workspaceId: workspace.id, title: "Getting started" }));
  seed.wikiPageId = page?.id;
  if (page) await best(() => client.action("link_wiki_page_to_project", { pageId: page.id, projectId: project.id }));
  return seed;
}
