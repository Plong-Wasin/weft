/** Plane's built-in workspace views. They are not stored: every workspace has them, and they cannot be changed or deleted. */
export const builtinViewKinds = ["all", "assigned", "created", "subscribed"] as const;
export type BuiltinViewKind = (typeof builtinViewKinds)[number];
export const builtinViewId = (kind: BuiltinViewKind) => `builtin:${kind}`;
export const isBuiltinViewId = (value: string) => builtinViewKinds.some((kind) => builtinViewId(kind) === value);
