use weft_server::knowledge::markdown::{parse_markdown, resolve_link, LinkResolution, VaultNote};

#[test]
fn comrak_characterizes_obsidian_markdown_and_strips_hostile_inline_html() {
    let source = r#"---
title: Properties
aliases: [Home]
---

# Guide

[[folder/Target#Details|friendly name]]
[[folder/Target#Details]]
[[folder/Target^block-id]]
![[image.png]]

> [!warning] Watch out
> Keep this safe.

<details onclick="alert(1)"><summary>Open</summary><script>alert(2)</script><img src="x" onerror="alert(3)"><img src="https://tracker.example/pixel"><a href="javascript:alert(4)">bad link</a><iframe src="https://example.invalid"></iframe><svg><script>alert(5)</script></svg></details>
"#;

    let parsed = parse_markdown(source);
    assert!(parsed.html.contains("friendly name"));
    assert!(parsed.html.contains("href=\"folder/Target#Details\""));
    assert!(parsed.html.contains("folder/Target^block-id"));
    assert!(parsed.html.contains("href=\"image.png\""));
    assert!(parsed
        .wikilinks
        .iter()
        .any(|link| link.target == "image.png" && link.embed));
    assert!(parsed.html.contains("callout"));
    assert!(parsed.html.contains("Guide"));
    assert!(!parsed.html.contains("title: Properties"));
    assert!(!parsed.html.contains("onclick"));
    assert!(!parsed.html.contains("<script"));
    assert!(!parsed.html.contains("onerror"));
    assert!(!parsed.html.contains("javascript:"));
    assert!(!parsed.html.contains("<iframe"));
    assert!(!parsed.html.contains("<svg"));
    assert!(!parsed.html.contains("tracker.example"));
    assert!(parsed.html.contains("src=\"x\""));
}

#[test]
fn weft_link_resolution_prefers_paths_case_insensitive_names_and_nearest_alias() {
    let notes = [
        VaultNote::new("guides/Start.md", ["Welcome"]),
        VaultNote::new("guides/reference/Start.md", ["Reference"]),
        VaultNote::new("Guides/Target.md", std::iter::empty::<&str>()),
        VaultNote::new("other/Target.md", std::iter::empty::<&str>()),
    ];

    assert_eq!(
        resolve_link("guides/Start.md", "Guides/Target", &notes),
        LinkResolution::Resolved("Guides/Target.md".into())
    );
    assert_eq!(
        resolve_link("guides/reference/Start.md", "start", &notes),
        LinkResolution::Resolved("guides/reference/Start.md".into())
    );
    assert_eq!(
        resolve_link("guides/Start.md", "welcome", &notes),
        LinkResolution::Resolved("guides/Start.md".into())
    );
    assert!(matches!(
        resolve_link("guides/Start.md", "Missing", &notes),
        LinkResolution::Unresolved
    ));
}

#[test]
fn duplicate_name_tie_is_reported_deterministically() {
    let notes = [
        VaultNote::new("z/Topic.md", std::iter::empty::<&str>()),
        VaultNote::new("a/Topic.md", std::iter::empty::<&str>()),
    ];

    assert_eq!(
        resolve_link("elsewhere/Source.md", "topic", &notes),
        LinkResolution::Ambiguous("a/Topic.md".into())
    );
}

#[test]
fn heading_and_block_targets_render_stable_anchors() {
    let parsed = parse_markdown("## Details\n\nA paragraph. ^block-id\n");
    assert!(parsed.html.contains("id=\"weft-details\""));
    assert!(parsed.html.contains("id=\"weft-block-block-id\""));
    assert!(!parsed.html.contains("^block-id"));
}
