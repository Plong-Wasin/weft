# Markdown links and Thai search spike

This spike records the behavior exercised by `crates/weft-server/tests/markdown_spike.rs` and `crates/weft-server/tests/thai_search_spike.rs`. The parser dependency is comrak 0.59.0 with default features disabled; raw HTML is enabled only for the parse-render-sanitize pipeline and then passed through ammonia 4.2.4.

## Markdown rendering

- With `wikilinks_title_after_pipe`, `[[folder/Target#Details|friendly name]]` renders `folder/Target#Details` as the link target and `friendly name` as its label. The no-alias `[[folder/Target#Details]]` form also renders as a link.
- `[[folder/Target^block-id]]` keeps the block target in the link target. The heading and block fragment are preserved by rendering; resolution still needs to split and retain the anchor separately from its file path.
- `![[image.png]]` is marked `embed = true` in the comrak AST, but comrak's HTML formatter still emits an anchor (`href="image.png"`), not an image. The AST flag must drive a later rendering transform.
- `ofm_callouts` renders Obsidian callout blocks; `front_matter_delimiter = "---"` removes frontmatter from rendered HTML. Properties therefore need separate extraction for indexing.
- The hostile fixture confirms scripts, event handlers, JavaScript URLs, remote image sources, iframes, and inline SVG are removed. A relative image path and benign `details`/`summary` content remain.

## Weft link resolution

The sample-vault tests cover explicit paths alongside duplicate basenames, case-insensitive note and alias matching, a same-folder match against a parent-folder match, deterministic ties, and unresolved targets. The implementation first checks an explicit path, then note stems and aliases without case, ranks candidates by folder-tree distance, flags a tie as ambiguous while returning the alphabetically first path, and leaves a miss unresolved. Resolution receives one vault's note list, so it cannot resolve a wikilink across Vaults. It does not create missing files.

## Thai search behavior

The PostgreSQL test exercises the real `simple` configuration and `pg_trgm` functions in the shared test database. For the no-space fixture `ระบบจัดการงานทีม`, `simple` full-text finds the entire phrase but not the substring `จัดการ`; `word_similarity` finds that substring at threshold 0.3 and returns 1.0 for an exact match. This confirms substring matching for the tested phrase while also confirming that `simple` does not segment Thai text.

This is a behavior sample, not a relevance benchmark. The threshold is not tuned for production, and short-query behavior, ranking, snippets, and ACL filtering remain to be measured when Knowledge search is implemented. No claim of general Thai word segmentation is supported by this result.

`crates/weft-server/migrations/0007_pg_trgm.sql` enables the extension in `public`; the test applies the normal server migrations to its own isolated schema before querying it.
