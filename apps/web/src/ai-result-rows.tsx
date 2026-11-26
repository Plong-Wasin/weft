import React from "react";
import { Box, Check, FileText, FolderKanban, RefreshCw } from "lucide-react";
import { Link } from "react-router";
import { translate, translateDynamic } from "@weft/shared";
import { Card } from "@/ui/card";
import { StateIcon } from "./property-dropdowns";
import { targetPath, type AppliedResult, type Target, type TargetKind } from "./ai-results";
import type { StateGroup } from "./types";

const kindIcon: Record<Exclude<TargetKind, "work_item">, React.ComponentType<{ size: number; "aria-hidden": true; className?: string }>> = { wiki_page: FileText, cycle: RefreshCw, module: Box, project: FolderKanban };
const row = "flex min-h-11 min-w-0 items-center gap-2 px-3 py-2 text-14";

const actionLabel = (action: string) => translateDynamic(`ai.action.${action}`) ?? translate("ai.result.change");

function Icon({ target }: { target: Target }) {
  if (target.kind === "work_item") return <span className="flex shrink-0"><StateIcon group={target.stateGroup as StateGroup} /><span className="sr-only">{translateDynamic(`states.group.${target.stateGroup}`)}</span></span>;
  const KindIcon = kindIcon[target.kind];
  return <KindIcon aria-hidden size={14} className="shrink-0 text-muted-foreground" />;
}

function TargetRow({ target, verb, slug }: { target: Target; verb: AppliedResult["verb"]; slug: string }) {
  const deleted = target.status === "deleted";
  const content = <>
    <Icon target={target} />
    {target.displayId && <span className="shrink-0 font-mono text-12 text-muted-foreground">{target.displayId}</span>}
    <span className={`min-w-0 flex-1 truncate ${deleted ? "text-muted-foreground line-through" : "text-foreground"}`} title={target.title}>{target.title}</span>
    {target.status !== "available" && <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-12 font-medium text-muted-foreground">{translate(`ai.result.status.${target.status}`)}</span>}
    {verb !== target.status && <span className="shrink-0 text-12 text-muted-foreground">{translate(`ai.result.${verb}`)}</span>}
  </>;
  return deleted ? <div className={row}>{content}</div> : <Link to={targetPath(slug, target)} className={`${row} hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring`}>{content}</Link>;
}

function LabelRow({ label, note }: { label: string; note?: string }) {
  return <div className={row}><Check aria-hidden size={14} className="shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate text-foreground">{label}</span>{note && <span className="shrink-0 text-12 text-muted-foreground">{note}</span>}</div>;
}

/**
 * One compact list of applied Write actions. `targets` holds only what the viewer may see: undefined while it loads, and a reference
 * missing from it shows as not available, with no title.
 */
export function ResultList({ results, targets, slug, heading }: { results: AppliedResult[]; targets: Target[] | undefined; slug: string; heading: string }) {
  const found = new Map(targets?.map((target) => [`${target.kind}:${target.ref}`, target]));
  return <Card data-results className="overflow-hidden rounded-xl p-0">
    <p role="status" className="m-0 border-b border-border px-3 py-1.5 text-12 font-medium text-muted-foreground">{heading}</p>
    <ul role="list" className="m-0 grid list-none grid-cols-[minmax(0,1fr)] divide-y divide-border p-0">
      {results.flatMap((result, index) => result.refs.length === 0
        ? [<li key={index}><LabelRow label={actionLabel(result.action)} /></li>]
        : result.refs.map((ref) => {
          const target = found.get(`${ref.kind}:${ref.id}`);
          return <li key={`${index}:${ref.id}`}>{target ? <TargetRow target={target} verb={result.verb} slug={slug} /> : <LabelRow label={actionLabel(result.action)} note={targets && translate("ai.result.unavailable")} />}</li>;
        }))}
    </ul>
  </Card>;
}
