# Design

Replacement visual world for the Weft web app (redesign: the previous green-on-grey form kit is an anti-reference). Mode: Operate. Built code-first. Product truth lives in `PRODUCT.md`.

## Direction (pinned by the owner)

Quiet, fast, dense work tool. Interaction models: Height (inline edit, command palette, many views over one set of Tasks, bulk actions) and Slack (sidebar navigation, conversation, Inbox, mobile). References are for interaction patterns, not for copying a look. Light and dark both ship; one accent colour.

Scene: a team member at a desk during the working day, or on a phone between meetings approving a Proposal. Light is the default; dark follows `prefers-color-scheme` and a manual switch. Both are first-class.

## Structure

- **App shell:** persistent left sidebar (Inbox with unread badge, My work, Proposals with pending badge, Projects, Teams, Lists, Knowledge) plus a top bar with the view title, a segmented view switcher (Table, Kanban, Calendar, Timeline), search / command palette trigger and `New task`. The task list fills the viewport; nothing sits above it.
- **Create / import / export / Smart List builder / Create Project / Create Team** live in dialogs or Settings, never stacked on the list screen.
- **Task detail:** side panel next to the list on desktop, full-screen sheet on mobile. Title first, then one property bar (Status, Assignee, Priority, Due, Milestone) that autosaves with a visible saved/saving indicator. Main column: Description, Subtasks, References and Backlinks, Discussion. Notifications, Watchers, Team access, Repeat, Move, Archive sit under `More`. AI actions are one `Ask AI` menu.
- **Mobile:** bottom tabs with icons (Inbox, My work, Proposals, Search, Menu), badges on Inbox and Proposals, view choice in one dropdown, task rows as the default surface. Labels never break mid-word.
- **Command palette:** opens with a ranked list of commands and Tasks and shortcut hints; `?` opens help; `g` then a letter navigates. No syntax manual.
- **Auto vs approve mode:** the current mode is always visible near the AI entry point; a Proposal that AI holds back in auto mode is marked as needing the user.

## Colour (Restrained)

Neutrals tinted toward the accent hue, a second neutral layer for sidebar and panels, one accent used only for primary action, current selection, focus and state. Semantic set (success, warning, error, info) standardised. Define everything as tokens on `:root` with OKLCH values, redefine for dark under `prefers-color-scheme` and `[data-theme]`. Suggested accent: a cobalt blue-teal around `oklch(52% 0.13 235)`; adjust to pass contrast. Text ≥ 4.5:1 (the old `span.count` at 4.4:1 is a known failure).

## Typography

One family carries headings, labels, body and data. Self-hosted (no CDN: the product is self-hosted). Latin and Thai must render as one voice with matched weights: a Latin sans (not Inter, not on the training-default list) paired with Noto Sans Thai through `unicode-range` (for example `@fontsource-variable/*` packages). Fixed rem scale, ratio about 1.125–1.2. Thai line-height ≥ 1.5. Tabular numerals for counts and ids. `<html lang>` follows the locale.

## Components

Every interactive component has default, hover, focus-visible, active, disabled, loading, error. One button vocabulary (primary, secondary, ghost, danger), one control vocabulary for inputs/selects/checkboxes (no native default-looking controls). Icons come from one drawn set, single stroke weight (inline SVG or a library); no emoji or glyphs as icons. Skeletons for loading. Empty states teach the next action. Focus ring and row focus are always visible, because full keyboard operation is a release requirement. Theme selection, caret, scrollbars and focus rings from the palette.

## Motion

150–250 ms, state changes only (panel open, save indicator, selection). Respect `prefers-reduced-motion`. No page-load choreography.

## Bans specific to this world

No kicker/eyebrow above headings, no coloured `border-left` stripes on rows (use background and a leading marker), no card-in-card, no gradient text, no modal where an inline or panel pattern works.

## Localisation

Thai and English are equals: a visible language switch, a dictionary for every user-facing string, `Intl` dates (`dd/MM/yyyy`; Buddhist-era display optional later), no raw enum values (`normal`, `title`) shown to people. Glossary terms are fixed by `GLOSSARY.md` in both languages.
