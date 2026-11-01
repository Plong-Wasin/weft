import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { actionRegistry, createWorkspaceAction, registerAction, type ActionContext } from "@weft/actions";
import { createDatabase, type Database } from "@weft/db";
import { createAuth } from "./auth";

function setting(name: string, defaultValue: boolean) {
  const value = Bun.env[name];
  return value === undefined ? defaultValue : value.toLowerCase() === "true";
}

export function createApp(
  context?: ActionContext,
  db: Database = createDatabase().db,
  gates = { allowSignup: setting("ALLOW_SIGNUP", true), allowWorkspaceCreation: setting("ALLOW_WORKSPACE_CREATION", true) },
) {
  const workspaceAction = createWorkspaceAction(db, gates);
  const auth = createAuth(db, workspaceAction.canSignUp);
  const app = registerAction(new Elysia().use(cors({ origin: Bun.env.WEB_ORIGIN ?? "http://localhost:5173", credentials: true })), actionRegistry.hello, context)
    .all("/api/auth/*", ({ request }) => auth.handler(request))
    .get("/api/me", async ({ request, set }) => {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) { set.status = 401; return { error: "Unauthenticated" }; }
      const workspaces = await workspaceAction.userWorkspaces(session.user.id);
      return { user: session.user, workspaces, canCreateWorkspace: await workspaceAction.canCreateWorkspace(session.user.id) };
    })
    .post("/actions/create_workspace", async ({ body, request, set }) => {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) { set.status = 401; return { error: "Unauthenticated" }; }
      try {
        return await workspaceAction.handler({ userId: session.user.id }, body);
      } catch (error) {
        set.status = 403;
        return { error: error instanceof Error ? error.message : "Workspace creation failed" };
      }
    }, { body: workspaceAction.input });
  return app;
}
