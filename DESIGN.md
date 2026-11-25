# Design system (as shipped)

This document records the design system as the web app ships it today. It was derived from the built UI and the shared style sheets, not from intentions. New screens should match it. Where the shipped UI disagrees with this document, the UI is the fact and this document needs an update.

Product context and terms: see the product brief and the glossary at the repo root. UI copy uses glossary terms (Work item, Project, Cycle, Module, Intake, Wiki page) and avoids the terms the glossary lists as alternatives.

## Direction

The product owner wants a tool that can do many things and still feels easy and uncluttered, in the spirit of Height. Plane is the structural base only (ADR-0019); the look below is the target, and the sections after it describe what ships today.

- **Capability stays, clutter goes.** Every capability remains reachable; it is not all visible at once.
- **One primary action per row, card and screen.** The other actions live one step away: a "more" menu, or on hover and focus. They are always reachable by keyboard and by touch, so nothing depends on hover alone.
- **Separate with space and type, not boxes.** Use whitespace, weight and size to group. A border or card must carry meaning (a container the person acts on, a boundary of a danger zone), not decorate.
- **Quiet by default.** Neutral surfaces. The accent colour marks the primary action and focus; the status colours mark status only.
- **Conversation reads as a calm stream.** Comments, activity and the AI chat are stacked, lightly separated entries with the reply field next to what is being replied to.
- **Keyboard is the fast path.** The command palette and shortcuts reach every frequent action; every menu item also has a keyboard path.
- **Destructive actions ask.** Delete and similar actions confirm and sit apart from the safe ones.

## Tokens

- All colour and most scale values are CSS custom properties defined once, in the token sheet, and read by Tailwind utilities in the main style sheet.
- Colour is defined in oklch. The light theme is the default `:root` set; the dark theme overrides the same names under `:root[data-theme="dark"]`. The theme is set on the root element: light, dark, or follows the system preference.
- Surface and text roles: `--bg-canvas` (page background), `--bg-surface-1` (cards and panels), `--bg-layer-1` to `--bg-layer-3` (nested layers and hover/selected fills), `--txt-primary`, `--txt-secondary`, `--txt-tertiary`, `--txt-placeholder`, `--txt-disabled`.
- Accent: `--bg-accent-primary` with `--bg-accent-primary-hover` and `--bg-accent-primary-active`; subtle accent fills use `--bg-accent-subtle`. Links use the `--txt-link-primary` role.
- Status colours come in success, warning and danger roles (`--bg-danger-primary`, `--bg-success-primary`, `--bg-warning-primary`), each with subtle backgrounds and matching borders.
- Borders: `--border-subtle` for dividers, `--border-strong` for control outlines, `--border-accent-strong` for focus. Border widths are `--border-width-md` and `--border-width-lg`.
- Shadow: `--shadow-menu` is the only shadow token; it backs floating menus and popups.
- Label colours and editor palette colours exist as fixed sets; they are data colours, not chrome.

## Type

- Body face: Inter (variable). Code face: IBM Plex Mono, used for code blocks, inline code and the ProseMirror code marks.
- Body text is 14px (`--text-14`). The scale is `--text-9` through `--text-40`; in practice screens use 12px for meta text, 13px for dense labels, 14px for body and controls, 16 to 20px for section titles, 24 to 28px for page titles and 40px only for the wiki page title.
- Weights: regular 400 is the base weight; labels, headings and large counts use the heavier weights the variable face provides. The heavy 800 weight is defined as a token.
- Text uses the `--txt-*` roles above; secondary text (descriptions, meta, empty-state copy) is always `--txt-secondary` or `--txt-tertiary`, never a new grey.

## Spacing and layout

- The spacing base is 4px (`--spacing` is 0.25rem); Tailwind spacing steps are multiples of it. Common steps in the shipped UI: 4, 6, 8, 12, 16, 24px.
- Page gutter: `--padding-page-x` and `--padding-page-y` are 1.35rem. At phone width no route may scroll the page sideways.
- Top bar height: `--height-header` (3.25rem). The top bar holds the menu button on phone, the workspace switcher, search, quick actions, notifications, help and the profile avatar.
- Desktop shell: an icon rail (Work, Wiki, AI, Settings) on the left, a secondary sidebar with the project tree, and the main column. Phone (below 768px): the sidebar becomes a drawer opened from the top bar's menu button; the drawer carries the same navigation.
- Content width: list and form screens fill the main column; settings and single-column forms cap their width so lines stay readable.

## Radius and elevation

- Radius scale: `--radius-xs` (2px), `--radius-sm`, `--radius-md` (6px, the default for controls and buttons), `--radius-lg`, `--radius-xl`, `--radius-2xl`, `--radius-3xl` (cards and sheets).
- Elevation: cards are flat on the canvas with a subtle border; only floating menus, popups and the drawer use `--shadow-menu` and the backdrop tone.

## Components

- Buttons: a primary (accent fill, white text) for the one main action of a screen; a secondary (surface fill, strong border) for every other action; a ghost icon button in the top bar and toolbars; a danger variant (red fill) only inside a Danger zone section.
- Text fields and selects: bordered, `--radius-md`, placeholder in `--txt-placeholder`; labels sit above fields.
- Search fields: a bordered field with a leading magnifier; the global search opens a results list below it.
- Tabs: text tabs with an accent underline for the active one (used for Upcoming, Active, Completed; All, Public, Private, Archived; Overview, Work items; List, Board, Spreadsheet, Calendar, Gantt).
- Toolbar chips and view switchers: a grouped row of icon-and-label toggles; a filter chip row follows it when filters are active.
- Work item row: desktop lists use a 12px muted column header and a shared fixed-column grid: checkbox, key, title, then State, Priority and the shown properties. State and Priority show an icon with their text. Rows stay on one line when the measured width permits; otherwise properties move below the title without a header. Phones keep the wrapping row. The list card has rounded corners, inset group bands, and rounded inset row hover and selected fills. Rows sit in group sections with a collapsible header that shows the count and a plus button to add.
- Property chips: list rows use muted, borderless text chips (a label keeps its colour dot); empty values show a muted dash in the same reachable control. Quiet chips gain the hover fill and keyboard focus ring when hovered or focused. Outlined pills remain on board cards, the spreadsheet and the work item detail page.
- Cards for summary numbers (analytics overview, work item counts) and for list-style items (cycles, modules, views).
- Danger zone: a bordered section with a red heading at the foot of settings pages, holding destructive actions only.
- Editor toolbar: a wrapping row of icon tools with separators; the rich text editor reads as an open page with a placeholder "Press '/' for commands".
- Popups and menus: anchored panel with `--shadow-menu`; close on outside click and Escape (the shared popover is the reference).
- Empty states: a single plain sentence in secondary text, sometimes with a create action. There is no illustration system.
- Focus: one focus ring for every keyboard-focusable control: a 2px outline in `--border-accent-strong`, offset 2px.

## Patterns

- Screen header: a back link ("Back to projects") above a title; the title row carries the project key and name, then page actions at the right (Settings, Add work item, Add page).
- Lists grouped by state or by section, with counts in the group header; collapsed groups stay visible as headers.
- Settings: a left list of sections inside the project settings area, each section a heading with a short description, then a form, then Danger zone last.
- Inline creation: settings lists (States, Labels, Estimates) show an existing list then a name field with an Add button below each group.
- Wiki and pages: a left tree (Inbox, All pages, Collections) and an editor column; page actions sit in the top right of the page (favourite, Ask AI, more menu).
- AI: an assistant page with suggested prompts, an input with a mode selector (Build) and a send button; an AI disclaimer line sits below the input.
- Phone: the same content stacks in one column; filters wrap into rows; wide tables keep their columns and do not scroll the page.
- Motion: short transitions on popups and drawers. The visual capture emulates reduced motion and turns off animation and transitions before each shot.

## Known gaps against this system

These come from the design review baseline (see the findings report under the local review folder). They are recorded here so new screens do not copy them.

- Long names truncate to one or two characters on phone (module names, view titles, member names).
- A few headers and filter rows overlap or wrap awkwardly at phone width.
- Some phone rows put three or more buttons on one line.
- The rich-text page title does not wrap on phone width.
