import { Type } from "@sinclair/typebox";
import { eq } from "drizzle-orm";
import type { Database } from "@weft/db";
import { users } from "@weft/db";
import { ActionError } from "./members";

type Context = { userId: string };

/** Keep in step with `locales` in @weft/shared (actions import nothing from apps, and the schema must name the values). */
const localeSchema = Type.Union([Type.Literal("en"), Type.Literal("th")]);

/** The signed-in user's own interface and AI-reply language. */
export function createLocaleActions(db: Database) {
  const output = Type.Object({ locale: localeSchema });
  return {
    getMyLocale: {
      name: "get_my_locale", kind: "read" as const,
      input: Type.Object({}), output,
      handler: async (context: Context, _input: Record<string, never>) => {
        const [row] = await db.select({ locale: users.locale }).from(users).where(eq(users.id, context.userId));
        if (!row) throw new ActionError("User not found", 404);
        return { locale: (row.locale ?? "en") as "en" | "th" };
      },
    },
    setMyLocale: {
      name: "set_my_locale", kind: "write" as const,
      input: Type.Object({ locale: localeSchema }), output,
      handler: async (context: Context, input: { locale: "en" | "th" }) => {
        const updated = await db.update(users).set({ locale: input.locale, updatedAt: new Date() }).where(eq(users.id, context.userId)).returning({ id: users.id });
        if (updated.length === 0) throw new ActionError("User not found", 404);
        return { locale: input.locale };
      },
    },
  };
}
