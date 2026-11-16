import { ActionError } from "./members";
import { markdownToDoc } from "./markdown-doc";

/** Pick one rich-text representation and give callers an actionable conflict message. */
export function richTextInput(document: unknown, markdown: unknown, documentName: string, markdownName: string) {
  if (document !== undefined && markdown !== undefined) throw new ActionError(`Send either ${markdownName} (Markdown text) or ${documentName} (a Tiptap document), not both.`, 400);
  if (markdown !== undefined) {
    if (typeof markdown !== "string") throw new ActionError(`${markdownName} must be Markdown text; pass a string.`, 400);
    return markdownToDoc(markdown);
  }
  return document;
}

/** Resolve the documented @{name} / @{id} Markdown mention tokens against people visible to the writer. */
export function resolveMarkdownMentions(document: unknown, people: Array<{ userId: string; name: string }>) {
  const root = structuredClone(document) as Node;
  const byId = new Map(people.map((person) => [person.userId, person]));
  const byName = new Map(people.map((person) => [person.name.trim().toLocaleLowerCase(), person]));
  const visit = (node: Node) => {
    if (node.type === "mention") {
      const token = String(node.attrs?.id ?? "");
      const person = byId.get(token) ?? byName.get(token.trim().toLocaleLowerCase());
      if (!person) throw new ActionError(`Markdown mention "${token}" did not match a visible member or Agent. Use @{exact name} or @{user id}.`, 400);
      node.attrs = { ...node.attrs, id: person.userId, label: person.name };
    }
    for (const child of node.content ?? []) visit(child);
  };
  if (root && typeof root === "object") visit(root);
  return root;
}

type Node = { type?: string; text?: string; attrs?: Record<string, unknown>; marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>; content?: Node[] };
const inline = (node: Node): string => {
  if (node.type === "text") {
    let value = node.text ?? "";
    for (const mark of node.marks ?? []) {
      if (mark.type === "bold") value = `**${value}**`;
      else if (mark.type === "italic") value = `_${value}_`;
      else if (mark.type === "strike") value = `~~${value}~~`;
      else if (mark.type === "code") value = `\`${value}\``;
      else if (mark.type === "link") value = `[${value}](${String(mark.attrs?.href ?? "")})`;
    }
    return value;
  }
  if (node.type === "mention") return `@{${String(node.attrs?.label ?? node.attrs?.name ?? node.attrs?.id ?? "unknown")}}`;
  if (node.type === "assetImage") return `![Image: ${String(node.attrs?.assetId ?? "unknown asset")}]`;
  return (node.content ?? []).map(inline).join("");
};
function block(node: Node): string {
  const children = node.content ?? [];
  switch (node.type) {
    case "heading": return `${"#".repeat(Math.max(1, Number(node.attrs?.level) || 1))} ${children.map(inline).join("")}`;
    case "paragraph": return children.map(inline).join("");
    case "codeBlock": return `\`\`\`${String(node.attrs?.language ?? "")}\n${children.map((part) => part.text ?? "").join("")}\n\`\`\``;
    case "bulletList": case "orderedList": case "taskList": return children.map((item, i) => `${node.type === "orderedList" ? `${i + 1}.` : node.type === "taskList" ? `- [${item.attrs?.checked ? "x" : " "}]` : "-"} ${block(item)}`).join("\n");
    case "listItem": case "taskItem": return children.map(block).join("\n");
    case "table": return children.map((row, i) => `| ${(row.content ?? []).map((cell) => (cell.content ?? []).map(block).join(" ").replaceAll("|", "\\|")).join(" | ")} |${i === 0 ? `\n| ${(row.content ?? []).map(() => "---").join(" | ")} |` : ""}`).join("\n");
    case "blockquote": return children.map(block).join("\n").split("\n").map((line) => `> ${line}`).join("\n");
    case "callout": return `> [!CALLOUT]\n${children.map(block).join("\n").split("\n").map((line) => `> ${line}`).join("\n")}`;
    case "horizontalRule": return "---";
    default: return children.map(inline).join("");
  }
}
/** Markdown view; placeholders preserve references to figures, mentions and callouts, which are flagged as non-standard Markdown. */
export function richTextMarkdown(document: unknown) {
  const nodes = (document as Node | null)?.content ?? [];
  const unsupported = new Set<string>();
  const scan = (node: Node) => { if (["assetImage", "mention", "callout"].includes(node.type ?? "")) unsupported.add(node.type!); for (const child of node.content ?? []) scan(child); };
  nodes.forEach(scan);
  const markdown = nodes.map(block).join("\n\n");
  return { markdown, markdownWarnings: [...unsupported].map((type) => `${type} is preserved in the document but has no Markdown representation`) };
}
