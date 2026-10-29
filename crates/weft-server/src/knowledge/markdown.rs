use std::collections::{HashMap, HashSet};

use comrak::{format_html, nodes::NodeValue, parse_document, Arena, Options};

#[derive(Debug, PartialEq, Eq)]
pub struct ParsedMarkdown {
    pub html: String,
    pub wikilinks: Vec<WikiLink>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct WikiLink {
    pub target: String,
    pub embed: bool,
}

/// Renders the supported Obsidian Markdown subset and sanitizes all raw HTML.
pub fn parse_markdown(source: &str) -> ParsedMarkdown {
    let mut options = Options::default();
    options.extension.wikilinks_title_after_pipe = true;
    options.extension.front_matter_delimiter = Some("---".to_owned());
    options.extension.header_id_prefix = Some("weft-".to_owned());
    options.extension.header_id_prefix_in_href = true;
    options.extension.ofm_callouts = true;
    options.extension.table = true;
    options.extension.tasklist = true;
    options.extension.strikethrough = true;
    options.extension.autolink = true;
    options.extension.description_lists = true;
    options.extension.multiline_block_quotes = true;
    options.extension.math_dollars = false;
    options.render.r#unsafe = true;

    let arena = Arena::new();
    let document = parse_document(&arena, source, &options);
    let wikilinks = document
        .descendants()
        .filter_map(|node| match &node.data().value {
            NodeValue::WikiLink(link) => Some(WikiLink {
                target: link.url.clone(),
                embed: link.embed,
            }),
            _ => None,
        })
        .collect();
    let mut html = String::new();
    format_html(document, &options, &mut html).expect("formatting a parsed document succeeds");

    ParsedMarkdown {
        html: add_block_identifiers(&sanitize_inline_html(&html), source),
        wikilinks,
    }
}

fn sanitize_inline_html(html: &str) -> String {
    let tags = [
        "a",
        "blockquote",
        "br",
        "code",
        "dd",
        "del",
        "details",
        "div",
        "dl",
        "dt",
        "em",
        "figcaption",
        "figure",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "hr",
        "img",
        "kbd",
        "li",
        "ol",
        "p",
        "pre",
        "s",
        "span",
        "strong",
        "sub",
        "summary",
        "sup",
        "table",
        "tbody",
        "td",
        "th",
        "thead",
        "tr",
        "ul",
    ]
    .into_iter()
    .collect::<HashSet<_>>();
    let attributes = HashMap::from([
        ("a", HashSet::from(["href", "title", "data-wikilink", "id"])),
        ("img", HashSet::from(["src", "alt", "title"])),
        ("div", HashSet::from(["class"])),
        ("span", HashSet::from(["class"])),
        ("code", HashSet::from(["class"])),
        ("h1", HashSet::from(["id"])),
        ("h2", HashSet::from(["id"])),
        ("h3", HashSet::from(["id"])),
        ("h4", HashSet::from(["id"])),
        ("h5", HashSet::from(["id"])),
        ("h6", HashSet::from(["id"])),
        ("p", HashSet::from(["id"])),
    ]);
    let url_schemes = ["http", "https", "mailto"].into_iter().collect();

    ammonia::Builder::default()
        .tags(tags)
        .tag_attributes(attributes)
        .url_schemes(url_schemes)
        .attribute_filter(|element, attribute, value| {
            if element == "img"
                && attribute == "src"
                && ["http:", "https:", "//", "data:"]
                    .iter()
                    .any(|prefix| value.to_ascii_lowercase().starts_with(prefix))
            {
                None
            } else {
                Some(value.into())
            }
        })
        .clean(html)
        .to_string()
}

fn add_block_identifiers(html: &str, source: &str) -> String {
    let mut html = html.to_owned();
    for line in source.lines() {
        let Some((_, id)) = line.rsplit_once(" ^") else {
            continue;
        };
        let id = id.trim();
        if id.is_empty()
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            continue;
        }
        let marker = format!(" ^{id}</p>");
        let Some(marker_start) = html.find(&marker) else {
            continue;
        };
        let Some(paragraph_start) = html[..marker_start].rfind("<p>") else {
            continue;
        };
        html.replace_range(marker_start..marker_start + marker.len(), "</p>");
        html.insert_str(paragraph_start + 2, &format!(" id=\"weft-block-{id}\""));
    }
    html
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultNote {
    pub path: String,
    pub aliases: Vec<String>,
}

impl VaultNote {
    pub fn new<I, S>(path: impl Into<String>, aliases: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            path: path.into(),
            aliases: aliases.into_iter().map(Into::into).collect(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkResolution {
    Resolved(String),
    Ambiguous(String),
    Unresolved,
}

/// Applies Weft's deterministic, within-Vault link rules to an indexed vault sample.
pub fn resolve_link(source_path: &str, target: &str, notes: &[VaultNote]) -> LinkResolution {
    let target = target.split(['#', '^']).next().unwrap_or(target).trim();
    let explicit_path = with_markdown_extension(target);
    if let Some(note) = notes.iter().find(|note| note.path == explicit_path) {
        return LinkResolution::Resolved(note.path.clone());
    }

    let candidates = notes
        .iter()
        .filter(|note| {
            note_stem(&note.path).eq_ignore_ascii_case(target)
                || note
                    .aliases
                    .iter()
                    .any(|alias| alias.eq_ignore_ascii_case(target))
        })
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return LinkResolution::Unresolved;
    }

    let source_folder = parent_folder(source_path);
    let nearest = candidates
        .iter()
        .map(|note| folder_distance(source_folder, parent_folder(&note.path)))
        .min()
        .unwrap_or(usize::MAX);
    let mut nearest_candidates = candidates
        .into_iter()
        .filter(|note| folder_distance(source_folder, parent_folder(&note.path)) == nearest)
        .map(|note| note.path.as_str())
        .collect::<Vec<_>>();
    nearest_candidates.sort_unstable();
    match nearest_candidates.as_slice() {
        [path] => LinkResolution::Resolved((*path).to_owned()),
        [path, ..] => LinkResolution::Ambiguous((*path).to_owned()),
        [] => LinkResolution::Unresolved,
    }
}

fn with_markdown_extension(path: &str) -> String {
    if path
        .rsplit('/')
        .next()
        .is_some_and(|name| name.contains('.'))
    {
        path.to_owned()
    } else {
        format!("{path}.md")
    }
}

fn note_stem(path: &str) -> &str {
    path.rsplit_once('/')
        .map(|(_, name)| name)
        .unwrap_or(path)
        .strip_suffix(".md")
        .unwrap_or_else(|| path.rsplit('/').next().unwrap_or(path))
}

fn parent_folder(path: &str) -> &str {
    path.rsplit_once('/')
        .map(|(folder, _)| folder)
        .unwrap_or("")
}

fn folder_distance(source: &str, target: &str) -> usize {
    let source_parts = source
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let target_parts = target
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let common_prefix = source_parts
        .iter()
        .zip(&target_parts)
        .take_while(|(left, right)| left == right)
        .count();
    source_parts.len() + target_parts.len() - 2 * common_prefix
}
