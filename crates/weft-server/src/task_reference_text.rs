use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

/// Finds task-number references in prose while preserving source character positions.
/// Markdown structures that use `#` as syntax are deliberately excluded.
pub(crate) fn references(source: &str, workspace: Uuid) -> Vec<(i64, i32, i32)> {
    let mut found = Vec::new();
    let mut offset = 0usize;
    let mut fence: Option<char> = None;
    for line in source.split_inclusive('\n') {
        let trimmed = line.trim_start();
        let fence_marker = trimmed
            .chars()
            .take_while(|c| *c == '`' || *c == '~')
            .count();
        if fence_marker >= 3 {
            let marker = trimmed.chars().next().unwrap_or('`');
            if fence == Some(marker) {
                fence = None;
            } else if fence.is_none() {
                fence = Some(marker);
            }
            offset += line.chars().count();
            continue;
        }
        if fence.is_some() || trimmed.starts_with('#') {
            offset += line.chars().count();
            continue;
        }
        let chars = line.chars().collect::<Vec<_>>();
        let mut i = 0usize;
        let mut ticks = 0usize;
        while i < chars.len() {
            if chars[i] == '`' {
                let n = chars[i..].iter().take_while(|c| **c == '`').count();
                if ticks == 0 {
                    ticks = n;
                } else if ticks == n {
                    ticks = 0;
                }
                i += n;
                continue;
            }
            if ticks == 0 {
                if let Some((number, end)) = task_url(&chars, i, workspace) {
                    found.push((number, (offset + i) as i32, (end - i) as i32));
                    i = end;
                    continue;
                }
            }
            if chars[i] == '#' && ticks == 0 {
                let prev = i.checked_sub(1).and_then(|p| chars.get(p)).copied();
                let boundary = prev.is_none_or(|c| {
                    !(c.is_alphanumeric() || c == '_' || c == '/' || c == '@' || c == '\\')
                });
                let token_start = chars[..i]
                    .iter()
                    .rposition(|c| c.is_whitespace() || matches!(c, '(' | '<'))
                    .map_or(0, |p| p + 1);
                let in_url = chars[token_start..i]
                    .windows(3)
                    .any(|part| part == [':', '/', '/']);
                let mut end = i + 1;
                while end < chars.len() && chars[end].is_ascii_digit() {
                    end += 1;
                }
                if boundary
                    && !in_url
                    && end > i + 1
                    && chars
                        .get(end)
                        .is_none_or(|c| !c.is_ascii_alphanumeric() && *c != '_')
                {
                    let value = chars[i + 1..end]
                        .iter()
                        .collect::<String>()
                        .parse::<i64>()
                        .ok();
                    if let Some(number) = value {
                        found.push((number, (offset + i) as i32, (end - i) as i32));
                    }
                    i = end;
                    continue;
                }
            }
            i += 1;
        }
        offset += line.chars().count();
    }
    found
}

fn task_url(chars: &[char], start: usize, workspace: Uuid) -> Option<(i64, usize)> {
    let previous = start.checked_sub(1).and_then(|index| chars.get(index));
    if previous.is_some_and(|c| c.is_alphanumeric() || matches!(c, '_' | '/' | '@' | '\\')) {
        return None;
    }
    let url_end = chars[start..]
        .iter()
        .position(|c| c.is_whitespace() || matches!(c, ')' | ']' | '>' | '\"' | '\''))
        .map_or(chars.len(), |length| start + length);
    let mut token_end = url_end;
    while token_end > start && matches!(chars[token_end - 1], '.' | ',' | ';' | ':' | '!' | '?') {
        token_end -= 1;
    }
    let value = chars[start..token_end].iter().collect::<String>();
    let path = if value.starts_with("/w/") {
        value.as_str()
    } else {
        let scheme_end = value.find("://")?;
        if !matches!(&value[..scheme_end], "http" | "https") {
            return None;
        }
        let authority_start = scheme_end + 3;
        let path_start = value[authority_start..].find('/')? + authority_start;
        &value[path_start..]
    };
    let prefix = format!("/w/{workspace}/tasks/");
    let suffix = path.strip_prefix(&prefix)?;
    let number_text = suffix
        .split(['/', '?', '#'])
        .next()
        .filter(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))?;
    let number = number_text.parse().ok()?;
    if suffix.len() > number_text.len()
        && !matches!(suffix.as_bytes()[number_text.len()], b'/' | b'?' | b'#')
    {
        return None;
    }
    Some((number, token_end))
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
        sqlx::query(
            "DELETE FROM task_references WHERE source_kind='comment' AND source_comment_id=$1",
        )
        .bind(comment_id)
        .execute(&mut **tx)
        .await?;
    } else {
        sqlx::query("DELETE FROM task_references WHERE source_kind='task_description' AND source_task_id=$1")
            .bind(source_task).execute(&mut **tx).await?;
    }
    for (number, position, _) in references(body, workspace) {
        let target = sqlx::query("SELECT t.id,p.id AS project_id FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.workspace_id=$1 AND t.number=$2 AND t.archived_at IS NULL AND p.archived_at IS NULL")
            .bind(workspace).bind(number).fetch_optional(&mut **tx).await?;
        let Some(target) = target else { continue };
        let access =
            crate::projects::evaluate_access(&mut **tx, target.get("project_id"), actor).await?;
        if !matches!(access, Some(access) if access.role >= crate::projects::Role::Viewer) {
            continue;
        }
        sqlx::query("INSERT INTO task_references(workspace_id,target_task_id,source_kind,source_task_id,source_comment_id,position) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING")
            .bind(workspace).bind(target.get::<Uuid,_>("id")).bind(source_kind).bind(source_task).bind(comment_id).bind(position).execute(&mut **tx).await?;
    }
    Ok(())
}

pub(crate) async fn render_markdown(
    pool: &sqlx::PgPool,
    workspace: Uuid,
    source_task: Uuid,
    source_kind: &str,
    comment_id: Option<Uuid>,
    viewer: Option<Uuid>,
    body: &str,
) -> Result<String, sqlx::Error> {
    let Some(viewer) = viewer else {
        return Ok(crate::knowledge::markdown::parse_markdown(body).html);
    };
    let rows = if source_kind == "comment" {
        sqlx::query("SELECT t.number,t.title,t.status,p.id AS project_id FROM task_references r JOIN tasks t ON t.id=r.target_task_id JOIN projects p ON p.id=t.project_id WHERE r.source_comment_id=$1 AND t.archived_at IS NULL AND p.archived_at IS NULL")
            .bind(comment_id).fetch_all(pool).await?
    } else {
        sqlx::query("SELECT t.number,t.title,t.status,p.id AS project_id FROM task_references r JOIN tasks t ON t.id=r.target_task_id JOIN projects p ON p.id=t.project_id WHERE r.source_kind='task_description' AND r.source_task_id=$1 AND t.archived_at IS NULL AND p.archived_at IS NULL")
            .bind(source_task).fetch_all(pool).await?
    };
    let mut labels = std::collections::HashMap::new();
    for row in rows {
        let access = crate::projects::evaluate_access(pool, row.get("project_id"), viewer).await?;
        if matches!(access, Some(access) if access.role >= crate::projects::Role::Viewer) {
            labels.insert(
                row.get::<i64, _>("number"),
                format!(
                    "{} · {}",
                    row.get::<String, _>("title"),
                    row.get::<String, _>("status")
                ),
            );
        }
    }
    let mut chars = body.chars().collect::<Vec<_>>();
    let mut occurrences = references(body, workspace);
    occurrences.reverse();
    for (number, position, length) in occurrences {
        let Some(label) = labels.get(&number) else {
            continue;
        };
        let start = position as usize;
        let end = start + length as usize;
        if end > chars.len() {
            continue;
        }
        let escaped_label = label
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&#39;");
        let link = format!("<a data-task-reference=\"true\" href=\"/w/{workspace}/tasks/{number}\">#{number} {escaped_label}</a>").chars().collect::<Vec<_>>();
        chars.splice(start..end, link);
    }
    let transformed = chars.into_iter().collect::<String>();
    Ok(crate::knowledge::markdown::parse_markdown(&transformed).html)
}

#[cfg(test)]
mod tests {
    use super::references;
    use uuid::Uuid;

    #[test]
    fn references_skip_markdown_code_headings_escapes_fragments_and_mentions() {
        let workspace = Uuid::new_v4();
        let text = format!("See #12 and #12. `#13`\n\n```\n#14\n```\n\\#15 https://example.test/page#16\n## #17\n@#18 #19 /w/{workspace}/tasks/20 https://example.test/w/{workspace}/tasks/21.");
        assert_eq!(
            references(&text, workspace)
                .iter()
                .map(|(n, _, _)| *n)
                .collect::<Vec<_>>(),
            [12, 12, 19, 20, 21]
        );
    }
}
