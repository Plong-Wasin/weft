import React from "react";
import { translate } from "@weft/shared";
import { Link } from "react-router";
import { paths } from "./routes";

type RelationType = "blocks" | "blocked_by" | "duplicate" | "relates_to";
type Relation = { id: string; type: RelationType; workItem: { id: string; displayId: string; title: string } };
type Candidate = { id: string; displayId: string; title: string };
type Action = <T>(name: string, body: unknown) => Promise<T | null>;
const types: RelationType[] = ["blocks", "blocked_by", "duplicate", "relates_to"];

export function RelationsPanel({ workspaceSlug, workItemId, candidates, canWrite, action, onChange }: {
  workspaceSlug: string; workItemId: string; candidates: Candidate[]; canWrite: boolean; action: Action; onChange: () => void;
}) {
  const [relations, setRelations] = React.useState<Relation[]>([]);
  const [type, setType] = React.useState<RelationType>("blocks");
  const [target, setTarget] = React.useState("");
  const [note, setNote] = React.useState<string | null>(null);
  const load = React.useCallback(async () => setRelations(await action<Relation[]>("list_work_item_relations", { workItemId }) ?? []), [action, workItemId]);
  React.useEffect(() => { void load(); }, [load]);
  const linked = new Set(relations.map((relation) => relation.workItem.id));
  const done = async (result: unknown) => { setNote(result === null ? translate("relations.failed") : null); await load(); onChange(); };
  return <section>
    <h3>{translate("relations.title")}</h3>
    {relations.length === 0 && <p>{translate("relations.empty")}</p>}
    <ul>{relations.map((relation) => <li key={relation.id}>
      {translate(`relations.type.${relation.type}`)}{" "}
      <Link to={paths.workItem(workspaceSlug, relation.workItem.displayId)}>{relation.workItem.displayId} {relation.workItem.title}</Link>
      {canWrite && <button className="secondary" onClick={async () => done(await action("remove_work_item_relation", { workItemId, relatedWorkItemId: relation.workItem.id }))}>{translate("relations.remove")}</button>}
    </li>)}</ul>
    {canWrite && <form onSubmit={async (event) => {
      event.preventDefault();
      const result = await action("create_work_item_relation", { workItemId, relatedWorkItemId: target, type });
      if (result !== null) setTarget("");
      await done(result);
    }}>
      <select aria-label={translate("relations.title")} value={type} onChange={(event) => setType(event.target.value as RelationType)}>
        {types.map((value) => <option key={value} value={value}>{translate(`relations.type.${value}`)}</option>)}
      </select>
      <select aria-label={translate("relations.target")} required value={target} onChange={(event) => setTarget(event.target.value)}>
        <option value="">{translate("relations.choose")}</option>
        {candidates.filter((candidate) => !linked.has(candidate.id)).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.displayId} {candidate.title}</option>)}
      </select>
      <button>{translate("relations.add")}</button>
    </form>}
    {note && <p role="alert">{note}</p>}
  </section>;
}
