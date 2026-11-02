# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Small to mid-size software teams that self-host their project tooling because the data must stay under their control. They track work items through cycles and modules, write wiki pages, and use an AI assistant to read project data and propose changes. Other audiences touch the product at its edges (people submitting work through Intake, readers of published pages), but they were not confirmed as design targets.

## Product Purpose

Weft is a self-hosted project management tool with a Plane-like UI. Teams track work items and write wiki pages; an AI assistant reads the data and proposes changes that a human confirms. Success: a team runs its planning in Weft, and AI assistance speeds the work without ever changing data the humans did not approve.

## Positioning

One shared Action surface serves the web UI, AI chat, CLI, and MCP clients, so every client does the same things under the same rules. AI proposals are approved one by one by a human, and the model is told what became of each proposal. A neighboring product cannot copy this without rebuilding its core around a single Action layer.

## Operating Context

Self-hosted via `docker compose` (Postgres, MinIO, API, Yjs live server, worker, web), optionally behind Caddy on a single root domain. Workspaces are the top-level tenant; a user can belong to many. Collaborative editing runs over a live WebSocket. Domain terms are fixed in `GLOSSARY.md` (Workspace, Project, Work item, State, Label, Cycle, Module, Intake, Estimate, Relation); UI copy must use them and avoid the listed alternatives (Issue, Ticket, Sprint, Epic, Tag, and so on).

## Capabilities and Constraints

- Work items with state, priority, assignees, labels, estimates, relations, sub-work items.
- Cycles, Modules, Intake, wiki pages, workspace Analytics and burndown, Exports (CSV/JSON).
- AI chat that proposes changes; the human confirms each one.
- CLI and MCP clients share the web app's Actions (`docs/mcp.md`).
- Platform is web only. UI language, brand assets, and accessibility standard are undecided.

## Evidence on Hand

Working app in `apps/web`, `GLOSSARY.md`, `README.md`, `docs/adr/`, `docs/mcp.md`. No customer testimonials, benchmarks, or pricing exist; do not fabricate them.

## Product Principles

- Humans stay in control: AI proposes, a person approves.
- One Action surface: no capability lives in only one client.
- Self-hosting is a first-class path, not an afterthought.
- Use the glossary's words consistently across UI, AI, CLI, and docs.
- Familiar project-management patterns beat novelty; users arrive knowing Plane-like tools.
