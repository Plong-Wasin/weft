# ADR 0020: shadcn/ui primitives on Base UI

Status: accepted
Date: 2026-11-25

## Context

Weft has several hand-written menus, popovers, dialogs and selects. Replacing them all at once would increase regression risk, so shared primitives and screens will be rebuilt on shadcn one group per pull request using a strangler delivery: each step remains usable and passes the existing acceptance flows.

## Decision

Use shadcn/ui as copied-in source under `apps/web/src/ui/`, with Base UI (`@base-ui/react`) as the primitive layer. Base UI is stable: its release history marks v1.0.0 stable and documents the package; the installed version is pinned to 1.9.0, the latest stable 1.9.x release on 2026-11-25. The Base UI documentation provides Tooltip, Select, Menu, Dialog, Popover, Tabs and Checkbox components, covering the planned primitive groups. This follows shadcn/ui's July 2026 default for new projects. Radix remains supported by shadcn, but is not the default for new projects.

Pin primitive dependencies exactly. Before adopting a newer Base UI minor, review its release notes and rerun the relevant primitive checks.

Use shadcn's default light and dark neutral theme variables in `apps/web/src/tokens.css`, beside the legacy Weft tokens. Do not map shadcn variables onto the legacy set. Migrated screens use the shadcn theme; legacy screens retain their existing classes until their own migration. Use literal Tailwind utility strings and merge classes through `cn()`.

## Consequences

- Components are owned and maintained in this repository; shadcn CLI output is a starting point, not a runtime dependency.
- `Tooltip` is the initial unused proof component. Later pull requests migrate one primitive group and its call sites at a time.
- Existing components and their public props stay untouched in this setup change.
- Work item layouts, property chips, Tiptap, calendar and gantt remain Weft-specific and are outside this migration.
- Revisit the primitive choice if shadcn stops maintaining the Base UI path or the CLI no longer supports it.

## References

- [shadcn/ui: Base UI as the default](https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default)
- [Base UI releases](https://base-ui.com/react/overview/releases)
- [Base UI Tooltip](https://base-ui.com/react/components/tooltip)
- [Base UI Select](https://base-ui.com/react/components/select)
- [Base UI Menu](https://base-ui.com/react/components/menu)
- [Base UI Dialog](https://base-ui.com/react/components/dialog)
- [Base UI Popover](https://base-ui.com/react/components/popover)
- [Base UI Tabs](https://base-ui.com/react/components/tabs)
- [Base UI Checkbox](https://base-ui.com/react/components/checkbox)
