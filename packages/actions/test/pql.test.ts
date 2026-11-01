import { afterAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createDatabase, users, workItems, type Database } from "@weft/db";
import { createCommentActions, createProjectActions, createSearchActions, createWorkItemActions, parse, PqlError, pqlLimits } from "../src";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

// ---- parser tables (no database) ----

test("valid queries parse", () => {
  const valid = [
    "", "   ", "priority = High", 'title ~ "login page"', "state = In Progress", "state IN (Backlog, In Progress, Todo)", "state NOT IN (Done)",
    "assignee IS NULL", "assignee IS NOT NULL", "dueDate BETWEEN startOfWeek() AND endOfWeek()", "dueDate < today()", "id >= WEB-11", "id IN (1, 2, 3)",
    "NOT hasNoAssignee()", "priority = High AND (state = Todo OR state = Backlog)", "NOT NOT priority = low", "priority = high ORDER BY dueDate DESC, title LIMIT 20",
    "ORDER BY title", "LIMIT 5", "stateGroup IN (openStates())", "priority = high and state = todo order by title asc limit 1000", "title = 'it\\'s'", 'title ~ "a\\"b"',
    "createdAt >= 2026-01-05", "(((priority = high)))", "title ~ ไทย", "assignee = currentUser() OR hasNoLabel()",
  ];
  for (const source of valid) expect(() => parse(source), source).not.toThrow();
  const query = parse("state = In Progress AND priority IN (urgent, high) ORDER BY title DESC LIMIT 7");
  expect(query.limit?.value).toBe(7);
  expect(query.orderBy).toEqual([{ field: "title", direction: "desc", pos: 60 }]);
  expect(query.where).toMatchObject({ kind: "and", left: { kind: "condition", field: "state", values: [{ kind: "literal", text: "In Progress" }] } });
});

test("invalid queries report the character position and the reason", () => {
  const invalid: Array<[string, number, string]> = [
    ["priority", 8, "an operator is expected"],
    ["priority =", 10, "a value is expected"],
    ["priority = AND state = Todo", 11, "a value is expected, found AND"],
    ["= High", 0, "a field name is expected"],
    ["priority = High AND", 19, "a condition is expected"],
    ["(priority = High", 16, 'expected ")"'],
    ["priority = High)", 15, "unexpected"],
    ["state IN Todo", 9, "needs a parenthesised list"],
    ["state IN (Todo", 14, 'expected "," or ")"'],
    ["dueDate BETWEEN today()", 23, "BETWEEN needs two values"],
    ["assignee IS", 11, "expected NULL or NOT NULL after IS"],
    ["title ~ 'open", 8, "unterminated string"],
    ["priority = High; DROP TABLE work_items", 15, 'unexpected character ";"'],
    ["priority ! High", 9, 'did you mean "!="'],
    ["priority = High ORDER title", 22, "expected BY after ORDER"],
    ["priority = High LIMIT x", 22, "LIMIT needs a whole number"],
    ["priority = High LIMIT 0", 22, "at least 1"],
    ["priority = High LIMIT 1001", 22, "at most 1000"],
    ["priority = High LIMIT 5 extra", 24, "unexpected"],
    ["today(1) < 5", 6, "takes no arguments"],
    ["ORDER BY", 8, "a field name is expected after ORDER BY"],
    ["a = 1 \u0000", 6, "unexpected character"],
  ];
  for (const [source, position, reason] of invalid) {
    let error: unknown;
    try { parse(source); } catch (caught) { error = caught; }
    expect(error, source).toBeInstanceOf(PqlError);
    expect((error as PqlError).position, source).toBe(position);
    expect((error as PqlError).reason, source).toContain(reason);
    expect((error as PqlError).message).toContain(`position ${position}`);
  }
});

test("long and deeply nested input is rejected cheaply", () => {
  const long = `title ~ "${"a".repeat(pqlLimits.maxLength)}"`;
  expect(() => parse(long)).toThrow(/longer than 2000/);
  expect(() => parse(`${"(".repeat(200)}priority = high${")".repeat(200)}`)).toThrow(/nesting is deeper/);
  expect(() => parse(`${"NOT ".repeat(200)}hasNoLabel()`)).toThrow(/nesting is deeper/);
  expect(() => parse(`priority IN (${Array.from({ length: 150 }, (_, i) => i).join(",")})`)).toThrow(/at most 100 values/);
  expect(() => parse(Array.from({ length: 190 }, () => "a=1").join(" AND "))).toThrow(/tokens/);
});

// ---- queries against Postgres ----

async function setup(transaction: Database) {
  const workspace = await createWorkspaceFactory(transaction);
  const ann = await createMemberFactory(transaction, workspace.id, "Member");
  const bob = await createMemberFactory(transaction, workspace.id, "Member");
  const outsider = await createMemberFactory(transaction, workspace.id, "Member");
  const guest = await createMemberFactory(transaction, workspace.id, "Guest");
  await transaction.update(users).set({ name: "Ann Lee" }).where(eq(users.id, ann.id));
  await transaction.update(users).set({ name: "Bob Ray" }).where(eq(users.id, bob.id));
  const projects = createProjectActions(transaction);
  const items = createWorkItemActions(transaction);
  const comments = createCommentActions(transaction);
  const search = createSearchActions(transaction);
  const project = await projects.createProject.handler({ userId: ann.id }, { workspaceId: workspace.id, name: "Mobile", key: "MOB", visibility: "public" });
  await projects.addProjectMember.handler({ userId: ann.id }, { projectId: project.id, userId: bob.id, role: "Member" });
  await projects.addProjectMember.handler({ userId: ann.id }, { projectId: project.id, userId: guest.id, role: "Guest" });
  const states = await items.listStates.handler({ userId: ann.id }, { projectId: project.id });
  const state = (name: string) => states.find((row) => row.name === name)!.id;
  const bug = await items.createLabel.handler({ userId: ann.id }, { projectId: project.id, name: "bug" });
  const feature = await items.createLabel.handler({ userId: ann.id }, { projectId: project.id, name: "feature" });
  const create = (title: string, extra: Record<string, unknown> = {}) => items.createWorkItem.handler({ userId: ann.id }, { projectId: project.id, title, ...extra });
  const list = async (query: string, as = ann.id, extra: Record<string, unknown> = {}) =>
    (await items.listWorkItems.handler({ userId: as }, { projectId: project.id, query, ...extra })).map((item) => item.title);
  return { workspace, ann, bob, outsider, guest, projects, items, comments, search, project, state, bug, feature, create, list };
}

test.concurrent("table of valid queries returns the expected work items", async () => {
  await withRollback(db, async (transaction) => {
    const env = await setup(transaction);
    const { ann, bob, state, bug, feature, create, list } = env;
    await create("Login crash", { priority: "urgent", assigneeIds: [ann.id], labelIds: [bug.id], dueDate: day(-3), startDate: day(-10), stateId: state("In Progress"), description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Fails on safari" }] }] } });
    await create("Search bar", { priority: "high", assigneeIds: [bob.id], labelIds: [feature.id], dueDate: day(5), stateId: state("Todo") });
    await create("Dark mode", { priority: "low", assigneeIds: [ann.id, bob.id], labelIds: [feature.id, bug.id], stateId: state("Done"), dueDate: day(-8) });
    await create("Cleanup", { priority: "none" });
    await create("100% done_ish", { priority: "medium", stateId: state("Backlog") });
    const table: Array<[string, string[]]> = [
      ["priority = urgent", ["Login crash"]],
      ["priority = High", ["Search bar"]],
      ["priority != none", ["100% done_ish", "Dark mode", "Login crash", "Search bar"]],
      ["priority IN (urgent, high) ORDER BY title", ["Login crash", "Search bar"]],
      ["priority NOT IN (urgent, high, low, medium)", ["Cleanup"]],
      ["state = In Progress", ["Login crash"]],
      ["state = \"in progress\"", ["Login crash"]],
      ["state IN (Todo, Backlog) ORDER BY title", ["100% done_ish", "Cleanup", "Search bar"]],
      ["state != Done AND priority = low", []],
      ["stateGroup = started", ["Login crash"]],
      ["stateGroup IN (openStates()) ORDER BY title", ["100% done_ish", "Cleanup", "Login crash", "Search bar"]],
      ["stateGroup IN (closedStates())", ["Dark mode"]],
      ["assignee = \"Ann Lee\" ORDER BY title", ["Dark mode", "Login crash"]],
      ["assignee = Bob Ray ORDER BY title", ["Dark mode", "Search bar"]],
      ["assignee != Bob Ray ORDER BY title", ["100% done_ish", "Cleanup", "Login crash"]],
      ["assignee IN (Ann Lee, Bob Ray) ORDER BY title", ["Dark mode", "Login crash", "Search bar"]],
      ["assignee NOT IN (Ann Lee, Bob Ray) ORDER BY title", ["100% done_ish", "Cleanup"]],
      ["assignee = currentUser() ORDER BY title", ["Dark mode", "Login crash"]],
      ["assignee IS NULL ORDER BY title", ["100% done_ish", "Cleanup"]],
      ["assignee IS NOT NULL ORDER BY title", ["Dark mode", "Login crash", "Search bar"]],
      ["hasNoAssignee() ORDER BY title", ["100% done_ish", "Cleanup"]],
      ["NOT hasNoAssignee() ORDER BY title", ["Dark mode", "Login crash", "Search bar"]],
      ["label = bug ORDER BY title", ["Dark mode", "Login crash"]],
      ["label IN (bug, feature) ORDER BY title", ["Dark mode", "Login crash", "Search bar"]],
      ["label != bug ORDER BY title", ["100% done_ish", "Cleanup", "Search bar"]],
      ["label IS NULL ORDER BY title", ["100% done_ish", "Cleanup"]],
      ["hasNoLabel() AND priority = none", ["Cleanup"]],
      ["createdBy = Ann Lee AND priority = urgent", ["Login crash"]],
      ["createdBy = Bob Ray", []],
      ["title ~ login", ["Login crash"]],
      ["title = \"Login crash\"", ["Login crash"]],
      ["title != \"Login crash\" AND priority = urgent", []],
      ["title ~ \"100%\"", ["100% done_ish"]],
      ["title ~ _", ["100% done_ish"]],
      ["text ~ safari", ["Login crash"]],
      ["text ~ login", ["Login crash"]],
      ["title ~ safari", []],
      ["id = MOB-1", ["Login crash"]],
      ["id = 2", ["Search bar"]],
      ["id IN (1, MOB-3) ORDER BY id", ["Login crash", "Dark mode"]],
      ["id > 3 ORDER BY id", ["Cleanup", "100% done_ish"]],
      ["id >= MOB-4 AND id < 5", ["Cleanup"]],
      ["id BETWEEN 2 AND 3 ORDER BY id", ["Search bar", "Dark mode"]],
      ["id ~ MOB-1", ["Login crash"]],
      ["id = OTHER-1", []],
      ["id != OTHER-1 AND id = 1", ["Login crash"]],
      ["project = MOB AND id = 1", ["Login crash"]],
      ["project = Elsewhere", []],
      ["project != Elsewhere AND id = 1", ["Login crash"]],
      ["dueDate < today() ORDER BY dueDate", ["Dark mode", "Login crash"]],
      ["dueDate > today()", ["Search bar"]],
      ["dueDate IS NULL ORDER BY title", ["100% done_ish", "Cleanup"]],
      ["dueDate IS NOT NULL AND priority = high", ["Search bar"]],
      [`dueDate = ${day(5)}`, ["Search bar"]],
      [`dueDate != ${day(5)} AND priority = high`, []],
      [`dueDate BETWEEN ${day(-9)} AND ${day(-1)} ORDER BY dueDate`, ["Dark mode", "Login crash"]],
      [`startDate <= ${day(-10)}`, ["Login crash"]],
      ["isOverdue()", ["Login crash"]],
      ["NOT isOverdue() AND dueDate IS NOT NULL ORDER BY title", ["Dark mode", "Search bar"]],
      ["createdAt >= today() AND priority = urgent", ["Login crash"]],
      ["createdAt < today()", []],
      ["updatedAt BETWEEN today() AND today() AND priority = urgent", ["Login crash"]],
      ["priority = urgent OR priority = low ORDER BY title", ["Dark mode", "Login crash"]],
      ["(priority = urgent OR priority = low) AND assignee = Bob Ray", ["Dark mode"]],
      ["NOT (priority = urgent OR priority = low) AND id <= 3", ["Search bar"]],
      ["priority = urgent AND priority = low", []],
      ["ORDER BY priority", ["Login crash", "Search bar", "100% done_ish", "Dark mode", "Cleanup"]],
      ["ORDER BY priority DESC, title", ["Cleanup", "Dark mode", "100% done_ish", "Search bar", "Login crash"]],
      ["ORDER BY dueDate", ["Dark mode", "Login crash", "Search bar", "Cleanup", "100% done_ish"]],
      ["ORDER BY dueDate DESC LIMIT 2", ["Search bar", "Login crash"]],
      ["ORDER BY title LIMIT 2", ["100% done_ish", "Cleanup"]],
      ["ORDER BY state, title", ["100% done_ish", "Cleanup", "Search bar", "Login crash", "Dark mode"]],
      ["ORDER BY assignee, title", ["Dark mode", "Login crash", "Search bar", "100% done_ish", "Cleanup"]],
      ["ORDER BY label, title", ["Dark mode", "Login crash", "Search bar", "100% done_ish", "Cleanup"]],
      ["ORDER BY id DESC LIMIT 1", ["100% done_ish"]],
      ["ORDER BY createdAt LIMIT 1", ["Login crash"]],
      ["ORDER BY sortOrder LIMIT 1", ["Login crash"]],
      ["", ["Login crash", "Search bar", "Dark mode", "Cleanup", "100% done_ish"]],
    ];
    for (const [query, expected] of table) {
      const actual = await list(query);
      expect(query.includes("ORDER BY") || query === "" ? actual : [...actual].sort(), query).toEqual(query.includes("ORDER BY") || query === "" ? expected : [...expected].sort());
    }
  });
});

test.concurrent("mention matches active comment mentions only", async () => {
  await withRollback(db, async (transaction) => {
    const { ann, bob, items, comments, create, list, project } = await setup(transaction);
    const a = await create("Mentioned");
    const b = await create("Deleted mention");
    await create("Quiet");
    const body = (id: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi " }, { type: "mention", attrs: { id, label: "x" } }] }] });
    await comments.createComment.handler({ userId: ann.id }, { workItemId: a.id, body: body(bob.id) });
    const gone = await comments.createComment.handler({ userId: ann.id }, { workItemId: b.id, body: body(bob.id) });
    await comments.deleteComment.handler({ userId: ann.id }, { commentId: gone.id });
    expect(await list("mention = Bob Ray")).toEqual(["Mentioned"]);
    expect(await list("mention IS NULL ORDER BY title")).toEqual(["Deleted mention", "Quiet"]);
    expect(await list("mention != Bob Ray ORDER BY title")).toEqual(["Deleted mention", "Quiet"]);
    expect(await list("mention IN (Bob Ray)")).toEqual(["Mentioned"]);
    expect(project.id).toBeTruthy();
    expect(items).toBeTruthy();
  });
});

test.concurrent("table of invalid queries fails with position and reason", async () => {
  await withRollback(db, async (transaction) => {
    const { ann, items, project, state, create, list } = await setup(transaction);
    await items.createState.handler({ userId: ann.id }, { projectId: project.id, name: "done", group: "completed" });
    await create("x");
    expect(state("Done")).toBeTruthy();
    const invalid: Array<[string, number, string]> = [
      ["colour = red", 0, "unknown field colour"],
      ["priority = high AND colour = red", 20, "unknown field colour"],
      ["priority ~ high", 9, "priority does not support ~"],
      ["title < a", 6, "title does not support <"],
      ["priority = purple", 11, 'not a valid priority'],
      ["stateGroup = open", 13, "not a valid stateGroup"],
      ["state = Nowhere", 8, 'state "Nowhere" was not found in this project'],
      ["state = done", 8, 'state "done" is ambiguous'],
      ["assignee = Nobody", 11, 'member "Nobody" was not found'],
      ["label = missing", 8, 'label "missing" was not found'],
      ["label IN (bug, missing)", 15, 'label "missing" was not found'],
      ["dueDate < tomorrow", 10, "is not a date"],
      ["dueDate < 2026-13-45", 10, "is not a date"],
      ["id = abc", 5, "not a work item id"],
      ["id = MOB-", 5, "not a work item id"],
      ["assignee = today()", 11, "returns date values, which assignee does not accept"],
      ["dueDate < currentUser()", 10, "returns user values"],
      ["stateGroup = openStates()", 13, "returns a list; use it with IN"],
      ["dueDate < nope()", 10, "unknown function nope()"],
      ["isOverdue() = 1", 12, "unexpected"],
      ["hasNoLabel", 10, "an operator is expected"],
      ["priority = hasNoLabel()", 11, "is a condition"],
      ["today()", 0, "is a value"],
      ["activeCycle()", 0, "activeCycle() is a value"],
      ["cycle = x", 8, "was not found in this project"],
      ["module = x", 9, "was not found in this project"],
      ["cycle < x", 6, "cycle does not support <"],
      ["priority = activeCycle()", 11, "does not accept"],
      ["ORDER BY nonsense", 9, "unknown field nonsense"],
      ["ORDER BY mention", 9, "cannot sort by mention"],
      ["priority = high LIMIT 1001", 22, "at most 1000"],
    ];
    for (const [query, position, reason] of invalid) {
      let error: unknown;
      try { await list(query); } catch (caught) { error = caught; }
      expect(error, query).toBeInstanceOf(PqlError);
      expect((error as PqlError).status).toBe(400);
      expect((error as PqlError).position, query).toBe(position);
      expect((error as PqlError).reason, query).toContain(reason);
    }
  });
});

test.concurrent("injection attempts are data, never SQL", async () => {
  await withRollback(db, async (transaction) => {
    const { create, list, items, project, ann } = await setup(transaction);
    await create("safe");
    const evil = [
      `title = "'; DROP TABLE work_items; --"`, `title ~ "' OR '1'='1"`, `title = '" OR 1=1 --'`, "title ~ \"\\\"; select pg_sleep(5); --\"",
      `title = 'a' --`, `title ~ '%'' ) or true or (''='`, `title = "x\\"`, `text ~ "${"'".repeat(500)}"`, `title ~ $$ x $$`, "title ~ ${1}", "title = `x`",
    ];
    for (const query of evil) {
      const result = await list(query).catch((error) => error);
      if (result instanceof Error) expect(result).toBeInstanceOf(PqlError);
      else expect(result).toEqual([]);
    }
    // The injection strings that parse must not match every row, and the table must still be intact.
    expect(await list(`title = "x" OR title ~ "' OR '1'='1"`)).toEqual([]);
    expect(await list("priority = none ORDER BY title; DROP TABLE work_items").catch((error) => error)).toBeInstanceOf(PqlError);
    expect(await items.listWorkItems.handler({ userId: ann.id }, { projectId: project.id })).toHaveLength(1);
  });
});

test.concurrent("LIMIT is capped at 1000 on the server and defaults to the cap", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, project, ann, items, list } = await setup(transaction);
    expect(await list("ORDER BY id LIMIT 1000").catch((e) => e)).toEqual([]);
    expect(await list("LIMIT 1001").catch((e) => e)).toBeInstanceOf(PqlError);
    expect(await list("LIMIT 99999999999999999999").catch((e) => e)).toBeInstanceOf(PqlError);
    // 1010 rows inserted directly: a query without LIMIT returns the cap, not everything.
    const [state] = await items.listStates.handler({ userId: ann.id }, { projectId: project.id });
    await transaction.insert(workItems).values(Array.from({ length: 1010 }, (_, i) => ({
      workspaceId: workspace.id, projectId: project.id, sequence: i + 1, title: `bulk ${i}`, stateId: state!.id, sortOrder: i, createdBy: ann.id,
    })));
    expect(await list("title ~ bulk")).toHaveLength(1000);
    expect(await list("title ~ bulk LIMIT 3")).toHaveLength(3);
    expect(await list("title ~ bulk ORDER BY id DESC LIMIT 1000")).toHaveLength(1000);
    expect(await list("")).toHaveLength(1010);
  });
});

test.concurrent("query ANDs with the existing filters and ORDER BY replaces sort", async () => {
  await withRollback(db, async (transaction) => {
    const { create, list, state, ann, bob } = await setup(transaction);
    await create("a", { priority: "high", stateId: state("Todo"), assigneeIds: [ann.id] });
    await create("b", { priority: "high", stateId: state("Done"), assigneeIds: [bob.id] });
    await create("c", { priority: "low", stateId: state("Todo") });
    expect(await list("priority = high", ann.id, { stateIds: [state("Todo")] })).toEqual(["a"]);
    expect(await list("priority = low", ann.id, { stateIds: [state("Todo")], priorities: ["high"] })).toEqual([]);
    expect(await list("assignee = Bob Ray", ann.id, { assigneeIds: [ann.id] })).toEqual([]);
    expect(await list("ORDER BY title DESC", ann.id, { sort: "title", direction: "asc" })).toEqual(["c", "b", "a"]);
    expect(await list("priority = high", ann.id, { sort: "title", direction: "desc" })).toEqual(["a", "b"].reverse());
  });
});

test.concurrent("results respect project access and exclude soft-deleted items", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, ann, bob, outsider, guest, projects, items, search, create, list } = await setup(transaction);
    const secret = await projects.createProject.handler({ userId: ann.id }, { workspaceId: workspace.id, name: "Secret", key: "SEC", visibility: "private" });
    await items.createWorkItem.handler({ userId: ann.id }, { projectId: secret.id, title: "hidden plan" });
    await create("visible");
    const gone = await create("deleted one");
    await items.deleteWorkItem.handler({ userId: ann.id }, { workItemId: gone.id });
    // Soft-deleted items never match, whatever the query says.
    expect(await list("title ~ deleted")).toEqual([]);
    expect(await list("id = 2")).toEqual([]);
    expect(await list("NOT priority = high ORDER BY title")).toEqual(["visible"]);
    // A caller without access to the private project is refused before the query runs, and bad queries do not change that.
    for (const query of ["title ~ hidden", "colour = red", ""]) {
      await expect(items.listWorkItems.handler({ userId: outsider.id }, { projectId: secret.id, query })).rejects.toMatchObject({ status: 404 });
    }
    await expect(items.listWorkItems.handler({ userId: bob.id }, { projectId: secret.id, query: "title ~ hidden" })).rejects.toMatchObject({ status: 404 });
    // Guests read through PQL like they read lists.
    expect(await list("title ~ visible", guest.id)).toEqual(["visible"]);
    // A query never reaches another project's work items, whatever it names.
    expect(await list("title ~ hidden OR project = SEC")).toEqual([]);
    // Search with PQL: same rules.
    const found = await search.searchWorkItems.handler({ userId: ann.id }, { workspaceId: workspace.id, projectId: secret.id, pql: "title ~ hidden" });
    expect(found.map((row) => row.title)).toEqual(["hidden plan"]);
    await expect(search.searchWorkItems.handler({ userId: outsider.id }, { workspaceId: workspace.id, projectId: secret.id, pql: "title ~ hidden" })).rejects.toMatchObject({ status: 404 });
    await expect(search.searchWorkItems.handler({ userId: outsider.id }, { workspaceId: workspace.id, query: "hidden" })).resolves.toEqual([]);
  });
});

test.concurrent("search_work_items takes a query for one project and combines it with the text", async () => {
  await withRollback(db, async (transaction) => {
    const { workspace, ann, project, search, create, state } = await setup(transaction);
    await create("Login crash", { priority: "urgent" });
    await create("Login slow", { priority: "low", stateId: state("Done") });
    await create("Other", { priority: "urgent" });
    const run = (input: Record<string, unknown>) => search.searchWorkItems.handler({ userId: ann.id }, { workspaceId: workspace.id, ...input } as never).then((rows) => rows.map((row) => row.title).sort());
    expect(await run({ query: "login" })).toEqual(["Login crash", "Login slow"]);
    expect(await run({ query: "login", projectId: project.id, pql: "priority = urgent" })).toEqual(["Login crash"]);
    expect(await run({ projectId: project.id, pql: "priority = urgent" })).toEqual(["Login crash", "Other"]);
    await expect(run({ projectId: project.id, pql: "stateGroup IN (closedStates()) ORDER BY title LIMIT 5" })).rejects.toMatchObject({ status: 400 });
    expect(await run({ projectId: project.id, pql: "stateGroup IN (closedStates())" })).toEqual(["Login slow"]);
    await expect(run({ pql: "priority = urgent" })).rejects.toMatchObject({ status: 400 });
    await expect(run({ projectId: project.id, pql: "nope = 1" })).rejects.toBeInstanceOf(PqlError);
    await expect(run({ projectId: crypto.randomUUID(), pql: "priority = urgent" })).rejects.toMatchObject({ status: 404 });
    await expect(run({})).rejects.toMatchObject({ status: 400 });
  });
});

test.concurrent("mention ignores a reply hidden under a deleted parent", async () => {
  await withRollback(db, async (transaction) => {
    const { ann, bob, comments, create, list } = await setup(transaction);
    const item = await create("Threaded");
    const body = (id: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi " }, { type: "mention", attrs: { id, label: "x" } }] }] });
    const plain = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "parent" }] }] };
    const parent = await comments.createComment.handler({ userId: ann.id }, { workItemId: item.id, body: plain });
    await comments.createComment.handler({ userId: ann.id }, { workItemId: item.id, body: body(bob.id), parentId: parent.id });
    expect(await list("mention = Bob Ray")).toEqual(["Threaded"]);
    await comments.deleteComment.handler({ userId: ann.id }, { commentId: parent.id });
    expect(await list("mention = Bob Ray")).toEqual([]);
  });
});

test.concurrent("leading whitespace keeps error positions relative to the raw query", async () => {
  await withRollback(db, async (transaction) => {
    const { ann, workspace, project, search, create, list } = await setup(transaction);
    await create("x");
    for (const run of [
      () => list("   colour = red"),
      () => search.searchWorkItems.handler({ userId: ann.id }, { workspaceId: workspace.id, projectId: project.id, pql: "  colour = red" }),
    ]) {
      let error: unknown;
      try { await run(); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(PqlError);
    }
    await expect(list("   colour = red")).rejects.toMatchObject({ position: 3 });
    await expect(search.searchWorkItems.handler({ userId: ann.id }, { workspaceId: workspace.id, projectId: project.id, pql: "  colour = red" })).rejects.toMatchObject({ position: 2 });
  });
});

test.concurrent("search pql finds this project's items when another project has more matches than LIMIT; ORDER BY and LIMIT are rejected", async () => {
  await withRollback(db, async (transaction) => {
    const { ann, workspace, project, projects, items, search, create } = await setup(transaction);
    const other = await projects.createProject.handler({ userId: ann.id }, { workspaceId: workspace.id, name: "Other", key: "OTH", visibility: "public" });
    await create("needle mine");
    const seed = await items.createWorkItem.handler({ userId: ann.id }, { projectId: other.id, title: "needle seed" });
    // More matching rows in the other project than the default PQL limit (1000).
    await transaction.execute(sql`insert into work_items (workspace_id, project_id, sequence, title, state_id, created_by, sort_order)
      select workspace_id, project_id, sequence + g, 'needle ' || g, state_id, created_by, sort_order from work_items, generate_series(1, 1100) g where id = ${seed.id}`);
    const found = await search.searchWorkItems.handler({ userId: ann.id }, { workspaceId: workspace.id, projectId: project.id, pql: "title ~ needle" });
    expect(found.map((row) => row.title)).toEqual(["needle mine"]);
    for (const pql of ["title ~ needle ORDER BY title", "title ~ needle LIMIT 5"]) {
      await expect(search.searchWorkItems.handler({ userId: ann.id }, { workspaceId: workspace.id, projectId: project.id, pql })).rejects.toMatchObject({ status: 400 });
    }
  });
});
