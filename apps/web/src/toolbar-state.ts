/** The pressed state of a toolbar button. Insert actions (the table button) are not toggles, so they are never "pressed" and carry no aria-pressed. */
const insertTools = new Set(["table"]);

export function toolPressed(key: string, isActive: (name: string) => boolean): boolean | undefined {
  return insertTools.has(key) ? undefined : isActive(key);
}
