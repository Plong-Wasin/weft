//! Bounded helpers for turning AI note edit commands into reviewable diffs.
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::process::Stdio;
use uuid::Uuid;

pub(crate) const MAX_NOTE_BYTES: usize = 10 * 1024 * 1024;
pub(crate) const MAX_FILE_BYTES: usize = 50 * 1024 * 1024;

pub(crate) fn sha256(text: &[u8]) -> String {
    format!("{:x}", Sha256::digest(text))
}

/// Commands use one-based line ranges so they can be shown directly in a review.
/// Supported forms: `{op:"replace_range", start_line, end_line, text}`,
/// `{op:"insert_after_heading", heading, text}`, and `{op:"append", text}`.
pub(crate) fn apply_commands(source: &str, commands: &[Value]) -> Result<String, &'static str> {
    if source.len() > MAX_NOTE_BYTES || commands.is_empty() || commands.len() > 100 {
        return Err("size_or_command_limit");
    }
    let mut output = source.to_owned();
    for command in commands {
        let text = command["text"].as_str().ok_or("command_text_required")?;
        let lines: Vec<&str> = output.lines().collect();
        match command["op"].as_str().ok_or("command_op_required")? {
            "append" => {
                if !output.is_empty() && !output.ends_with('\n') {
                    output.push('\n');
                }
                output.push_str(text);
            }
            "insert_after_heading" => {
                let heading = command["heading"].as_str().ok_or("heading_required")?;
                if heading.is_empty() {
                    return Err("heading_required");
                }
                let index = lines
                    .iter()
                    .position(|line| *line == heading)
                    .ok_or("heading_not_found")?;
                let mut next = lines[..=index].join("\n");
                next.push('\n');
                next.push_str(text);
                if index + 1 < lines.len() {
                    next.push('\n');
                    next.push_str(&lines[index + 1..].join("\n"));
                }
                output = next;
            }
            "replace_range" => {
                let start = command["start_line"]
                    .as_u64()
                    .filter(|n| *n > 0)
                    .ok_or("line_range_invalid")? as usize;
                let end = command["end_line"]
                    .as_u64()
                    .filter(|n| *n >= start as u64)
                    .ok_or("line_range_invalid")? as usize;
                if end > lines.len() {
                    return Err("line_range_invalid");
                }
                let mut next = lines[..start - 1].join("\n");
                if start > 1 {
                    next.push('\n');
                }
                next.push_str(text);
                if end < lines.len() {
                    next.push('\n');
                    next.push_str(&lines[end..].join("\n"));
                }
                output = next;
            }
            _ => return Err("command_op_invalid"),
        }
        if output.len() > MAX_NOTE_BYTES {
            return Err("note_too_large");
        }
    }
    Ok(output)
}

pub(crate) async fn prepare_tool_items(
    pool: &PgPool,
    run: Uuid,
    name: &str,
    items: &[Value],
) -> Result<Vec<Value>, &'static str> {
    let run_row = sqlx::query(
        "SELECT workspace_id,initiator_id,scope FROM ai_runs WHERE id=$1 AND state='running'",
    )
    .bind(run)
    .fetch_optional(pool)
    .await
    .map_err(|_| "run_unavailable")?
    .ok_or("run_unavailable")?;
    let workspace: Uuid = run_row.get("workspace_id");
    let actor: Uuid = run_row.get("initiator_id");
    let scope: Value = run_row.get("scope");
    let mut prepared = Vec::with_capacity(items.len());
    for original in items {
        let mut item = original.clone();
        item["kind"] = Value::String(
            if name == "propose_note_edit" {
                "note_edit"
            } else {
                "file_add"
            }
            .to_owned(),
        );
        if item["rename_to"].as_str().is_some()
            && !item["link_fixes"]
                .as_array()
                .is_some_and(|fixes| !fixes.is_empty())
        {
            return Err("rename_requires_link_fixes");
        }
        let vault = Uuid::parse_str(item["vault_id"].as_str().ok_or("vault_id_required")?)
            .map_err(|_| "invalid_vault_id")?;
        if !scope["vaults"].as_array().is_some_and(|ids| {
            ids.iter()
                .any(|id| id.as_str().and_then(|s| Uuid::parse_str(s).ok()) == Some(vault))
        }) {
            return Err("vault_outside_scope");
        }
        if !matches!(crate::vaults::evaluate_access(pool, vault, actor).await, Ok(Some(access)) if access.workspace_id == workspace && access.role >= crate::projects::Role::Contributor)
        {
            return Err("vault_access_denied");
        }
        let path = item["path"].as_str().ok_or("path_required")?;
        if path.is_empty()
            || path.starts_with('/')
            || path.contains('\\')
            || path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err("invalid_path");
        }
        let repository: String = sqlx::query_scalar(
            "SELECT repository_path FROM vaults WHERE id=$1 AND workspace_id=$2",
        )
        .bind(vault)
        .bind(workspace)
        .fetch_optional(pool)
        .await
        .map_err(|_| "vault_unavailable")?
        .ok_or("vault_unavailable")?;
        if name == "propose_note_edit" {
            let commit = crate::git_readonly_command()
                .arg("-C")
                .arg(&repository)
                .arg("rev-parse")
                .arg("HEAD")
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .output()
                .map_err(|_| "vault_unavailable")?;
            if !commit.status.success() {
                return Err("vault_unavailable");
            }
            let commit = String::from_utf8_lossy(&commit.stdout).trim().to_owned();
            let bytes = crate::git_readonly_command()
                .arg("-C")
                .arg(&repository)
                .arg("show")
                .arg(format!("{commit}:{path}"))
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .output()
                .map_err(|_| "note_not_found")?;
            if !bytes.status.success() || bytes.stdout.len() > MAX_NOTE_BYTES {
                return Err("note_not_found_or_too_large");
            }
            let source = String::from_utf8(bytes.stdout).map_err(|_| "note_not_text")?;
            if item["base_hash"].as_str() != Some(&sha256(source.as_bytes())) {
                return Err("stale_base_hash");
            }
            let commands = item["commands"].as_array().ok_or("commands_required")?;
            let content = apply_commands(&source, commands)?;
            item["content"] = Value::String(content.clone());
            item["diff"] = Value::String(unified_preview(&source, &content));
            item["base_commit"] = Value::String(commit);
        } else {
            let encoded = item["content_base64"]
                .as_str()
                .ok_or("file_content_required")?;
            if encoded.len() > MAX_FILE_BYTES * 4 / 3 + 8 {
                return Err("file_too_large");
            }
            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| "file_content_invalid")?;
            if bytes.len() > MAX_FILE_BYTES {
                return Err("file_too_large");
            }
            let text_extension = [
                "md", "txt", "csv", "json", "html", "htm", "xml", "yaml", "yml", "toml", "css",
                "js", "ts", "svg",
            ];
            let extension = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
            let is_text = text_extension.contains(&extension.as_str())
                && !bytes.contains(&0)
                && std::str::from_utf8(&bytes).is_ok();
            item["storage"] = Value::String(if is_text { "git" } else { "lfs" }.into());
            item["preview"] = Value::String(if is_text {
                String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).into_owned()
            } else {
                format!("Binary file · {} bytes · Git LFS", bytes.len())
            });
        }
        prepared.push(item);
    }
    Ok(prepared)
}

fn unified_preview(before: &str, after: &str) -> String {
    let old: Vec<&str> = before.lines().collect();
    let new: Vec<&str> = after.lines().collect();
    let mut lines = vec!["--- current".to_owned(), "+++ proposed".to_owned()];
    for line in old.iter().filter(|line| !new.contains(line)).take(80) {
        lines.push(format!("- {line}"));
    }
    for line in new.iter().filter(|line| !old.contains(line)).take(80) {
        lines.push(format!("+ {line}"));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn applies_range_heading_and_append_commands_in_order() {
        let changed = apply_commands(
            "# Plan\nold\n# Next\nkeep",
            &[
                json!({"op":"replace_range","start_line":2,"end_line":2,"text":"new"}),
                json!({"op":"insert_after_heading","heading":"# Next","text":"added"}),
                json!({"op":"append","text":"tail"}),
            ],
        )
        .unwrap();
        assert_eq!(changed, "# Plan\nnew\n# Next\nadded\nkeep\ntail");
    }

    #[test]
    fn rejects_missing_heading_and_invalid_range() {
        assert_eq!(
            apply_commands(
                "# Plan",
                &[json!({"op":"insert_after_heading","heading":"# Missing","text":"x"})]
            ),
            Err("heading_not_found")
        );
        assert_eq!(
            apply_commands(
                "# Plan",
                &[json!({"op":"replace_range","start_line":1,"end_line":2,"text":"x"})]
            ),
            Err("line_range_invalid")
        );
    }
}
