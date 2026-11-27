import { Button } from "@/ui/button";
import React from "react";
import { translate } from "@weft/shared";
import type { OwnerRef } from "./asset-upload";
import { DescriptionEditor, type DescriptionMentionPerson } from "./description-editor";

type Call = <T>(name: string, body: unknown) => Promise<T | null>;
type Status = "saved" | "saving" | "failed" | "notSaved";

/** Description editor for Cycle and Module records, using their shared Action as the persistence boundary. */
export function EntityDescription({ action, workspaceId, owner, mentionPeople = [], initial, editable }: { action: Call; workspaceId: string; owner: OwnerRef; mentionPeople?: DescriptionMentionPerson[] | null; initial: unknown; editable: boolean }) {
  const [status, setStatus] = React.useState<Status>("saved");
  const pending = React.useRef<unknown>(null);
  const revision = React.useRef(0);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = React.useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (pending.current === null) return;
    const value = pending.current, currentRevision = revision.current;
    setStatus("saving");
    const actionName = owner.ownerType === "cycle" ? "update_cycle" : "update_module";
    const idField = owner.ownerType === "cycle" ? "cycleId" : "moduleId";
    const result = await action(actionName, { [idField]: owner.ownerId, description: value });
    if (currentRevision !== revision.current) return;
    if (!result) setStatus("failed");
    else { pending.current = null; setStatus("saved"); }
  }, [action, owner.ownerId, owner.ownerType]);
  React.useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; void flush(); } }, [flush]);
  const statusText = translate(`workItems.descriptionSave.${status}` as "workItems.descriptionSave.saved" | "workItems.descriptionSave.saving" | "workItems.descriptionSave.failed" | "workItems.descriptionSave.notSaved");
  return <div onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) void flush(); }}><DescriptionEditor
    workspaceId={workspaceId}
    owner={owner}
    mentionPeople={mentionPeople}
    initial={initial}
    editable={editable}
    status={<p role="status" data-testid="entity-description-save-status" className={`m-0 min-w-0 text-12 ${status === "failed" || status === "notSaved" ? "text-destructive" : "text-muted-foreground"}`}>{status === "failed" ? translate("workItems.descriptionSave.failed") : statusText}{status === "failed" && <Button type="button" className="ml-2 underline" onClick={() => void flush()}>{translate("workItems.descriptionSave.retry")}</Button>}</p>}
    onSourceDraftChange={(hasDraft) => { if (hasDraft) setStatus("notSaved"); }}
    onChange={(doc) => { pending.current = doc; revision.current += 1; setStatus("saving"); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => void flush(), 700); }}
  /></div>;
}
