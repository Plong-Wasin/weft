import { Extension, type AnyExtension, type Range } from "@tiptap/core";
import { AllSelection, Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { sinkListItem, liftListItem } from "@tiptap/pm/schema-list";
import { Suggestion, type SuggestionProps } from "@tiptap/suggestion";
import Placeholder from "@tiptap/extension-placeholder";
import { translate, type MessageKey } from "@weft/shared";
import { editorPalette } from "../../../packages/actions/src/wiki-editor-extensions";
import { createWikiLowlight, wikiEditorExtensions } from "../../../packages/actions/src/wiki-editor-extensions";
import { OPEN_LINK_EVENT, OPEN_SHORTCUTS_EVENT } from "./shortcuts";
import { blockRangeOfSelection, moveTopLevelRange, duplicateTopLevelBlock, topLevelBlockAtSelection, topLevelBlocks } from "./wiki-block-moves";
import { MermaidCodeBlock } from "./mermaid-diagram";
import { revealOption, suggestRender } from "./suggest-list";
import { isAllowedLinkScheme } from "../../../packages/actions/src/written-form-attributes";

/**
 * When ProseMirror still holds a text range or a select-all but the DOM selection has already collapsed (an arrow key or a click moved it), collapse ProseMirror to the DOM caret before the key acts.
 * ProseMirror reads the DOM selection only on the async selectionchange, so an Enter sent right after ArrowRight would otherwise replace the old triple-click range,
 * and an Enter sent right after a click into a task item would replace the whole document while ProseMirror still held the old select-all.
 * A real select-all has a DOM selection that is not collapsed, so it is never adopted away. A node or cell selection keeps its own state.
 */
export function syncSelectionFromDom(view: EditorView) {
  const { selection: current } = view.state;
  if (current.empty || !(current instanceof TextSelection || current instanceof AllSelection)) return;
  const selection = view.dom.ownerDocument.getSelection();
  if (!selection?.anchorNode || !selection.isCollapsed || !view.dom.contains(selection.anchorNode)) return;
  const caret = view.posAtDOM(selection.anchorNode, selection.anchorOffset);
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(caret))));
}

/** Runs the selection sync before any other key handler of the editor, on every editing surface (description, Comment, Wiki). */
export const SelectionSync = Extension.create({
  name: "selectionSync",
  priority: 1000,
  addProseMirrorPlugins() {
    return [new Plugin({ key: new PluginKey("selectionSync"), props: { handleKeyDown: (view) => { if (!view.composing) syncSelectionFromDom(view); return false; } } })];
  },
});

/** Shared Tiptap schema for each editing surface; callers replace per-surface mention and image adapters. */
export function surfaceEditorExtensions(options: { surface: "full" | "comment"; mention?: AnyExtension; image?: AnyExtension; collaborative?: boolean }): AnyExtension[] {
  const enabled = options.surface === "full"
    ? wikiEditorExtensions
    : wikiEditorExtensions.filter((item) => !["taskList", "taskItem", "callout"].includes(item.name));
  // The shared set turns undo off for Yjs collaboration (the Collaboration extension brings its own); a surface without collaboration needs the stock history.
  return [...enabled.map((item) => item.name === "codeBlock" ? MermaidCodeBlock.configure({ lowlight: createWikiLowlight(), defaultLanguage: "javascript" }) : item.name === "mention" ? options.mention ?? item : item.name === "assetImage" ? (options.image ?? item)
    .configure({ writtenFormControls: options.collaborative === true })
    : item.name === "starterKit" && !options.collaborative ? item.configure({ undoRedo: {} }) : item), OpenLinkShortcut, ClearFormattingShortcut, ShortcutsHelpShortcut, SelectionSync];
}

/** Placeholder shared by the editable description, Comment, and Wiki editors. */
export const EditorPlaceholder = Placeholder.configure({
  placeholder: ({ editor }) => editor.isEditable ? translate("editor.placeholder") : "",
  showOnlyCurrent: false,
});

type SlashChain = ReturnType<ReturnType<SuggestionProps<SlashCommand, SlashCommand>["editor"]["chain"]>["focus"]>;
type SlashCommand = { id: string; label: MessageKey; run: (chain: SlashChain, options: SlashMenuOptions, editor: SuggestionProps<SlashCommand, SlashCommand>["editor"]) => void };
type SlashMenuOptions = { commands: SlashCommand[]; onImage?: () => void };
const emojiChoices = ["😀", "😂", "😍", "👍", "🎉", "❤️", "🚀", "✅"];

function showEmojiPicker(editor: SuggestionProps<SlashCommand, SlashCommand>["editor"]) {
  document.querySelector("[data-emoji-picker]")?.remove();
  const picker = document.createElement("div");
  picker.className = "emoji-picker";
  picker.dataset.emojiPicker = "";
  picker.setAttribute("role", "dialog");
  picker.setAttribute("aria-label", translate("wiki.insert.emoji"));
  for (const emoji of emojiChoices) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = emoji;
    button.setAttribute("aria-label", `${translate("wiki.insert.emoji")} ${emoji}`);
    button.onmousedown = (event) => event.preventDefault();
    button.onclick = () => { editor.chain().focus().insertContent(emoji).run(); picker.remove(); };
    picker.append(button);
  }
  document.body.append(picker);
}

/** Tab nests a list item and Shift-Tab lifts it one level when the selection is in a list. */
/** Ctrl/⌘+K asks the focused editor's Link button to open its form. */
export const OpenLinkShortcut = Extension.create({
  name: "openLinkShortcut",
  addKeyboardShortcuts() { return { "Mod-k": () => { const asked = new CustomEvent<{ claimed: boolean }>(OPEN_LINK_EVENT, { detail: { claimed: false } }); document.dispatchEvent(asked); return asked.detail.claimed; } }; },
});

/** True while a suggestion popup (slash menu, emoji, mention) is open: its own Escape closes it, and the editor keys leave Escape alone. */
export function suggestionOpen(editor: { state: EditorState }): boolean {
  return editor.state.plugins.some((plugin) => { const state = plugin.getState(editor.state) as { active?: unknown; dismissedRange?: unknown } | undefined; return state?.active === true && "dismissedRange" in state; });
}

/** Ctrl/⌘+\ removes every mark from the selection and resets its blocks to paragraphs. */
export const ClearFormattingShortcut = Extension.create({
  name: "clearFormattingShortcut",
  addKeyboardShortcuts() { return { "Mod-\\": () => this.editor.chain().focus().unsetAllMarks().clearNodes().run() }; },
});

/** Ctrl/⌘+/ asks for the shortcuts dialog, which the shell mounts once and listens for. */
export const ShortcutsHelpShortcut = Extension.create({
  name: "shortcutsHelpShortcut",
  addKeyboardShortcuts() { return { "Mod-/": () => { document.dispatchEvent(new CustomEvent(OPEN_SHORTCUTS_EVENT)); return true; } }; },
});

/** Ctrl/⌘+Shift+Up and Down move the block the caret is in; Ctrl/⌘+D duplicates it. The Wiki and description editors add this; the Comment editor does not. */
export const BlockKeyboardShortcuts = Extension.create({
  name: "blockKeyboardShortcuts",
  addKeyboardShortcuts() {
    const moveBy = (delta: -1 | 1) => () => {
      // The whole selected run moves together, as with the grip; with a caret in one block that block moves alone.
      const range = blockRangeOfSelection(this.editor.state.selection);
      if (!range) return false;
      const blocks = topLevelBlocks(this.editor);
      const neighbour = delta < 0 ? blocks.find((item) => item.pos + item.size === range.from) : blocks.find((item) => item.pos === range.to);
      // At the first or last block there is nowhere to move; the key is still consumed so the page does not scroll.
      if (!neighbour) return true;
      const destination = delta < 0 ? neighbour.pos : neighbour.pos + neighbour.size;
      const multi = !this.editor.state.selection.empty && range.to - range.from > (this.editor.state.doc.nodeAt(range.from)?.nodeSize ?? 0);
      return moveTopLevelRange(this.editor, range, destination, multi ? { keepRange: true } : { keepCaret: true });
    };
    return {
      "Shift-Mod-ArrowUp": moveBy(-1),
      "Shift-Mod-ArrowDown": moveBy(1),
      "Mod-d": () => {
        const block = topLevelBlockAtSelection(this.editor);
        return block ? duplicateTopLevelBlock(this.editor, block.pos) : false;
      },
    };
  },
});

export const ListIndent = Extension.create({
  name: "listIndent",
  priority: 1100,
  addKeyboardShortcuts() {
    return {
      Tab: () => sinkListItem(this.editor.schema.nodes.listItem)(this.editor.state, this.editor.view.dispatch),
      "Shift-Tab": () => liftListItem(this.editor.schema.nodes.listItem)(this.editor.state, this.editor.view.dispatch),
    };
  },
});

/** Copy controls are widgets, so they never enter the saved document or clipboard content. */
export const CodeBlockCopy = Extension.create({
  name: "codeBlockCopy",
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey("codeBlockCopy"),
      props: {
        decorations: (state) => {
          if (!this.editor.isEditable) return null;
          const widgets = [] as Decoration[];
          state.doc.descendants((node, position) => {
            if (node.type.name !== "codeBlock") return;
            const button = document.createElement("button");
            button.type = "button";
            button.className = "code-block-copy";
            button.textContent = translate("editor.copyCode");
            button.setAttribute("aria-label", translate("editor.copyCode"));
            button.addEventListener("mousedown", (event) => event.preventDefault());
            button.addEventListener("click", async () => {
              await navigator.clipboard.writeText(node.textContent);
              button.textContent = translate("editor.codeCopied");
              setTimeout(() => { button.textContent = translate("editor.copyCode"); }, 1200);
            });
            widgets.push(Decoration.widget(position + node.nodeSize - 1, button, { side: 1, key: `copy-${position}` }));
          });
          return DecorationSet.create(state.doc, widgets);
        },
      },
    })];
  },
});

/** Markdown plain-text pastes become normal editor blocks when they contain Markdown syntax. */
export const MarkdownPaste = Extension.create({
  name: "markdownPaste",
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey("markdownPaste"),
      props: {
        handlePaste: (_view, event) => {
          if (!this.editor.isEditable || !this.editor.markdown) return false;
          const text = event.clipboardData?.getData("text/plain") ?? "";
          if (!/^(#{1,6} |[-*+] |\d+\. |```|> )/m.test(text)) return false;
          event.preventDefault();
          this.editor.commands.insertContent(this.editor.markdown.parse(text));
          return true;
        },
      },
    })];
  },
});

const heading = (level: 1 | 2 | 3 | 4 | 5 | 6, label: MessageKey): SlashCommand => ({ id: `heading${level}`, label, run: (chain) => { chain.setHeading({ level }).run(); } });

/** Block commands every editor offers. */
export const blockCommands: SlashCommand[] = [
  { id: "text", label: "wiki.tool.text", run: (chain) => { chain.setParagraph().run(); } },
  heading(1, "wiki.tool.h1"), heading(2, "wiki.tool.h2"), heading(3, "wiki.tool.h3"),
  { id: "bulletList", label: "wiki.tool.bulletList", run: (chain) => { chain.toggleBulletList().run(); } },
  { id: "orderedList", label: "wiki.tool.orderedList", run: (chain) => { chain.toggleOrderedList().run(); } },
  { id: "blockquote", label: "wiki.tool.quote", run: (chain) => { chain.toggleBlockquote().run(); } },
  { id: "codeBlock", label: "wiki.tool.codeBlock", run: (chain) => { chain.toggleCodeBlock().run(); } },
  { id: "divider", label: "wiki.tool.divider", run: (chain) => { chain.setHorizontalRule().run(); } },
];

/** The Wiki editor's richer set: all six heading levels, to-do list, table, callout, emoji, text color and image. */
export const wikiCommands: SlashCommand[] = [
  heading(1, "wiki.tool.h1"), heading(2, "wiki.tool.h2"), heading(3, "wiki.tool.h3"), heading(4, "wiki.tool.h4"), heading(5, "wiki.tool.h5"), heading(6, "wiki.tool.h6"),
  { id: "bulletList", label: "wiki.tool.bulletList", run: (chain) => { chain.toggleBulletList().run(); } },
  { id: "orderedList", label: "wiki.tool.orderedList", run: (chain) => { chain.toggleOrderedList().run(); } },
  { id: "todo", label: "wiki.insert.todo", run: (chain) => { chain.toggleTaskList().run(); } },
  { id: "table", label: "wiki.insert.table", run: (chain) => { chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); } },
  { id: "blockquote", label: "wiki.tool.quote", run: (chain) => { chain.toggleBlockquote().run(); } },
  { id: "codeBlock", label: "wiki.tool.codeBlock", run: (chain) => { chain.toggleCodeBlock().run(); } },
  { id: "callout", label: "wiki.insert.callout", run: (chain) => { chain.insertContent({ type: "callout", content: [{ type: "paragraph" }] }).run(); } },
  { id: "divider", label: "wiki.insert.divider", run: (chain) => { chain.setHorizontalRule().run(); } },
  { id: "emoji", label: "wiki.insert.emoji", run: (chain, _options, editor) => { chain.run(); showEmojiPicker(editor); } },
  { id: "color", label: "wiki.insert.color", run: (chain) => { chain.setColor(editorPalette[5]).run(); } },
  { id: "image", label: "wiki.insert.image", run: (chain, options) => { chain.run(); options.onImage?.(); } },
];

/** The ":" emoji choices: a glyph and its name, matched by the name typed after the colon. */
const colonEmojiChoices: Array<{ emoji: string; name: MessageKey }> = [
  { emoji: "😀", name: "emoji.smile" }, { emoji: "😂", name: "emoji.laugh" }, { emoji: "😍", name: "emoji.love" }, { emoji: "👍", name: "emoji.thumbsUp" },
  { emoji: "🎉", name: "emoji.celebrate" }, { emoji: "❤️", name: "emoji.heart" }, { emoji: "🚀", name: "emoji.rocket" }, { emoji: "✅", name: "emoji.check" },
];

/** Emoji suggestions appear after a colon and are also available from the slash menu. They use the same list as the "@" mentions. */
export const EmojiSuggestions = Extension.create({
  name: "emojiSuggestions",
  addProseMirrorPlugins() {
    return [Suggestion<(typeof colonEmojiChoices)[number], (typeof colonEmojiChoices)[number]>({
      editor: this.editor, char: ":", pluginKey: new PluginKey("emojiSuggestions"), allowedPrefixes: [" ", "(", "["],
      items: ({ query }) => colonEmojiChoices.filter((choice) => !query || translate(choice.name).toLowerCase().startsWith(query.toLowerCase())),
      command: ({ editor, range, props }) => editor.chain().focus().deleteRange(range).insertContent(props.emoji).run(),
      render: suggestRender<(typeof colonEmojiChoices)[number]>({
        label: "wiki.insert.emoji",
        content: (choice) => {
          const glyph = document.createElement("span");
          glyph.className = "suggest-option-emoji";
          glyph.textContent = choice.emoji;
          const name = document.createElement("span");
          name.className = "suggest-option-name";
          name.textContent = translate(choice.name);
          return [glyph, name];
        },
      }),
    })];
  },
});

/** Editable link clicks need an explicit feature string; Link's default window.open call leaves window.opener available. */
export const SafeLinkClick = Extension.create({
  name: "safeLinkClick",
  addProseMirrorPlugins() {
    return [new Plugin({
      props: {
        handleClick: (view, _position, event) => {
          if (!view.editable || event.button !== 0) return false;
          const target = event.target;
          if (!(target instanceof Element)) return false;
          const anchor = target.closest<HTMLAnchorElement>("a[href]");
          if (!anchor || !view.dom.contains(anchor)) return false;
          if (anchor.hasAttribute("data-unavailable-reference")) { event.preventDefault(); return true; }
          event.preventDefault();
          let url: URL;
          try { url = new URL(anchor.href, document.baseURI); } catch { return true; }
          if (!isAllowedLinkScheme(url.protocol)) return true;
          window.open(url.href, "_blank", "noopener,noreferrer");
          return true;
        },
      },
    })];
  },
});

function applyCommand(editor: SuggestionProps<SlashCommand, SlashCommand>["editor"], range: Range, command: SlashCommand, options: SlashMenuOptions) {
  if (!editor.isEditable) return;
  command.run(editor.chain().focus().deleteRange(range), options, editor);
}

const slashIcon = (body: string) => `<svg class="slash-menu-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const headingIcon = (level: number) => slashIcon(`<text x="12" y="16.5" text-anchor="middle" fill="currentColor" stroke="none" font-size="10" font-weight="700">H${level}</text>`);

/** One icon per slash command id, as static SVG markup (no user input reaches it). */
const slashIcons: Record<string, string> = {
  default: slashIcon(`<circle cx="12" cy="12" r="2"/>`),
  text: slashIcon(`<path d="M4 6h16M4 12h10M4 18h14"/>`),
  heading1: headingIcon(1), heading2: headingIcon(2), heading3: headingIcon(3), heading4: headingIcon(4), heading5: headingIcon(5), heading6: headingIcon(6),
  bulletList: slashIcon(`<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>`),
  orderedList: slashIcon(`<path d="M10 6h10M10 12h10M10 18h10"/><path d="M3.5 5l1.5-1v5M3.5 13.5a1.5 1.5 0 0 1 3 0c0 1.5-3 2.5-3 4h3"/>`),
  todo: slashIcon(`<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><path d="M4.5 7l1.5 1.5L9 5.5M13 7h8M3.5 13.5h7v7h-7zM13 17h8"/>`),
  table: slashIcon(`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>`),
  blockquote: slashIcon(`<path d="M5 9h4v4H6a1 1 0 0 1-1-1zM14 9h4v4h-3a1 1 0 0 1-1-1z"/><path d="M7 13v3M16 13v3"/>`),
  codeBlock: slashIcon(`<path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>`),
  divider: slashIcon(`<path d="M3 12h18"/>`),
  callout: slashIcon(`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h6"/>`),
  emoji: slashIcon(`<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5s1.5 2 3.5 2 3.5-2 3.5-2M9 9.5h.01M15 9.5h.01"/>`),
  color: slashIcon(`<path d="M12 3a9 9 0 0 0 0 18c1.2 0 1.6-.9 1.6-1.6 0-.9-.6-1.4-.6-2.2 0-.9.7-1.6 1.6-1.6H17a4 4 0 0 0 4-4C21 6.5 17 3 12 3z"/><circle cx="7.5" cy="10.5" r="1"/><circle cx="12" cy="7.5" r="1"/>`),
  image: slashIcon(`<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>`),
};

function slashMenu() {
  let props: SuggestionProps<SlashCommand, SlashCommand> | null = null;
  let selected = 0;
  let menu: HTMLUListElement | null = null;
  let unmount: (() => void) | null = null;

  const paint = () => {
    if (!menu || !props) return;
    const list = menu;
    list.hidden = props.items.length === 0;
    list.replaceChildren(...props.items.map((item, index) => {
      const option = document.createElement("li");
      // The icon markup is a constant from slashIcons; the label is translated text and goes in as a text node.
      option.insertAdjacentHTML("beforeend", slashIcons[item.id] ?? slashIcons.default);
      option.append(translate(item.label));
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(index === selected));
      option.className = index === selected ? "slash-menu-option is-selected" : "slash-menu-option";
      option.onmousedown = (event) => {
        event.preventDefault();
        props?.command(item);
      };
      return option;
    }));
    // Keep the highlighted option inside the menu's scroll area ("nearest"), without scrolling the editor page as well.
    const highlighted = list.children[selected] as HTMLElement | undefined;
    if (highlighted) revealOption(list, highlighted);
  };

  const update = (next: SuggestionProps<SlashCommand, SlashCommand>) => {
    props = next;
    selected = 0;
    paint();
  };

  return {
    onStart: (next: SuggestionProps<SlashCommand, SlashCommand>) => {
      update(next);
      menu = document.createElement("ul");
      menu.className = "slash-menu";
      menu.setAttribute("role", "listbox");
      menu.setAttribute("aria-label", translate("editor.slashMenu"));
      unmount = next.mount(menu);
      paint();
    },
    onUpdate: update,
    onKeyDown: ({ event }: { event: KeyboardEvent }) => {
      if (!props || props.items.length === 0) return false;
      if (event.key === "ArrowDown") {
        selected = (selected + 1) % props.items.length;
        paint();
        return true;
      }
      if (event.key === "ArrowUp") {
        selected = (selected - 1 + props.items.length) % props.items.length;
        paint();
        return true;
      }
      if (event.key === "Enter") {
        props.command(props.items[selected]!);
        return true;
      }
      // Escape: leave the typed "/" in place; the suggestion plugin closes the menu itself.
      return false;
    },
    onExit: () => {
      unmount?.();
      unmount = null;
      menu = null;
      props = null;
      selected = 0;
    },
  };
}

/** Shared slash commands for the description and Wiki editors. Configure `commands` and `onImage` per editor. */
export const SlashMenu = Extension.create<SlashMenuOptions>({
  name: "slashMenu",
  addOptions() { return { commands: blockCommands }; },
  addProseMirrorPlugins() {
    const options = this.options;
    return [Suggestion<SlashCommand, SlashCommand>({
      editor: this.editor,
      char: "/",
      startOfLine: true,
      allowedPrefixes: null,
      // Suggestion matches on the selection, so a read-only viewer clicking after "/x" would otherwise get a menu that edits the page.
      allow: ({ editor }) => editor.isEditable,
      items: ({ query }) => options.commands.filter((command) => translate(command.label).toLowerCase().includes(query.toLowerCase())),
      command: ({ editor, range, props: command }) => applyCommand(editor, range, command, options),
      render: slashMenu,
    })];
  },
});
