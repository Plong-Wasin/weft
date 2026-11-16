import { Type } from "@sinclair/typebox";
import { eq } from "drizzle-orm";
import { users, type Database } from "@weft/db";
import { ActionError } from "./members";
import { emailNotificationKinds } from "./email-digest";

const kindSchema = Type.Union(emailNotificationKinds.map((kind) => Type.Literal(kind)));
const output = Type.Object({ email: Type.String(), emailVerified: Type.Boolean(), kinds: Type.Array(kindSchema) });

/** The signed-in person's own email settings: which notification kinds they get by email. */
export function createEmailPreferenceActions(db: Database) {
  async function read(userId: string) {
    const [row] = await db.select({ email: users.email, emailVerified: users.emailVerified, kinds: users.emailNotificationKinds }).from(users).where(eq(users.id, userId));
    if (!row) throw new ActionError("User not found", 404);
    // Keep the saved order of the catalogue, and drop anything the catalogue no longer has.
    return { email: row.email, emailVerified: row.emailVerified, kinds: emailNotificationKinds.filter((kind) => row.kinds.includes(kind)) };
  }
  return {
    getMyEmailPreferences: {
      name: "get_my_email_preferences", kind: "read" as const,
      input: Type.Object({}), output,
      handler: async (context: { userId: string }, _input: Record<string, never>) => read(context.userId),
    },
    setMyEmailPreferences: {
      name: "set_my_email_preferences", kind: "write" as const,
      input: Type.Object({ kinds: Type.Array(kindSchema, { uniqueItems: true }) }), output,
      handler: async (context: { userId: string }, input: { kinds: (typeof emailNotificationKinds)[number][] }) => {
        // An empty list turns every notification email off.
        const updated = await db.update(users).set({ emailNotificationKinds: [...new Set(input.kinds)], updatedAt: new Date() })
          .where(eq(users.id, context.userId)).returning({ id: users.id });
        if (updated.length === 0) throw new ActionError("User not found", 404);
        return read(context.userId);
      },
    },
  };
}
