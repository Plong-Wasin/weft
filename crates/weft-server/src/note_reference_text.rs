use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

#[derive(Debug)]
struct Occurrence {
    target: String,
    position: i32,
    length: i32,
}

fn occurrences(source: &str) -> Vec<Occurrence> {
    let chars = source.chars().collect::<Vec<_>>();
    let mut found = Vec::new();
    let mut index = 0;
    while index + 1 < chars.len() {
        if chars[index] == '[' && chars[index + 1] == '[' {
            if let Some(end) = (index + 2..chars.len().saturating_sub(1))
                .find(|at| chars[*at] == ']' && chars[*at + 1] == ']')
            {
                let target = chars[index + 2..end].iter().collect::<String>();
                if !target.trim().is_empty() {
                    found.push(Occurrence {
                        target,
                        position: index as i32,
                        length: (end + 2 - index) as i32,
                    });
                }
                index = end + 2;
                continue;
            }
        }
        if chars[index..].starts_with(&['h', 't', 't', 'p', 's', ':', '/', '/'])
            || chars[index..].starts_with(&['h', 't', 't', 'p', ':', '/', '/'])
        {
            let end = (index..chars.len())
                .find(|at| chars[*at].is_whitespace() || matches!(chars[*at], ')' | ']' | '>'))
                .unwrap_or(chars.len());
            let mut token_end = end;
            while token_end > index
                && matches!(chars[token_end - 1], '.' | ',' | ';' | ':' | '!' | '?')
            {
                token_end -= 1;
            }
            let token = chars[index..token_end].iter().collect::<String>();
            if let Some(target) = note_api_url_target(&token) {
                found.push(Occurrence {
                    target,
                    position: index as i32,
                    length: (token_end - index) as i32,
                });
                index = token_end;
                continue;
            }
        }
        index += 1;
    }
    found
}

fn note_api_url_target(url: &str) -> Option<String> {
    let path = url.split_once("/api/v1/vaults/")?.1;
    let (vault, query) = path.split_once("/notes?path=")?;
    let vault = Uuid::parse_str(vault).ok()?;
    let encoded_path = query.split('&').next()?;
    let mut bytes = Vec::with_capacity(encoded_path.len());
    let raw = encoded_path.as_bytes();
    let mut index = 0;
    while index < raw.len() {
        if raw[index] == b'%' && index + 2 < raw.len() {
            let hex = std::str::from_utf8(&raw[index + 1..index + 3]).ok()?;
            bytes.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            bytes.push(if raw[index] == b'+' { b' ' } else { raw[index] });
            index += 1;
        }
    }
    let note_path = String::from_utf8(bytes).ok()?;
    Some(format!("@{vault}/{note_path}"))
}

fn split_vault_target<'a>(target: &'a str, vaults: &[(Uuid, String)]) -> Option<(Uuid, &'a str)> {
    vaults
        .iter()
        .filter_map(|(id, name)| {
            target
                .strip_prefix(name)
                .and_then(|rest| rest.strip_prefix('/'))
                .map(|path| (name.len(), *id, path))
        })
        .max_by_key(|(length, _, _)| *length)
        .map(|(_, id, path)| (id, path))
}

pub(crate) async fn replace_index(
    tx: &mut Transaction<'_, Postgres>,
    workspace: Uuid,
    source_task: Uuid,
    source_kind: &str,
    comment_id: Option<Uuid>,
    actor: Uuid,
    body: &str,
) -> Result<(), sqlx::Error> {
    if source_kind == "comment" {
        sqlx::query("DELETE FROM task_note_references WHERE source_comment_id=$1")
            .bind(comment_id)
            .execute(&mut **tx)
            .await?;
    } else {
        sqlx::query("DELETE FROM task_note_references WHERE source_kind='task_description' AND source_task_id=$1")
            .bind(source_task)
            .execute(&mut **tx)
            .await?;
    }
    let vault_rows = sqlx::query("SELECT id,name FROM vaults WHERE workspace_id=$1")
        .bind(workspace)
        .fetch_all(&mut **tx)
        .await?;
    let vaults = vault_rows
        .iter()
        .map(|row| (row.get::<Uuid, _>("id"), row.get::<String, _>("name")))
        .collect::<Vec<_>>();
    for occurrence in occurrences(body) {
        let parsed = occurrence
            .target
            .strip_prefix('@')
            .and_then(|target| target.split_once('/'));
        let (vault, path) = if let Some((id, path)) = parsed {
            let Ok(vault) = Uuid::parse_str(id) else {
                continue;
            };
            if !vaults.iter().any(|(available, _)| *available == vault) {
                continue;
            }
            (vault, path)
        } else if let Some(found) = split_vault_target(&occurrence.target, &vaults) {
            found
        } else {
            continue;
        };
        if !matches!(crate::vaults::evaluate_access(&mut **tx, vault, actor).await?, Some(access) if access.role >= crate::projects::Role::Viewer && access.workspace_id == workspace)
        {
            continue;
        }
        let note_id = sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM vault_note_identities WHERE vault_id=$1 AND path=$2 AND deleted_at IS NULL",
        )
        .bind(vault)
        .bind(path)
        .fetch_optional(&mut **tx)
        .await?;
        let Some(note_id) = note_id else { continue };
        sqlx::query("INSERT INTO task_note_references(workspace_id,note_id,source_kind,source_task_id,source_comment_id,position) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING")
            .bind(workspace).bind(note_id).bind(source_kind).bind(source_task).bind(comment_id).bind(occurrence.position)
            .execute(&mut **tx).await?;
    }
    Ok(())
}

/// Keep the note's identity stable when a Knowledge Apply moves or renames it.
#[allow(dead_code)] // Called by the Knowledge Apply flow owned by ticket 14.
pub(crate) async fn rename_note(
    tx: &mut Transaction<'_, Postgres>,
    vault: Uuid,
    note_id: Uuid,
    old_path: &str,
    new_path: &str,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query("UPDATE vault_note_identities SET path=$4 WHERE vault_id=$1 AND id=$2 AND path=$3 AND deleted_at IS NULL")
        .bind(vault).bind(note_id).bind(old_path).bind(new_path).execute(&mut **tx).await?;
    Ok(result.rows_affected() == 1)
}

/// Keep references resolvable as a tombstone after a Knowledge Apply deletes a note.
#[allow(dead_code)] // Called by the Knowledge Apply flow owned by ticket 14.
pub(crate) async fn delete_note(
    tx: &mut Transaction<'_, Postgres>,
    vault: Uuid,
    note_id: Uuid,
    path: &str,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query("UPDATE vault_note_identities SET deleted_at=now() WHERE vault_id=$1 AND id=$2 AND path=$3 AND deleted_at IS NULL")
        .bind(vault).bind(note_id).bind(path).execute(&mut **tx).await?;
    Ok(result.rows_affected() == 1)
}

/// Reverse a rename or deletion while undoing the Knowledge Apply.
#[allow(dead_code)] // Called by the Knowledge Apply flow owned by ticket 14.
pub(crate) async fn restore_note(
    tx: &mut Transaction<'_, Postgres>,
    note_id: Uuid,
    restored_path: &str,
) -> Result<bool, sqlx::Error> {
    let result =
        sqlx::query("UPDATE vault_note_identities SET path=$2,deleted_at=NULL WHERE id=$1")
            .bind(note_id)
            .bind(restored_path)
            .execute(&mut **tx)
            .await?;
    Ok(result.rows_affected() == 1)
}

pub(crate) async fn replacements(
    pool: &sqlx::PgPool,
    source_kind: &str,
    source_task: Uuid,
    comment_id: Option<Uuid>,
    viewer: Uuid,
    body: &str,
) -> Result<Vec<(usize, usize, String)>, sqlx::Error> {
    let rows = if source_kind == "comment" {
        sqlx::query("SELECT r.position,n.id,n.deleted_at::text AS deleted_at,f.title,v.name,v.id AS vault_id FROM task_note_references r JOIN vault_note_identities n ON n.id=r.note_id JOIN vaults v ON v.id=n.vault_id LEFT JOIN vault_indexed_files f ON f.vault_id=n.vault_id AND f.path=n.path WHERE r.source_comment_id=$1")
            .bind(comment_id).fetch_all(pool).await?
    } else {
        sqlx::query("SELECT r.position,n.id,n.deleted_at::text AS deleted_at,f.title,v.name,v.id AS vault_id FROM task_note_references r JOIN vault_note_identities n ON n.id=r.note_id JOIN vaults v ON v.id=n.vault_id LEFT JOIN vault_indexed_files f ON f.vault_id=n.vault_id AND f.path=n.path WHERE r.source_kind='task_description' AND r.source_task_id=$1")
            .bind(source_task).fetch_all(pool).await?
    };
    let found = occurrences(body);
    let mut replacements = Vec::new();
    for row in rows {
        let position: i32 = row.get("position");
        let Some(occurrence) = found.iter().find(|item| item.position == position) else {
            continue;
        };
        let readable = matches!(crate::vaults::evaluate_access(pool, row.get("vault_id"), viewer).await?, Some(access) if access.role >= crate::projects::Role::Viewer);
        let label = if !readable {
            "note".to_owned()
        } else if row.get::<Option<String>, _>("deleted_at").is_some() {
            "note deleted".to_owned()
        } else {
            format!(
                "{} · {}",
                row.get::<Option<String>, _>("title")
                    .unwrap_or_else(|| "Note".into()),
                row.get::<String, _>("name")
            )
        };
        let replacement = if readable {
            format!(
                "<span data-note-reference=\"true\">{}</span>",
                escape_html(&label)
            )
        } else {
            escape_html(&label)
        };
        replacements.push((
            occurrence.position as usize,
            occurrence.length as usize,
            replacement,
        ));
    }
    Ok(replacements)
}

pub(crate) async fn safe_body(
    pool: &sqlx::PgPool,
    source_kind: &str,
    source_task: Uuid,
    comment_id: Option<Uuid>,
    viewer: Option<Uuid>,
    body: &str,
) -> Result<String, sqlx::Error> {
    let rows = if source_kind == "comment" {
        sqlx::query("SELECT r.position,n.vault_id FROM task_note_references r JOIN vault_note_identities n ON n.id=r.note_id WHERE r.source_comment_id=$1")
            .bind(comment_id).fetch_all(pool).await?
    } else {
        sqlx::query("SELECT r.position,n.vault_id FROM task_note_references r JOIN vault_note_identities n ON n.id=r.note_id WHERE r.source_kind='task_description' AND r.source_task_id=$1")
            .bind(source_task).fetch_all(pool).await?
    };
    let found = occurrences(body);
    let mut replacements = Vec::new();
    for row in rows {
        let readable = if let Some(viewer) = viewer {
            matches!(crate::vaults::evaluate_access(pool, row.get("vault_id"), viewer).await?, Some(access) if access.role >= crate::projects::Role::Viewer)
        } else {
            false
        };
        if readable {
            continue;
        }
        let position: i32 = row.get("position");
        if let Some(occurrence) = found.iter().find(|item| item.position == position) {
            replacements.push((occurrence.position as usize, occurrence.length as usize));
        }
    }
    replacements.sort_by_key(|(position, _)| std::cmp::Reverse(*position));
    let mut chars = body.chars().collect::<Vec<_>>();
    for (start, length) in replacements {
        if start + length <= chars.len() {
            chars.splice(start..start + length, "[[note]]".chars());
        }
    }
    Ok(chars.into_iter().collect())
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[cfg(test)]
mod tests {
    use super::occurrences;

    #[test]
    fn finds_vault_qualified_note_references_and_keeps_positions() {
        let found = occurrences("Read [[Team Notes/Runbook.md]] and [[Team Notes/Runbook.md]].");
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].target, "Team Notes/Runbook.md");
        assert_eq!(found[1].position, 35);
    }

    #[test]
    fn pasted_note_api_url_resolves_to_vault_and_decoded_path() {
        let url = "https://weft.example/api/v1/vaults/33333333-3333-4333-8333-333333333333/notes?path=Runbooks/Plan%20A.md";
        let found = occurrences(&format!("See {url}."));
        assert_eq!(found.len(), 1);
        assert_eq!(
            found[0].target,
            "@33333333-3333-4333-8333-333333333333/Runbooks/Plan A.md"
        );
    }
}
