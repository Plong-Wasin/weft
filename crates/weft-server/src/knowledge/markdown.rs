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

/// The only image source user content may carry is a comment attachment on this origin. Any other
/// relative path (an export or other state-changing route) or absolute URL would make a viewer's
/// browser issue a request just by rendering the page. The value is matched exactly, with no
/// trimming, so whitespace, backslash and control-character tricks never reach a prefix check.
fn allowed_image_source(value: &str) -> bool {
    value
        .strip_prefix("/api/v1/attachments/")
        .is_some_and(|key| !key.is_empty() && key.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))
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
        (
            "a",
            HashSet::from([
                "href",
                "title",
                "data-wikilink",
                "data-task-reference",
                "data-note-reference",
                "id",
            ]),
        ),
        ("img", HashSet::from(["src", "alt", "title"])),
        ("div", HashSet::from(["class"])),
        ("span", HashSet::from(["class", "data-note-reference"])),
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
            if attribute == "class" {
                allowed_markdown_classes(element, value).then(|| value.into())
            } else if attribute == "id" {
                // Generated heading anchors carry the `weft-` prefix; any other id could
                // clobber an element of the application page.
                value.starts_with("weft-").then(|| value.into())
            } else if element == "img" && attribute == "src" {
                allowed_image_source(value).then(|| value.into())
            } else {
                Some(value.into())
            }
        })
        .clean(html)
        .to_string()
}

fn allowed_markdown_classes(element: &str, value: &str) -> bool {
    let classes = value.split_ascii_whitespace().collect::<Vec<_>>();
    !classes.is_empty()
        && classes.iter().all(|class| match element {
            "div" | "span" => {
                matches!(
                    *class,
                    "callout"
                        | "task-list"
                        | "task-list-item"
                        | "contains-task-list"
                        | "task-list-item-checkbox"
                ) || class.starts_with("callout-")
                    && class[8..].bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                    })
            }
            "code" => class.strip_prefix("language-").is_some_and(|language| {
                !language.is_empty()
                    && language.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'+' | b'-' | b'#')
                    })
            }),
            _ => false,
        })
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

#[cfg(test)]
mod tests {
    use super::parse_markdown;

    #[test]
    fn raw_html_cannot_assign_application_overlay_classes() {
        let rendered =
            parse_markdown(r#"<div class="overlay-backdrop phishing">Sign in again</div>"#);
        assert!(!rendered.html.contains("overlay-backdrop"));
        assert!(!rendered.html.contains("phishing"));
    }

    #[test]
    fn image_sources_are_limited_to_the_attachment_route() {
        let img = |src: &str| parse_markdown(&format!("<img src=\"{src}\">")).html;
        let key = "11111111-1111-1111-1111-111111111111";
        assert!(img(&format!("/api/v1/attachments/{key}")).contains("src="));
        for blocked in [
            "/api/v1/workspaces/11111111-1111-1111-1111-111111111111/export",
            "/api/v1/vaults/11111111-1111-1111-1111-111111111111/export",
            "/\\evil.example/x",
            "\\\\evil.example/x",
            " https://evil.example/x",
            "\thttps://evil.example/x",
            "JaVaScRiPt:alert(1)",
            "/api/v1/attachments/../workspaces/x/export",
            "relative/pic.png",
        ] {
            assert!(!img(blocked).contains("src="), "{blocked:?} kept: {}", img(blocked));
        }
    }

    #[test]
    fn user_ids_cannot_clobber_page_elements() {
        let html = parse_markdown("<p id=\"root\">x</p><a id=\"root\">y</a>\n\n# Title").html;
        assert!(!html.contains("id=\"root\""), "{html}");
        assert!(html.contains("id=\"weft-"), "generated heading anchors keep their ids: {html}");
    }
}
