import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { ActionError, actionRegistry, createActionList, createApiTokenActions, createWorkspaceAction, registerAction, type ActionContext } from "@weft/actions";
import { eq } from "drizzle-orm";
import { createDatabase, users, type Database } from "@weft/db";
import { createAuth } from "./auth";
import { registerAiRoutes } from "./ai";
import type { LanguageModel } from "ai";

function setting(name: string, defaultValue: boolean) {
  const value = Bun.env[name];
  return value === undefined ? defaultValue : value.toLowerCase() === "true";
}

export function createApp(
  context?: ActionContext,
  db: Database = createDatabase().db,
  gates = { allowSignup: setting("ALLOW_SIGNUP", true), allowWorkspaceCreation: setting("ALLOW_WORKSPACE_CREATION", true) },
  aiModel?: LanguageModel,
) {
  const workspaceAction = createWorkspaceAction(db, gates);
  const auth = createAuth(db, workspaceAction.canSignUp);
  const memberActions = createActionList(db);
  const tokens = createApiTokenActions(db);
  /** Cookie session first (unchanged), then a personal API token in `Authorization: Bearer`. */
  async function resolveCaller(request: Request): Promise<ActionContext | null> {
    const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (bearer) {
      const owner = await tokens.authenticate(bearer.trim());
      if (!owner) return null;
      const source = request.headers.get("x-weft-source") === "mcp" ? "mcp" : "cli";
      return { userId: owner.userId, source, via: "token" };
    }
    const session = await auth.api.getSession({ headers: request.headers });
    return session ? { userId: session.user.id, via: "session" } : null;
  }
  const app = registerAction(new Elysia().use(cors({ origin: Bun.env.WEB_ORIGIN ?? "http://localhost:5173", credentials: true })), actionRegistry.hello, context)
    .all("/api/auth/*", ({ request }) => auth.handler(request))
    .get("/api/me", async ({ request, set }) => {
      const caller = await resolveCaller(request);
      if (!caller) { set.status = 401; return { error: "Unauthenticated" }; }
      const workspaces = await workspaceAction.userWorkspaces(caller.userId);
      const [user] = await db.select().from(users).where(eq(users.id, caller.userId));
      return { user, workspaces, canCreateWorkspace: await workspaceAction.canCreateWorkspace(caller.userId) };
    })
    .post("/actions/create_workspace", async ({ body, request, set }) => {
      const caller = await resolveCaller(request);
      if (!caller) { set.status = 401; return { error: "Unauthenticated" }; }
      try {
        return await workspaceAction.handler({ userId: caller.userId, source: caller.source }, body);
      } catch (error) {
        set.status = 403;
        return { error: error instanceof Error ? error.message : "Workspace creation failed" };
      }
    }, { body: workspaceAction.input });
  for (const action of memberActions) {
    app.post(`/actions/${action.name}`, async ({ body, request, set }) => {
      const caller = await resolveCaller(request);
      if (!caller) { set.status = 401; return { error: "Unauthenticated" }; }
      try {
        return await (action.handler as (context: ActionContext, input: unknown) => Promise<unknown>)(caller, body);
      } catch (error) {
        if (error instanceof ActionError) { set.status = error.status; return { error: error.message }; }
        throw error;
      }
    }, { body: action.input });
  }
  registerAiRoutes(app, { db, resolveCaller, model: aiModel });
  return app;
}
