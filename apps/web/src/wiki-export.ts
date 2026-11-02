type JsonNode = { type?: string; text?: string; attrs?: Record<string, unknown>; marks?: Array<{ type: string; attrs?: Record<string, unknown> }>; content?: JsonNode[] };

function inline(node: JsonNode, resolveAsset: (id: string) => Promise<string>): Promise<string> | string {
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
  if (node.type === "hardBreak") return "  \n";
  if (node.type === "assetImage") return resolveAsset(String(node.attrs?.assetId ?? "" )).then((url) => `![Image](${url})`);
  return Promise.all((node.content ?? []).map((child) => inline(child, resolveAsset))).then((parts) => parts.join(""));
}

function cellText(node: JsonNode, resolveAsset: (id: string) => Promise<string>) {
  return Promise.all((node.content ?? []).map((child) => inline(child, resolveAsset))).then((parts) => parts.join("").replaceAll("|", "\\|"));
}

async function block(node: JsonNode, resolveAsset: (id: string) => Promise<string>, depth = 0): Promise<string> {
  const children = node.content ?? [];
  switch (node.type) {
    case "heading": return `${"#".repeat(Math.max(1, Math.min(6, Number(node.attrs?.level) || 1)))} ${await inlineContent(children, resolveAsset)}`;
    case "paragraph": return inlineContent(children, resolveAsset);
    case "codeBlock": return `\`\`\`${String(node.attrs?.language ?? "")}\n${children.map((part) => part.text ?? "").join("")}\n\`\`\``;
    case "blockquote": return (await blocks(children, resolveAsset)).split("\n").map((line) => `> ${line}`).join("\n");
    case "bulletList": case "orderedList": case "taskList": {
      const output: string[] = [];
      for (let index = 0; index < children.length; index++) {
        const item = children[index]!;
        const marker = node.type === "taskList" ? (item.attrs?.checked ? "- [x] " : "- [ ] ") : node.type === "orderedList" ? `${index + 1}. ` : "- ";
        const content = await blocks(item.content ?? [], resolveAsset, depth + 1);
        const lines = content.split("\n");
        output.push(`${"  ".repeat(depth)}${marker}${lines[0] ?? ""}${lines.slice(1).map((line) => `\n${"  ".repeat(depth + 1)}${line}`).join("")}`);
      }
      return output.join("\n");
    }
    case "listItem": case "taskItem": return blocks(children, resolveAsset, depth);
    case "table": {
      const rows: string[][] = [];
      for (const row of children) rows.push(await Promise.all((row.content ?? []).map((cell) => cellText(cell, resolveAsset))));
      if (!rows.length) return "";
      const width = Math.max(...rows.map((row) => row.length));
      const format = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`;
      return [format(rows[0]!), format(Array.from({ length: width }, () => "---")), ...rows.slice(1).map(format)].join("\n");
    }
    case "tableRow": case "tableCell": case "tableHeader": return blocks(children, resolveAsset, depth);
    case "horizontalRule": return "---";
    case "assetImage": return inline(node, resolveAsset);
    case "callout": return (await blocks(children, resolveAsset)).split("\n").map((line) => `> ${line}`).join("\n");
    default: return inlineContent(children, resolveAsset);
  }
}

async function inlineContent(nodes: JsonNode[], resolveAsset: (id: string) => Promise<string>) {
  return (await Promise.all(nodes.map((node) => inline(node, resolveAsset)))).join("");
}

async function blocks(nodes: JsonNode[], resolveAsset: (id: string) => Promise<string>, depth = 0) {
  return (await Promise.all(nodes.map((node) => block(node, resolveAsset, depth)))).filter((part) => part !== "").join("\n\n");
}

/** Convert the editor's Tiptap document into portable Markdown, resolving uploaded images to download links. */
export function toMarkdown(document: unknown, resolveAsset: (id: string) => Promise<string> = async (id) => `asset:${id}`) {
  return blocks(((document as JsonNode | null)?.content ?? []), resolveAsset);
}
