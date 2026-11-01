import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { Elysia } from "elysia";
import { and, asc, count, eq, gt, sql } from "drizzle-orm";
export * from "./members";
import { sha256 } from "./members";
export * from "./projects";
export * from "./work-items";
export * from "./api-tokens";
export * from "./registry";
export * from "./comments";
export * from "./relations";
export * from "./search";
export * from "./assets";
export * from "./storage";
export * from "./wiki";
export * from "./jobs";
export * from "./notifications";
export * from "./ai-chats";
export * from "./confirmations";
export * from "./locale";
export * from "./features";
export * from "./cycles";
export * from "./intake";
export * from "./triage";
import type { Database } from "@weft/db";
import { users, workspaceInvites, workspaceMembers, workspaces } from "@weft/db";

export type ActionKind = "read" | "write";

export interface ActionContext {
  userId: string;
  source?: "ui" | "ai" | "cli" | "mcp";
  /** The AI chat a call came from when source is "ai". */
  chatId?: string;
  /** How the caller authenticated; absent means a signed-in session. */
  via?: "session" | "token";
}

export interface Action<Input extends TSchema, Output extends TSchema> {
  name: string;
  kind: ActionKind;
  input: Input;
  output: Output;
  permission: (context: ActionContext, input: Static<Input>) => boolean | Promise<boolean>;
  handler: (context: ActionContext, input: Static<Input>) => Static<Output> | Promise<Static<Output>>;
}

export function defineAction<Input extends TSchema, Output extends TSchema>(action: Action<Input, Output>, context: ActionContext = { userId: "development-user" }) {
  return action;
}

export const helloAction = defineAction({
  name: "hello",
  kind: "read",
  input: Type.Object({ name: Type.String({ minLength: 1 }) }),
  output: Type.Object({ greeting: Type.String() }),
  permission: (context: ActionContext) => context.userId.length > 0,
  handler: (_context: ActionContext, input: { name: string }) => ({ greeting: `Hello, ${input.name}!` }),
});

export function registerAction<
  App extends Elysia,
  Input extends TSchema,
  Output extends TSchema,
>(app: App, action: Action<Input, Output>, context: ActionContext = { userId: "development-user" }) {
  return app.post(`/actions/${action.name}`, async ({ body, set }) => {
    if (!(await action.permission(context, body as Static<Input>))) {
      set.status = 403;
      return { error: "Forbidden" };
    }
    return action.handler(context, body as Static<Input>);
  }, {
    body: action.input,
    response: { 200: action.output, 403: Type.Object({ error: Type.String() }) },
  });
}

export const actionRegistry = { hello: helloAction } as const;

export interface WorkspaceGateSettings {
  allowSignup: boolean;
  allowWorkspaceCreation: boolean;
}

export function createWorkspaceAction(db: Database, settings: WorkspaceGateSettings) {
  return {
    name: "create_workspace",
    kind: "write" as const,
    input: Type.Object({ name: Type.String({ minLength: 1, maxLength: 100 }), slug: Type.String({ minLength: 1, maxLength: 48, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }) }),
    output: Type.Object({ id: Type.String(), name: Type.String(), slug: Type.String() }),
    permission: async (context: ActionContext) => context.userId.length > 0,
    handler: async (context: ActionContext, input: { name: string; slug: string }) => {
      return db.transaction(async (transaction) => {
        await transaction.execute(sql`select pg_advisory_xact_lock(88421)`);
        const [{ value: workspaceCount }] = await transaction.select({ value: count() }).from(workspaces);
        if (!settings.allowWorkspaceCreation) {
          const [firstUser] = await transaction.select({ id: users.id }).from(users).orderBy(asc(users.createdAt), asc(users.id)).limit(1);
          if (workspaceCount > 0 || firstUser?.id !== context.userId) {
            throw new Error("Workspace creation is disabled");
          }
        }
        const [workspace] = await transaction.insert(workspaces).values(input).returning();
        await transaction.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: context.userId, role: "Admin" });
        return { id: workspace.id, name: workspace.name, slug: workspace.slug };
      });
    },
    /** An invitee holding a live invite token may sign up even when open signup is off. */
    canSignUp: async (inviteToken?: string | null) => {
      if (settings.allowSignup) return true;
      if (inviteToken) {
        const [invite] = await db.select({ id: workspaceInvites.id }).from(workspaceInvites)
          .where(and(eq(workspaceInvites.tokenHash, await sha256(inviteToken)), gt(workspaceInvites.expiresAt, new Date())));
        if (invite) return true;
      }
      const [{ value: workspaceCount }] = await db.select({ value: count() }).from(workspaces);
      return workspaceCount === 0;
    },
    userWorkspaces: async (userId: string) => db.select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug })
      .from(workspaceMembers).innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id)).where(eq(workspaceMembers.userId, userId)),
    canCreateWorkspace: async (userId: string) => {
      if (settings.allowWorkspaceCreation) return true;
      const [{ value }] = await db.select({ value: count() }).from(workspaces);
      const [firstUser] = await db.select({ id: users.id }).from(users).orderBy(asc(users.createdAt), asc(users.id)).limit(1);
      return value === 0 && firstUser?.id === userId;
    },
  };
}
export * from "./realtime";
