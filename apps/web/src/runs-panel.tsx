import React from "react";
import { formatDate, translate } from "@weft/shared";
import { ProposalSet } from "./ai-chat";
import { runFailureText } from "./run-failure";
import { canCancelRun, canRerunRun, isActiveRun, runStatusKey } from "./run-status";

type Run = { id: string; originatorId: string; status: string; attempt: number; rerunOfId: string | null; inputTokens: number; outputTokens: number; createdAt: string; startedAt: string | null; finishedAt: string | null; failureMessage: string | null; failureReason: string | null };
type Step =
  | { seq: number; kind: "thought" | "answer" | "question" | "error"; text: string }
  | { seq: number; kind: "tool_call"; toolName: string; input: unknown; result: unknown; failed: boolean };
type Transcript = { steps: Step[]; runtimeProfile: { name: string; sandbox: string; enforceSandbox: boolean } | null; failureMessage: string | null; failureReason: string | null; confirmations: Array<{ id: string; status: string }> };
type Action = <T>(name: string, body: unknown) => Promise<T | null>;

const pollMs = 2_000;
const stepLabel = { thought: "runs.thought", answer: "runs.answer", question: "runs.question", error: "runs.error" } as const;
const pretty = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2);

function StepView({ step }: { step: Step }) {
  if (step.kind === "tool_call") return <li data-step="tool_call" className="grid gap-1">
    <span className="font-medium">{translate("runs.tool")}: {step.toolName}{step.failed ? ` (${translate("runs.toolFailed")})` : ""}</span>
    <details className="text-12 text-tertiary"><summary className="cursor-pointer">{translate("ai.details")}</summary>
      {step.input === null && step.result === null ? <p className="m-0">{translate("runs.hidden")}</p> : <><pre className="whitespace-pre-wrap">{pretty(step.input)}</pre>{step.result !== null && <pre className="whitespace-pre-wrap">{pretty(step.result)}</pre>}</>}</details>
  </li>;
  return <li data-step={step.kind}><span className="font-medium">{translate(stepLabel[step.kind])}: </span>{step.text}</li>;
}

function RunCard({ run, workspaceId, highlighted, canControl, action, tick, onChanged }: { run: Run; workspaceId: string; highlighted: boolean; canControl: boolean; action: Action; tick: number; onChanged: () => void }) {
  const [open, setOpen] = React.useState(highlighted);
  const [transcript, setTranscript] = React.useState<Transcript | null>(null);
  const [failed, setFailed] = React.useState(false);
  const failureText = runFailureText(run.failureReason);
  const waiting = run.status === "waiting_confirmation";
  const showTranscript = open || waiting;
  React.useEffect(() => { if (highlighted) document.getElementById(`run-${run.id}`)?.scrollIntoView({ block: "center" }); }, [highlighted, run.id]);
  React.useEffect(() => {
    if (!showTranscript) return;
    void action<Transcript>("get_run_transcript", { runId: run.id }).then((loaded) => { if (loaded) setTranscript(loaded); });
  }, [action, run.id, run.status, showTranscript, tick]);
  const control = async (name: "cancel_run" | "rerun_run") => { setFailed(await action(name, { runId: run.id }) === null); onChanged(); };
  const pending = (transcript?.confirmations ?? []).filter((card) => card.status === "pending").map((card) => card.id);
  return <li id={`run-${run.id}`} data-run-status={run.status} data-highlighted={highlighted || undefined} className={`grid gap-2 rounded-lg border bg-surface-1 px-4 py-3 ${highlighted ? "border-accent-strong" : "border-subtle"}`}>
    <div className="flex flex-wrap items-center gap-2 text-14">
      <strong data-testid="run-status">{translate(runStatusKey(run.status))}</strong>
      <small className="text-tertiary">{formatDate(run.createdAt)} · {translate("runs.attempt").replace("{attempt}", String(run.attempt + 1))} · {translate("runs.tokens").replace("{count}", String(run.inputTokens + run.outputTokens))}</small>
      {canControl && canCancelRun(run) && <button type="button" className="secondary" onClick={() => void control("cancel_run")}>{translate("runs.cancel")}</button>}
      {canControl && canRerunRun(run) && <button type="button" className="secondary" onClick={() => void control("rerun_run")}>{translate("runs.rerun")}</button>}
      {!waiting && <button type="button" className="secondary" aria-expanded={open} onClick={() => setOpen(!open)}>{translate(open ? "runs.hideTranscript" : "runs.showTranscript")}</button>}
    </div>
    {(failureText || run.failureMessage) && <div role="alert" className="grid gap-0.5 text-13 text-danger-text">
      {failureText && <p className="m-0">{failureText}</p>}
      {run.failureMessage && <p className="m-0 text-secondary">{translate("runs.failureDetail").replace("{detail}", run.failureMessage)}</p>}
    </div>}
    {failed && <p role="alert" className="text-13 text-danger-text">{translate("runs.failed")}</p>}
    {showTranscript && <div aria-label={translate("runs.transcript")}>
      {transcript?.runtimeProfile && <div className="rounded-md bg-surface-2 px-3 py-2 text-12" data-testid="run-runtime-profile"><strong>{translate("runs.runtimeProfileHeader")}: {transcript.runtimeProfile.name}</strong> · {translate(transcript.runtimeProfile.sandbox === "full" ? "runtimes.fullAccessWarning" : "runtimes.sandboxEnabled")}</div>}
      {transcript && transcript.steps.length === 0 && <p className="text-13 text-secondary">{translate("runs.noSteps")}</p>}
      <ol className="m-0 grid list-none gap-1.5 p-0 text-13">{transcript?.steps.map((step) => <StepView key={step.seq} step={step} />)}</ol>
    </div>}
    {pending.length > 0 && <ProposalSet ids={pending} refreshKey={tick} onResolved={onChanged} workspaceId={workspaceId} />}
  </li>;
}

/** The Agent Runs of a work item: status, transcript, cancel and rerun, and the Originator's pending Confirmations. Polls while a Run is active. */
export function RunsPanel({ workItemId, workspaceId, canControl, selfId, isAdmin, action, onActivity }: { workItemId: string; workspaceId: string; canControl: boolean; selfId: string; isAdmin: boolean; action: Action; onActivity: () => void }) {
  const [runs, setRuns] = React.useState<Run[] | null>(null);
  const [tick, setTick] = React.useState(0);
  const statuses = React.useRef<Record<string, string>>({});
  const focused = React.useMemo(() => new URLSearchParams(window.location.search).get("run"), []);
  const load = React.useCallback(async () => {
    const loaded = await action<Run[]>("list_runs", { workItemId });
    if (loaded === null) return;
    // A Run reaching a final status may have posted an Agent comment or changed the item: tell the page.
    const before = statuses.current;
    if (loaded.some((run) => before[run.id] !== undefined && before[run.id] !== run.status && !isActiveRun(run))) onActivity();
    statuses.current = Object.fromEntries(loaded.map((run) => [run.id, run.status]));
    setRuns(loaded);
    setTick((value) => value + 1);
  }, [action, workItemId, onActivity]);
  React.useEffect(() => { void load(); }, [load]);
  const anyActive = runs?.some(isActiveRun) ?? false;
  React.useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(() => void load(), pollMs);
    return () => clearInterval(timer);
  }, [anyActive, load]);
  if (runs === null || (runs.length === 0 && !focused)) return null;
  return <section aria-labelledby="runs-title" data-testid="runs-panel" className="grid gap-2">
    <h3 id="runs-title" className="text-16 font-medium text-primary">{translate("runs.title")}</h3>
    {focused && !runs.some((run) => run.id === focused) && <p role="status" className="text-13 text-secondary">{translate("runs.empty")}</p>}
    <ul className="m-0 grid list-none gap-2 p-0">{runs.map((run) => <RunCard key={run.id} run={run} workspaceId={workspaceId} highlighted={run.id === focused} canControl={canControl && (isAdmin || run.originatorId === selfId)} action={action} tick={tick} onChanged={() => void load()} />)}</ul>
  </section>;
}
