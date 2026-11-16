# Runs on a Runtime continue their Session in a stable folder

Today every Run on a Runtime starts a new agent CLI process in a fresh temporary directory that is deleted when the Run ends, and no session id is stored, so a second Run of the same Agent on the same work item remembers nothing of the first. With Agents waking each other (ADR 0013), a coder Agent that is woken for review round two would start from zero.

A Run on a Runtime now resumes the **Session** of the previous Run of the same Agent on the same work item and the same Runtime. The server stores the CLI's session id on the Run; the Daemon passes it to the CLI's resume option and works in one stable folder per Agent and work item inside the Daemon's work root, instead of a temporary directory. A Run starts a new Session when the previous Run failed or went stale, when the Runtime differs, when the folder is gone or the CLI rejects the resume, or when a person reruns it as new. The Daemon removes the folder when the work item is closed, or when nothing has used it for 7 days. Sandbox settings are still built fresh for each Run (ADR 0011), and the folder must lie inside the profile's allowed paths.

A Run on the Weft server keeps starting fresh. Its conversation grows with every Run, which raises token cost with each round, and it can already see earlier work through the work item and the comments an Agent posted.

## Alternatives rejected

- **Stay stateless.** Simplest, and nothing lingers on the owner's computer, but every wake-up in a chain re-reads the work item and loses what was tried; the review loop of ADR 0013 would repeat itself.
- **Replay earlier transcripts into the next prompt.** It works for the Weft server and for every CLI, but the prompt grows without a bound, and today Agents are denied the run-reading actions, so a transcript is not something an Agent is meant to see. Using the CLI's own resume keeps the transcript out of Weft.
- **Resume on the Weft server too.** Rejected for cost, as above.

## Consequences and limits

Files from a work item stay on the Runtime owner's computer until the item is closed or unused for 7 days, longer than the single Run they lived for before. The Runtime owner already owns that risk (ADR 0009, ADR 0011), but it is now visible in the length of time, not only the Run. A stale or poisoned Session can carry a mistake or an injected instruction into later Runs; starting a new Session after a failure and on a person's request is the only repair. Multica, which this follows, keys the Session by agent and issue, resumes only on the same Runtime, and keeps a list of failure kinds that make a resume unsafe; the first version here treats any failed or stale previous Run as unsafe and may refine that later. The Run's CLI must support resume; a CLI that does not simply starts a new Session every time.
