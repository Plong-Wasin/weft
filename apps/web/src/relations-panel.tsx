import React from "react";
import { translate } from "@weft/shared";
import { Link } from "react-router";
import { X } from "lucide-react";
import { Dialog, DialogActions } from "./dialog";
import { paths } from "./routes";

type RelationType = "blocks" | "blocked_by" | "duplicate" | "relates_to";
type Relation = { id: string; type: RelationType; workItem: { id: string; displayId: string; title: string } };
type Candidate = { id: string; displayId: string; title: string };
type Action = <T>(name: string, body: unknown) => Promise<T | null>;
const types: RelationType[] = ["blocks", "blocked_by", "duplicate", "relates_to"];

export function RelationsPanel({ workspaceSlug, workItemId, candidates, canWrite, action, onChange, showForm, onClose, onCount }: {
  workspaceSlug: string; workItemId: string; candidates: Candidate[]; canWrite: boolean; action: Action; onChange: () => void; showForm: boolean; onClose: () => void; onCount: (count: number) => void;
}) {
  const [relations, setRelations] = React.useState<Relation[]>([]);
  const [type, setType] = React.useState<RelationType>("blocks");
  const [target, setTarget] = React.useState("");
  const [note, setNote] = React.useState<string | null>(null);
  const load = React.useCallback(async () => setRelations(await action<Relation[]>("list_work_item_relations", { workItemId }) ?? []), [action, workItemId]);
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => { onCount(relations.length); }, [onCount, relations.length]);
  const linked = new Set(relations.map((relation) => relation.workItem.id));
  const done = async (result: unknown) => { setNote(result === null ? translate("relations.failed") : null); await load(); onChange(); };
  return <section className="grid gap-3">
    {types.map((group) => {
      const rows = relations.filter((relation) => relation.type === group);
      if (rows.length === 0) return null;
      return <div key={group} className="grid gap-1">
        <h4 className="m-0 text-12 font-medium text-tertiary">{translate(`relations.type.${group}`)} <span className="font-normal">{rows.length}</span></h4>
        <ul className="m-0 grid list-none gap-1 !pl-0">{rows.map((relation) => <li key={relation.id} className="flex items-center gap-2 rounded-md bg-layer-1 px-2.5 py-1.5 text-13">
          <Link to={paths.workItem(workspaceSlug, relation.workItem.displayId)} className="flex min-w-0 flex-1 gap-2 text-primary hover:underline"><span className="shrink-0 text-tertiary">{relation.workItem.displayId}</span><span className="truncate">{relation.workItem.title}</span></Link>
          {canWrite && <button type="button" className="grid size-6 shrink-0 place-items-center rounded-md !bg-transparent !p-0 text-secondary hover:!bg-layer-transparent-hover hover:text-danger-text" aria-label={`${translate("relations.remove")} ${relation.workItem.displayId}`} title={translate("relations.remove")} onClick={async () => done(await action("remove_work_item_relation", { workItemId, relatedWorkItemId: relation.workItem.id }))}><X aria-hidden size={13} /></button>}
        </li>)}</ul>
      </div>;
    })}
    {canWrite && showForm && <Dialog title={translate("relations.addTitle")} onClose={onClose}>
      <form className="grid gap-3" onSubmit={async (event) => {
        event.preventDefault();
        const result = await action("create_work_item_relation", { workItemId, relatedWorkItemId: target, type });
        if (result !== null) { setTarget(""); onClose(); }
        await done(result);
      }}>
        <label className="grid gap-1 text-13 text-secondary">{translate("relations.typeLabel")}<select value={type} onChange={(event) => setType(event.target.value as RelationType)}>
          {types.map((value) => <option key={value} value={value}>{translate(`relations.type.${value}`)}</option>)}
        </select></label>
        <label className="grid gap-1 text-13 text-secondary">{translate("relations.target")}<select required value={target} onChange={(event) => setTarget(event.target.value)}>
          <option value="">{translate("relations.choose")}</option>
          {candidates.filter((candidate) => !linked.has(candidate.id)).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.displayId} {candidate.title}</option>)}
        </select></label>
        <DialogActions onClose={onClose} submit={translate("relations.add")} />
      </form>
    </Dialog>}
    {note && <p role="alert">{note}</p>}
  </section>;
}
