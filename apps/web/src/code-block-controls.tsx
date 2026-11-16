import React from "react";
import { translate } from "@weft/shared";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";

const languages = ["javascript", "typescript", "python", "json", "html", "css"] as const;

/** Lets a writer select the language used by the shared code highlighter. */
export function CodeBlockControls({ editor, editable }: { editor: Editor | null; editable: boolean }) {
  const active = useEditorState({ editor, selector: ({ editor: current }) => !!current?.isActive("codeBlock") });
  if (!editable || !editor || !active) return null;
  const language = editor.isActive("codeBlock") ? editor.getAttributes("codeBlock").language || "javascript" : "javascript";
  return <label className="code-language-control">{translate("editor.codeLanguage")}
    <select aria-label={translate("editor.codeLanguage")} value={language} onMouseDown={(event) => event.stopPropagation()} onChange={(event) => editor.chain().focus().updateAttributes("codeBlock", { language: event.target.value }).run()}>
      {languages.map((item) => <option key={item} value={item}>{translate(`editor.language.${item}` as never)}</option>)}
    </select>
  </label>;
}
