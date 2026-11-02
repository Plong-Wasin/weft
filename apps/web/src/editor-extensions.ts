import { Extension, type Range } from "@tiptap/core";
import { Suggestion, type SuggestionProps } from "@tiptap/suggestion";
import { translate, type MessageKey } from "@weft/shared";

type SlashCommand = { id: string; label: MessageKey };

const commands: SlashCommand[] = [
  { id: "text", label: "wiki.tool.text" },
  { id: "heading1", label: "wiki.tool.h1" },
  { id: "heading2", label: "wiki.tool.h2" },
  { id: "heading3", label: "wiki.tool.h3" },
  { id: "bulletList", label: "wiki.tool.bulletList" },
  { id: "orderedList", label: "wiki.tool.orderedList" },
  { id: "blockquote", label: "wiki.tool.quote" },
  { id: "codeBlock", label: "wiki.tool.codeBlock" },
  { id: "divider", label: "wiki.tool.divider" },
];

function applyCommand(editor: SuggestionProps<SlashCommand, SlashCommand>["editor"], range: Range, command: SlashCommand) {
  const chain = editor.chain().focus().deleteRange(range);
  switch (command.id) {
    case "text": chain.setParagraph().run(); break;
    case "heading1": chain.setHeading({ level: 1 }).run(); break;
    case "heading2": chain.setHeading({ level: 2 }).run(); break;
    case "heading3": chain.setHeading({ level: 3 }).run(); break;
    case "bulletList": chain.toggleBulletList().run(); break;
    case "orderedList": chain.toggleOrderedList().run(); break;
    case "blockquote": chain.toggleBlockquote().run(); break;
    case "codeBlock": chain.toggleCodeBlock().run(); break;
    case "divider": chain.setHorizontalRule().run(); break;
  }
}

function slashMenu() {
  let props: SuggestionProps<SlashCommand, SlashCommand> | null = null;
  let selected = 0;
  let menu: HTMLUListElement | null = null;
  let unmount: (() => void) | null = null;

  const paint = () => {
    if (!menu || !props) return;
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
      if (!props) return false;
      if (event.key === "ArrowDown") {
        if (props.items.length) selected = (selected + 1) % props.items.length;
        paint();
        return true;
      }
      if (event.key === "ArrowUp") {
        if (props.items.length) selected = (selected - 1 + props.items.length) % props.items.length;
        paint();
        return true;
      }
      if (event.key === "Enter") {
        const item = props.items[selected];
        if (item) props.command(item);
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

/** Shared slash commands for the description and Wiki editors. */
export const SlashMenu = Extension.create({
  name: "slashMenu",
  addProseMirrorPlugins() {
    return [Suggestion<SlashCommand, SlashCommand>({
      editor: this.editor,
      char: "/",
      startOfLine: true,
      allowedPrefixes: null,
      items: ({ query }) => commands.filter((command) => translate(command.label).toLowerCase().includes(query.toLowerCase())),
      command: ({ editor, range, props: command }) => applyCommand(editor, range, command),
      render: slashMenu,
    })];
  },
});
