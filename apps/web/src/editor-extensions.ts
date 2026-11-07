import { Extension, type AnyExtension, type Range } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { sinkListItem, liftListItem } from "@tiptap/pm/schema-list";
import { Suggestion, type SuggestionProps } from "@tiptap/suggestion";
import Placeholder from "@tiptap/extension-placeholder";
import { translate, type MessageKey } from "@weft/shared";
import { editorPalette } from "../../../packages/actions/src/wiki-editor-extensions";
import { wikiEditorExtensions } from "../../../packages/actions/src/wiki-editor-extensions";

/** Shared Tiptap schema for each editing surface; callers replace per-surface mention and image adapters. */
export function surfaceEditorExtensions(options: { surface: "full" | "comment"; mention?: AnyExtension; image?: AnyExtension; collaborative?: boolean }): AnyExtension[] {
  const enabled = options.surface === "full"
    ? wikiEditorExtensions
    : wikiEditorExtensions.filter((item) => !["table", "tableRow", "tableHeader", "tableCell", "taskList", "taskItem", "color", "highlight", "textAlign", "callout"].includes(item.name));
  // The shared set turns undo off for Yjs collaboration (the Collaboration extension brings its own); a surface without collaboration needs the stock history.
  return enabled.map((item) => item.name === "mention" ? options.mention ?? item : item.name === "assetImage" ? options.image ?? item
    : item.name === "starterKit" && !options.collaborative ? item.configure({ undoRedo: {} }) : item);
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

/** Emoji suggestions appear after a colon and are also available from the slash menu. */
export const EmojiSuggestions = Extension.create({
  name: "emojiSuggestions",
  addProseMirrorPlugins() {
    const emojis = ["😀", "😂", "😍", "👍", "🎉", "❤️", "🚀", "✅"];
    return [Suggestion<{ emoji: string }, { emoji: string }>({
      editor: this.editor, char: ":", pluginKey: new PluginKey("emojiSuggestions"), allowedPrefixes: [" ", "(", "["],
      items: ({ query }) => emojis.filter((emoji, index) => !query || ["smile", "laugh", "love", "thumbsup", "tada", "heart", "rocket", "check"][index]!.startsWith(query.toLowerCase())).map((emoji) => ({ emoji })),
      command: ({ editor, range, props }) => editor.chain().focus().deleteRange(range).insertContent(props.emoji).run(),
      render: () => {
        let box: HTMLUListElement | null = null;
        let current: SuggestionProps<{ emoji: string }, { emoji: string }> | null = null;
        const paint = () => {
          if (!box || !current) return;
          box.replaceChildren(...current.items.map(({ emoji }) => {
            const option = document.createElement("li"); option.textContent = emoji; option.setAttribute("role", "option");
            option.onmousedown = (event) => { event.preventDefault(); current?.command({ emoji }); }; return option;
          }));
        };
        return {
          onStart: (props: SuggestionProps<{ emoji: string }, { emoji: string }>) => { current = props; box = document.createElement("ul"); box.className = "emoji-suggestions"; box.setAttribute("role", "listbox"); document.body.append(box); paint(); },
          onUpdate: (props: SuggestionProps<{ emoji: string }, { emoji: string }>) => { current = props; paint(); },
          onKeyDown: ({ event }: { event: KeyboardEvent }) => { if (event.key === "Escape") { box?.remove(); box = null; return true; } if (event.key === "Enter" && current?.items[0]) { current.command(current.items[0]); return true; } return false; },
          onExit: () => { box?.remove(); box = null; current = null; },
        };
      },
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
          event.preventDefault();
          let url: URL;
          try { url = new URL(anchor.href, document.baseURI); } catch { return true; }
          if (!["http:", "https:", "mailto:", "tel:"].includes(url.protocol)) return true;
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

function slashMenu() {
  let props: SuggestionProps<SlashCommand, SlashCommand> | null = null;
  let selected = 0;
  let menu: HTMLUListElement | null = null;
  let unmount: (() => void) | null = null;

  const paint = () => {
    if (!menu || !props) return;
    menu.hidden = props.items.length === 0;
    menu.replaceChildren(...props.items.map((item, index) => {
      const option = document.createElement("li");
      option.textContent = translate(item.label);
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(index === selected));
      option.className = index === selected ? "slash-menu-option is-selected" : "slash-menu-option";
      option.onmousedown = (event) => {
        event.preventDefault();
        props?.command(item);
      };
      return option;
    }));
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
