use crate::{
    auth::{require_session, AuthState},
    lists::{matches_query, readable_projects, QueryData, SortKey, ViewOrder},
};
use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use futures_util::{stream, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

const DEFAULT_ROW_CEILING: usize = 10_000;
const DEFAULT_BATCH: usize = 200;
/// Rows scanned per exported row of ceiling: a view that hides almost everything still ends.
const SCAN_FACTOR: usize = 50;
const NOT_A_BACKUP: &str = "CSV export is not a backup: it holds only the rows this view showed you, not history, attachments or comments. Use the Workspace export and Installation backup to protect data.";
const COLUMNS: [&str; 7] = [
    "number",
    "title",
    "project",
    "status",
    "priority",
    "start_date",
    "due_date",
];

pub(crate) fn routes() -> Router<AuthState> {
    Router::new().route(
        "/workspaces/:workspace_id/tasks/export.csv",
        post(export_csv),
    )
}

#[derive(Deserialize)]
struct ExportRequest {
    list_id: Option<Uuid>,
    task_ids: Option<Vec<Uuid>>,
    status: Option<String>,
    project_id: Option<Uuid>,
    columns: Option<Vec<String>>,
}

/// Reads a size setting: an unset, unparsable or out-of-range value falls back to the default,
/// so a typo can never make every export empty.
fn bounded(value: Option<&str>, range: std::ops::RangeInclusive<usize>, default: usize) -> usize {
    value
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|v| range.contains(v))
        .unwrap_or(default)
}

/// Rows per keyset page (`WEFT_EXPORT_BATCH`, 1..=1000); a test can shrink it to cross page
/// borders with few rows.
fn batch() -> usize {
    bounded(
        std::env::var("WEFT_EXPORT_BATCH").ok().as_deref(),
        1..=1000,
        DEFAULT_BATCH,
    )
}

/// Rows one export may hold (`WEFT_EXPORT_ROW_CEILING`, 1..=100000).
fn row_ceiling() -> usize {
    bounded(
        std::env::var("WEFT_EXPORT_ROW_CEILING").ok().as_deref(),
        1..=100_000,
        DEFAULT_ROW_CEILING,
    )
}

/// Neutralises a cell that a spreadsheet could run as a formula, then escapes it for CSV.
pub(crate) fn csv_cell(value: &str) -> String {
    let risky = |c: char| matches!(c, '=' | '+' | '-' | '@' | '\t' | '\r');
    let mut text = value.to_owned();
    if value.trim_start_matches(' ').starts_with(risky) {
        text.insert(0, '\'');
    }
    if text.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text
    }
}

fn csv_row(cells: &[String]) -> String {
    let mut line = cells
        .iter()
        .map(|c| csv_cell(c))
        .collect::<Vec<_>>()
        .join(",");
    line.push_str("\r\n");
    line
}

fn cell(task: &Value, column: &str) -> String {
    match task.get(column) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

async fn export_csv(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<ExportRequest>,
) -> Response {
    // POST with the CSRF header: a link or an image on another site must never start an export.
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let member = sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2",
    )
    .bind(workspace)
    .bind(user)
    .fetch_optional(&state.pool)
    .await;
    match member {
        Ok(Some(_)) => {}
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    let ceiling = row_ceiling();
    let mut query = json!({});
    let mut manual: Option<Uuid> = None;
    if let Some(list) = request.list_id {
        let row = sqlx::query("SELECT kind,query FROM task_lists WHERE workspace_id=$1 AND id=$2")
            .bind(workspace)
            .bind(list)
            .fetch_optional(&state.pool)
            .await;
        match row {
            Ok(Some(r)) => {
                if r.get::<String, _>("kind") == "manual" {
                    manual = Some(list);
                } else {
                    query = r.get("query");
                }
            }
            Ok(None) => return StatusCode::NOT_FOUND.into_response(),
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    }
    let wanted: Vec<String> = match request.columns {
        Some(columns) => columns,
        None => query
            .get("columns")
            .and_then(Value::as_array)
            .map(|c| {
                c.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
    };
    let mut columns: Vec<&str> = COLUMNS
        .into_iter()
        .filter(|c| wanted.iter().any(|w| w == c))
        .collect();
    if columns.is_empty() {
        columns = COLUMNS.to_vec();
    } else if !columns.contains(&"number") {
        columns.insert(0, "number");
    }
    let order = ViewOrder::parse(&query);
    let Ok(data) = QueryData::load(&state.pool, workspace, user, &query).await else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let Ok(readable) = readable_projects(&state.pool, workspace, user).await else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    // One more than the ceiling tells the export that rows were left out.
    let limit = ceiling + 1;
    let batch = batch();
    let scan_cap = ceiling.saturating_mul(SCAN_FACTOR);
    let sorted = !order.is_empty();
    let first_by = if manual.is_some() {
        "the rows are the first in the List's order"
    } else {
        "the rows are the first by Task number"
    };
    let ids = request
        .task_ids
        .map(|ids| ids.into_iter().take(limit * 2).collect::<Vec<_>>());
    // Keyset pages by task number: no pool connection stays checked out while rows are
    // checked, so concurrent exports cannot starve the pool.
    let mut tasks: Vec<(Vec<SortKey>, Value)> = Vec::new();
    // A manual List pages by its own order (membership position, then number), like read_list.
    let mut after_position: i32 = i32::MIN;
    let mut after: i64 = 0;
    let mut scanned = 0usize;
    let mut scan_capped = false;
    'pages: loop {
        let page = sqlx::query(
            "SELECT t.id,t.number,t.project_id,p.name AS project,t.title,t.status,t.priority,t.start_date::text AS start_date,t.due_date::text AS due_date,t.workspace_id,t.parent_task_id,t.description,t.completed_at::text AS completed_at,t.version,t.created_at::text AS created_at,t.updated_at::text AS updated_at,t.archived_at::text AS archived_at,COALESCE(m.position,0) AS list_position FROM tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN task_list_memberships m ON m.list_id=$2 AND m.task_id=t.id WHERE t.workspace_id=$1 AND t.archived_at IS NULL AND ($2::uuid IS NULL OR m.task_id IS NOT NULL) AND ($3::uuid[] IS NULL OR t.id=ANY($3)) AND ($4::text IS NULL OR t.status=$4) AND ($5::uuid IS NULL OR t.project_id=$5) AND (COALESCE(m.position,0),t.number)>($6,$8) ORDER BY COALESCE(m.position,0),t.number LIMIT $7",
        )
        .bind(workspace)
        .bind(manual)
        .bind(&ids)
        .bind(&request.status)
        .bind(request.project_id)
        .bind(after_position)
        .bind(batch as i64)
        .bind(after)
        .fetch_all(&state.pool)
        .await;
        let Ok(page) = page else {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        };
        let last_page = page.len() < batch;
        for row in page {
            if scanned >= scan_cap {
                scan_capped = true;
                break 'pages;
            }
            scanned += 1;
            after = row.get("number");
            after_position = row.get("list_position");
            let project: Uuid = row.get("project_id");
            if !readable.contains(&project) || !matches_query(&data, &row, &query) {
                continue;
            }
            let keys = order.keys(&data, &row);
            tasks.push((
                keys,
                json!({
                    "number": row.get::<i64, _>("number"),
                    "title": row.get::<String, _>("title"),
                    "project": row.get::<String, _>("project"),
                    "status": row.get::<String, _>("status"),
                    "priority": row.get::<Option<String>, _>("priority"),
                    "start_date": row.get::<Option<String>, _>("start_date"),
                    "due_date": row.get::<Option<String>, _>("due_date"),
                }),
            ));
            // A sorted view needs every match up to the scan cap: its head is not the lowest numbers.
            if !sorted && tasks.len() >= limit {
                break 'pages;
            }
        }
        // Only the head can reach the final result, so a sorted scan keeps `limit` rows, not
        // every match: memory stays bounded by one batch beyond the head.
        if sorted && tasks.len() > limit {
            tasks.sort_by(|a, b| order.compare(&a.0, &b.0));
            tasks.truncate(limit);
        }
        if last_page {
            break;
        }
    }
    if sorted {
        tasks.sort_by(|a, b| order.compare(&a.0, &b.0));
    }
    let over_ceiling = tasks.len() > ceiling;
    let truncated = over_ceiling || scan_capped;
    tasks.truncate(ceiling);
    let exported = tasks.len();
    let header_line = csv_row(&columns.iter().map(|c| (*c).to_owned()).collect::<Vec<_>>());
    let mut notice = NOT_A_BACKUP.to_owned();
    if scan_capped {
        let order = if sorted {
            "the rows are the head of the sort among the Tasks scanned only"
        } else {
            first_by
        };
        notice = format!("Export stopped after scanning {scan_cap} Tasks; more may exist, and {order}. Narrow the view and export again. {NOT_A_BACKUP}");
    } else if over_ceiling {
        let order = if sorted {
            "the rows are the head of the view's sort"
        } else {
            first_by
        };
        notice = format!("Export stopped at the {ceiling} row limit; more rows exist, and {order}. Narrow the view and export again. {NOT_A_BACKUP}");
    }
    let notice_line = csv_row(&[notice.clone()]);
    let body = stream::once(async move {
        // The byte order mark lets Excel read Thai text as UTF-8.
        Ok::<_, std::convert::Infallible>(format!("\u{feff}{header_line}").into_bytes())
    })
    .chain(
        stream::iter(
            tasks
                .chunks(batch)
                .map(|chunk| {
                    chunk
                        .iter()
                        .map(|(_, t)| {
                            csv_row(&columns.iter().map(|c| cell(t, c)).collect::<Vec<_>>())
                        })
                        .collect::<String>()
                })
                .collect::<Vec<_>>(),
        )
        .map(|chunk| Ok(chunk.into_bytes())),
    )
    .chain(stream::once(async move { Ok(notice_line.into_bytes()) }));
    let mut response = Body::from_stream(body).into_response();
    let map = response.headers_mut();
    map.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/csv; charset=utf-8"),
    );
    map.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment; filename=\"weft-tasks.csv\""),
    );
    map.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    map.insert(
        HeaderName::from_static("x-weft-export-truncated"),
        HeaderValue::from_static(if truncated { "true" } else { "false" }),
    );
    map.insert(
        HeaderName::from_static("x-weft-export-rows"),
        HeaderValue::from(exported),
    );
    if let Ok(value) = HeaderValue::from_str(&notice) {
        map.insert(HeaderName::from_static("x-weft-export-notice"), value);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::{bounded, csv_cell, DEFAULT_BATCH};

    #[test]
    fn size_settings_clamp_to_their_range_and_fall_back_to_the_default() {
        let range = 1..=100_000;
        assert_eq!(bounded(None, range.clone(), 10_000), 10_000);
        assert_eq!(bounded(Some("0"), range.clone(), 10_000), 10_000);
        assert_eq!(bounded(Some("100001"), range.clone(), 10_000), 10_000);
        assert_eq!(bounded(Some("-5"), range.clone(), 10_000), 10_000);
        assert_eq!(bounded(Some("lots"), range.clone(), 10_000), 10_000);
        assert_eq!(bounded(Some(" 3 "), range.clone(), 10_000), 3);
        assert_eq!(bounded(Some("100000"), range, 10_000), 100_000);
        assert_eq!(
            bounded(Some("1001"), 1..=1000, DEFAULT_BATCH),
            DEFAULT_BATCH
        );
    }

    #[test]
    fn neutralises_formula_prefixes() {
        for hostile in ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx", "  =1"] {
            assert!(
                csv_cell(hostile).trim_matches('"').starts_with(['\'', ' ']),
                "{hostile:?}"
            );
        }
        assert_eq!(csv_cell("=1+1"), "'=1+1");
    }

    #[test]
    fn escapes_commas_quotes_newlines_and_keeps_thai() {
        assert_eq!(csv_cell("a,b"), "\"a,b\"");
        assert_eq!(csv_cell("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_cell("line1\nline2"), "\"line1\nline2\"");
        assert_eq!(csv_cell("งานด่วน, สำคัญ"), "\"งานด่วน, สำคัญ\"");
    }
}
