import { Type } from "@sinclair/typebox";
import { eq } from "drizzle-orm";
import { users, type Database } from "@weft/db";
import { ActionError } from "./members";

const output = Type.Object({ showSelectionMenu: Type.Boolean() });

/** The signed-in person's own AI preferences. They follow the account, not the browser. */
export function createAiPreferenceActions(db: Database) {
  async function read(userId: string) {
    const [row] = await db.select({ showSelectionMenu: users.aiSelectionMenu }).from(users).where(eq(users.id, userId));
    if (!row) throw new ActionError("User not found", 404);
    return { showSelectionMenu: row.showSelectionMenu };
  }
  return {
    getMyAiPreferences: {
      name: "get_my_ai_preferences", kind: "read" as const,
      input: Type.Object({}), output,
      handler: async (context: { userId: string }, _input: Record<string, never>) => read(context.userId),
    },
    setMyAiPreferences: {
      name: "set_my_ai_preferences", kind: "write" as const,
      input: Type.Object({ showSelectionMenu: Type.Boolean() }), output,
      handler: async (context: { userId: string }, input: { showSelectionMenu: boolean }) => {
        const updated = await db.update(users).set({ aiSelectionMenu: input.showSelectionMenu, updatedAt: new Date() })
          .where(eq(users.id, context.userId)).returning({ id: users.id });
        if (updated.length === 0) throw new ActionError("User not found", 404);
        return read(context.userId);
      },
    },
  };
}
