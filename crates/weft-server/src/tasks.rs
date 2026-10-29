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

#[derive(Deserialize)]
struct UpdateTask {
    expected_version: i64,
    title: Option<String>,
    description: Option<String>,
    status: Option<String>,
    priority: Option<String>,
    start_date: Option<Option<String>>,
    due_date: Option<Option<String>>,
    watchers: Option<Vec<Uuid>>,
    project_id: Option<Uuid>,
    confirm_move: Option<bool>,
}

#[derive(Deserialize)]
struct VersionInput {
    expected_version: i64,
}

fn valid_status(value: &str) -> bool {
    ["backlog", "not_started", "active", "completed", "canceled"].contains(&value)
}
fn valid_priority(value: &str) -> bool {
    ["low", "normal", "high", "urgent"].contains(&value)
}

async fn can_read(pool: &PgPool, project: Uuid, user: Uuid) -> Result<bool, sqlx::Error> {
    Ok(matches!(evaluate_access(pool, project, user).await?, Some(a) if a.role >= Role::Viewer))
}

async fn can_write(pool: &PgPool, project: Uuid, user: Uuid) -> Result<bool, sqlx::Error> {
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
            match can_read(&state.pool, input.project_id, watcher).await {
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
    Json(input): Json<UpdateTask>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let existing=match sqlx::query("SELECT workspace_id,number,project_id,version FROM tasks WHERE id=$1 AND archived_at IS NULL").bind(id).fetch_optional(&state.pool).await {Ok(Some(r))=>r,Ok(None)=>return StatusCode::NOT_FOUND.into_response(),Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response()};
    let workspace: Uuid = existing.get("workspace_id");
    let number: i64 = existing.get("number");
    let old_project: Uuid = existing.get("project_id");
    let version: i64 = existing.get("version");
    if version != input.expected_version {
        return conflict(&state.pool, workspace, number).await;
    }
    let new_project = input.project_id.unwrap_or(old_project);
    match can_write(&state.pool, old_project, user).await {
        Ok(true) => {}
        Ok(false) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    if new_project != old_project {
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
        return conflict(&state.pool, workspace, number).await;
    }
    if new_project != old_project
        && sqlx::query("WITH RECURSIVE descendants(id) AS (SELECT id FROM tasks WHERE parent_task_id=$1 UNION ALL SELECT t.id FROM tasks t JOIN descendants d ON t.parent_task_id=d.id) UPDATE tasks SET project_id=$2,updated_at=now(),version=version+1 WHERE id IN (SELECT id FROM descendants)")
            .bind(id)
            .bind(new_project)
            .execute(&mut *tx)
            .await
            .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
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
            match can_read(&state.pool, new_project, watcher).await {
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
    if version != expected {
        return conflict(&state.pool, workspace, number).await;
    }
    match can_write(&state.pool, project, user).await {
        Ok(true) => {}
        Ok(false) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    let sql = if archive {
        "UPDATE tasks SET archived_at=now(),updated_at=now(),version=version+1 WHERE id=$1 AND archived_at IS NULL"
    } else {
        "UPDATE tasks SET archived_at=NULL,updated_at=now(),version=version+1 WHERE id=$1 AND archived_at IS NOT NULL"
    };
    if sqlx::query(sql)
        .bind(id)
        .execute(&state.pool)
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
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
    let result=sqlx::query("INSERT INTO task_relations(workspace_id,source_task_id,target_task_id,kind) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING").bind(workspace).bind(source).bind(input.target_task_id).bind(&input.kind).execute(&state.pool).await;
    if result.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    (StatusCode::CREATED,Json(json!({"source_task_id":source,"target_task_id":input.target_task_id,"kind":input.kind}))).into_response()
}
#[derive(Deserialize)]
struct RelationInput {
    target_task_id: Uuid,
    kind: String,
}
