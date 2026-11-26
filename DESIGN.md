# Design system

This document describes the shadcn/ui design system adopted across the web app. New and migrated screens follow shadcn defaults unless a documented product behavior needs an override. During the staged migration, unmigrated screens may still use legacy token utilities; each surface moves to the shadcn theme with its migration ticket.

Product context and terms: see the product brief and the glossary at the repo root. UI copy uses glossary terms (Work item, Project, Cycle, Module, Intake, Wiki page) and avoids the terms the glossary lists as alternatives.

## Direction

The web UI follows shadcn/ui's default neutral theme and component styling. The same features remain available while surfaces move over incrementally. Keep layouts airy, calm and predictable, with stable dimensions and aligned controls.

- **Capability stays, clutter goes.** Every capability remains reachable; it is not all visible at once.
- **One primary action per row, card and screen.** The other actions live one step away: a "more" menu, or on hover and focus. They are always reachable by keyboard and by touch, so nothing depends on hover alone.
- **Separate with space and type, not boxes.** Use whitespace, weight and size to group. A border or card must carry meaning (a container the person acts on, a boundary of a danger zone), not decorate.
- **Quiet by default.** Neutral surfaces. The accent colour marks the primary action and focus; the status colours mark status only.
- **Conversation reads as a calm stream.** Comments, activity and the AI chat are stacked, lightly separated entries with the reply field next to what is being replied to.
- **Keyboard is the fast path.** The command palette and shortcuts reach every frequent action; every menu item also has a keyboard path.
- **Destructive actions ask.** Delete and similar actions confirm and sit apart from the safe ones.

## Tokens

- The active theme uses shadcn roles such as `--background`, `--foreground`, `--card`, `--popover`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`, `--ring` and `--radius`.
- Theme values are defined in `apps/web/src/tokens.css` in oklch. Light is the default; dark overrides the same roles under `:root[data-theme="dark"]`.
- Tailwind classes use the matching utilities (`bg-background`, `text-foreground`, `bg-muted`, `text-muted-foreground`, `border-border`, `ring-ring`) rather than the legacy Weft aliases. Work item lists, boards, spreadsheets, details and peek, creation, property chips, filters, intake and their supporting panels now use the shadcn theme utilities; other surfaces remain on legacy aliases until their migration stage. Keep this transition limited to the affected surface and remove legacy definitions only in the final migration stage.
- Status and label colours may use standard Tailwind palette utilities where semantic status color is needed, with `dark:` variants following the app's `data-theme="dark"` setting; neutral app chrome stays on shadcn theme roles.

## Type

- Body face: Inter (variable). Code face: IBM Plex Mono, used for code blocks, inline code and the ProseMirror code marks.
- Body text follows the app's 14px base. Use the shadcn type scale for new work; existing screens may keep explicit pixel sizes during migration when that preserves alignment and row rhythm.
- Weights: regular 400 is the base weight; labels, headings and large counts use the heavier weights the variable face provides. The heavy 800 weight is defined as a token.
- Text uses theme roles: `foreground` for primary content and `muted-foreground` for secondary labels and metadata.

## Spacing and layout

- The spacing base is 4px (`--spacing` is 0.25rem); Tailwind spacing steps are multiples of it. Common steps in the shipped UI: 4, 6, 8, 12, 16, 24px.
- Page gutter: `--padding-page-x` and `--padding-page-y` are 1.35rem. At phone width no route may scroll the page sideways.
- Top bar height: `--height-header` (3.25rem). The top bar holds the menu button on phone, the workspace switcher, search, quick actions, notifications, help and the profile avatar.
- Desktop shell: an icon rail (Work, Wiki, AI, Settings) on the left, a secondary sidebar with the project tree, and the main column. Phone (below 768px): the sidebar becomes a drawer opened from the top bar's menu button; the drawer carries the same navigation.
- Content width: list and form screens fill the main column; settings and single-column forms cap their width so lines stay readable.

## Radius and elevation

- Use shadcn radius utilities and the shared `--radius` token. Prefer the primitive defaults; use modest rounding for controls and menus, and larger radii only for cards, dialogs and sheets.
- Elevation stays restrained: cards are flat with a border, while menus and popups use the shadcn shadow treatment.

## Components

### shadcn/ui primitives

Shared primitives live in `apps/web/src/ui/` and use Base UI 1.9.0 for accessible interaction behavior. Shadcn's default light and dark neutral theme variables are used by migrated controls; legacy screens retain their existing classes until their own migration. Keep Tailwind class names literal and combine conditional classes with `cn()` from `apps/web/src/lib/utils.ts`. Use shadcn's default component styling; override only for a documented Weft behavior.

- Buttons: controls use shadcn's 6px radius and 36px default height; `Button` variants are `primary`, `secondary`, `ghost` and `danger`. Use primary for the main action, secondary for other actions, ghost in toolbars and danger only for destructive actions. The default is secondary while legacy call sites are migrated. On coarse pointers every Button is at least 44px high, and an icon-only one at least 44px wide; icons never shrink to make room for padding.
- Text fields and selects: migrated controls use shadcn's `border-input`, `bg-background`, `text-foreground`, `text-muted-foreground`, and `ring-ring` tokens, with a 6px radius and a visible keyboard focus ring. Labels sit above fields. Native `<select>` remains for compact, phone-oriented forms where the platform picker is the more usable control.
- Input and Textarea use shadcn's neutral border, background, placeholder and focus tokens. Inputs stay 36px high on fine pointers and grow to at least 44px on coarse pointers; 16px text below the `md` breakpoint avoids mobile focus zoom. Textarea keeps native resizing and a 64px minimum height.
- Checkbox uses the Base UI shadcn primitive, including checked, unchecked, indeterminate, disabled and invalid states. It is 16px on fine pointers; on coarse pointers the element is a 44px target that still paints a 16px box. Switch is used for on/off settings and is at least 44px in each dimension on coarse pointers.
- Cards and popups: cards use a flat surface with a subtle border; dropdown menus use shadcn popover and border tokens with a restrained shadow. Menu rows use shadcn accent hover and focus fills; dialogs and sheets use their primitive defaults.
- Dialog and Sheet: modal forms and confirmations use the Base UI Dialog primitive styled with shadcn neutral tokens, a dimmed backdrop, focus containment, Escape dismissal and focus return. The mobile navigation uses Sheet as a left-side modal drawer with the same navigation content, a labeled 44px close target and an 85vw width cap. The wide work item peek stays independent.
  - Dialog keeps `rounded-2xl` (16px) as the documented Weft behavior requested for ticket 04, and constrains height to the viewport with internal scrolling.
  - Sheet uses `side="left"`, `w-72 max-w-[85vw]` and `rounded-r-2xl` to keep the existing navigation drawer's placement and width; its 44px close target stays reachable on touch screens.
- Search fields: a bordered field with a leading magnifier; the global search opens a results list below it.
- Tabs: Base UI shadcn tabs use a muted list surface and active tab treatment, with roving keyboard focus. Triggers have a 44px minimum height on coarse pointers. Route navigation stays ordinary navigation rather than claiming tab semantics.
- Toolbar chips and view switchers: a grouped row of icon-and-label toggles; a filter chip row follows it when filters are active.
- Work item row: desktop lists use a 12px muted column header and a shared fixed-column grid: checkbox, key, title, then State, Priority and the shown properties. State and Priority show an icon with their text. Rows stay on one line when the measured width permits; otherwise properties move below the title without a header. Phones keep the wrapping row. Current rows are 41px tall with shadcn Button sizing; the former 40px cap no longer applies. The list card has rounded corners, inset group bands, and rounded inset row hover and selected fills. Rows sit in group sections with a collapsible header that shows the count and a plus button to add.
- Board cards: clamp titles to two lines and keep their property controls in one horizontally scrollable row. Show populated properties first, summarize additional populated properties with `+N`, and reveal empty controls only while a card is hovered or focused; keep them keyboard reachable. Show selection checkboxes on hover, focus, or selection. Use 32px column controls, and pair an edge fade with a visible scroll button above the board.
- Spreadsheet: keep rows at 48px with one-line work item titles in a 384px desktop first column (256px on phones). Use ellipsis with the full title in a tooltip; keep empty property cells visually blank at rest while revealing their controls on row hover or focus.
- Intake rows use equal 112px minimum-height buttons with a vertical key, two-line title and one-line metadata rhythm; the full title remains available in its tooltip. Intake edit forms use the shared Select and MultiSelect controls, and show each edited property once. Accept is the primary decision action; Reject remains secondary.
- Property chips: list rows use muted, borderless text chips (a label keeps its colour dot); empty values show a muted dash in the same reachable control. Quiet chips gain the shadcn accent hover fill and keyboard focus ring when hovered or focused. Outlined pills remain on board cards, the spreadsheet and the work item detail page. Status and priority colors use standard Tailwind palette utilities; neutral surfaces, borders and text use shadcn theme roles.
- Work item detail and peek: the work item title is the page's `h1` (the project key stays in the breadcrumb); property section headings and value controls share a left edge, with equal-width values in the Properties panel. Keep Links as a collapsible section after the Timeline, and place the comment composer in normal flow with a clear gap after comment actions so it never covers them. Peek actions have their own divider, and Delete uses destructive text treatment.
- Cards for summary numbers (analytics overview, work item counts) and for list-style items (cycles, modules, views).
- Cycle and Module lists keep metadata in stable columns where space allows, and let those columns wrap as a consistent stack on narrow screens. A Cycle's work item removal lives in each row's overflow menu; its details use one progress bar, a label/value stat list and a state count list. Module filters use the shared shadcn Input and Select controls, and percentage text stays fully inside the progress ring.
- Danger zone: a bordered section with a red heading at the foot of settings pages, holding destructive actions only.
- Editor toolbar: a wrapping row of icon tools with separators; the rich text editor reads as an open page with a placeholder "Press '/' for commands".
- Dropdown menus: use the Base UI shadcn `DropdownMenu` primitive for action menus, including arrow-key navigation with wraparound, Home/End, outside dismissal and Escape focus restoration. Panels use `bg-popover`, `text-popover-foreground`, `border-border`, a restrained radius and shadow; rows use the primitive accent hover and focus fills. On coarse pointers, menu triggers and rows have a 44px minimum target. Panels cap their height to 32rem and the available viewport height, then scroll internally. Use the shared Popover only for non-menu panels.
- Select and Tooltip: `apps/web/src/ui/select.tsx` (shadcn Select on Base UI) and `apps/web/src/ui/tooltip.tsx` (Tooltip). Language and theme selectors use the Select: bordered trigger, neutral popup, check indicator, visible focus. Native selects remain for forms and settings where platform-native menus are useful, especially longer choices on touch screens. The desktop sidebar toggle, command palette, notifications and Sidecar icon controls show a Tooltip and keep their accessible names. Sizing overrides are `w-auto` on inline language/theme triggers (so they fit their labels instead of filling the auth footer/settings row) and `pointer-coarse:min-h-11 pointer-coarse:min-w-11` on Select and icon-only tooltip triggers (to preserve touch targets).
- Empty states: a short title and single plain sentence in secondary text, sometimes with a create action; an optional icon sits in a softly rounded tile. There is no illustration system.
- Focus: use the shadcn `ring` role for a consistent visible keyboard focus indicator.

### Shell and navigation

- The app rail, top bar and navigation sidebar use the shadcn sidebar and border roles, with muted foreground for secondary labels and accent fills for hover and selection.
- Workspace, project and wiki navigation keep their current features and dimensions. Equal row rhythm, truncation and touch targets take precedence over decorative styling.
- Global search uses the shadcn input treatment and a popover-like results surface. Inbox notifications and profile actions use the same neutral theme and menu row behavior.

## Patterns

- Screen header: a back link ("Back to projects") above a title; the title row carries the project key and name, then page actions at the right (Settings, Add work item, Add page).
- Lists grouped by state or by section, with counts in the group header; collapsed groups stay visible as headers.
- Settings: a left list of sections inside the project settings area, each section a heading with a short description, then a form, then Danger zone last.
- Inline creation: settings lists show existing rows first, then one creation action for the page. States keep their workflow groups as plain section headings; the shared add form asks for the State group first (labelled "State group", never "Group by", with no preselected group), and Cancel or Create returns focus to Add state.
- Settings navigation: workspace settings put the project picker before the Workspace section links; workspace and project section links share the same row height, type and selected treatment. Keep the cross-surface Inbox link in Work only. The Workspace links split into two blocks by a divider; the second block has no heading until a copy key exists for one.
- Project directory: keep one finder in the page header, with its visible title row aligned to the shared PageHeader. Its actions wrap inside the content column at every width (no fixed widths). Project rows have one compact, equal-height rhythm, truncate long names with the full name available as a title, and separate star and visibility metadata with quiet dividers.
- Inbox: use shared Tabs for All and Unread, a ghost action for Mark all read, and the shared EmptyState when the selected filter has no notifications. Populated notifications remain a readable stream with full text and reachable read-state actions.
- Analytics: use shared Select controls with stacked labels, right-aligned numeric table headers and tabular figures. On phone, project names clamp to two lines with the full name in a title, so every row keeps the same minimum height. Select triggers show the translated option label, never the internal value. State charts use the fixed state group colours from Settings > States (the same in light and dark) rather than one colour for every status.
- Read-only values (Workspace name and URL): a read-only input on the muted surface with muted text, out of the tab order, so it never looks like an editable field; editable inputs keep the background surface.
- Danger zones: use a muted destructive surface and an outlined destructive action; reserve the filled destructive button for a confirmation step.
- Wiki and pages: a left tree (Inbox, All pages, Collections) and an editor column; page actions sit in the top right of the page (favourite, Ask AI, more menu).
- AI: an assistant page with suggested prompts, an input with a mode selector (Build) and a send button; an AI disclaimer line sits below the input.
- Phone: the same content stacks in one column; filters wrap into rows; wide tables keep their columns and do not scroll the page.
- Calendar: month cells show only the day number; add controls stay visually quiet until hover or keyboard focus and remain visible on touch. Date ranges render as shared pills across each week, with equal-width day columns and stronger muted treatment outside the month; phones use an agenda of dated items.
- Gantt: work item labels use the standard 13px table scale, date ticks use 12px tabular figures, and bars use restrained state tints. The dashed one-pixel today marker sits behind row content, weekend columns use a muted surface, and issue keys stay outside the bars.
- Motion: short transitions on popups and drawers. The visual capture emulates reduced motion and turns off animation and transitions before each shot.

## Known gaps against this system

These come from the design review baseline (see the findings report under the local review folder). They are recorded here so new screens do not copy them.

- Long names truncate to one or two characters on phone (module names, view titles, member names).
- A few headers and filter rows overlap or wrap awkwardly at phone width.
- Some phone rows put three or more buttons on one line.
- The rich-text page title does not wrap on phone width.
