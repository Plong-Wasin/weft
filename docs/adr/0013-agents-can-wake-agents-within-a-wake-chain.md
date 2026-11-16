# Agents can wake other Agents, within a Wake chain

Supersedes the parts of ADR 0007 and ADR 0009 that say a change made by an Agent never fires a Trigger, an Agent's comment never starts a Run, and so Agents cannot wake each other. That rule was an MVP safeguard, and it makes an Agent hand-off useless: a coder Agent that assigns its work to a reviewer Agent starts nothing, and a person has to start every step.

An Agent's change now wakes another Agent through the same three paths a person's change does: assigning it a work item, mentioning it in a comment, and firing one of its event Triggers. No new tool is added; the Agent's instructions decide whom to wake, and nothing in Weft requires a "reviewer" or a "plan". Four limits replace the old rule:

- **Switch.** Only an Agent whose **Can wake Agents** switch is on can start a wake. The switch is off by default and only a workspace Admin turns it on, so existing Agents keep behaving as before.
- **Wake chain depth.** A Run a person or schedule starts has depth 0, and a Run woken by another Run has that Run's depth plus 1. A wake that would pass depth 6 does not happen; the work item gets an Activity that gives the reason and the Originator is notified. Six allows three coder-and-reviewer rounds.
- **One Originator.** The whole chain keeps the Originator of its first Run, including when the wake goes through a Trigger (a Trigger fired by a person's change still uses the Trigger's creator). The Originator must hold Agent access to the Agent being woken, checked at every wake, so an Agent cannot reach an Agent its Originator may not use.
- **Existing limits stay:** Runs per hour per person and per Agent, two concurrent Runs per Agent, the monthly token budget, and Confirmation or Autopilot as each Agent is configured. No new "confirm the plan" step is added.

Three changes keep a chain from losing work. A request for an Agent that already has an active Run on the work item is no longer dropped: it becomes one **Follow-up Run** per Agent and work item, started when the active Run ends and carrying the comments written meanwhile (at most 20 comments or 64 KiB, with a note when some are cut). A person's mention of an Agent whose Run on the Weft server is active is a **Steer**: the comment joins that Run at its next step. An Agent never steers another Agent, and a Run on a Runtime cannot be steered because its CLI is started once with no input channel; both fall back to a Follow-up Run. A new event Trigger, sub-items closed, wakes the Agent assigned to a parent when every sub-item is Done or Cancelled, which is how a split gets summarised. The "one active Run per Agent per work item" rule gets a database unique index, because the old check in code could be raced and now applies to every path that creates a Run.

Every action that can wake an Agent reports a **Wake outcome** per target: started, waiting, steered, or skipped with its reason. A skip never fails an Agent's own action.

## Alternatives rejected

- **Waking always on, as Multica does.** In Multica any Agent can wake any Agent its Originator may invoke, with no switch and no depth counter on assign and mention; its loop pause and hourly cap apply only to wakeup rules. An Agent that was safe because it could wake nobody would change behaviour silently, so we keep an Admin-owned switch and a depth limit.
- **A built-in split-and-review feature** (plan approval, reviewer role, stages). It adds concepts, and the behaviour already follows from Agent instructions plus the wake paths. Ordering therefore comes from assign, mention, and Triggers, not from `blocked by` or a stage number; `blocked by` stays information.
- **Agents steering Agents.** Multica allows it with caps of 10 per turn and 3 per Agent. A Follow-up Run needs no cap and cannot derail a Run in progress.
- **Per-rule loop pause and per-rule hourly cap from Multica.** The depth limit and the existing hourly limits already bound a chain.

## Consequences and limits

An Agent that has both the switch and Autopilot, or runs on a Runtime, can run a chain of up to seven Runs with nobody confirming in between; the limits above are then the only brake, so an Admin should turn the switch on only for Agents that need it. A prompt injected into a comment can now cause an Agent to wake another Agent, within the Originator's permissions. Multica's own assign path checks the assigner's person but runs as the issue's creator; here the Originator of the chain is the one identity for both the check and the Run, and tests must cover that.
