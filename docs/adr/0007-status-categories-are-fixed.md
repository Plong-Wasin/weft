# ADR-0007: Status categories are fixed at five

- **Status:** Accepted
- **Date:** 2026-10-31

## Context

Statuses are customizable per Workspace, but the system reads their meaning: completion stamps `completed_at`, overdue and Milestone progress treat finished work as closed, and boards group Statuses into columns. The first model had four categories (`not_started`, `active`, `completed`, `canceled`) and let an admin move a Status to another category, which silently reclassified every Task in it.

## Decision

Statuses belong to exactly one of five categories, in this order: `not_started` (Not started), `active` (In progress), `blocked` (Blocked), `wont_do` (Won't do), `completed` (Completed). The set is fixed in the schema (a CHECK constraint) and in the API. A Status's category is chosen when it is created and never changes: the API answers `category_fixed` and a database trigger refuses the same write from anywhere else.

`canceled` was renamed to `wont_do`. The migration changes the category value only; Status keys, Task rows and History rows name Status keys, so they keep working. `completed` and `wont_do` are closed categories; `not_started`, `active` and `blocked` are open.

A new Workspace is seeded with three Statuses (Todo, In progress, Done). One not-started Status per Workspace is the default for new Tasks, stored as `is_default` instead of being hard-coded to a key; Workspaces created before this decision keep `backlog` as their default.

## Alternatives considered

- **Keep category changes, reclassify Tasks.** Rejected: it rewrites completion and overdue meaning for existing Tasks and made Undo unsafe.
- **User-defined categories.** Rejected: every consumer (progress, overdue, boards, AI tools) would need to learn the meaning of each one.
