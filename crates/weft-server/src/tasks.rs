use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

type FieldChange = (String, Value, Value);
type BulkPlan = (Uuid, i64, Vec<FieldChange>);

use crate::{
    auth::{require_session, AuthState},
    projects::{evaluate_access, Role},
};

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route(
            "/workspaces/:workspace_id/members",
            get(list_workspace_members),
        )
        .route(
            "/workspaces/:workspace_id/tasks",
            get(list_tasks).post(create_task),
        )
        .route("/workspaces/:workspace_id/tasks/bulk", post(bulk_update))
        .route(
            "/workspaces/:workspace_id/tasks/:number",
            get(read_task).patch(update_task_by_number),
        )
        .route(
            "/workspaces/:workspace_id/tasks/:number/archive",
            post(archive_task),
        )
        .route(
            "/workspaces/:workspace_id/tasks/:number/restore",
            post(restore_task),
        )
        .route(
            "/workspaces/:workspace_id/tasks/:number/duplicate",
            post(duplicate_task),
        )
        .route("/tasks/:task_id", axum::routing::patch(update_task))
        .route("/tasks/:task_id/history", get(task_history))
        .route("/workspaces/:workspace_id/history/undo", post(undo_latest))
        .route("/workspaces/:workspace_id/history/redo", post(redo_latest))
        .route("/tasks/:task_id/move-preview", post(move_preview))
        .route("/tasks/:task_id/relations", post(create_relation))
}

async fn list_workspace_members(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let is_member = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2)",
    )
    .bind(workspace)
    .bind(user)
    .fetch_one(&state.pool)
    .await;
    if !matches!(is_member, Ok(true)) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match sqlx::query("SELECT u.id,u.email,m.role FROM workspace_memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY u.email")
        .bind(workspace)
        .fetch_all(&state.pool)
        .await
    {
        Ok(rows) => Json(json!({"members": rows.into_iter().map(|row| json!({"id":row.get::<Uuid,_>("id"),"email":row.get::<String,_>("email"),"role":row.get::<String,_>("role")})).collect::<Vec<_>>()})).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Deserialize)]
struct CreateTask {
    project_id: Uuid,
    title: String,
    description: Option<String>,
    status: Option<String>,
    priority: Option<String>,
    start_date: Option<String>,
    due_date: Option<String>,
    watchers: Option<Vec<Uuid>>,
    parent_task_id: Option<Uuid>,
}

// An explicit JSON null must differ from an absent field so a date can be cleared.
fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
struct UpdateTask {
    expected_version: i64,
    command_id: Option<Uuid>,
    title: Option<String>,
    description: Option<String>,
    status: Option<String>,
    priority: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    start_date: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    due_date: Option<Option<String>>,
    watchers: Option<Vec<Uuid>>,
    project_id: Option<Uuid>,
    confirm_move: Option<bool>,
}

#[derive(Deserialize)]
struct VersionInput {
    expected_version: i64,
    command_id: Option<Uuid>,
}

fn valid_status(value: &str) -> bool {
    ["backlog", "not_started", "active", "completed", "canceled"].contains(&value)
}
fn valid_priority(value: &str) -> bool {
    ["low", "normal", "high", "urgent"].contains(&value)
}

async fn can_read(
    pool: impl sqlx::PgExecutor<'_>,
    project: Uuid,
    user: Uuid,
) -> Result<bool, sqlx::Error> {
    Ok(matches!(evaluate_access(pool, project, user).await?, Some(a) if a.role >= Role::Viewer))
}

async fn can_write(
    pool: impl sqlx::PgExecutor<'_>,
    project: Uuid,
    user: Uuid,
) -> Result<bool, sqlx::Error> {
    Ok(
        matches!(evaluate_access(pool, project, user).await?, Some(a) if a.role >= Role::Contributor),
    )
}

async fn task_row(
    pool: &PgPool,
    workspace: Uuid,
    number: i64,
    include_archived: bool,
) -> Result<Option<sqlx::postgres::PgRow>, sqlx::Error> {
    sqlx::query("SELECT id,workspace_id,number,project_id,parent_task_id,title,description,status,priority,start_date::text AS start_date,due_date::text AS due_date,version,created_at::text AS created_at,updated_at::text AS updated_at,archived_at::text AS archived_at FROM tasks WHERE workspace_id=$1 AND number=$2 AND ($3 OR archived_at IS NULL)")
        .bind(workspace).bind(number).bind(include_archived).fetch_optional(pool).await
}

async fn serialize_task(pool: &PgPool, row: &sqlx::postgres::PgRow) -> Result<Value, sqlx::Error> {
    let id: Uuid = row.get("id");
    let watchers: Vec<Uuid> =
        sqlx::query_scalar("SELECT user_id FROM task_watchers WHERE task_id=$1 ORDER BY user_id")
            .bind(id)
            .fetch_all(pool)
            .await?;
    Ok(
        json!({"id":id,"workspace_id":row.get::<Uuid,_>("workspace_id"),"number":row.get::<i64,_>("number"),"project_id":row.get::<Uuid,_>("project_id"),"parent_task_id":row.get::<Option<Uuid>,_>("parent_task_id"),"title":row.get::<String,_>("title"),"description":row.get::<String,_>("description"),"status":row.get::<String,_>("status"),"priority":row.get::<String,_>("priority"),"start_date":row.get::<Option<String>,_>("start_date"),"due_date":row.get::<Option<String>,_>("due_date"),"watchers":watchers,"version":row.get::<i64,_>("version"),"created_at":row.get::<String,_>("created_at"),"updated_at":row.get::<String,_>("updated_at"),"archived_at":row.get::<Option<String>,_>("archived_at")}),
    )
}

async fn create_task(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<CreateTask>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    if input.title.trim().is_empty()
        || input.status.as_deref().is_some_and(|v| !valid_status(v))
        || input
            .priority
            .as_deref()
            .is_some_and(|v| !valid_priority(v))
    {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    match can_write(&state.pool, input.project_id, user).await {
        Ok(true) => {}
        Ok(false) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let project_workspace: Option<Uuid> =
        sqlx::query_scalar("SELECT workspace_id FROM projects WHERE id=$1 AND archived_at IS NULL")
            .bind(input.project_id)
            .fetch_optional(&mut *tx)
            .await
            .unwrap_or(None);
    if project_workspace != Some(workspace) {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    if let Some(parent) = input.parent_task_id {
        let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM tasks WHERE id=$1 AND workspace_id=$2 AND project_id=$3 AND archived_at IS NULL)").bind(parent).bind(workspace).bind(input.project_id).fetch_one(&mut *tx).await.unwrap_or(false);
        if !valid {
            return StatusCode::UNPROCESSABLE_ENTITY.into_response();
        }
    }
    let number: i64 = match sqlx::query_scalar("UPDATE workspaces SET next_task_number=next_task_number+1 WHERE id=$1 RETURNING next_task_number-1").bind(workspace).fetch_optional(&mut *tx).await { Ok(Some(n)) => n, _ => return StatusCode::NOT_FOUND.into_response() };
    let id = Uuid::new_v4();
    let created = sqlx::query("INSERT INTO tasks(id,workspace_id,number,project_id,parent_task_id,title,description,status,priority,start_date,due_date,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11::date,$12)")
        .bind(id).bind(workspace).bind(number).bind(input.project_id).bind(input.parent_task_id).bind(input.title.trim()).bind(input.description.unwrap_or_default()).bind(input.status.unwrap_or_else(||"backlog".into())).bind(input.priority.unwrap_or_else(||"normal".into())).bind(input.start_date).bind(input.due_date).bind(user).execute(&mut *tx).await;
    if created.is_err() {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    if let Some(watchers) = input.watchers {
        for watcher in watchers {
            match can_read(&mut *tx, input.project_id, watcher).await {
                Ok(true) => {}
                Ok(false) => return StatusCode::UNPROCESSABLE_ENTITY.into_response(),
                Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            }
            if sqlx::query(
                "INSERT INTO task_watchers(workspace_id,task_id,user_id) VALUES($1,$2,$3)",
            )
            .bind(workspace)
            .bind(id)
            .bind(watcher)
            .execute(&mut *tx)
            .await
            .is_err()
            {
                return StatusCode::UNPROCESSABLE_ENTITY.into_response();
            }
        }
    }
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    match task_row(&state.pool, workspace, number, false).await {
        Ok(Some(row)) => match serialize_task(&state.pool, &row).await {
            Ok(value) => (StatusCode::CREATED, Json(value)).into_response(),
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        },
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn list_tasks(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let rows = match sqlx::query("SELECT t.id,t.workspace_id,t.number,t.project_id,t.parent_task_id,t.title,t.description,t.status,t.priority,t.start_date::text AS start_date,t.due_date::text AS due_date,t.version,t.created_at::text AS created_at,t.updated_at::text AS updated_at,t.archived_at::text AS archived_at FROM tasks t WHERE t.workspace_id=$1 AND t.archived_at IS NULL ORDER BY t.number").bind(workspace).fetch_all(&state.pool).await { Ok(rows) => rows, Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
    let mut tasks = Vec::new();
    for row in rows {
        let project: Uuid = row.get("project_id");
        match can_read(&state.pool, project, user).await {
            Ok(true) => match serialize_task(&state.pool, &row).await {
                Ok(task) => tasks.push(task),
                Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            },
            Ok(false) => {}
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    }
    Json(json!({"tasks":tasks})).into_response()
}

async fn read_task(
    State(state): State<AuthState>,
    Path((workspace, number)): Path<(Uuid, i64)>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    match task_row(&state.pool, workspace, number, false).await {
        Ok(Some(row)) => {
            let project: Uuid = row.get("project_id");
            match can_read(&state.pool, project, user).await {
                Ok(true) => match serialize_task(&state.pool, &row).await {
                    Ok(v) => Json(v).into_response(),
                    Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                },
                Ok(false) => StatusCode::NOT_FOUND.into_response(),
                Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            }
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn update_task(
    State(state): State<AuthState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(mut input): Json<UpdateTask>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let existing=match sqlx::query("SELECT workspace_id,number,project_id,version,title,description,status,priority,start_date::text AS start_date,due_date::text AS due_date FROM tasks WHERE id=$1 AND archived_at IS NULL").bind(id).fetch_optional(&state.pool).await {Ok(Some(r))=>r,Ok(None)=>return StatusCode::NOT_FOUND.into_response(),Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response()};
    let workspace: Uuid = existing.get("workspace_id");
    let number: i64 = existing.get("number");
    let old_project: Uuid = existing.get("project_id");
    let version: i64 = existing.get("version");
    let new_project = input.project_id.unwrap_or(old_project);
    match can_write(&state.pool, old_project, user).await {
        Ok(true) => {}
        Ok(false) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    if version != input.expected_version {
        return conflict(&state.pool, workspace, number).await;
    }
    if new_project != old_project {
        let has_parent: bool =
            sqlx::query_scalar("SELECT parent_task_id IS NOT NULL FROM tasks WHERE id=$1")
                .bind(id)
                .fetch_one(&state.pool)
                .await
                .unwrap_or(false);
        if has_parent {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(json!({"error":"subtask_move_not_allowed"})),
            )
                .into_response();
        }
        if input.confirm_move != Some(true) {
            return (StatusCode::UNPROCESSABLE_ENTITY,Json(json!({"error":"move_confirmation_required","preview_url":format!("/api/v1/tasks/{id}/move-preview")}))).into_response();
        }
        match can_write(&state.pool, new_project, user).await {
            Ok(true) => {}
            Ok(false) => return StatusCode::NOT_FOUND.into_response(),
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
        let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL)").bind(new_project).bind(workspace).fetch_one(&state.pool).await.unwrap_or(false);
        if !valid {
            return StatusCode::UNPROCESSABLE_ENTITY.into_response();
        }
    }
    if input.title.as_deref().is_some_and(|v| v.trim().is_empty())
        || input.status.as_deref().is_some_and(|v| !valid_status(v))
        || input
            .priority
            .as_deref()
            .is_some_and(|v| !valid_priority(v))
    {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let mut changes: Vec<FieldChange> = Vec::new();
    macro_rules! field_change {
        ($key:literal, $old:expr, $new:expr) => {
            if let Some(value) = $new {
                let after = json!(value);
                let before = json!($old);
                if before != after {
                    changes.push(($key.into(), before, after));
                }
            }
        };
    }
    field_change!(
        "title",
        existing.get::<String, _>("title"),
        input.title.as_ref().map(|v| v.trim().to_owned())
    );
    field_change!(
        "description",
        existing.get::<String, _>("description"),
        input.description.as_ref().cloned()
    );
    field_change!(
        "status",
        existing.get::<String, _>("status"),
        input.status.as_ref().cloned()
    );
    field_change!(
        "priority",
        existing.get::<String, _>("priority"),
        input.priority.as_ref().cloned()
    );
    field_change!(
        "start_date",
        existing.get::<Option<String>, _>("start_date"),
        input.start_date.clone()
    );
    field_change!(
        "due_date",
        existing.get::<Option<String>, _>("due_date"),
        input.due_date.clone()
    );
    field_change!(
        "project_id",
        old_project,
        (new_project != old_project).then_some(new_project)
    );
    if let Some(requested) = &input.watchers {
        let current: Vec<Uuid> = sqlx::query_scalar(
            "SELECT user_id FROM task_watchers WHERE task_id=$1 ORDER BY user_id",
        )
        .bind(id)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default();
        let mut requested = requested.clone();
        requested.sort();
        requested.dedup();
        if requested == current {
            input.watchers = None;
        }
    }
    if changes.is_empty() && input.watchers.is_none() {
        return match task_row(&state.pool, workspace, number, false).await {
            Ok(Some(row)) => match serialize_task(&state.pool, &row).await {
                Ok(v) => Json(v).into_response(),
                Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            },
            _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        };
    }
    let mut tx = match state.pool.begin().await {
        Ok(t) => t,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let row=sqlx::query("UPDATE tasks SET title=COALESCE($3,title),description=COALESCE($4,description),status=COALESCE($5,status),priority=COALESCE($6,priority),start_date=CASE WHEN $7 THEN $8::date ELSE start_date END,due_date=CASE WHEN $9 THEN $10::date ELSE due_date END,project_id=$11,updated_at=now(),version=version+1 WHERE id=$1 AND version=$2 RETURNING id")
        .bind(id).bind(input.expected_version).bind(input.title.map(|v|v.trim().to_owned())).bind(input.description).bind(input.status).bind(input.priority).bind(input.start_date.is_some()).bind(input.start_date.flatten()).bind(input.due_date.is_some()).bind(input.due_date.flatten()).bind(new_project).fetch_optional(&mut *tx).await;
    if let Err(e) = row {
        if e.as_database_error()
            .is_some_and(|d| d.code().as_deref() == Some("22007"))
        {
            return StatusCode::UNPROCESSABLE_ENTITY.into_response();
        }
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if row.ok().flatten().is_none() {
        let _ = tx.rollback().await;
        return conflict(&state.pool, workspace, number).await;
    }
    let resulting_version: i64 = match sqlx::query_scalar("SELECT version FROM tasks WHERE id=$1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await
    {
        Ok(v) => v,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if !changes.is_empty() {
        let command = input.command_id.unwrap_or_else(Uuid::new_v4);
        let group = Uuid::new_v4();
        if sqlx::query("INSERT INTO task_operation_groups(id,command_id,workspace_id,actor_id) VALUES($1,$2,$3,$4)").bind(group).bind(command).bind(workspace).bind(user).execute(&mut *tx).await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
        if sqlx::query("UPDATE task_operation_groups SET state='suppressed' WHERE workspace_id=$1 AND actor_id=$2 AND state='undone'").bind(workspace).bind(user).execute(&mut *tx).await.is_err(){return StatusCode::INTERNAL_SERVER_ERROR.into_response();}
        for (field, before, after) in changes {
            if sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(Uuid::new_v4()).bind(group).bind(id).bind(field).bind(before).bind(after).bind(resulting_version).execute(&mut *tx).await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
        }
    }
    if new_project != old_project {
        let moved: Vec<(Uuid, i64)> = match sqlx::query_as("WITH RECURSIVE descendants(id) AS (SELECT id FROM tasks WHERE parent_task_id=$1 UNION ALL SELECT t.id FROM tasks t JOIN descendants d ON t.parent_task_id=d.id) UPDATE tasks SET project_id=$2,updated_at=now(),version=version+1 WHERE id IN (SELECT id FROM descendants) RETURNING id,version")
            .bind(id)
            .bind(new_project)
            .fetch_all(&mut *tx)
            .await
        {
            Ok(rows) => rows,
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        };
        if !moved.is_empty() {
            let group: Uuid = match sqlx::query_scalar("SELECT group_id FROM task_operations WHERE task_id=$1 AND field_key='project_id' AND task_version=$2")
                .bind(id)
                .bind(resulting_version)
                .fetch_one(&mut *tx)
                .await
            {
                Ok(group) => group,
                Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            };
            for (descendant, version) in moved {
                if sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,'project_id',$4,$5,$6)").bind(Uuid::new_v4()).bind(group).bind(descendant).bind(json!(old_project)).bind(json!(new_project)).bind(version).execute(&mut *tx).await.is_err() {
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            }
        }
    }
    if let Some(watchers) = input.watchers {
        if sqlx::query("DELETE FROM task_watchers WHERE task_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await
            .is_err()
        {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        for watcher in watchers {
            match can_read(&mut *tx, new_project, watcher).await {
                Ok(true) => {}
                Ok(false) => return StatusCode::UNPROCESSABLE_ENTITY.into_response(),
                Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            }
            if sqlx::query(
                "INSERT INTO task_watchers(workspace_id,task_id,user_id) VALUES($1,$2,$3)",
            )
            .bind(workspace)
            .bind(id)
            .bind(watcher)
            .execute(&mut *tx)
            .await
            .is_err()
            {
                return StatusCode::UNPROCESSABLE_ENTITY.into_response();
            }
        }
    }
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    match task_row(&state.pool, workspace, number, false).await {
        Ok(Some(row)) => match serialize_task(&state.pool, &row).await {
            Ok(v) => Json(v).into_response(),
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        },
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn update_task_by_number(
    State(state): State<AuthState>,
    Path((workspace, number)): Path<(Uuid, i64)>,
    headers: HeaderMap,
    Json(input): Json<UpdateTask>,
) -> Response {
    let id = match sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM tasks WHERE workspace_id=$1 AND number=$2 AND archived_at IS NULL",
    )
    .bind(workspace)
    .bind(number)
    .fetch_optional(&state.pool)
    .await
    {
        Ok(Some(id)) => id,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    update_task(State(state), Path(id), headers, Json(input)).await
}

#[derive(Deserialize)]
struct BulkUpdate {
    command_id: Option<Uuid>,
    items: Vec<BulkItem>,
}
#[derive(Deserialize)]
struct BulkItem {
    task_id: Uuid,
    expected_version: i64,
    title: Option<String>,
    description: Option<String>,
    status: Option<String>,
    priority: Option<String>,
}

async fn bulk_update(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
    Json(mut input): Json<BulkUpdate>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    if input.items.is_empty()
        || input.items.iter().any(|i| {
            i.title.as_deref().is_some_and(|v| v.trim().is_empty())
                || i.status.as_deref().is_some_and(|v| !valid_status(v))
                || i.priority.as_deref().is_some_and(|v| !valid_priority(v))
        })
    {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let mut ids: Vec<Uuid> = input.items.iter().map(|i| i.task_id).collect();
    ids.sort();
    ids.dedup();
    if ids.len() != input.items.len() {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    input.items.sort_by_key(|item| item.task_id);
    let mut tx = match state.pool.begin().await {
        Ok(v) => v,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let mut plans: Vec<BulkPlan> = Vec::new();
    for item in input.items {
        let row=match sqlx::query("SELECT workspace_id,number,project_id,version,title,description,status,priority FROM tasks WHERE id=$1 AND archived_at IS NULL FOR UPDATE").bind(item.task_id).fetch_optional(&mut *tx).await {Ok(Some(r))=>r,Ok(None)=>return StatusCode::NOT_FOUND.into_response(),Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response()};
        if row.get::<Uuid, _>("workspace_id") != workspace
            || !matches!(
                can_write(&mut *tx, row.get("project_id"), user).await,
                Ok(true)
            )
        {
            return StatusCode::NOT_FOUND.into_response();
        }
        if row.get::<i64, _>("version") != item.expected_version {
            return (StatusCode::CONFLICT,Json(json!({"error":"bulk_conflict","task_id":item.task_id,"cause":"task version changed"}))).into_response();
        }
        let mut changes = Vec::new();
        macro_rules! bulk_change {
            ($field:literal,$old:expr,$new:expr) => {
                if let Some(v) = $new {
                    let before = json!($old);
                    let after = json!(v);
                    if before != after {
                        changes.push(($field.to_owned(), before, after));
                    }
                }
            };
        }
        bulk_change!(
            "title",
            row.get::<String, _>("title"),
            item.title.as_ref().map(|v| v.trim().to_owned())
        );
        bulk_change!(
            "description",
            row.get::<String, _>("description"),
            item.description.clone()
        );
        bulk_change!(
            "status",
            row.get::<String, _>("status"),
            item.status.clone()
        );
        bulk_change!(
            "priority",
            row.get::<String, _>("priority"),
            item.priority.clone()
        );
        plans.push((item.task_id, item.expected_version, changes));
    }
    if plans.iter().all(|p| p.2.is_empty()) {
        let _ = tx.rollback().await;
        return Json(json!({"group_id":null,"tasks":[]})).into_response();
    }
    let group = Uuid::new_v4();
    let command = input.command_id.unwrap_or_else(Uuid::new_v4);
    if sqlx::query("INSERT INTO task_operation_groups(id,command_id,workspace_id,actor_id) VALUES($1,$2,$3,$4)").bind(group).bind(command).bind(workspace).bind(user).execute(&mut *tx).await.is_err(){return StatusCode::INTERNAL_SERVER_ERROR.into_response();}
    if sqlx::query("UPDATE task_operation_groups SET state='suppressed' WHERE workspace_id=$1 AND actor_id=$2 AND state='undone'").bind(workspace).bind(user).execute(&mut *tx).await.is_err(){return StatusCode::INTERNAL_SERVER_ERROR.into_response();}
    let mut changed = Vec::new();
    for (task, version, fields) in plans {
        if fields.is_empty() {
            continue;
        }
        for (field, _, after) in &fields {
            if set_field(&mut tx, task, field, after).await.is_err() {
                return StatusCode::UNPROCESSABLE_ENTITY.into_response();
            }
        }
        let new_version=match sqlx::query_scalar::<_,i64>("UPDATE tasks SET version=version+1,updated_at=now() WHERE id=$1 AND version=$2 RETURNING version").bind(task).bind(version).fetch_optional(&mut *tx).await {Ok(Some(v))=>v,Ok(None)=>return (StatusCode::CONFLICT,Json(json!({"error":"bulk_conflict","task_id":task,"cause":"task version changed"}))).into_response(),Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response()};
        for (field, before, after) in fields {
            if sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(Uuid::new_v4()).bind(group).bind(task).bind(field).bind(before).bind(after).bind(new_version).execute(&mut *tx).await.is_err(){return StatusCode::INTERNAL_SERVER_ERROR.into_response();}
        }
        changed.push(task);
    }
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    Json(json!({"group_id":group,"tasks":changed})).into_response()
}

async fn conflict(pool: &PgPool, workspace: Uuid, number: i64) -> Response {
    match task_row(pool, workspace, number, true).await {
        Ok(Some(row)) => match serialize_task(pool, &row).await {
            Ok(current) => (
                StatusCode::CONFLICT,
                Json(json!({"error":"version_conflict","current":current})),
            )
                .into_response(),
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        },
        _ => StatusCode::CONFLICT.into_response(),
    }
}

async fn archive_task(
    State(state): State<AuthState>,
    Path((workspace, number)): Path<(Uuid, i64)>,
    headers: HeaderMap,
    Json(input): Json<VersionInput>,
) -> Response {
    mutate_archive(
        state,
        workspace,
        number,
        headers,
        input.expected_version,
        input.command_id.unwrap_or_else(Uuid::new_v4),
        true,
    )
    .await
}
async fn restore_task(
    State(state): State<AuthState>,
    Path((workspace, number)): Path<(Uuid, i64)>,
    headers: HeaderMap,
    Json(input): Json<VersionInput>,
) -> Response {
    mutate_archive(
        state,
        workspace,
        number,
        headers,
        input.expected_version,
        input.command_id.unwrap_or_else(Uuid::new_v4),
        false,
    )
    .await
}
async fn mutate_archive(
    state: AuthState,
    workspace: Uuid,
    number: i64,
    headers: HeaderMap,
    expected: i64,
    command: Uuid,
    archive: bool,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let row = match task_row(&state.pool, workspace, number, true).await {
        Ok(Some(r)) => r,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let project: Uuid = row.get("project_id");
    let version: i64 = row.get("version");
    let id: Uuid = row.get("id");
    match can_write(&state.pool, project, user).await {
        Ok(true) => {}
        Ok(false) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    if version != expected {
        return conflict(&state.pool, workspace, number).await;
    }
    let is_archived: bool = row.get::<Option<String>, _>("archived_at").is_some();
    if is_archived == archive {
        return match serialize_task(&state.pool, &row).await {
            Ok(v) => Json(v).into_response(),
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        };
    }
    let mut tx = match state.pool.begin().await {
        Ok(v) => v,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let updated = if archive {
        sqlx::query("UPDATE tasks SET archived_at=now(),updated_at=now(),version=version+1 WHERE id=$1 AND version=$2 AND archived_at IS NULL RETURNING version").bind(id).bind(expected).fetch_optional(&mut *tx).await
    } else {
        sqlx::query("UPDATE tasks SET archived_at=NULL,updated_at=now(),version=version+1 WHERE id=$1 AND version=$2 AND archived_at IS NOT NULL RETURNING version").bind(id).bind(expected).fetch_optional(&mut *tx).await
    };
    let new_version = match updated {
        Ok(Some(r)) => r.get::<i64, _>("version"),
        Ok(None) => {
            let _ = tx.rollback().await;
            return conflict(&state.pool, workspace, number).await;
        }
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let group = Uuid::new_v4();
    if sqlx::query("INSERT INTO task_operation_groups(id,command_id,workspace_id,actor_id) VALUES($1,$2,$3,$4)").bind(group).bind(command).bind(workspace).bind(user).execute(&mut *tx).await.is_err()
        || sqlx::query("UPDATE task_operation_groups SET state='suppressed' WHERE workspace_id=$1 AND actor_id=$2 AND state='undone'").bind(workspace).bind(user).execute(&mut *tx).await.is_err()
        || sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,'archived',$4,$5,$6)").bind(Uuid::new_v4()).bind(group).bind(id).bind(json!(is_archived)).bind(json!(archive)).bind(new_version).execute(&mut *tx).await.is_err()
        || tx.commit().await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
    match task_row(&state.pool, workspace, number, true).await {
        Ok(Some(r)) => match serialize_task(&state.pool, &r).await {
            Ok(v) => Json(v).into_response(),
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        },
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn duplicate_task(
    State(state): State<AuthState>,
    Path((workspace, number)): Path<(Uuid, i64)>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let source = match task_row(&state.pool, workspace, number, false).await {
        Ok(Some(r)) => r,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let project: Uuid = source.get("project_id");
    match can_write(&state.pool, project, user).await {
        Ok(true) => {}
        Ok(false) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let mut tx = match state.pool.begin().await {
        Ok(t) => t,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let new_number:i64=match sqlx::query_scalar("UPDATE workspaces SET next_task_number=next_task_number+1 WHERE id=$1 RETURNING next_task_number-1").bind(workspace).fetch_one(&mut *tx).await{Ok(n)=>n,Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response()};
    let id = Uuid::new_v4();
    let result=sqlx::query("INSERT INTO tasks(id,workspace_id,number,project_id,title,description,status,priority,start_date,due_date,created_by) SELECT $1,workspace_id,$2,project_id,title || ' (copy)',description,status,priority,start_date,due_date,$3 FROM tasks WHERE id=$4").bind(id).bind(new_number).bind(user).bind(source.get::<Uuid,_>("id")).execute(&mut *tx).await;
    if result.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let watchers: Vec<Uuid> =
        match sqlx::query_scalar("SELECT user_id FROM task_watchers WHERE task_id=$1")
            .bind(source.get::<Uuid, _>("id"))
            .fetch_all(&mut *tx)
            .await
        {
            Ok(watchers) => watchers,
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        };
    for watcher in watchers {
        if sqlx::query("INSERT INTO task_watchers(workspace_id,task_id,user_id) VALUES($1,$2,$3)")
            .bind(workspace)
            .bind(id)
            .bind(watcher)
            .execute(&mut *tx)
            .await
            .is_err()
        {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    match task_row(&state.pool, workspace, new_number, false).await {
        Ok(Some(r)) => match serialize_task(&state.pool, &r).await {
            Ok(v) => (StatusCode::CREATED, Json(v)).into_response(),
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        },
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn move_preview(
    State(state): State<AuthState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<MoveInput>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let row = match sqlx::query(
        "SELECT workspace_id,project_id FROM tasks WHERE id=$1 AND archived_at IS NULL",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let workspace: Uuid = row.get("workspace_id");
    let from: Uuid = row.get("project_id");
    let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL)").bind(input.project_id).bind(workspace).fetch_one(&state.pool).await.unwrap_or(false);
    if !valid {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    };
    match (
        can_write(&state.pool, from, user).await,
        can_write(&state.pool, input.project_id, user).await,
    ) {
        (Ok(true), Ok(true)) => {}
        (Ok(_), Ok(_)) => return StatusCode::NOT_FOUND.into_response(),
        _ => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let impacts=sqlx::query("WITH RECURSIVE subtree(id) AS (SELECT id FROM tasks WHERE id=$1 UNION ALL SELECT t.id FROM tasks t JOIN subtree s ON t.parent_task_id=s.id) SELECT (SELECT count(*)-1 FROM subtree) AS subtasks,(SELECT count(*) FROM task_relations r WHERE r.source_task_id IN(SELECT id FROM subtree) OR r.target_task_id IN(SELECT id FROM subtree)) AS relations").bind(id).fetch_one(&state.pool).await;
    let Ok(impacts) = impacts else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let visibility: String = sqlx::query_scalar("SELECT visibility FROM projects WHERE id=$1")
        .bind(input.project_id)
        .fetch_one(&state.pool)
        .await
        .unwrap_or_else(|_| "restricted".into());
    let access = sqlx::query(
        "SELECT user_id,role FROM project_memberships WHERE project_id=$1 ORDER BY user_id",
    )
    .bind(input.project_id)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    Json(json!({"from_project_id":from,"to_project_id":input.project_id,"destination_visibility":visibility,"subtasks_affected":impacts.get::<i64,_>("subtasks"),"relations_affected":impacts.get::<i64,_>("relations"),"destination_members":access.into_iter().map(|r|json!({"user_id":r.get::<Uuid,_>("user_id"),"role":r.get::<String,_>("role")})).collect::<Vec<_>>(),"confirmation_required":true})).into_response()
}
#[derive(Deserialize)]
struct MoveInput {
    project_id: Uuid,
}

async fn create_relation(
    State(state): State<AuthState>,
    Path(source): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<RelationInput>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    if source == input.target_task_id
        || !["blocks", "related", "duplicate"].contains(&input.kind.as_str())
    {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    };
    let rows = sqlx::query(
        "SELECT id,workspace_id,project_id FROM tasks WHERE id=ANY($1) AND archived_at IS NULL",
    )
    .bind(vec![source, input.target_task_id])
    .fetch_all(&state.pool)
    .await;
    let Ok(rows) = rows else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    if rows.len() != 2 {
        return StatusCode::NOT_FOUND.into_response();
    };
    let workspace: Uuid = rows[0].get("workspace_id");
    if rows
        .iter()
        .any(|r| r.get::<Uuid, _>("workspace_id") != workspace)
    {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    };
    for row in rows {
        match can_write(&state.pool, row.get("project_id"), user).await {
            Ok(true) => {}
            Ok(false) => return StatusCode::NOT_FOUND.into_response(),
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    }
    let already=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM task_relations WHERE source_task_id=$1 AND target_task_id=$2 AND kind=$3)").bind(source).bind(input.target_task_id).bind(&input.kind).fetch_one(&state.pool).await;
    match already {Ok(true)=>return (StatusCode::CREATED,Json(json!({"source_task_id":source,"target_task_id":input.target_task_id,"kind":input.kind}))).into_response(),Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response(),Ok(false)=>{}}
    let mut tx = match state.pool.begin().await {
        Ok(v) => v,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if sqlx::query("INSERT INTO task_relations(workspace_id,source_task_id,target_task_id,kind) VALUES($1,$2,$3,$4)").bind(workspace).bind(source).bind(input.target_task_id).bind(&input.kind).execute(&mut *tx).await.is_err(){return StatusCode::INTERNAL_SERVER_ERROR.into_response();}
    let version = match sqlx::query_scalar::<_, i64>(
        "UPDATE tasks SET version=version+1,updated_at=now() WHERE id=$1 RETURNING version",
    )
    .bind(source)
    .fetch_one(&mut *tx)
    .await
    {
        Ok(v) => v,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let group = Uuid::new_v4();
    let command = Uuid::new_v4();
    let field = format!("relation/{}/{}", input.target_task_id, input.kind);
    if sqlx::query("INSERT INTO task_operation_groups(id,command_id,workspace_id,actor_id) VALUES($1,$2,$3,$4)").bind(group).bind(command).bind(workspace).bind(user).execute(&mut *tx).await.is_err()
        || sqlx::query("UPDATE task_operation_groups SET state='suppressed' WHERE workspace_id=$1 AND actor_id=$2 AND state='undone'").bind(workspace).bind(user).execute(&mut *tx).await.is_err()
        || sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,$4,'false'::jsonb,'true'::jsonb,$5)").bind(Uuid::new_v4()).bind(group).bind(source).bind(field).bind(version).execute(&mut *tx).await.is_err()
        || tx.commit().await.is_err(){return StatusCode::INTERNAL_SERVER_ERROR.into_response();}
    (StatusCode::CREATED,Json(json!({"source_task_id":source,"target_task_id":input.target_task_id,"kind":input.kind}))).into_response()
}
#[derive(Deserialize)]
struct RelationInput {
    target_task_id: Uuid,
    kind: String,
}

async fn task_history(
    State(state): State<AuthState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let task = match sqlx::query("SELECT workspace_id,project_id FROM tasks WHERE id=$1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if !matches!(
        can_read(&state.pool, task.get("project_id"), user).await,
        Ok(true)
    ) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let rows = match sqlx::query("SELECT o.id,o.group_id,o.field_key,o.before_value,o.after_value,o.task_version,o.suppressed,g.actor_id,g.created_at::text AS created_at,g.state FROM task_operations o JOIN task_operation_groups g ON g.id=o.group_id WHERE o.task_id=$1 ORDER BY o.created_at,o.id").bind(id).fetch_all(&state.pool).await { Ok(v)=>v,Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
    let mut visible: Vec<Value> = Vec::new();
    for row in rows {
        if row.get::<bool, _>("suppressed")
            || matches!(
                row.get::<String, _>("state").as_str(),
                "suppressed" | "undone"
            )
        {
            continue;
        }
        let field: String = row.get("field_key");
        let actor: Uuid = row.get("actor_id");
        if let Some(previous) = visible.iter_mut().rev().find(|v| v["field"] == field) {
            if previous["actor_id"] == json!(actor) {
                previous["after"] = row.get::<Value, _>("after_value");
                previous["version"] = json!(row.get::<i64, _>("task_version"));
                previous["suppressed"] = json!(false);
                if previous["before"] == previous["after"] {
                    previous["suppressed"] = json!(true);
                }
                continue;
            }
        }
        visible.push(json!({"id":row.get::<Uuid,_>("id"),"group_id":row.get::<Uuid,_>("group_id"),"actor_id":actor,"created_at":row.get::<String,_>("created_at"),"field":field,"before":row.get::<Value,_>("before_value"),"after":row.get::<Value,_>("after_value"),"version":row.get::<i64,_>("task_version"),"suppressed":false}));
    }
    visible.retain(|v| !v["suppressed"].as_bool().unwrap_or(false));
    Json(json!({"operations":visible})).into_response()
}

async fn undo_latest(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    apply_history(state, workspace, headers, false).await
}
async fn redo_latest(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    apply_history(state, workspace, headers, true).await
}

async fn apply_history(
    state: AuthState,
    workspace: Uuid,
    headers: HeaderMap,
    redo: bool,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let target_state = if redo { "undone" } else { "active" };
    let group=match sqlx::query("SELECT id FROM task_operation_groups WHERE workspace_id=$1 AND actor_id=$2 AND state=$3 ORDER BY CASE WHEN $3='undone' THEN -extract(epoch FROM created_at) ELSE extract(epoch FROM created_at) END DESC LIMIT 1").bind(workspace).bind(user).bind(target_state).fetch_optional(&state.pool).await { Ok(Some(r))=>r.get::<Uuid,_>("id"),Ok(None)=>return (StatusCode::CONFLICT,Json(json!({"error":"undo_unavailable","reason":"No eligible operation group"}))).into_response(),Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
    let mut tx = match state.pool.begin().await {
        Ok(t) => t,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let operations=match sqlx::query("SELECT o.task_id,o.field_key,o.before_value,o.after_value,t.workspace_id,t.number,t.project_id,t.version FROM task_operations o JOIN tasks t ON t.id=o.task_id WHERE o.group_id=$1 ORDER BY o.task_id,o.field_key FOR UPDATE OF t").bind(group).fetch_all(&mut *tx).await {Ok(v)=>v,Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response()};
    if operations.is_empty() {
        return StatusCode::CONFLICT.into_response();
    }
    let mut conflicts = Vec::new();
    for op in &operations {
        let task: Uuid = op.get("task_id");
        let project: Uuid = op.get("project_id");
        let field: String = op.get("field_key");
        match can_write(&mut *tx, project, user).await {
            Ok(true) => {}
            Ok(false) => {
                conflicts.push(json!({"task_id":task,"cause":"write access was removed"}));
                continue;
            }
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
        if field == "project_id" {
            let destination = if redo {
                op.get::<Value, _>("after_value")
            } else {
                op.get::<Value, _>("before_value")
            };
            let writable = match destination.as_str().and_then(|v| Uuid::parse_str(v).ok()) {
                Some(destination) => match can_write(&mut *tx, destination, user).await {
                    Ok(writable) => writable,
                    Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                },
                None => false,
            };
            if !writable {
                conflicts.push(json!({"task_id":task,"cause":"write access to the destination project is missing"}));
                continue;
            }
        }
        match current_field(&mut tx, task, &field).await {
            Ok(Some(value)) => {
                let expected = if redo {
                    op.get::<Value, _>("before_value")
                } else {
                    op.get::<Value, _>("after_value")
                };
                if value != expected {
                    conflicts.push(
                        json!({"task_id":task,"field":field,"cause":"current value changed"}),
                    );
                }
            }
            _ => conflicts
                .push(json!({"task_id":task,"field":field,"cause":"unsupported or missing field"})),
        }
    }
    if !conflicts.is_empty() {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"history_conflict","conflicts":conflicts})),
        )
            .into_response();
    }
    let mut touched = std::collections::HashSet::new();
    for op in operations {
        let task: Uuid = op.get("task_id");
        let field: String = op.get("field_key");
        let value = if redo {
            op.get::<Value, _>("after_value")
        } else {
            op.get::<Value, _>("before_value")
        };
        if set_field(&mut tx, task, &field, &value).await.is_err() {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        touched.insert(task);
    }
    for task in &touched {
        if sqlx::query("UPDATE tasks SET version=version+1,updated_at=now() WHERE id=$1")
            .bind(task)
            .execute(&mut *tx)
            .await
            .is_err()
        {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    let new_state = if redo { "active" } else { "undone" };
    match sqlx::query("UPDATE task_operation_groups SET state=$2 WHERE id=$1 AND state=$3")
        .bind(group)
        .bind(new_state)
        .bind(target_state)
        .execute(&mut *tx)
        .await
    {
        Ok(result) if result.rows_affected() == 1 => {}
        Ok(_) => {
            return (
                StatusCode::CONFLICT,
                Json(json!({"error":"undo_unavailable","reason":"The operation group changed"})),
            )
                .into_response()
        }
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let first = *touched.iter().next().unwrap();
    let row = match sqlx::query("SELECT workspace_id,number FROM tasks WHERE id=$1")
        .bind(first)
        .fetch_one(&state.pool)
        .await
    {
        Ok(r) => r,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    match task_row(
        &state.pool,
        row.get("workspace_id"),
        row.get("number"),
        true,
    )
    .await
    {
        Ok(Some(r)) => match serialize_task(&state.pool, &r).await {
            Ok(task) => Json(json!({"group_id":group,"task":task})).into_response(),
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        },
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn current_field(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    task: Uuid,
    field: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let sql = match field {
        "title" => "SELECT to_jsonb(title) AS value FROM tasks WHERE id=$1",
        "description" => "SELECT to_jsonb(description) AS value FROM tasks WHERE id=$1",
        "status" => "SELECT to_jsonb(status) AS value FROM tasks WHERE id=$1",
        "priority" => "SELECT to_jsonb(priority) AS value FROM tasks WHERE id=$1",
        "start_date" => "SELECT COALESCE(to_jsonb(start_date::text),'null'::jsonb) AS value FROM tasks WHERE id=$1",
        "due_date" => "SELECT COALESCE(to_jsonb(due_date::text),'null'::jsonb) AS value FROM tasks WHERE id=$1",
        "project_id" => "SELECT to_jsonb(project_id) AS value FROM tasks WHERE id=$1",
        "archived" => "SELECT to_jsonb(archived_at IS NOT NULL) AS value FROM tasks WHERE id=$1",
        value if value.starts_with("relation/") => {
            let Some((target,kind))=value.trim_start_matches("relation/").split_once('/') else {return Ok(None)};
            let Ok(target)=Uuid::parse_str(target) else {return Ok(None)};
            let exists=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM task_relations WHERE source_task_id=$1 AND target_task_id=$2 AND kind=$3)").bind(task).bind(target).bind(kind).fetch_one(&mut **tx).await?;
            return Ok(Some(json!(exists)));
        }
        _ => return Ok(None),
    };
    sqlx::query_scalar(sql)
        .bind(task)
        .fetch_optional(&mut **tx)
        .await
}

async fn set_field(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    task: Uuid,
    field: &str,
    value: &Value,
) -> Result<(), sqlx::Error> {
    match field {
        "title" => {
            sqlx::query("UPDATE tasks SET title=$2 WHERE id=$1")
                .bind(task)
                .bind(value.as_str().unwrap_or_default())
                .execute(&mut **tx)
                .await?;
        }
        "description" => {
            sqlx::query("UPDATE tasks SET description=$2 WHERE id=$1")
                .bind(task)
                .bind(value.as_str().unwrap_or_default())
                .execute(&mut **tx)
                .await?;
        }
        "status" => {
            sqlx::query("UPDATE tasks SET status=$2 WHERE id=$1")
                .bind(task)
                .bind(value.as_str().unwrap_or_default())
                .execute(&mut **tx)
                .await?;
        }
        "priority" => {
            sqlx::query("UPDATE tasks SET priority=$2 WHERE id=$1")
                .bind(task)
                .bind(value.as_str().unwrap_or_default())
                .execute(&mut **tx)
                .await?;
        }
        "start_date" => {
            sqlx::query("UPDATE tasks SET start_date=$2::date WHERE id=$1")
                .bind(task)
                .bind(value.as_str())
                .execute(&mut **tx)
                .await?;
        }
        "due_date" => {
            sqlx::query("UPDATE tasks SET due_date=$2::date WHERE id=$1")
                .bind(task)
                .bind(value.as_str())
                .execute(&mut **tx)
                .await?;
        }
        "project_id" => {
            sqlx::query("UPDATE tasks SET project_id=$2 WHERE id=$1")
                .bind(task)
                .bind(value.as_str().and_then(|v| Uuid::parse_str(v).ok()))
                .execute(&mut **tx)
                .await?;
        }
        "archived" => {
            let archived = value.as_bool().unwrap_or(false);
            let sql = if archived {
                "UPDATE tasks SET archived_at=COALESCE(archived_at,now()) WHERE id=$1"
            } else {
                "UPDATE tasks SET archived_at=NULL WHERE id=$1"
            };
            sqlx::query(sql).bind(task).execute(&mut **tx).await?;
        }
        field_name if field_name.starts_with("relation/") => {
            let Some((target, kind)) = field_name.trim_start_matches("relation/").split_once('/')
            else {
                return Ok(());
            };
            let Ok(target) = Uuid::parse_str(target) else {
                return Ok(());
            };
            if value.as_bool().unwrap_or(false) {
                sqlx::query("INSERT INTO task_relations(workspace_id,source_task_id,target_task_id,kind) SELECT workspace_id,$1,$2,$3 FROM tasks WHERE id=$1 ON CONFLICT DO NOTHING")
                    .bind(task).bind(target).bind(kind).execute(&mut **tx).await?;
            } else {
                sqlx::query("DELETE FROM task_relations WHERE source_task_id=$1 AND target_task_id=$2 AND kind=$3")
                    .bind(task).bind(target).bind(kind).execute(&mut **tx).await?;
            }
        }
        _ => {}
    }
    Ok(())
}
