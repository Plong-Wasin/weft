import React from "react";
import { translate } from "@weft/shared";
import { Dialog } from "./dialog";
import { OPEN_SHORTCUTS_EVENT } from "./shortcuts";
import { ShortcutTable } from "./pages/shortcuts-page";

/** The shortcuts dialog Ctrl/⌘+/ opens from inside an editor. Mounted once for every signed-in screen; Escape closes it. */
export function EditorShortcutsDialog() {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    const show = () => setOpen(true);
    document.addEventListener(OPEN_SHORTCUTS_EVENT, show);
    return () => document.removeEventListener(OPEN_SHORTCUTS_EVENT, show);
  }, []);
  if (!open) return null;
  return <Dialog title={translate("shortcuts.title")} onClose={() => setOpen(false)}>
    <div className="-mx-1 max-h-[65vh] overflow-y-auto px-1"><ShortcutTable /></div>
  </Dialog>;
}
