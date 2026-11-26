import { Button } from "@/ui/button";
import React from "react";
import { translate } from "@weft/shared";
import { DialogContent, DialogTitle } from "./ui/dialog";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";

/** A short form dialog. Esc and backdrop dismissal close it; Base UI manages focus. */
export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  // Mounted open, so Base UI never sees an open transition: return focus to the opener it was mounted from.
  const [opener] = React.useState(() => document.activeElement as HTMLElement | null);
  return <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent finalFocus={() => (opener?.isConnected ? opener : true)}>
      <DialogTitle>{title}</DialogTitle>
      {children}
    </DialogContent>
  </DialogPrimitive.Root>;
}

/** Cancel on the left of the primary action, as every form dialog ends. */
export function DialogActions({ onClose, submit }: { onClose: () => void; submit: string }) {
  return <div className="flex justify-end gap-2">
    <Button type="button" className="pointer-coarse:min-h-11" onClick={onClose}>{translate("comments.cancel")}</Button>
    <Button type="submit" className="pointer-coarse:min-h-11">{submit}</Button>
  </div>;
}
