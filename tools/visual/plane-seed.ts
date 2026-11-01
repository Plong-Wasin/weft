// Seeds a local Plane with a small, deterministic data set so reference screenshots are comparable run to run.
import { PlaneClient } from "./plane-client";

export type PlaneSeed = { slug: string; projectId: string; projectIdentifier: string; cycleId?: string; moduleId?: string; viewId?: string; pageId?: string; issueId?: string; issueSequence?: number; inboxIssueId?: string };

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

export async function seedPlane(client: PlaneClient, slug = "weft-ui-reference"): Promise<PlaneSeed> {
  // A fresh account is sent to onboarding until its profile says otherwise.
  await client.json("/api/users/me/", "PATCH", { first_name: "Reference", last_name: "User" });
  await client.json("/api/users/me/profile/", "PATCH", { is_onboarded: true, onboarding_step: { profile_complete: true, workspace_create: true, workspace_invite: true, workspace_join: true }, theme: { theme: "light" } }).catch(() => client.json("/api/users/me/onboard/", "PATCH", { is_onboarded: true }));
  const workspaces: { slug: string }[] = await client.json("/api/users/me/workspaces/");
  if (!workspaces.some((w) => w.slug === slug)) {
    await client.json("/api/workspaces/", "POST", { name: "Weft reference", slug, organization_size: "1-10" });
  }
  const w = `/api/workspaces/${slug}`;
  const projects: any[] = await client.json(`${w}/projects/`).then((r) => (Array.isArray(r) ? r : r.results ?? []));
  let project = projects.find((p) => p.identifier === "REF");
  if (!project) {
    project = await client.json(`${w}/projects/`, "POST", { name: "Reference", identifier: "REF", network: 2, cycle_view: true, module_view: true, issue_views_view: true, page_view: true, inbox_view: true });
  }
  const p = `${w}/projects/${project.id}`;
  const seed: PlaneSeed = { slug, projectId: project.id, projectIdentifier: "REF" };

  const existing: any[] = await client.json(`${p}/issues/`).then((r) => (Array.isArray(r) ? r : r.results ?? []));
  if (existing.length === 0) {
    const states: any[] = await client.json(`${p}/states/`);
    const byGroup = (g: string) => states.find((s) => s.group === g)?.id;
    const labelNames = [["Bug", "#ef4444"], ["Feature", "#3b82f6"], ["Docs", "#22c55e"]] as const;
    const labels: string[] = [];
    for (const [name, color] of labelNames) labels.push((await client.json(`${p}/issue-labels/`, "POST", { name, color })).id);
    const me = await client.json("/api/users/me/");
    const items: [string, string, string, number, boolean][] = [
      ["Set up CI pipeline", "high", "started", 0, true],
      ["Fix login redirect", "urgent", "unstarted", 1, true],
      ["Write onboarding guide", "medium", "backlog", 2, false],
      ["Design settings page", "low", "started", 0, false],
      ["Upgrade dependencies", "none", "completed", 1, true],
      ["Add export button", "medium", "unstarted", 2, false],
    ];
    for (const [name, priority, group, label, assign] of items) {
      const issue = await client.json(`${p}/issues/`, "POST", { name, priority, state_id: byGroup(group), label_ids: [labels[label]], assignee_ids: assign ? [me.id] : [], start_date: day(-2), target_date: day(5) });
      seed.issueId ??= issue.id;
      seed.issueSequence ??= issue.sequence_id;
    }
  } else {
    seed.issueId = existing[0].id;
    seed.issueSequence = existing[0].sequence_id;
  }

  const list = async (path: string) => client.json(`${p}/${path}/`).then((r: any) => (Array.isArray(r) ? r : r.results ?? []));
  const optional = async <T>(fn: () => Promise<T>): Promise<T | undefined> => { try { return await fn(); } catch (e) { console.warn(`seed (optional) skipped: ${(e as Error).message.slice(0, 160)}`); } };

  const issueIds = (await list("issues")).map((i: any) => i.id as string);
  seed.cycleId = (await list("cycles"))[0]?.id ?? (await optional(() => client.json(`${p}/cycles/`, "POST", { name: "Sprint 1", start_date: day(-3), end_date: day(10), project_id: project.id })))?.id;
  if (seed.cycleId) await optional(() => client.json(`${p}/cycles/${seed.cycleId}/cycle-issues/`, "POST", { issues: issueIds.slice(0, 4) }));
  seed.moduleId = (await list("modules"))[0]?.id ?? (await optional(() => client.json(`${p}/modules/`, "POST", { name: "Authentication", status: "in-progress", project_id: project.id })))?.id;
  if (seed.moduleId) await optional(() => client.json(`${p}/modules/${seed.moduleId}/issues/`, "POST", { issues: issueIds.slice(0, 3) }));
  seed.viewId = (await list("views"))[0]?.id ?? (await optional(() => client.json(`${p}/views/`, "POST", { name: "High priority", access: 1, filters: { priority: ["urgent", "high"] }, display_filters: { layout: "list", group_by: "state" }, display_properties: {} })))?.id;
  seed.pageId = (await list("pages"))[0]?.id ?? (await optional(() => client.json(`${p}/pages/`, "POST", { name: "Getting started", access: 0, description_html: "<p>Welcome to the reference project.</p>" })))?.id;
  await optional(() => client.json(`${w}/projects/${project.id}/`, "PATCH", { intake_view: true, inbox_view: true }));
  const inbox = (await optional(() => list("intake-issues")))?.[0] ?? (await optional(() => client.json(`${p}/intake-issues/`, "POST", { issue: { name: "Customer asks for dark mode", priority: "medium" } })));
  seed.inboxIssueId = inbox?.issue?.id ?? inbox?.issue_detail?.id ?? inbox?.issue;
  return seed;
}
