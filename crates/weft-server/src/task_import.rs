use crate::{
    auth::{require_session, AuthState},
    tasks::can_write,
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

const MAX_ITEMS: usize = 100;
const MAX_TITLE: usize = 500;
const MAX_DESCRIPTION: usize = 20_000;
const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route("/workspaces/:workspace_id/tasks/import", post(dry_run))
        .route(
            "/workspaces/:workspace_id/tasks/import/:preview_id/apply",
            post(apply),
        )
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ImportTask {
    project_id: Uuid,
    title: String,
    #[serde(default)]
    description: String,
    status: Option<String>,
    priority: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ImportInput {
    items: Vec<ImportTask>,
}

fn validate_shape(items: &[ImportTask]) -> Result<(), &'static str> {
    if items.is_empty() {
        return Err("items_required");
    }
    if items.len() > MAX_ITEMS {
        return Err("too_many_items");
    }
    if items
        .iter()
        .any(|item| item.title.len() > MAX_TITLE || item.description.len() > MAX_DESCRIPTION)
    {
        return Err("item_too_large");
    }
    if serde_json::to_vec(items).is_ok_and(|payload| payload.len() > MAX_PAYLOAD_BYTES) {
        return Err("payload_too_large");
    }
    Ok(())
}

async fn dry_run(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
    body: Result<Json<ImportInput>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let Json(input) = match body {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(json!({"error":"malformed_json"})),
            )
                .into_response()
        }
    };
    if let Err(reason) = validate_shape(&input.items) {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({"error":reason})),
        )
            .into_response();
    }
    let role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2",
    )
    .bind(workspace)
    .bind(actor)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);
    if !matches!(role.as_deref(), Some("owner" | "admin")) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut results = Vec::new();
    let mut persistable = Vec::new();
    for (index, item) in input.items.iter().enumerate() {
        let status_valid = match item.status.as_deref() {
            Some(s) => valid_status(&state.pool, workspace, s).await,
            None => true,
        };
        let priority_valid = item
            .priority
            .as_deref()
            .is_none_or(|p| ["urgent", "high", "normal", "low"].contains(&p));
        let project_in_workspace: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL)",
        )
        .bind(item.project_id)
        .bind(workspace)
        .fetch_one(&state.pool)
        .await
        .unwrap_or(false);
        let reason = if item.title.trim().is_empty() {
            Some("title_required")
        } else if !status_valid {
            Some("invalid_status")
        } else if !priority_valid {
            Some("invalid_priority")
        } else if !project_in_workspace {
            Some("invalid_project")
        } else {
            match can_write(&state.pool, item.project_id, actor).await {
                Ok(true) => None,
                Ok(false) => Some("project_access_denied"),
                Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            }
        };
        let accepted = reason.is_none();
        results.push(json!({"index":index,"status":if accepted {"created"} else {"rejected"},"reason":reason}));
        persistable.push(accepted);
    }
    let id = Uuid::new_v4();
    let items = serde_json::to_value(&input.items).unwrap_or_else(|_| json!([]));
    if sqlx::query(
        "INSERT INTO task_json_import_previews(id,workspace_id,actor_id,items) VALUES($1,$2,$3,$4)",
    )
    .bind(id)
    .bind(workspace)
    .bind(actor)
    .bind(items)
    .execute(&state.pool)
    .await
    .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    Json(json!({"preview_id":id,"results":results,"applyable":persistable.iter().any(|v|*v)}))
        .into_response()
}

async fn valid_status(pool: impl sqlx::PgExecutor<'_>, workspace: Uuid, status: &str) -> bool {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_statuses WHERE workspace_id=$1 AND status_key=$2 AND archived_at IS NULL)").bind(workspace).bind(status).fetch_one(pool).await.unwrap_or(false)
}

async fn apply(
    State(state): State<AuthState>,
    Path((workspace, preview)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let row = sqlx::query("SELECT items FROM task_json_import_previews WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 AND expires_at>now() FOR UPDATE").bind(preview).bind(workspace).bind(actor).fetch_optional(&mut *tx).await;
    let Some(row) = row.ok().flatten() else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"preview_unavailable"})),
        )
            .into_response();
    };
    let items: Vec<ImportTask> = match serde_json::from_value(row.get::<Value, _>("items")) {
        Ok(v) => v,
        Err(_) => return StatusCode::UNPROCESSABLE_ENTITY.into_response(),
    };
    let role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2",
    )
    .bind(workspace)
    .bind(actor)
    .fetch_optional(&mut *tx)
    .await
    .unwrap_or(None);
    if !matches!(role.as_deref(), Some("owner" | "admin")) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let group = Uuid::new_v4();
    if sqlx::query("INSERT INTO task_operation_groups(id,command_id,workspace_id,actor_id) VALUES($1,$2,$3,$4)").bind(group).bind(Uuid::new_v4()).bind(workspace).bind(actor).execute(&mut *tx).await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
    if sqlx::query("UPDATE task_operation_groups SET state='suppressed' WHERE workspace_id=$1 AND actor_id=$2 AND state='undone'").bind(workspace).bind(actor).execute(&mut *tx).await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
    let mut imported = Vec::new();
    let mut results = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let access = crate::projects::evaluate_access(&mut *tx, item.project_id, actor).await;
        let writable =
            matches!(access, Ok(Some(a)) if a.role >= crate::projects::Role::Contributor);
        let status = item.status.as_deref().unwrap_or("backlog");
        let valid = !item.title.trim().is_empty()
            && item.title.len() <= MAX_TITLE
            && item.description.len() <= MAX_DESCRIPTION
            && item
                .priority
                .as_deref()
                .is_none_or(|p| ["urgent", "high", "normal", "low"].contains(&p))
            && valid_status(&mut *tx, workspace, status).await;
        if !writable || !valid {
            results.push(json!({"index":index,"status":"rejected","reason":if writable {"invalid_item"} else {"project_access_denied"}}));
            continue;
        }
        let project_workspace: Option<Uuid> = sqlx::query_scalar(
            "SELECT workspace_id FROM projects WHERE id=$1 AND archived_at IS NULL FOR SHARE",
        )
        .bind(item.project_id)
        .fetch_optional(&mut *tx)
        .await
        .unwrap_or(None);
        if project_workspace != Some(workspace) {
            results.push(json!({"index":index,"status":"rejected","reason":"invalid_project"}));
            continue;
        }
        let number: i64 = match sqlx::query_scalar("UPDATE workspaces SET next_task_number=next_task_number+1 WHERE id=$1 RETURNING next_task_number-1").bind(workspace).fetch_optional(&mut *tx).await { Ok(Some(n)) => n, _ => return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
        let task = Uuid::new_v4();
        let priority = item
            .priority
            .as_deref()
            .filter(|p| ["urgent", "high", "normal", "low"].contains(p))
            .unwrap_or("normal");
        if sqlx::query("INSERT INTO tasks(id,workspace_id,number,project_id,title,description,status,priority,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)").bind(task).bind(workspace).bind(number).bind(item.project_id).bind(item.title.trim()).bind(&item.description).bind(status).bind(priority).bind(actor).execute(&mut *tx).await.is_err() { return StatusCode::UNPROCESSABLE_ENTITY.into_response(); }
        if sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,'archived','true','false',1)").bind(Uuid::new_v4()).bind(group).bind(task).execute(&mut *tx).await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
        imported.push(json!({"id":task,"number":number,"title":item.title.trim()}));
        results.push(json!({"index":index,"status":"created","number":number}));
    }
    if imported.is_empty()
        || sqlx::query("DELETE FROM task_json_import_previews WHERE id=$1")
            .bind(preview)
            .execute(&mut *tx)
            .await
            .is_err()
        || tx.commit().await.is_err()
    {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({"error":"nothing_imported"})),
        )
            .into_response();
    }
    (
        StatusCode::CREATED,
        Json(json!({"group_id":group,"tasks":imported,"results":results})),
    )
        .into_response()
}
