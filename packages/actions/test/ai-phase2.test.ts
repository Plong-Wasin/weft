import { afterAll, expect, test } from "bun:test";
import { createViewActions } from "../src/views";
import { eq } from "drizzle-orm";
import { createDatabase, cycles, intakeItems } from "@weft/db";
import {
  actionNotes, aiWriteActions, createActionList, createAiTools, createChatStore, createConfirmationStore, createCycleActions, createIntakeActions, createProjectActions, createWorkItemActions, pqlSyntaxHelp,
} from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";
import type { Database } from "@weft/db";

const { client, db } = createDatabase();
afterAll(async () => client.end());

/** Every Action added in phase 2 (tickets 01 to 09), by name. */
const phase2Actions = [
  "create_cycle", "update_cycle", "list_cycles", "get_cycle", "check_cycle_dates", "add_cycle_items", "remove_cycle_items", "transfer_cycle_items", "archive_cycle", "delete_cycle",
  "create_module", "update_module", "list_modules", "get_module", "add_module_items", "remove_module_items", "archive_module", "unarchive_module", "delete_module",
  "submit_intake_item", "list_intake_items", "update_intake_item", "accept_intake_item", "reject_intake_item", "snooze_intake_item", "duplicate_intake_item",
  "list_work_item_relations", "create_work_item_relation", "remove_work_item_relation",
  "create_comment", "list_comments", "list_comment_versions", "list_timeline", "set_project_features",
];
/** Hidden on purpose (ticket 07): only the author and workspace Admins may read earlier comment versions. */
const hiddenPhase2 = ["list_comment_versions"];

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const admin = await createMemberFactory(transaction, workspace.id, "Admin");
  const guest = await createMemberFactory(transaction, workspace.id, "Guest");
  const project = await createProjectActions(transaction).createProject.handler({ userId: admin.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" });
  const chat = (await createChatStore(transaction).upsertChat({ id: crypto.randomUUID(), workspaceId: workspace.id, userId: admin.id, title: "t" }))!;
  const toolsFor = (userId: string) => createAiTools(transaction, { userId, workspaceId: workspace.id, chatId: chat.id });
  return { workspace, admin, guest, project, chat, toolsFor };
}

test("every phase 2 Action is registered, and every one except list_comment_versions is an AI tool", () => {
  const registered = createActionList(db).map((action) => action.name);
  for (const name of phase2Actions) expect(registered).toContain(name);
  const tools = createAiTools(db, { userId: "u", workspaceId: crypto.randomUUID(), chatId: crypto.randomUUID() }).map((tool) => tool.name);
  for (const name of phase2Actions) expect(tools.includes(name)).toBe(!hiddenPhase2.includes(name));
});

test("every Write Action among the phase 2 ones is on the AI write list, so it needs a Confirmation card", () => {
  const actions = createActionList(db).filter((action) => phase2Actions.includes(action.name));
  for (const action of actions.filter((entry) => entry.kind === "write")) expect(aiWriteActions as readonly string[]).toContain(action.name);
  for (const action of actions.filter((entry) => entry.kind === "read")) expect(aiWriteActions as readonly string[]).not.toContain(action.name);
});

test.concurrent("every AI tool for a phase 2 Write Action only proposes: nothing runs without confirm", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const tools = s.toolsFor(s.admin.id);
    const writes = createActionList(transaction).filter((action) => phase2Actions.includes(action.name) && action.kind === "write");
    for (const action of writes) {
      const tool = tools.find((entry) => entry.name === action.name)!;
      expect(tool.description).toContain("Confirmation card");
      // An invalid input never reaches the action either.
      const result = JSON.parse(await tool.execute({})) as { status?: string; error?: string };
      expect(result.status === "awaiting_user_confirmation" ? "proposed" : "refused").not.toBe("proposed");
    }
    const created = JSON.parse(await tools.find((entry) => entry.name === "create_cycle")!.execute({ projectId: s.project.id, name: "Sprint 1", startDate: "2030-01-01", endDate: "2030-01-14" })) as { status: string; confirmationId: string };
    expect(created.status).toBe("awaiting_user_confirmation");
    expect(await transaction.select().from(cycles).where(eq(cycles.projectId, s.project.id))).toHaveLength(0);
    const store = createConfirmationStore(transaction);
    expect((await store.confirm(s.admin.id, created.confirmationId)).status).toBe("confirmed");
    expect(await transaction.select().from(cycles).where(eq(cycles.projectId, s.project.id))).toHaveLength(1);
  });
});

test.concurrent("an Intake decision is only proposed by the AI; confirming it runs it as the user with source ai", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const submitted = await createIntakeActions(transaction).submitIntakeItem.handler({ userId: s.guest.id }, { projectId: s.project.id, title: "Add SSO" });
    const tools = s.toolsFor(s.admin.id);
    const proposal = JSON.parse(await tools.find((entry) => entry.name === "accept_intake_item")!.execute({ intakeItemId: submitted.id })) as { status: string; confirmationId: string };
    expect(proposal.status).toBe("awaiting_user_confirmation");
    expect((await transaction.select().from(intakeItems).where(eq(intakeItems.id, submitted.id)))[0]!.outcome).toBe("pending");
    // The item's own project check runs at confirm: a Guest cannot decide even by confirming a card.
    const guestTools = s.toolsFor(s.guest.id);
    const refused = JSON.parse(await guestTools.find((entry) => entry.name === "accept_intake_item")!.execute({ intakeItemId: submitted.id })) as { error?: string; status: number | string };
    expect(refused.error).toBeTruthy();
    expect((await createConfirmationStore(transaction).confirm(s.admin.id, proposal.confirmationId)).status).toBe("confirmed");
    expect((await transaction.select().from(intakeItems).where(eq(intakeItems.id, submitted.id)))[0]!.outcome).toBe("accepted");
  });
});

test.concurrent("a Guest may propose submitting to Intake but not a Cycle; a card cannot target another workspace's Cycle", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const guestTools = s.toolsFor(s.guest.id);
    const submit = JSON.parse(await guestTools.find((entry) => entry.name === "submit_intake_item")!.execute({ projectId: s.project.id, title: "Please" })) as { status: string };
    expect(submit.status).toBe("awaiting_user_confirmation");
    const cycle = JSON.parse(await guestTools.find((entry) => entry.name === "create_cycle")!.execute({ projectId: s.project.id, name: "X", startDate: "2030-01-01", endDate: "2030-01-02" })) as { error?: string };
    expect(cycle.error).toBeTruthy();

    const other = await setup(transaction);
    const foreignCycle = await createCycleActions(transaction).createCycle.handler({ userId: other.admin.id }, { projectId: other.project.id, name: "Theirs", startDate: "2030-01-01", endDate: "2030-01-14" });
    const foreign = JSON.parse(await s.toolsFor(s.admin.id).find((entry) => entry.name === "delete_cycle")!.execute({ cycleId: foreignCycle.id })) as { error?: string; status?: number };
    expect(foreign.error).toBeTruthy();
    expect(foreign.status).toBe(404);

    // A View of another workspace cannot be targeted either, even by a user who is a Member there.
    const foreignView = await createViewActions(transaction).createView.handler({ userId: other.admin.id }, { projectId: other.project.id, name: "Theirs" });
    const foreignDelete = JSON.parse(await s.toolsFor(s.admin.id).find((entry) => entry.name === "delete_view")!.execute({ viewId: foreignView.id })) as { error?: string; status?: number };
    expect(foreignDelete.error).toBeTruthy();
    expect(foreignDelete.status).toBe(404);

    // Extra id keys cannot smuggle a foreign target past the guard: every target id must be in the chat's workspace.
    const ownCycle = await createCycleActions(transaction).createCycle.handler({ userId: s.admin.id }, { projectId: s.project.id, name: "Mine", startDate: "2030-02-01", endDate: "2030-02-14" });
    const smuggled = JSON.parse(await s.toolsFor(s.admin.id).find((entry) => entry.name === "create_cycle")!.execute({ projectId: other.project.id, name: "X", startDate: "2030-03-01", endDate: "2030-03-02", cycleId: ownCycle.id })) as { error?: string; status?: number };
    expect(smuggled.error).toBeTruthy();
    expect(smuggled.status).toBe(404);
  });
});

test("list_work_items and search_work_items descriptions separate query from pql and carry the syntax with cycle, module, and activeCycle() examples", () => {
  const tools = createAiTools(db, { userId: "u", workspaceId: crypto.randomUUID(), chatId: crypto.randomUUID() });
  const list = tools.find((tool) => tool.name === "list_work_items")!;
  const search = tools.find((tool) => tool.name === "search_work_items")!;
  expect(list.description).toContain("PQL");
  expect(list.description).toContain("`query`");
  expect(search.description).toContain("free text");
  expect(search.description).toContain("`pql`");
  expect(search.description).toContain("needs `projectId`");
  for (const description of [list.description, search.description, pqlSyntaxHelp]) {
    expect(description).toContain("activeCycle()");
    expect(description).toContain("cycle = activeCycle()");
    expect(description).toContain("module = ");
  }
  const listQuery = (list.inputSchema.properties as Record<string, { description?: string }>).query!;
  const searchProps = search.inputSchema.properties as Record<string, { description?: string }>;
  expect(listQuery.description).toBe(pqlSyntaxHelp);
  expect(searchProps.pql!.description!.startsWith(pqlSyntaxHelp)).toBe(true);
  expect(searchProps.pql!.description).toContain("rejected with a 400");
  expect(searchProps.query!.description).toContain("not PQL");
  expect(Object.keys(actionNotes)).toContain("search_work_items");
});

test.concurrent("the examples in the syntax reference are valid queries", async () => {
  await withRollback(db, async (transaction) => {
    const s = await setup(transaction);
    const work = createWorkItemActions(transaction);
    const cycleActions = createCycleActions(transaction);
    await cycleActions.createCycle.handler({ userId: s.admin.id }, { projectId: s.project.id, name: "Sprint 1", startDate: "2000-01-01", endDate: "2099-01-01" });
    const { createModuleActions } = await import("../src");
    await createModuleActions(transaction).createModule.handler({ userId: s.admin.id }, { projectId: s.project.id, name: "Mobile app" });
    await work.createLabel.handler({ userId: s.admin.id }, { projectId: s.project.id, name: "bug", color: "#ff0000" } as never);
    const examples = [...pqlSyntaxHelp.matchAll(/\((\d)\) (.+?)(?= \(\d\) |$)/g)].map((match) => match[2]!.trim());
    expect(examples).toHaveLength(3);
    for (const query of examples) await work.listWorkItems.handler({ userId: s.admin.id }, { projectId: s.project.id, query });
  });
});

test.concurrent("a proposal naming a label, state or project from another workspace is refused, and project writes are proposed, not run", async () => {
  await withRollback(db, async (transaction) => {
    const here = await setup(transaction);
    const other = await setup(transaction);
    const work = createWorkItemActions(transaction);
    const foreignLabel = await work.createLabel.handler({ userId: other.admin.id }, { projectId: other.project.id, name: "bug", color: "#ff0000" } as never) as { id: string };
    const tools = new Map(here.toolsFor(here.admin.id).map((tool) => [tool.name, tool]));
    const run = async (name: string, input: Record<string, unknown>) => JSON.parse(String(await tools.get(name)!.execute(input))) as { error?: string; status?: number; confirmationId?: string };
    expect((await run("update_label", { labelId: foreignLabel.id, name: "renamed" })).status).toBe(404);
    expect((await run("create_label", { projectId: other.project.id, name: "x" })).status).toBe(404);
    const proposed = await run("create_project", { name: "Web", key: "WEB", visibility: "public" });
    expect(proposed.error).toBeUndefined();
    expect((await createProjectActions(transaction).listProjects.handler({ userId: here.admin.id }, { workspaceId: here.workspace.id } as never) as { key: string }[]).map((project) => project.key)).toEqual(["MOB"]);
  });
});
