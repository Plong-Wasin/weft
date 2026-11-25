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

- Radius scale: `--radius-xs` (2px), `--radius-sm`, `--radius-md` (6px), `--radius-lg` (8px; controls, buttons, menus and popovers), `--radius-xl` (12px; cards), `--radius-2xl` (16px; dialogs), and `--radius-3xl` (24px; sheets). Shared semantic tokens in `tokens.css` keep control, row, card and dialog geometry consistent.
- Elevation: cards are flat on the canvas with a subtle border; only floating menus, popups and the drawer use `--shadow-menu` and the backdrop tone.

## Components

### shadcn/ui primitives

Shared primitives live in `apps/web/src/ui/` and use Base UI 1.9.0 for accessible interaction behavior. Shadcn's default light and dark neutral theme variables are used by migrated controls; legacy screens retain their existing classes until their own migration. Keep Tailwind class names literal and combine conditional classes with `cn()` from `apps/web/src/lib/utils.ts`. Use shadcn's default component styling; override only for a documented Weft behavior.

- Buttons: controls use shadcn's 6px radius and 36px default height; `Button` variants are `primary`, `secondary`, `ghost` and `danger`. Use primary for the main action, secondary for other actions, ghost in toolbars and danger only for destructive actions. The default is secondary while legacy call sites are migrated.
- Text fields and selects: migrated controls use shadcn's `border-input`, `bg-background`, `text-foreground`, `text-muted-foreground`, and `ring-ring` tokens, with a 6px radius and a visible keyboard focus ring. Labels sit above fields. Native `<select>` remains for compact, phone-oriented forms where the platform picker is the more usable control.
- Input and Textarea use shadcn's neutral border, background, placeholder and focus tokens. Inputs stay 36px high on fine pointers and grow to at least 44px on coarse pointers; 16px text below the `md` breakpoint avoids mobile focus zoom. Textarea keeps native resizing and a 64px minimum height.
- Checkbox uses the Base UI shadcn primitive, including checked, unchecked, indeterminate, disabled and invalid states. It is 16px on fine pointers and a 44px target on coarse pointers. Switch is used for on/off settings and is at least 44px in each dimension on coarse pointers.
- Cards and popups: cards use a flat surface with a subtle border and 12px radius; dropdown menus use shadcn's popover and border tokens, 6px radius, and `shadow-md`; menu rows keep the inset rounded hover; dialogs use a 16px radius. Shared classes `card-surface`, `inset-row-hover`, `group-band` and `quiet-divider` provide reusable surface, row, band and divider treatments.
- Dialog and Sheet: modal forms and confirmations use the Base UI Dialog primitive styled with shadcn neutral tokens, a dimmed backdrop, focus containment, Escape dismissal and focus return. The mobile navigation uses Sheet as a left-side modal drawer with the same navigation content, a labeled 44px close target and an 85vw width cap. The wide work item peek stays independent.
  - Dialog keeps `rounded-2xl` (16px) as the documented Weft behavior requested for ticket 04, and constrains height to the viewport with internal scrolling.
  - Sheet uses `side="left"`, `w-72 max-w-[85vw]` and `rounded-r-2xl` to keep the existing navigation drawer's placement and width; its 44px close target stays reachable on touch screens.
- Search fields: a bordered field with a leading magnifier; the global search opens a results list below it.
- Tabs: Base UI shadcn tabs use a muted list surface and active tab treatment, with roving keyboard focus. Triggers have a 44px minimum height on coarse pointers. Route navigation stays ordinary navigation rather than claiming tab semantics.
- Toolbar chips and view switchers: a grouped row of icon-and-label toggles; a filter chip row follows it when filters are active.
- Work item row: desktop lists use a 12px muted column header and a shared fixed-column grid: checkbox, key, title, then State, Priority and the shown properties. State and Priority show an icon with their text. Rows stay on one line when the measured width permits; otherwise properties move below the title without a header. Phones keep the wrapping row. Current rows are 41px tall with shadcn Button sizing; the former 40px cap no longer applies. The list card has rounded corners, inset group bands, and rounded inset row hover and selected fills. Rows sit in group sections with a collapsible header that shows the count and a plus button to add.
- Property chips: list rows use muted, borderless text chips (a label keeps its colour dot); empty values show a muted dash in the same reachable control. Quiet chips gain the hover fill and keyboard focus ring when hovered or focused. Outlined pills remain on board cards, the spreadsheet and the work item detail page.
- Cards for summary numbers (analytics overview, work item counts) and for list-style items (cycles, modules, views).
- Danger zone: a bordered section with a red heading at the foot of settings pages, holding destructive actions only.
- Editor toolbar: a wrapping row of icon tools with separators; the rich text editor reads as an open page with a placeholder "Press '/' for commands".
- Dropdown menus: use the Base UI shadcn `DropdownMenu` primitive for action menus, including arrow-key navigation with wraparound, Home/End, outside dismissal and Escape focus restoration. Panels use `bg-popover`, `text-popover-foreground`, `border-border`, `rounded-md` and `shadow-md`; menu rows retain inset rounded hover fills as the documented Weft behavior. On coarse pointers, menu triggers and rows have a 44px minimum target. Panels cap their height to 32rem and the available viewport height, then scroll internally. Use the shared Popover only for non-menu panels.
- Select and Tooltip: `apps/web/src/ui/select.tsx` (shadcn Select on Base UI) and `apps/web/src/ui/tooltip.tsx` (Tooltip). Language and theme selectors use the Select: bordered trigger, neutral popup, check indicator, visible focus. Native selects remain for forms and settings where platform-native menus are useful, especially longer choices on touch screens. The desktop sidebar toggle, command palette, notifications and Sidecar icon controls show a Tooltip and keep their accessible names. Sizing overrides are `w-auto` on inline language/theme triggers (so they fit their labels instead of filling the auth footer/settings row) and `pointer-coarse:min-h-11 pointer-coarse:min-w-11` on Select and icon-only tooltip triggers (to preserve touch targets).
- Empty states: a short title and single plain sentence in secondary text, sometimes with a create action; an optional icon sits in a softly rounded tile. There is no illustration system.
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
