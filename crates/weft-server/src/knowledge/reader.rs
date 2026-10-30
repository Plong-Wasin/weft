use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::Stdio,
};

use axum::{
    body::Body,
    extract::{Path as AxumPath, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    auth::{require_session, AuthState},
    knowledge::markdown::{parse_markdown, resolve_link, LinkResolution, VaultNote},
    projects::Role,
    vaults::evaluate_access,
};

const MAX_NOTE_BYTES: usize = 10 * 1024 * 1024;
const MAX_LFS_OBJECT_BYTES: u64 = 25 * 1024 * 1024;

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route("/vaults/:vault_id/notes", get(read_note))
        .route("/vaults/:vault_id/backlinks", get(read_backlinks))
        .route("/vaults/:vault_id/history", get(read_history))
        .route("/vaults/:vault_id/files", get(read_file))
}

pub(crate) fn page_routes() -> Router<AuthState> {
    Router::new().route("/vault-pages/:vault_id/*path", get(read_html_page))
}

async fn read_html_page(
    State(state): State<AuthState>,
    AxumPath((vault, path)): AxumPath<(Uuid, String)>,
    headers: HeaderMap,
) -> Response {
    if !path.to_ascii_lowercase().ends_with(".html") || !safe_vault_path(&path) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some((repository, _)) = authorized_repository(&state, vault, &headers).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let files = match tree_files_async(&repository).await {
        Ok(files) => files,
        Err(status) => return status.into_response(),
    };
    let Some(_entry) = files
        .get(&path)
        .filter(|entry| entry.mode.starts_with("100"))
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let bytes = match read_git_file_async(&repository, &path).await {
        Ok(bytes) if bytes.len() <= MAX_NOTE_BYTES => bytes,
        Ok(_) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
        Err(status) => return status.into_response(),
    };
    let Ok(source) = String::from_utf8(bytes) else {
        return StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response();
    };
    let mut response = Response::new(Body::from(source));
    *response.status_mut() = StatusCode::OK;
    let response_headers = response.headers_mut();
    response_headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    response_headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response_headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'"));
    response
}

#[derive(serde::Deserialize)]
struct VaultPath {
    path: String,
}

async fn read_note(
    State(state): State<AuthState>,
    AxumPath(vault): AxumPath<Uuid>,
    Query(query): Query<VaultPath>,
    headers: HeaderMap,
) -> Response {
    let path = query.path;
    let Some((repository, _)) = authorized_repository(&state, vault, &headers).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !safe_vault_path(&path) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let files = match tree_files_async(&repository).await {
        Ok(files) => files,
        Err(status) => return status.into_response(),
    };
    let Some(entry) = files.get(&path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if entry.mode == "120000" || !entry.mode.starts_with("100") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(source) = read_git_file_async(&repository, &path)
        .await
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if path.to_ascii_lowercase().ends_with(".html") {
        let encoded_path = path
            .split('/')
            .map(encode_path_segment)
            .collect::<Vec<_>>()
            .join("/");
        return Json(json!({"path": path, "title": super::index::html_title(&source), "visible_text": super::index::html_text(&source), "page_url": format!("/vault-pages/{vault}/{encoded_path}"), "format": "html_page"})).into_response();
    }
    if !path.to_ascii_lowercase().ends_with(".md") {
        return StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response();
    }
    let loaded = match load_notes(&repository, &files).await {
        Ok(notes) => notes,
        Err(status) => return status.into_response(),
    };
    let parsed = parse_markdown(&source);
    let links = parsed
        .wikilinks
        .iter()
        .map(|link| {
            let target = decode_wikilink_target(&link.target);
            let resolution = resolve_reader_link(&path, &target, link.embed, &loaded.notes, &files);
            json!({"target":target,"embed":link.embed,"resolution":resolution_json(resolution)})
        })
        .collect::<Vec<_>>();
    let aliases = aliases_from_frontmatter(&source);
    let properties = frontmatter_properties(&source);
    let tags = markdown_tags(&source);
    let html = rewrite_wikilink_hrefs(
        &parsed.html,
        &parsed.wikilinks,
        &path,
        &loaded.notes,
        &files,
        vault,
    );
    Json(json!({
        "path": path,
        "html": html,
        "properties": properties,
        "aliases": aliases,
        "tags": tags,
        "links": links,
        "format": "markdown"
    }))
    .into_response()
}

async fn read_backlinks(
    State(state): State<AuthState>,
    AxumPath(vault): AxumPath<Uuid>,
    Query(query): Query<VaultPath>,
    headers: HeaderMap,
) -> Response {
    let path = query.path;
    let Some((repository, _)) = authorized_repository(&state, vault, &headers).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !safe_vault_path(&path) || !path.to_ascii_lowercase().ends_with(".md") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let files = match tree_files_async(&repository).await {
        Ok(files) => files,
        Err(status) => return status.into_response(),
    };
    if !files.contains_key(&path) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let loaded = match load_notes(&repository, &files).await {
        Ok(notes) => notes,
        Err(status) => return status.into_response(),
    };
    let mut backlinks = Vec::new();
    for note in loaded.notes.iter().filter(|note| note.path != path) {
        let Some(links) = loaded.links.get(&note.path) else {
            continue;
        };
        if links.iter().any(|(target, embed)| {
            matches!(resolve_reader_link(&note.path, target, *embed, &loaded.notes, &files), LinkResolution::Resolved(found) if found == path)
        }) {
            let title = loaded
                .titles
                .get(&note.path)
                .map(String::as_str)
                .unwrap_or_default();
            backlinks.push(json!({"path":note.path,"title":title}));
        }
    }
    Json(json!({"backlinks": backlinks})).into_response()
}

async fn read_history(
    State(state): State<AuthState>,
    AxumPath(vault): AxumPath<Uuid>,
    Query(query): Query<VaultPath>,
    headers: HeaderMap,
) -> Response {
    let path = query.path;
    let Some((repository, _)) = authorized_repository(&state, vault, &headers).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !safe_vault_path(&path) || path.to_ascii_lowercase().ends_with(".html") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let files = match tree_files_async(&repository).await {
        Ok(files) => files,
        Err(status) => return status.into_response(),
    };
    if !files.contains_key(&path) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let output = tokio::task::spawn_blocking(move || {
        crate::vault_import::git_readonly_command()
            .arg("--git-dir")
            .arg(&repository)
            .args([
                "log",
                "--follow",
                "--format=%H%x00%an%x00%aI%x00%s",
                "--",
                &path,
            ])
            .output()
    })
    .await;
    let Ok(Ok(output)) = output else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    if !output.status.success() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let commits = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(4, '\0');
            Some(json!({
                "id":fields.next()?,
                "author":fields.next()?,
                "time":fields.next()?,
                "message":fields.next()?
            }))
        })
        .collect::<Vec<_>>();
    Json(json!({"commits":commits})).into_response()
}

async fn read_file(
    State(state): State<AuthState>,
    AxumPath(vault): AxumPath<Uuid>,
    Query(query): Query<VaultPath>,
    headers: HeaderMap,
) -> Response {
    let path = query.path;
    let Some((repository, _)) = authorized_repository(&state, vault, &headers).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !safe_vault_path(&path) || path.to_ascii_lowercase().ends_with(".html") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let files = match tree_files_async(&repository).await {
        Ok(files) => files,
        Err(status) => return status.into_response(),
    };
    let Some(entry) = files.get(&path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if entry.mode == "120000" || !entry.mode.starts_with("100") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let mut bytes = match read_git_file_async(&repository, &path).await {
        Ok(bytes) => bytes,
        Err(status) => return status.into_response(),
    };
    if let Some(oid) = lfs_oid(&bytes) {
        let object = Path::new(&repository)
            .join("lfs/objects")
            .join(&oid[0..2])
            .join(&oid[2..4])
            .join(&oid);
        bytes = match tokio::fs::metadata(&object).await {
            Ok(metadata) if metadata.len() <= MAX_LFS_OBJECT_BYTES => {
                match tokio::fs::read(object).await {
                    Ok(bytes) => bytes,
                    Err(_) => return StatusCode::NOT_FOUND.into_response(),
                }
            }
            Ok(_) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
            Err(_) => return StatusCode::NOT_FOUND.into_response(),
        };
    }
    let mime = image_content_type(&path).unwrap_or("application/octet-stream");
    let inline = image_content_type(&path).is_some();
    let disposition = if inline {
        "inline; filename=\"image\""
    } else {
        "attachment; filename=\"download\""
    };
    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = StatusCode::OK;
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static(disposition),
    );
    response
}

async fn authorized_repository(
    state: &AuthState,
    vault: Uuid,
    headers: &HeaderMap,
) -> Option<(String, Uuid)> {
    let (_, user) = require_session(&state.pool, headers, false).await.ok()?;
    let access = match evaluate_access(&state.pool, vault, user).await {
        Ok(Some(access)) => access,
        _ => return None,
    };
    if access.role < Role::Viewer {
        return None;
    }
    let repository =
        sqlx::query("SELECT repository_path FROM vaults WHERE id=$1 AND workspace_id=$2")
            .bind(vault)
            .bind(access.workspace_id)
            .fetch_optional(&state.pool)
            .await;
    let repository = match repository {
        Ok(Some(repository)) => repository,
        _ => return None,
    };
    Some((repository.get("repository_path"), user))
}

#[derive(Clone)]
struct TreeEntry {
    mode: String,
    oid: String,
}

struct LoadedNotes {
    notes: Vec<VaultNote>,
    links: HashMap<String, Vec<(String, bool)>>,
    titles: HashMap<String, String>,
}

fn tree_files(repository: &str) -> Result<HashMap<String, TreeEntry>, StatusCode> {
    let output = crate::vault_import::git_readonly_command()
        .arg("--git-dir")
        .arg(repository)
        .args(["ls-tree", "-r", "-z", "--full-tree", "HEAD"])
        .output()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if !output.status.success() {
        return Err(StatusCode::NOT_FOUND);
    }
    let mut files = HashMap::new();
    for entry in output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
    {
        let Some(separator) = entry.iter().position(|byte| *byte == b'\t') else {
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        };
        let (metadata, path) = (&entry[..separator], &entry[separator + 1..]);
        let metadata = String::from_utf8_lossy(metadata);
        let mode = metadata
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_owned();
        let oid = metadata
            .split_whitespace()
            .nth(2)
            .unwrap_or_default()
            .to_owned();
        let path = String::from_utf8_lossy(path).into_owned();
        if path == ".obsidian" || path.starts_with(".obsidian/") || !safe_vault_path(&path) {
            continue;
        }
        files.insert(path, TreeEntry { mode, oid });
    }
    Ok(files)
}

fn read_git_file(repository: &str, path: &str) -> Result<Vec<u8>, StatusCode> {
    let output = crate::vault_import::git_readonly_command()
        .arg("--git-dir")
        .arg(repository)
        .arg("show")
        .arg(format!("HEAD:{path}"))
        .output()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(StatusCode::NOT_FOUND)
    }
}

async fn tree_files_async(repository: &str) -> Result<HashMap<String, TreeEntry>, StatusCode> {
    let repository = repository.to_owned();
    tokio::task::spawn_blocking(move || tree_files(&repository))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
}

async fn read_git_file_async(repository: &str, path: &str) -> Result<Vec<u8>, StatusCode> {
    let repository = repository.to_owned();
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || read_git_file(&repository, &path))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
}

async fn load_notes(
    repository: &str,
    files: &HashMap<String, TreeEntry>,
) -> Result<LoadedNotes, StatusCode> {
    let repository = repository.to_owned();
    let mut markdown_files = files
        .iter()
        .filter(|(path, entry)| {
            path.to_ascii_lowercase().ends_with(".md")
                && entry.mode.starts_with("100")
                && entry.mode != "120000"
        })
        .map(|(path, entry)| (path.clone(), entry.oid.clone()))
        .collect::<Vec<_>>();
    markdown_files.sort_by(|left, right| left.0.cmp(&right.0));
    tokio::task::spawn_blocking(move || load_notes_batch(&repository, markdown_files))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
}

fn load_notes_batch(
    repository: &str,
    files: Vec<(String, String)>,
) -> Result<LoadedNotes, StatusCode> {
    let mut child = crate::vault_import::git_readonly_command()
        .arg("--git-dir")
        .arg(repository)
        .args(["cat-file", "--batch"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut input = child
        .stdin
        .take()
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    let stdout = child
        .stdout
        .take()
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut output = BufReader::new(stdout);
    let mut header = Vec::new();
    let mut notes = Vec::new();
    let mut links = HashMap::new();
    let mut titles = HashMap::new();
    for (path, oid) in files {
        writeln!(input, "{oid}").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        input
            .flush()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        header.clear();
        output
            .read_until(b'\n', &mut header)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if header.ends_with(b" missing\n") {
            continue;
        }
        let size = header
            .split(|byte| byte.is_ascii_whitespace())
            .nth(2)
            .and_then(|size| std::str::from_utf8(size).ok())
            .and_then(|size| size.parse::<usize>().ok())
            .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
        if size > MAX_NOTE_BYTES {
            std::io::copy(&mut output.by_ref().take(size as u64), &mut std::io::sink())
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            let mut separator = [0];
            output
                .read_exact(&mut separator)
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            continue;
        }
        let mut bytes = vec![0; size];
        output
            .read_exact(&mut bytes)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let mut separator = [0];
        output
            .read_exact(&mut separator)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let Ok(source) = String::from_utf8(bytes) else {
            continue;
        };
        notes.push(VaultNote::new(
            path.clone(),
            aliases_from_frontmatter(&source),
        ));
        let parsed = parse_markdown(&source);
        links.insert(
            path.clone(),
            parsed
                .wikilinks
                .into_iter()
                .map(|link| (link.target, link.embed))
                .collect(),
        );
        titles.insert(path.clone(), note_title(&source, &path));
    }
    drop(input);
    let status = child
        .wait()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if !status.success() {
        return Err(StatusCode::NOT_FOUND);
    }
    Ok(LoadedNotes {
        notes,
        links,
        titles,
    })
}

fn safe_vault_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains('\0')
        && !path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        && path != ".obsidian"
        && !path.starts_with(".obsidian/")
}

fn aliases_from_frontmatter(source: &str) -> Vec<String> {
    let Some(frontmatter) = frontmatter(source) else {
        return Vec::new();
    };
    let Some(value) = frontmatter.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        matches!(key.trim(), "aliases" | "alias").then_some(value.trim())
    }) else {
        return Vec::new();
    };
    let value = value.trim_matches(['[', ']']);
    value
        .split(',')
        .map(|alias| alias.trim().trim_matches(['\'', '"']).trim().to_owned())
        .filter(|alias| !alias.is_empty())
        .collect()
}

fn frontmatter_properties(source: &str) -> Value {
    let mut properties = serde_json::Map::new();
    if let Some(frontmatter) = frontmatter(source) {
        for line in frontmatter.lines() {
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            let key = key.trim();
            let value = value.trim();
            if key.is_empty() {
                continue;
            }
            properties.insert(
                key.to_owned(),
                json!(value.trim_matches(['[', ']']).trim_matches(['\'', '"'])),
            );
        }
    }
    Value::Object(properties)
}

fn frontmatter(source: &str) -> Option<&str> {
    let rest = source.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    Some(&rest[..end])
}

fn markdown_tags(source: &str) -> Vec<String> {
    let mut tags = frontmatter(source)
        .and_then(|frontmatter| {
            frontmatter.lines().find_map(|line| {
                let (key, value) = line.split_once(':')?;
                (key.trim() == "tags").then_some(value.trim())
            })
        })
        .map(|value| {
            value
                .trim_matches(['[', ']'])
                .split(',')
                .map(|tag| tag.trim().trim_matches(['\'', '"']).to_owned())
                .filter(|tag| !tag.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let body = source
        .strip_prefix("---\n")
        .and_then(|rest| rest.find("\n---").map(|end| &rest[end + 4..]))
        .unwrap_or(source);
    tags.extend(
        body.split_whitespace()
            .filter_map(|word| word.strip_prefix('#'))
            .map(|tag| {
                tag.trim_matches(|character: char| {
                    !character.is_alphanumeric() && character != '_' && character != '-'
                })
            })
            .filter(|tag| !tag.is_empty())
            .map(str::to_owned),
    );
    let mut seen = HashSet::new();
    tags.retain(|tag| seen.insert(tag.to_ascii_lowercase()));
    tags
}

fn note_title(source: &str, path: &str) -> String {
    source
        .lines()
        .find_map(|line| line.strip_prefix("# ").map(str::to_owned))
        .unwrap_or_else(|| {
            Path::new(path)
                .file_stem()
                .and_then(|name| name.to_str())
                .unwrap_or(path)
                .to_owned()
        })
}

fn resolution_json(resolution: LinkResolution) -> Value {
    match resolution {
        LinkResolution::Resolved(path) => json!({"status":"resolved","path":path}),
        LinkResolution::Ambiguous(candidate) => json!({"status":"ambiguous","candidate":candidate}),
        LinkResolution::Unresolved => json!({"status":"unresolved"}),
    }
}

fn rewrite_wikilink_hrefs(
    html: &str,
    links: &[crate::knowledge::markdown::WikiLink],
    source_path: &str,
    notes: &[VaultNote],
    files: &HashMap<String, TreeEntry>,
    vault: Uuid,
) -> String {
    let mut rewritten = html.to_owned();
    for link in links {
        let target = decode_wikilink_target(&link.target);
        let resolution = resolve_reader_link(source_path, &target, link.embed, notes, files);
        let LinkResolution::Resolved(path) = resolution else {
            continue;
        };
        let fragment = target
            .find(['#', '^'])
            .map(|index| &target[index..])
            .unwrap_or("");
        let suffix = if let Some(block_id) = fragment.strip_prefix('^') {
            format!("#weft-block-{block_id}")
        } else if let Some(heading) = fragment.strip_prefix('#') {
            format!("#weft-{}", heading_slug(heading))
        } else {
            String::new()
        };
        let encoded_path = path
            .split('/')
            .map(encode_path_segment)
            .collect::<Vec<_>>()
            .join("/");
        let replacement = if link.embed {
            format!("/api/v1/vaults/{vault}/files?path={encoded_path}")
        } else {
            format!("/api/v1/vaults/{vault}/notes?path={encoded_path}{suffix}")
        };
        let old_target = encode_wikilink_href(&link.target);
        let old = format!("href=\"{}\"", escape_html_attribute(&old_target));
        let new = format!("href=\"{}\"", escape_html_attribute(&replacement));
        if link.embed {
            let text = escape_html_attribute(&target);
            let old_anchor =
                format!("<a {old} data-wikilink=\"true\" rel=\"noopener noreferrer\">{text}</a>");
            let image = format!(
                "<img src=\"{}\" alt=\"{}\" />",
                escape_html_attribute(&replacement),
                text
            );
            rewritten = rewritten.replace(&old_anchor, &image);
        } else {
            rewritten = rewritten.replace(&old, &new);
        }
    }
    rewritten
}

fn resolve_reader_link(
    source_path: &str,
    target: &str,
    embed: bool,
    notes: &[VaultNote],
    files: &HashMap<String, TreeEntry>,
) -> LinkResolution {
    let decoded_target = decode_wikilink_target(target);
    if embed {
        let target = decoded_target
            .split(['#', '^'])
            .next()
            .unwrap_or(&decoded_target)
            .trim();
        let local = Path::new(source_path)
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .map(|parent| parent.join(target).to_string_lossy().into_owned());
        for candidate in [Some(target.to_owned()), local].into_iter().flatten() {
            if files.contains_key(&candidate) {
                return LinkResolution::Resolved(candidate);
            }
        }
        return LinkResolution::Unresolved;
    }
    resolve_link(source_path, &decoded_target, notes)
}

fn encode_path_segment(segment: &str) -> String {
    let bytes = segment.as_bytes();
    let mut encoded = String::new();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            encoded.push(byte as char);
        } else if byte == b'%'
            && index + 2 < bytes.len()
            && bytes[index + 1].is_ascii_hexdigit()
            && bytes[index + 2].is_ascii_hexdigit()
        {
            encoded.push('%');
            encoded.push(bytes[index + 1] as char);
            encoded.push(bytes[index + 2] as char);
            index += 2;
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
        index += 1;
    }
    encoded
}

fn decode_wikilink_target(target: &str) -> String {
    let bytes = target.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                decoded.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn encode_wikilink_href(target: &str) -> String {
    let fragment_start = target.find('#').unwrap_or(target.len());
    let (path, fragment) = target.split_at(fragment_start);
    let encoded_path = path
        .split('/')
        .map(encode_path_segment)
        .collect::<Vec<_>>()
        .join("/");
    format!("{encoded_path}{fragment}")
}

fn heading_slug(heading: &str) -> String {
    let mut slug = String::new();
    let mut separator = false;
    for character in heading.to_lowercase().chars() {
        if character.is_alphanumeric() || character == '_' || character == '-' {
            if separator && !slug.is_empty() {
                slug.push('-');
            }
            separator = false;
            slug.push(character);
        } else {
            separator = true;
        }
    }
    slug
}

fn escape_html_attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn lfs_oid(bytes: &[u8]) -> Option<String> {
    let pointer = std::str::from_utf8(bytes).ok()?;
    if !pointer.starts_with("version https://git-lfs.github.com/spec/v1\n") {
        return None;
    }
    let oid = pointer
        .lines()
        .find_map(|line| line.strip_prefix("oid sha256:"))?;
    (oid.len() == 64 && oid.bytes().all(|byte| byte.is_ascii_hexdigit())).then(|| oid.to_owned())
}

fn image_content_type(path: &str) -> Option<&'static str> {
    match Path::new(path)
        .extension()?
        .to_str()?
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "avif" => Some("image/avif"),
        "bmp" => Some("image/bmp"),
        "tif" | "tiff" => Some("image/tiff"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, process::Command};

    #[test]
    fn missing_note_blob_is_ignored_instead_of_failing_the_vault_view() {
        let root = std::env::temp_dir().join(format!("weft-reader-missing-{}", Uuid::new_v4()));
        let repo = root.join("repo.git");
        let work = root.join("work");
        fs::create_dir_all(&root).unwrap();
        assert!(Command::new("git")
            .args(["init", "--bare", "--initial-branch=main"])
            .arg(&repo)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["clone", "--"])
            .arg(&repo)
            .arg(&work)
            .status()
            .unwrap()
            .success());
        fs::write(work.join("note.md"), "available note").unwrap();
        assert!(Command::new("git")
            .arg("-C")
            .arg(&work)
            .args(["add", "note.md"])
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .arg("-C")
            .arg(&work)
            .args([
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                "seed"
            ])
            .status()
            .unwrap()
            .success());
        let oid = Command::new("git")
            .arg("-C")
            .arg(&work)
            .args(["rev-parse", "HEAD:note.md"])
            .output()
            .unwrap();
        let oid = String::from_utf8(oid.stdout).unwrap().trim().to_owned();
        assert!(Command::new("git")
            .arg("-C")
            .arg(&work)
            .args(["push", "origin", "HEAD:main"])
            .status()
            .unwrap()
            .success());
        let remote = root.join("remote.git");
        assert!(Command::new("git")
            .args(["clone", "--mirror", "--"])
            .arg(&repo)
            .arg(&remote)
            .status()
            .unwrap()
            .success());
        for (key, value) in [
            ("remote.origin.url", remote.to_str().unwrap()),
            ("remote.origin.promisor", "true"),
            ("remote.origin.partialclonefilter", "blob:none"),
            ("extensions.partialclone", "origin"),
            ("protocol.file.allow", "always"),
        ] {
            assert!(Command::new("git")
                .arg("--git-dir")
                .arg(&repo)
                .args(["config", key, value])
                .status()
                .unwrap()
                .success());
        }
        let object = repo.join("objects").join(&oid[..2]).join(&oid[2..]);
        fs::remove_file(object).unwrap();
        let loaded =
            load_notes_batch(repo.to_str().unwrap(), vec![("note.md".into(), oid)]).unwrap();
        assert!(loaded.notes.is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
