import React from 'react';

// Review helpers for a Proposal that came from an AI run. Every edit here only reshapes the draft
// Proposal; nothing reaches Tasks until the member approves it.

export type ReviewItem = { id: string; kind: string; selected: boolean; depends_on?: string[]; reason: string; sources: unknown[]; [key: string]: unknown };

export function sourceLabel(source: unknown): string {
  if (typeof source === 'string') return source;
  const entry = source as { kind?: string; id?: string; label?: string } | null;
  if (!entry) return 'Unknown source';
  if (entry.kind === 'user_request') return 'Your request';
  if (entry.label) return entry.label;
  return `${entry.kind ?? 'source'} ${String(entry.id ?? '').slice(0, 8)}`.trim();
}

export function itemName(item: ReviewItem): string {
  return String(item.title ?? item.name ?? item.path ?? (item.kind === 'relation' ? 'Task link' : item.id));
}

/** A readable name for a link row: its type and the two Tasks it joins. */
export function rowName(item: ReviewItem, all: ReviewItem[]): string {
  if (item.kind !== 'relation') return itemName(item);
  const end = (id: unknown, label: unknown) => { const found = all.find((other) => other.id === id); return found ? itemName(found) : typeof label === 'string' ? label : 'an existing Task'; };
  return item.relation === 'parent' ? `parent link: ${end(item.source_task_id, item.source_label)} is the parent of ${end(item.target_task_id, item.target_label)}` : `${String(item.relation ?? 'related')} link: ${end(item.source_task_id, item.source_label)} to ${end(item.target_task_id, item.target_label)}`;
}

function endpointIds(item: ReviewItem): string[] {
  return item.kind === 'relation' ? [item.source_task_id, item.target_task_id].filter((id): id is string => typeof id === 'string') : [];
}

/** Unticking a row also unticks what needs it. The server cascades through `depends_on`, so links between drafted Tasks are unticked here before the request. */
export function untickBrokenLinks<T extends ReviewItem>(items: T[], id: string): T[] {
  const gone = new Set([id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const item of items) {
      if (item.selected && !gone.has(item.id) && item.depends_on?.some((dep) => gone.has(dep))) { gone.add(item.id); changed = true; }
    }
  }
  return items.map((item) => (item.kind === 'relation' && item.selected && endpointIds(item).some((endpoint) => gone.has(endpoint)) ? { ...item, selected: false } : item));
}

/** Rejecting a row removes it, everything that needs it, and the links that touch it. */
export function rejectItem<T extends ReviewItem>(items: T[], id: string): { items: T[]; removed: T[] } {
  const gone = new Set([id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const item of items) {
      if (gone.has(item.id)) continue;
      if (item.depends_on?.some((dep) => gone.has(dep)) || endpointIds(item).some((endpoint) => gone.has(endpoint))) { gone.add(item.id); changed = true; }
    }
  }
  return { items: items.filter((item) => !gone.has(item.id)), removed: items.filter((item) => gone.has(item.id)) };
}

/** Merging folds one draft Task into another: text is combined and links are re-pointed. */
export function mergeItems<T extends ReviewItem>(items: T[], fromId: string, intoId: string): T[] {
  const from = items.find((item) => item.id === fromId);
  const into = items.find((item) => item.id === intoId);
  if (!from || !into || from.kind !== 'task' || into.kind !== 'task' || fromId === intoId) return items;
  const join = (a: unknown, b: unknown) => [a, b].filter((text): text is string => typeof text === 'string' && text.trim() !== '').join('\n\n');
  const criteria = [...(Array.isArray(into.acceptance_criteria) ? into.acceptance_criteria : []), ...(Array.isArray(from.acceptance_criteria) ? from.acceptance_criteria : [])];
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (item.id === fromId) continue;
    let next: T = item;
    if (item.id === intoId) {
      const needs = [...new Set([...(item.depends_on ?? []), ...(from.depends_on ?? [])])].filter((dep) => dep !== fromId && dep !== intoId);
      next = { ...item, description: join(into.description, from.description), acceptance_criteria: criteria, depends_on: needs, edited: true };
    } else {
      const deps = item.depends_on?.map((dep) => (dep === fromId ? intoId : dep));
      if (deps) next = { ...next, depends_on: [...new Set(deps)] };
      if (item.kind === 'relation') {
        const swap = (value: unknown) => (value === fromId ? intoId : value);
        next = { ...next, source_task_id: swap(item.source_task_id), target_task_id: swap(item.target_task_id) };
        if (next.source_task_id === next.target_task_id) continue;
        const key = `${next.relation}:${String(next.source_task_id)}:${String(next.target_task_id)}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
    }
    result.push(next);
  }
  return result;
}

export type ApprovalSummary = { created: number; updated: number; linked: number; scope: string[] };

export function approvalSummary(items: ReviewItem[], scope: unknown, projects: { id: string; name: string }[], vaults: { id: string; name: string }[]): ApprovalSummary {
  const kept = items.filter((item) => item.selected);
  const touched = new Set<string>();
  for (const relation of kept.filter((item) => item.kind === 'relation')) {
    for (const endpoint of endpointIds(relation)) if (!endpoint.startsWith('tmp-')) touched.add(endpoint);
  }
  const updated = touched.size + kept.filter((item) => item.kind === 'skill').length;
  const raw = scope as { project_ids?: string[]; vault_ids?: string[] } | null;
  const names = [
    ...(raw?.project_ids ?? []).map((id) => `Project ${projects.find((project) => project.id === id)?.name ?? id}`),
    ...(raw?.vault_ids ?? []).map((id) => `Vault ${vaults.find((vault) => vault.id === id)?.name ?? id}`),
  ];
  return { created: kept.filter((item) => item.kind === 'task').length, updated, linked: kept.filter((item) => item.kind === 'relation').length, scope: names };
}

/** Swap in a regenerated draft Task, keeping the row's identity, place in the tree and selection. */
export function applyRegeneratedRow<T extends ReviewItem>(items: T[], rowId: string, drafts: ReviewItem[], replaceEdited: boolean): T[] {
  const fresh = drafts.filter((item) => item.kind === 'task');
  if (fresh.length === 0) return items;
  const rows = items.filter((item) => item.kind === 'task');
  const targets = new Map<string, ReviewItem>([[rowId, fresh[0]]]);
  if (replaceEdited) {
    const others = rows.filter((item) => item.id !== rowId && item.edited === true);
    others.forEach((item, index) => { const draft = fresh[index + 1]; if (draft) targets.set(item.id, draft); });
  }
  return items.map((item) => {
    const draft = targets.get(item.id);
    if (!draft) return item;
    return { ...item, title: draft.title, description: draft.description ?? '', acceptance_criteria: draft.acceptance_criteria, status: draft.status, attributes: draft.attributes, guesses: draft.guesses, reason: draft.reason, sources: draft.sources, edited: false };
  });
}

type Guesses = { assignees?: unknown[]; due_date?: string; start_date?: string };

export function guessLines(item: ReviewItem): string[] {
  const guesses = (item.guesses ?? {}) as Guesses;
  const lines: string[] = [];
  const assignees = (guesses.assignees ?? []).map((entry) => (typeof entry === 'string' ? entry : String((entry as { name?: string })?.name ?? ''))).filter(Boolean);
  if (assignees.length) lines.push(`Guessed assignee: ${assignees.join(', ')}`);
  if (guesses.start_date) lines.push(`Guessed start date: ${guesses.start_date}`);
  if (guesses.due_date) lines.push(`Guessed due date: ${guesses.due_date}`);
  return lines;
}

type EditorProps = {
  item: ReviewItem;
  all: ReviewItem[];
  statuses: { key: string; name: string }[];
  busy: boolean;
  canRegenerate: boolean;
  onEdit: (id: string, patch: Record<string, unknown>) => void;
  onReject: (id: string) => void;
  onMerge: (fromId: string, intoId: string) => void;
  onRegenerate: (id: string, instruction: string, replaceEdited: boolean) => void;
};

/** The expanded row of an AI Proposal: why it is there, what it read, and the editable fields. */
export function ProposalRowEditor({ item, all, statuses, busy, canRegenerate, onEdit, onReject, onMerge, onRegenerate }: EditorProps) {
  const [instruction, setInstruction] = React.useState('');
  const [replaceEdited, setReplaceEdited] = React.useState(false);
  const [mergeTarget, setMergeTarget] = React.useState('');
  const name = itemName(item);
  const guesses = guessLines(item);
  const mergeChoices = all.filter((other) => other.kind === 'task' && other.id !== item.id);
  const names = (ids: string[]) => ids.map((id) => all.find((other) => other.id === id)).filter((other): other is ReviewItem => !!other).map(itemName);
  const links = all.filter((other) => other.kind === 'relation' && endpointIds(other).includes(item.id));
  const attributes = Object.entries((item.attributes ?? {}) as Record<string, unknown>);
  const blur = (field: string, current: unknown, raw: string, parse: (value: string) => unknown = (value) => value) => {
    const next = parse(raw);
    if (JSON.stringify(next) !== JSON.stringify(current ?? (Array.isArray(next) ? [] : ''))) onEdit(item.id, { [field]: next });
  };
  const criteria = Array.isArray(item.acceptance_criteria) ? item.acceptance_criteria.map(String) : [];
  const key = `${item.id}:${String(item.title)}:${String(item.description)}:${criteria.join('|')}:${String(item.status ?? '')}`;
  return <div className="proposal-diff proposal-editor" key={key}>
    <p><strong>Why:</strong> {item.reason}</p>
    <p className="proposal-sources"><strong>Sources:</strong> {item.sources.length ? item.sources.map((source, index) => <span className="chip" key={index}>{sourceLabel(source)}</span>) : 'None recorded'}</p>
    {guesses.length > 0 && <div className="proposal-guess" role="note"><strong>Guessed by the AI, check before approving</strong>{guesses.map((line) => <span key={line}>{line}</span>)}</div>}
    {item.kind === 'task' ? <>
      <label>Title<input aria-label={`Title for ${name}`} defaultValue={String(item.title ?? '')} maxLength={500} disabled={busy} onBlur={(event) => { const value = event.target.value.trim(); if (value) blur('title', item.title, value); else event.target.value = String(item.title ?? ''); }} /></label>
      <label>Description<textarea aria-label={`Description for ${name}`} rows={3} defaultValue={String(item.description ?? '')} disabled={busy} onBlur={(event) => blur('description', item.description, event.target.value)} /></label>
      <label>Acceptance criteria, one per line<textarea aria-label={`Acceptance criteria for ${name}`} rows={3} defaultValue={criteria.join('\n')} disabled={busy} onBlur={(event) => blur('acceptance_criteria', criteria, event.target.value, (value) => value.split('\n').map((line) => line.trim()).filter(Boolean))} /></label>
      <label>Status<select aria-label={`Status for ${name}`} value={String(item.status ?? '')} disabled={busy} onChange={(event) => onEdit(item.id, { status: event.target.value || undefined })}><option value="">Default Status</option>{statuses.map((status) => <option key={status.key} value={status.key}>{status.name}</option>)}</select></label>
      {attributes.length > 0 && <dl className="proposal-attributes">{attributes.map(([attribute, value]) => <React.Fragment key={attribute}><dt>{attribute}</dt><dd>{String(value)}</dd></React.Fragment>)}</dl>}
      {item.source_task_id && <p><strong>Parent:</strong> split from an existing Task ({item.split_mode === 'peer' ? 'as a peer' : 'as a subtask'}).</p>}
      {(item.depends_on?.length ?? 0) > 0 && <p><strong>Needs first:</strong> {names(item.depends_on ?? []).join(', ')}</p>}
      {links.length > 0 && <p><strong>Links:</strong> {links.map((link) => `${String(link.relation ?? 'related')} (${names(endpointIds(link)).join(' to ') || 'existing Task'})`).join('; ')}</p>}
      <div className="proposal-row-actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => onReject(item.id)}>Reject {name}</button>
        {mergeChoices.length > 0 && <span className="proposal-merge"><select aria-label={`Merge ${name} into`} value={mergeTarget} disabled={busy} onChange={(event) => setMergeTarget(event.target.value)}><option value="">Merge into…</option>{mergeChoices.map((other) => <option key={other.id} value={other.id}>{itemName(other)}</option>)}</select><button type="button" className="secondary" disabled={busy || !mergeTarget} onClick={() => { onMerge(item.id, mergeTarget); setMergeTarget(''); }}>Merge {name}</button></span>}
      </div>
      {canRegenerate && <fieldset className="proposal-regenerate" disabled={busy}><legend>Regenerate this row</legend>
        <label>What should change?<input aria-label={`Instruction to regenerate ${name}`} value={instruction} maxLength={500} onChange={(event) => setInstruction(event.target.value)} placeholder="Optional, for example: split by platform" /></label>
        <label className="check"><input type="checkbox" checked={replaceEdited} onChange={(event) => setReplaceEdited(event.target.checked)} />Also replace my manual edits on other rows</label>
        <button type="button" className="secondary" onClick={() => onRegenerate(item.id, instruction, replaceEdited)}>Regenerate {name}</button>
      </fieldset>}
    </> : <>
      {item.kind === 'relation' && <p><strong>Link type:</strong> {String(item.relation ?? 'related')}</p>}
      {typeof item.diff === 'string' ? <pre className="proposal-knowledge-preview" aria-label={`Proposed note diff for ${name}`}>{item.diff}</pre>
        : typeof item.preview === 'string' ? <pre className="proposal-knowledge-preview" aria-label={`Proposed file preview for ${name}`}>{item.preview}</pre>
          : <p>{String(item.description ?? item.content ?? item.body ?? item.reason)}</p>}
    </>}
  </div>;
}
