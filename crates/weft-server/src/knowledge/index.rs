use serde_json::{Map, Value};

pub(crate) const PARSER_VERSION: &str = "comrak-0.59-index-1";

pub(crate) struct IndexedFile {
    pub(crate) path: String,
    pub(crate) text_content: Option<String>,
    pub(crate) title: String,
    pub(crate) search_text: String,
    pub(crate) properties: Value,
    pub(crate) tags: Vec<String>,
    pub(crate) outgoing_links: Vec<String>,
}

pub(crate) fn build(files: Vec<(String, Option<String>)>) -> Vec<IndexedFile> {
    files
        .into_iter()
        .map(|(path, text_content)| {
            let filename = path.rsplit('/').next().unwrap_or(&path);
            let fallback_title = filename.rsplit_once('.').map_or(filename, |(stem, _)| stem);
            let mut title = fallback_title.to_owned();
            let mut frontmatter_title = false;
            let mut properties = Map::new();
            let mut tags = Vec::new();
            let mut outgoing_links = Vec::new();
            let mut body = String::new();
            if let Some(source) = text_content.as_deref() {
                if path.to_ascii_lowercase().ends_with(".md") {
                    let (frontmatter, content) = split_frontmatter(source);
                    for line in frontmatter.lines() {
                        if let Some((key, value)) = line.split_once(':') {
                            let key = key.trim();
                            let value = value.trim().trim_matches(['"', '\'']);
                            if !key.is_empty() {
                                properties.insert(key.to_owned(), Value::String(value.to_owned()));
                                if key.eq_ignore_ascii_case("title") && !value.is_empty() {
                                    title = value.to_owned();
                                    frontmatter_title = true;
                                }
                                if key.eq_ignore_ascii_case("tags") {
                                    tags.extend(parse_list(value));
                                }
                            }
                        }
                    }
                    let parsed = super::markdown::parse_markdown(content);
                    if !frontmatter_title {
                        if let Some(heading) = content.lines().find_map(|line| {
                            let heading = line.trim_start_matches('#').trim();
                            (line.starts_with('#') && !heading.is_empty()).then_some(heading)
                        }) {
                            title = heading.to_owned();
                        }
                    }
                    outgoing_links.extend(parsed.wikilinks.into_iter().map(|link| link.target));
                    tags.extend(extract_tags(content));
                    body.push_str(content);
                } else if path.to_ascii_lowercase().ends_with(".html") {
                    title = html_title(source).unwrap_or(title);
                    body.push_str(&html_text(source));
                } else {
                    body.push_str(source);
                }
            }
            tags.sort();
            tags.dedup();
            outgoing_links.sort();
            outgoing_links.dedup();
            let mut indexed = vec![path.as_str(), title.as_str(), body.as_str()];
            let property_text = properties
                .iter()
                .map(|(key, value)| format!("{key} {}", value.as_str().unwrap_or_default()))
                .collect::<Vec<_>>();
            let tag_text = tags.iter().map(|tag| format!("#{tag}")).collect::<Vec<_>>();
            indexed.extend(property_text.iter().map(String::as_str));
            indexed.extend(tag_text.iter().map(String::as_str));
            indexed.extend(outgoing_links.iter().map(String::as_str));
            let search_text = indexed.join(" ");
            IndexedFile {
                path,
                text_content,
                title,
                search_text,
                properties: Value::Object(properties),
                tags,
                outgoing_links,
            }
        })
        .collect()
}

fn split_frontmatter(source: &str) -> (String, &str) {
    let Some(rest) = source.strip_prefix("---\n") else {
        return (String::new(), source);
    };
    let Some(end) = rest.find("\n---") else {
        return (String::new(), source);
    };
    (
        rest[..end].to_owned(),
        rest[end + 4..].trim_start_matches('\n'),
    )
}

fn parse_list(value: &str) -> Vec<String> {
    let value = value.trim().trim_start_matches('[').trim_end_matches(']');
    value
        .split(',')
        .map(|part| part.trim().trim_matches(['"', '\'', '#']).to_owned())
        .filter(|part| !part.is_empty())
        .collect()
}

fn extract_tags(source: &str) -> Vec<String> {
    let mut tags = Vec::new();
    for (index, _) in source.match_indices('#') {
        let suffix = &source[index + 1..];
        let tag = suffix
            .chars()
            .take_while(|character| {
                character.is_alphanumeric() || matches!(character, '_' | '-' | '/')
            })
            .collect::<String>();
        if !tag.is_empty() {
            tags.push(tag);
        }
    }
    tags
}

pub(crate) fn html_title(source: &str) -> Option<String> {
    let lower = source.to_ascii_lowercase();
    let start = lower.find("<title>")? + 7;
    let end = lower[start..].find("</title>")? + start;
    Some(source[start..end].trim().to_owned())
}

pub(crate) fn html_text(source: &str) -> String {
    let mut result = String::with_capacity(source.len());
    let mut rest = source;
    while !rest.is_empty() {
        let Some(tag_start) = rest.find('<') else {
            result.push_str(rest);
            break;
        };
        result.push_str(&rest[..tag_start]);
        let Some(tag_end) = rest[tag_start..].find('>') else {
            break;
        };
        let tag = rest[tag_start + 1..tag_start + tag_end]
            .trim_start_matches('/')
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        rest = &rest[tag_start + tag_end + 1..];
        if matches!(tag.as_str(), "script" | "style" | "head" | "title") {
            let closing = format!("</{tag}");
            if let Some(close_start) = rest.to_ascii_lowercase().find(&closing) {
                if let Some(close_end) = rest[close_start..].find('>') {
                    rest = &rest[close_start + close_end + 1..];
                } else {
                    break;
                }
            } else {
                break;
            }
        }
    }
    result.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(crate) fn snippet(search_text: &str, query: &str) -> String {
    let lower_query = query.to_lowercase();
    let mut lower_text = String::with_capacity(search_text.len());
    let mut source_offsets = Vec::with_capacity(search_text.len());
    for (source_index, character) in search_text.char_indices() {
        let lowered = character.to_lowercase().collect::<String>();
        source_offsets.extend(std::iter::repeat_n(source_index, lowered.len()));
        lower_text.push_str(&lowered);
    }
    let match_start = lower_text
        .find(&lower_query)
        .and_then(|index| source_offsets.get(index).copied())
        .unwrap_or(0);
    let start = search_text[..match_start]
        .char_indices()
        .rev()
        .nth(50)
        .map_or(0, |(index, _)| index);
    let end = search_text[start..]
        .char_indices()
        .nth(180)
        .map_or(search_text.len(), |(index, _)| start + index);
    search_text[start..end].trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::snippet;

    #[test]
    fn snippets_keep_case_folded_match_offsets_on_character_boundaries() {
        for (text, query) in [
            ("İภาษาไทย", "ภาษา"),
            ("Kภาษาไทย", "ภาษา"),
            ("ภาษาไทย", "ไทย"),
        ] {
            assert!(snippet(text, query).contains(query));
        }
    }
}
