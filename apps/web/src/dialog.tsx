import React from "react";
import { translate } from "@weft/shared";
import { DialogContent, DialogTitle } from "./ui/dialog";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";

/** A short form dialog. Esc and backdrop dismissal close it; Base UI manages focus. */
export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent>
      <DialogTitle>{title}</DialogTitle>
      {children}
    </DialogContent>
  </DialogPrimitive.Root>;
}

/** Cancel on the left of the primary action, as every form dialog ends. */
export function DialogActions({ onClose, submit }: { onClose: () => void; submit: string }) {
  return <div className="flex justify-end gap-2">
    <button type="button" className="secondary pointer-coarse:min-h-11" onClick={onClose}>{translate("comments.cancel")}</button>
    <button type="submit" className="pointer-coarse:min-h-11">{submit}</button>
  </div>;
}
