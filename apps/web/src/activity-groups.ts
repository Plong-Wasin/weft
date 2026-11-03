export type GroupableActivity = {
  id: string;
  field: string;
  actorId: string;
  actorName: string;
  source: string;
  createdAt: string;
  oldValue: unknown;
  newValue: unknown;
  [key: string]: unknown;
};

export type ActivityDisplayRow<T extends GroupableActivity> =
  | { kind: "activity"; id: string; activity: T }
  | { kind: "group"; id: string; field: string; actorId: string; actorName: string; source: string; oldValue: unknown; newValue: unknown; count: number; activities: T[] };

const groupWindowMs = 5 * 60 * 1000;
/** Lifecycle and attachment events are facts of their own, never value changes of one field: they are not grouped. */
const eventFields = new Set(["created", "deleted", "archived", "restored", "moved", "moved_scope", "attachment_added", "relation_added", "relation_removed"]);
const isEventField = (field: string) => eventFields.has(field) || field.startsWith("web_link_") || field.startsWith("comment_") || field.startsWith("intake_");
const sameValue = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/**
 * Groups Activities for display only; the source Activity records remain intact. A group is one field by one actor and surface,
 * each change within 5 minutes of the previous one; another actor's change ends every open group, other fields of the same actor do not.
 */
export function groupActivities<T extends GroupableActivity>(activities: T[], showAllChanges = false): ActivityDisplayRow<T>[] {
  type Slot = { members: T[]; open: boolean };
  const slots: Slot[] = [];
  const openByKey = new Map<string, Slot>();
  let lastActor: string | null = null;
  for (const activity of activities) {
    if (lastActor !== null && activity.actorId !== lastActor) for (const slot of openByKey.values()) slot.open = false;
    lastActor = activity.actorId;
    if (isEventField(activity.field)) { slots.push({ members: [activity], open: false }); continue; }
    // A change to this field by another surface breaks the chain of any open group on the same field.
    for (const [openKey, openSlot] of openByKey) if (openSlot.open && openSlot.members[0]!.field === activity.field && openKey !== `${activity.field}\u0000${activity.actorId}\u0000${activity.source}`) openSlot.open = false;
    const key = `${activity.field}\u0000${activity.actorId}\u0000${activity.source}`;
    const slot = openByKey.get(key);
    const previous = slot?.members.at(-1);
    if (slot && slot.open && previous && Math.abs(Date.parse(activity.createdAt) - Date.parse(previous.createdAt)) <= groupWindowMs) { slot.members.push(activity); continue; }
    const fresh: Slot = { members: [activity], open: true };
    openByKey.set(key, fresh);
    slots.push(fresh);
  }
  const rows: ActivityDisplayRow<T>[] = [];
  for (const { members } of slots) {
    const first = members[0]!;
    if (members.length === 1) { rows.push({ kind: "activity", id: first.id, activity: first }); continue; }
    const last = members.at(-1)!;
    const elapsed = Date.parse(first.createdAt) - Date.parse(last.createdAt);
    // Equal timestamps cannot tell the order, so follow the chain of values: the newer row starts where the older one ended.
    const newestFirst = elapsed !== 0 ? elapsed > 0 : sameValue(first.oldValue, members[1]!.newValue) && !sameValue(first.newValue, members[1]!.oldValue);
    const oldValue = newestFirst ? last.oldValue : first.oldValue;
    const newValue = newestFirst ? first.newValue : last.newValue;
    if (showAllChanges || !sameValue(oldValue, newValue)) rows.push({ kind: "group", id: first.id, field: first.field, actorId: first.actorId, actorName: first.actorName, source: first.source, oldValue, newValue, count: members.length, activities: members });
  }
  return rows;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A readable value for a group's old to new summary, or null for ids, lists and objects, which would print as noise. */
export function readableActivityValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return uuidPattern.test(value) ? null : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}
