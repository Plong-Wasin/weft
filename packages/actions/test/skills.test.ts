import { afterAll, expect, test } from "bun:test";
import { ActionError, createActionList } from "../src";
import { createDatabase, workspaceMembers } from "@weft/db";
import { createMemberFactory, createWorkspaceFactory, withRollback } from "../../db/src/test-helpers";

const { client, db } = createDatabase();
afterAll(async () => client.end());

test.concurrent("members manage private Personal skills while workspace skills remain admin managed", async () => {
  await withRollback(db, async (tx) => {
    const workspace = await createWorkspaceFactory(tx);
    const admin = await createMemberFactory(tx, workspace.id, "Admin");
    const member = await createMemberFactory(tx, workspace.id, "Member");
    const guest = await createMemberFactory(tx, workspace.id, "Guest");
    const otherWorkspace = await createWorkspaceFactory(tx);
    const outsider = await createMemberFactory(tx, otherWorkspace.id, "Member");
    const actions = Object.fromEntries(createActionList(tx).map((action) => [action.name, action])) as Record<string, any>;
    const personal = await actions.create_skill.handler({ userId: member.id }, {
      workspaceId: workspace.id, scope: "personal", name: "my-guide", description: "Private guidance", instructions: "Do this privately",
    });
    const workspaceSkill = await actions.create_skill.handler({ userId: admin.id }, {
      workspaceId: workspace.id, scope: "workspace", name: "my-guide", description: "Team guidance", instructions: "Do this together",
    });

    expect((await actions.list_skills.handler({ userId: member.id }, { workspaceId: workspace.id })).sort((a: any, b: any) => a.scope.localeCompare(b.scope))).toEqual([
      { id: personal.id, name: "my-guide", description: "Private guidance", scope: "personal" },
      { id: workspaceSkill.id, name: "my-guide", description: "Team guidance", scope: "workspace" },
    ]);
    expect(await actions.get_skill.handler({ userId: member.id }, { skillId: personal.id })).toMatchObject({ instructions: "Do this privately" });
    for (const user of [admin, guest, outsider]) {
      await expect(actions.get_skill.handler({ userId: user.id }, { skillId: personal.id })).rejects.toBeInstanceOf(ActionError);
    }
    await expect(actions.create_skill.handler({ userId: guest.id }, {
      workspaceId: workspace.id, scope: "personal", name: "guest-guide", description: "No", instructions: "No",
    })).rejects.toBeInstanceOf(ActionError);
    await expect(actions.create_skill.handler({ userId: member.id }, {
      workspaceId: workspace.id, scope: "workspace", name: "member-guide", description: "No", instructions: "No",
    })).rejects.toBeInstanceOf(ActionError);
    await expect(actions.create_skill.handler({ userId: member.id }, {
      workspaceId: workspace.id, scope: "personal", name: "my-guide", description: "Duplicate", instructions: "No",
    })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("already exists") });
    const updated = await actions.update_skill.handler({ userId: member.id }, { skillId: personal.id, instructions: "Updated" });
    expect(updated.instructions).toBe("Updated");
    await expect(actions.update_skill.handler({ userId: admin.id }, { skillId: personal.id, description: "Intrusion" })).rejects.toBeInstanceOf(ActionError);
    await expect(actions.update_skill.handler({ userId: member.id }, { skillId: workspaceSkill.id, description: "Intrusion" })).rejects.toBeInstanceOf(ActionError);
    expect(await actions.delete_skill.handler({ userId: member.id }, { skillId: personal.id })).toEqual({ deleted: true });
    await expect(actions.get_skill.handler({ userId: member.id }, { skillId: personal.id })).rejects.toBeInstanceOf(ActionError);
  });
});

test.concurrent("the AI chat proposes Skill writes as Confirmations that run only on confirm", async () => {
  const { aiWriteActions, createAiTools, createChatStore, createConfirmationStore } = await import("../src");
  await withRollback(db, async (tx) => {
    const workspace = await createWorkspaceFactory(tx);
    const member = await createMemberFactory(tx, workspace.id, "Member");
    for (const name of ["create_skill", "update_skill", "delete_skill"]) expect(aiWriteActions as readonly string[]).toContain(name);
    const chat = (await createChatStore(tx).upsertChat({ id: crypto.randomUUID(), workspaceId: workspace.id, userId: member.id, title: "t" }))!;
    const tool = createAiTools(tx, { userId: member.id, workspaceId: workspace.id, chatId: chat.id, mode: "build" }).find((entry) => entry.name === "create_skill")!;
    const proposal = JSON.parse(await tool.execute({ scope: "personal", name: "via-chat", description: "From chat", instructions: "Steps" })) as { status: string; confirmationId: string };
    expect(proposal.status).toBe("awaiting_user_confirmation");
    const actions = Object.fromEntries(createActionList(tx).map((action) => [action.name, action])) as Record<string, any>;
    expect(await actions.list_skills.handler({ userId: member.id }, { workspaceId: workspace.id })).toEqual([]);
    expect((await createConfirmationStore(tx).confirm(member.id, proposal.confirmationId)).status).toBe("confirmed");
    expect(await actions.list_skills.handler({ userId: member.id }, { workspaceId: workspace.id })).toHaveLength(1);
  });
});

test.concurrent("a Skill card shows what changes and refuses a Skill of another workspace or another user", async () => {
  const { createAiTools, createChatStore, createConfirmationStore } = await import("../src");
  await withRollback(db, async (tx) => {
    const workspace = await createWorkspaceFactory(tx);
    const other = await createWorkspaceFactory(tx);
    const admin = await createMemberFactory(tx, workspace.id, "Admin");
    const stranger = await createMemberFactory(tx, workspace.id, "Member");
    const actions = Object.fromEntries(createActionList(tx).map((action) => [action.name, action])) as Record<string, any>;
    const mine = await actions.create_skill.handler({ userId: admin.id }, { workspaceId: workspace.id, scope: "personal", name: "mine", description: "Mine", instructions: "v1" });
    await tx.insert(workspaceMembers).values({ workspaceId: other.id, userId: admin.id, role: "Admin" });
    const foreign = await actions.create_skill.handler({ userId: admin.id }, { workspaceId: other.id, scope: "workspace", name: "foreign", description: "Foreign", instructions: "x" });
    const chat = (await createChatStore(tx).upsertChat({ id: crypto.randomUUID(), workspaceId: workspace.id, userId: admin.id, title: "t" }))!;
    const tools = createAiTools(tx, { userId: admin.id, workspaceId: workspace.id, chatId: chat.id, mode: "build" });
    const update = tools.find((entry) => entry.name === "update_skill")!;
    const proposal = JSON.parse(await update.execute({ skillId: mine.id, instructions: "v2" })) as { status: string; confirmationId: string };
    expect(proposal.status).toBe("awaiting_user_confirmation");
    await actions.update_skill.handler({ userId: admin.id }, { skillId: mine.id, instructions: "v3" });
    const outcome = await createConfirmationStore(tx).confirm(admin.id, proposal.confirmationId);
    expect(outcome.status).toBe("changed");
    expect(JSON.stringify(outcome)).toContain("instructions");
    const crossed = JSON.parse(await update.execute({ skillId: foreign.id, instructions: "no" })) as { error?: string; status?: string };
    expect(crossed.status).not.toBe("awaiting_user_confirmation");
    const strangerTools = createAiTools(tx, { userId: stranger.id, workspaceId: workspace.id, chatId: chat.id, mode: "build" });
    const peek = JSON.parse(await strangerTools.find((entry) => entry.name === "update_skill")!.execute({ skillId: mine.id, instructions: "no" })) as { status?: string };
    expect(peek.status).not.toBe("awaiting_user_confirmation");
  });
});
