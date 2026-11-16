# Markdown fields for rich text

Actions that write comments, work item descriptions, and Wiki page content accept a dedicated `*Markdown` field beside the existing editor document field. Supply exactly one representation. Reads retain the editor document and add `markdown` (comments), `descriptionMarkdown` (work items), or `contentMarkdown` (Wiki pages), with a corresponding `*Warnings` array.

Headings, paragraphs, emphasis, links, code, lists, task lists, block quotes, and tables use standard Markdown. Content without an exact Markdown equivalent remains visible in the Markdown view as a flagged placeholder:

- Mentions use `@{name}` or `@{id}`.
- Uploaded images use `![Image: asset-id]`.
- Callouts use a block quote beginning `> [!CALLOUT]`.

The warning array names each kind that used a placeholder. These markers are for faithful reading and are not parsed back into the original rich node by Markdown input; keep the editor document when editing content that contains these nodes.

The CLI accepts a Markdown field as a flag value, or `-` to read it from stdin. MCP tool schemas place the Markdown field first and include an example in its description.
