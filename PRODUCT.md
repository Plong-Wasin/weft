# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Teams of 5–30 people (measured up to about 100 active users) who run Weft themselves. They create and edit Tasks quickly, discuss work in the context of a Task, and ask AI to plan, split and link work. They do this on desktop (full keyboard operation) and on mobile (installable PWA, including reviewing and approving AI changes). An administrator sets up the shared AI connection once; permitted members use it, and personal connections are optional.

## Product Purpose
Weft is self-hosted, open-source (AGPL-3.0-only), AI-first work management. It exists so a team can turn goals into planned, linked, tracked work with AI doing the preparation, while people keep control. Success: creating and changing work feels as fast as typing a list, a Task explains its own status, conversation and history, and AI help never costs the team control of its data.

## Positioning
- AI works through the same permissions as people and prepares complete Proposals. Applying a Proposal is a user decision.
- The user chooses the AI mode per use: **approve mode** (every Proposal waits for a user's approval) or **auto mode** (AI may apply its own changes). In auto mode, AI still stops and asks for approval for any change it judges should need it. Auto mode never removes that escape hatch.
- Knowledge is Markdown in git-backed Vaults that people read on the web and AI edits only through Proposals.
- One installation, one public origin, Docker install; Core tasks keep working when the AI provider is down or no AI account is connected.

## Operating Context
- Work happens in Tasks, Projects, Milestones, Smart Lists, Table and Kanban views, Task chat, and an Inbox.
- Every effective Task edit has readable History (actor, time, old and new value); Undo/Redo collapses reverted edits so the Timeline shows only net effect.
- Tasks reference each other GitHub-style with `#123`, with autocomplete. A Reference is two-way: if A references B, B shows A as a Backlink. A viewer sees a Backlink only when they can read both Tasks, so a user without access to A never learns that A references B.
- Self-hosted via `docker/compose.yml`; frontend, API, WebSocket and attachments share one public domain.

## Capabilities and Constraints
- UI languages: Thai and English must both be supported.
- Vocabulary is fixed by `GLOSSARY.md`: Knowledge, Vault, Proposal, Skill, Team, Assignee, Reference, Backlink, Mention, Inbox, Workspace. Do not use the avoided terms (Wiki, Draft, Suggestion, Plan, Org and so on).
- Users never edit Knowledge notes directly; no Markdown editor, no real-time collaborative note editing.
- Out of scope: GitHub/GitLab integration, Height 2.0 cloning, native mobile apps, offline writes, marketplace, billing, federation, external webhooks, general automation engine.
- Open conflict: `GLOSSARY.md`, ADR-0006 and spec v0.4 say AI has no way to apply changes and there is no pre-authorized policy. The auto mode above contradicts that. Reconcile the spec and glossary before building it.
- Current state: the existing UI/UX is judged poor by the owner and needs a redesign.

## Brand Commitments
The owner names Height (height.app, now shut down) as the reference for the work-management experience: fast inline editing, bulk actions, command palette, many views over one set of Tasks. The reference is for interaction model and speed. The owner also names Slack as a second reference, for conversation, Inbox, sidebar navigation and the mobile experience. Both are references for interaction patterns, not for copying a look. No visual identity, logo or palette has been set.

## Evidence on Hand
Product specs in `docs/specs/` (v0.4 current), `GLOSSARY.md`, `docs/adr/`, and the running app (`docker/compose.yml`, Rust backend, React + Vite frontend in `apps/web`, Playwright e2e tests). No testimonials, customers, benchmarks or brand assets exist; none may be invented.

## Product Principles
1. Speed first: every common action is reachable in few steps, by mouse or keyboard.
2. People stay in control: AI proposes; the user decides how much it may apply on its own, and AI asks whenever it judges a decision to be the user's.
3. Context travels with the work: References, Backlinks, History and discussion sit on the Task, filtered by the viewer's permissions.
4. Permissions are never leaked: nothing a viewer cannot read appears, including through links.
5. Thai and English are equals, on desktop and phone.

## Accessibility & Inclusion
Full keyboard operation is a release requirement; every mouse function has a discoverable keyboard equivalent. Thai and English text must render and wrap correctly. A formal WCAG level has not been chosen.
