import type { SuggestionProps } from "@tiptap/suggestion";
import { translate, type MessageKey } from "@weft/shared";
import { avatarElement } from "./avatar";

/**
 * The popups that open under the caret while typing: the "@" mention list (Wiki and comment editors) and the ":" emoji list.
 * They share one listbox, one selection rule, one placement and one set of classes (`.suggest-menu`, `.suggest-option`, styled
 * beside the "/" slash menu in style.css), so the lists cannot drift apart again.
 */

type Rect = (() => DOMRect | null) | null | undefined;

/** The popup list, absolute to the page and kept beside the caret. A resize moves the caret but not the list, so it is placed again. */
class SuggestBox {
  readonly list: HTMLUListElement;
  private rect: Rect = null;
  private readonly reflow = () => this.place();

  constructor(label: MessageKey) {
    this.list = document.createElement("ul");
    this.list.className = "suggest-menu";
    this.list.setAttribute("role", "listbox");
    this.list.setAttribute("aria-label", translate(label));
    document.body.append(this.list);
    window.addEventListener("resize", this.reflow);
  }

  follow(rect: Rect) {
    this.rect = rect;
    this.place();
  }

  /** Below the caret when it fits, otherwise above it; kept inside the viewport width. */
  private place() {
    const bounds = this.rect?.();
    if (!bounds) return;
    const height = this.list.offsetHeight;
    const below = bounds.bottom + height <= window.innerHeight || bounds.top < height;
    const left = Math.max(8, Math.min(bounds.left, window.innerWidth - this.list.offsetWidth - 8));
    this.list.style.left = `${left + window.scrollX}px`;
    this.list.style.top = `${(below ? bounds.bottom : bounds.top - height) + window.scrollY}px`;
  }

  remove() {
    window.removeEventListener("resize", this.reflow);
    this.list.remove();
  }
}

/** The next selected index for ArrowDown (+1) or ArrowUp (-1); both ends wrap. `count` must be above zero. */
export function nextSelection(selected: number, count: number, key: string): number {
  return key === "ArrowDown" ? (selected + 1) % count : (selected - 1 + count) % count;
}

/** Tab accepts only a live, pickable suggestion; Shift-Tab, IME and status/empty menus keep native editor navigation. */
export function acceptsSuggestionOnTab(event: Pick<KeyboardEvent, "key" | "shiftKey" | "isComposing" | "keyCode">, pickable: boolean): boolean {
  return event.key === "Tab" && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && pickable;
}

/** Scrolls the popup just enough that the option is fully visible; the page does not move. */
export function revealOption(list: HTMLElement, option: HTMLElement) {
  if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
  else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
}

type ListOptions<T> = {
  /** The label the listbox is announced with. */
  label: MessageKey;
  /** Row content; the list adds the option role, the selection state and the mouse pick. */
  content: (item: T) => Node[];
  /** Rows that are shown but cannot be picked. */
  disabled?: (item: T) => boolean;
  /** Rows with the same group sit together under one heading; a heading shows only when the list has more than one group. */
  group?: (item: T) => MessageKey | null;
  /** A status row in place of the options (loading, failed, no match, nothing typed yet). While it shows, no option can be picked. */
  notice?: (props: SuggestionProps<T, T> & { loading?: boolean }) => MessageKey | null;
};

/** The Suggestion `render` for a listbox: keyboard (ArrowUp/Down with wrap, Enter), mouse pick and selection shared by every popup. Escape is left to the suggestion plugin, which closes the popup. */
export function suggestRender<T>(options: ListOptions<T>) {
  return () => {
    let box: SuggestBox | null = null;
    let selected = 0;
    let current: SuggestionProps<T, T> | null = null;

    const paint = () => {
      if (!box || !current) return;
      const { items } = current;
      const list = box.list;
      const status = options.notice?.(current) ?? null;
      list.hidden = status === null && items.length === 0;
      if (status !== null) {
        const row = document.createElement("li");
        row.className = "suggest-notice";
        row.setAttribute("role", "status");
        row.textContent = translate(status);
        list.replaceChildren(row);
        return;
      }
      if (selected >= items.length) selected = 0;
      const grouped = new Set(items.map((item) => options.group?.(item) ?? null)).size > 1;
      let previous: MessageKey | null | undefined;
      let highlighted: HTMLElement | null = null;
      const nodes: HTMLElement[] = [];
      items.forEach((item, index) => {
        const group = options.group?.(item) ?? null;
        if (grouped && group !== previous && group !== null) {
          const heading = document.createElement("li");
          heading.className = "suggest-group";
          heading.setAttribute("role", "presentation");
          heading.textContent = translate(group);
          nodes.push(heading);
        }
        previous = group;
        const isSelected = index === selected;
        const unavailable = options.disabled?.(item) === true;
        const row = document.createElement("li");
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(isSelected));
        row.setAttribute("aria-disabled", String(unavailable));
        row.className = `suggest-option${isSelected ? " is-selected" : ""}${unavailable ? " is-unavailable" : ""}`;
        row.append(...options.content(item));
        row.onmousedown = (event) => {
          event.preventDefault();
          if (!unavailable) current?.command(item);
        };
        nodes.push(row);
        if (isSelected) highlighted = row;
      });
      list.replaceChildren(...nodes);
      if (highlighted) revealOption(list, highlighted);
    };

    return {
      onStart: (props: SuggestionProps<T, T>) => {
        current = props;
        selected = 0;
        box = new SuggestBox(options.label);
        paint();
        box.follow(props.clientRect);
      },
      onUpdate: (props: SuggestionProps<T, T>) => {
        current = props;
        selected = 0;
        paint();
        box?.follow(props.clientRect);
      },
      onKeyDown: ({ event }: { event: KeyboardEvent }) => {
        const selectedItem = current?.items[selected];
        const menuReady = !!current && current.items.length > 0 && options.notice?.(current) == null;
        if (acceptsSuggestionOnTab(event, menuReady && !!selectedItem && !options.disabled?.(selectedItem))) {
          current!.command(selectedItem!);
          return true;
        }
        if (!current || current.items.length === 0 || options.notice?.(current) != null) return false;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          selected = nextSelection(selected, current.items.length, event.key);
          paint();
          return true;
        }
        if (event.key === "Enter") {
          const item = current.items[selected]!;
          if (!options.disabled?.(item)) current.command(item);
          return true;
        }
        return false;
      },
      onExit: () => {
        box?.remove();
        box = null;
        current = null;
      },
    };
  };
}

/** One "@" mention candidate: a person, or an Agent (`isAgent`) with a `codeCapable` runtime. */
export type MentionOption = { id: string; label: string; isAgent?: boolean; codeCapable?: boolean; unavailable?: boolean; unavailableReason?: string | null };

/** The text under a mention's name: "Code-capable" for an Agent that can edit code, and why an unavailable Agent cannot be picked. */
export function mentionNotes(item: MentionOption): { note: string | null; reason: string | null } {
  return {
    note: item.isAgent && item.codeCapable ? translate("mention.codeCapable") : null,
    reason: item.unavailable ? item.unavailableReason ?? null : null,
  };
}

/** People sit under "People" and Agents under "Agents", as in the Assignee picker. */
export function mentionGroup(item: MentionOption): MessageKey {
  return item.isAgent ? "agents.group" : "members.group";
}

function textLine(className: string, text: string) {
  const line = document.createElement("span");
  line.className = className;
  line.textContent = text;
  return line;
}

/** The "@" mention list used by the Wiki and comment editors. */
export function mentionRender(label: MessageKey) {
  return suggestRender<MentionOption>({
    label,
    group: mentionGroup,
    disabled: (item) => item.unavailable === true,
    content: (item) => {
      const { note, reason } = mentionNotes(item);
      const body = document.createElement("span");
      body.className = "suggest-option-body";
      body.append(textLine("suggest-option-name", item.label));
      if (note) body.append(textLine("suggest-option-note", note));
      if (reason) body.append(textLine("suggest-option-reason", reason));
      return [avatarElement(item.label, item.id, !!item.isAgent), body];
    },
  });
}
