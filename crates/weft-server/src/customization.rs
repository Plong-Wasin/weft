use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::auth::{require_session, AuthState};

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route(
            "/workspaces/:workspace_id/statuses",
            get(list_statuses).post(create_status),
        )
        .route(
            "/workspaces/:workspace_id/statuses/reorder",
            axum::routing::post(reorder_statuses),
        )
        .route(
            "/workspaces/:workspace_id/statuses/:status_id",
            axum::routing::patch(update_status),
        )
        .route(
            "/workspaces/:workspace_id/statuses/:status_id/archive-preview",
            get(preview_status_archive),
        )
        .route(
            "/workspaces/:workspace_id/statuses/:status_id/archive",
            post(archive_status),
        )
        .route(
            "/workspaces/:workspace_id/attributes",
            get(list_attributes).post(create_attribute),
        )
        .route(
            "/workspaces/:workspace_id/attributes/:attribute_id",
            axum::routing::patch(update_attribute),
        )
        .route(
            "/workspaces/:workspace_id/attributes/:attribute_id/archive-preview",
            get(preview_attribute_archive),
        )
        .route(
            "/workspaces/:workspace_id/attributes/:attribute_id/options",
            post(create_option),
        )
        .route(
            "/workspaces/:workspace_id/attributes/:attribute_id/options/:option_id",
            axum::routing::patch(update_option),
        )
        .route(
            "/tasks/:task_id/attributes",
            get(read_task_attributes).patch(update_task_attributes),
        )
        .route(
            "/workspaces/:workspace_id/tasks/bulk-attributes",
            post(bulk_update_task_attributes),
        )
}

#[derive(Deserialize)]
struct StatusOrder {
    status_ids: Vec<Uuid>,
}

async fn reorder_statuses(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<StatusOrder>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return auth_error(s),
    };
    if !matches!(
        is_schema_admin(&state.pool, workspace, user).await,
        Ok(true)
    ) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if input.status_ids.is_empty() {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let mut unique = input.status_ids.clone();
    unique.sort();
    unique.dedup();
    if unique.len() != input.status_ids.len() {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let mut actual: Vec<Uuid> = match sqlx::query_scalar("SELECT id FROM workspace_statuses WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY position,id").bind(workspace).fetch_all(&mut *tx).await { Ok(v) => v, Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
    let mut requested = input.status_ids.clone();
    actual.sort();
    requested.sort();
    if actual != requested {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    for (position, id) in input.status_ids.iter().enumerate() {
        if sqlx::query("UPDATE workspace_statuses SET position=$3 WHERE workspace_id=$1 AND id=$2")
            .bind(workspace)
            .bind(id)
            .bind(position as i32)
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
    Json(json!({"status_ids":input.status_ids})).into_response()
}

async fn is_schema_admin(
    pool: &sqlx::PgPool,
    workspace: Uuid,
    user: Uuid,
) -> Result<bool, sqlx::Error> {
    let role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2",
    )
    .bind(workspace)
    .bind(user)
    .fetch_optional(pool)
    .await?;
    Ok(matches!(role.as_deref(), Some("owner" | "admin")))
}

fn auth_error(status: StatusCode) -> Response {
    status.into_response()
}

async fn list_statuses(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return auth_error(s),
    };
    let member: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2)",
    )
    .bind(workspace)
    .bind(user)
    .fetch_one(&state.pool)
    .await
    .unwrap_or(false);
    if !member {
        return StatusCode::NOT_FOUND.into_response();
    }
    match sqlx::query("SELECT id,status_key,name,category,color,position,archived_at IS NOT NULL AS archived FROM workspace_statuses WHERE workspace_id=$1 ORDER BY position,id").bind(workspace).fetch_all(&state.pool).await {
        Ok(rows) => Json(json!({"statuses": rows.iter().map(status_json).collect::<Vec<_>>()})).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

fn status_json(row: &sqlx::postgres::PgRow) -> Value {
    json!({"id":row.get::<Uuid,_>("id"),"key":row.get::<String,_>("status_key"),"name":row.get::<String,_>("name"),"category":row.get::<String,_>("category"),"color":row.get::<String,_>("color"),"position":row.get::<i32,_>("position"),"archived":row.get::<bool,_>("archived")})
}

#[derive(Deserialize)]
struct NewStatus {
    name: String,
    category: String,
    color: Option<String>,
}

async fn create_status(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<NewStatus>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return auth_error(s),
    };
    if !matches!(
        is_schema_admin(&state.pool, workspace, user).await,
        Ok(true)
    ) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let name = input.name.trim();
    if name.is_empty()
        || !valid_category(&input.category)
        || input.color.as_deref().is_some_and(|c| !valid_color(c))
    {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let key = format!("custom_{}", Uuid::new_v4().simple());
    let result = sqlx::query("INSERT INTO workspace_statuses(id,workspace_id,status_key,name,category,color,position) VALUES($1,$2,$3,$4,$5,$6,(SELECT COALESCE(max(position),-1)+1 FROM workspace_statuses WHERE workspace_id=$2)) RETURNING id,status_key,name,category,color,position,archived_at IS NOT NULL AS archived")
        .bind(Uuid::new_v4()).bind(workspace).bind(key).bind(name).bind(input.category).bind(input.color.unwrap_or_else(|| "#64748b".into())).fetch_one(&state.pool).await;
    match result {
        Ok(row) => (StatusCode::CREATED, Json(status_json(&row))).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

fn valid_category(value: &str) -> bool {
    ["not_started", "active", "completed", "canceled"].contains(&value)
}
fn valid_color(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].bytes().all(|c| c.is_ascii_hexdigit())
}

#[derive(Deserialize)]
struct StatusPatch {
    name: Option<String>,
    color: Option<String>,
    position: Option<i32>,
    category: Option<String>,
}

async fn update_status(
    State(state): State<AuthState>,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(input): Json<StatusPatch>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return auth_error(s),
    };
    if !matches!(
        is_schema_admin(&state.pool, workspace, user).await,
        Ok(true)
    ) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if input.name.as_deref().is_some_and(|v| v.trim().is_empty())
        || input.color.as_deref().is_some_and(|v| !valid_color(v))
        || input
            .category
            .as_deref()
            .is_some_and(|v| !valid_category(v))
    {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let previous = match sqlx::query(
        "SELECT category FROM workspace_statuses WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(workspace)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(Some(row)) => row.get::<String, _>("category"),
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let result = sqlx::query("UPDATE workspace_statuses SET name=COALESCE($3,name),color=COALESCE($4,color),position=COALESCE($5,position),category=COALESCE($6,category) WHERE workspace_id=$1 AND id=$2 RETURNING id,status_key,name,category,color,position,archived_at IS NOT NULL AS archived")
        .bind(workspace).bind(id).bind(input.name.map(|s| s.trim().to_owned())).bind(input.color).bind(input.position).bind(input.category).fetch_optional(&mut *tx).await;
    match result {
        Ok(Some(row)) => {
            if row.get::<String, _>("category") != previous {
                let key: String = row.get("status_key");
                if crate::tasks::restate_tasks(&mut tx, workspace, user, &key, &key)
                    .await
                    .is_err()
                {
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            }
            if tx.commit().await.is_err() {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
            Json(status_json(&row)).into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Deserialize)]
struct ArchiveStatus {
    replacement_id: Option<Uuid>,
}

async fn preview_status_archive(
    State(state): State<AuthState>,
    Path((workspace, status)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return auth_error(s),
    };
    let member: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2)",
    )
    .bind(workspace)
    .bind(user)
    .fetch_one(&state.pool)
    .await
    .unwrap_or(false);
    if !member {
        return StatusCode::NOT_FOUND.into_response();
    }
    match sqlx::query("SELECT (SELECT count(*) FROM tasks t JOIN workspace_statuses s ON s.workspace_id=t.workspace_id AND s.status_key=t.status WHERE t.workspace_id=$1 AND s.id=$2) AS affected_tasks,(SELECT count(DISTINCT l.id) FROM task_lists l WHERE l.workspace_id=$1 AND l.kind='smart' AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(l.query->'filters','[]'::jsonb)) AS filters(value) WHERE filters.value->>'field'='status' AND filters.value->>'value'=$2::text)) AS affected_views").bind(workspace).bind(status).fetch_one(&state.pool).await {
        Ok(row) => Json(json!({"status_id":status,"affected_tasks":row.get::<i64,_>("affected_tasks"),"affected_views":row.get::<i64,_>("affected_views")})).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn archive_status(
    State(state): State<AuthState>,
    Path((workspace, status)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(input): Json<ArchiveStatus>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return auth_error(s),
    };
    if !matches!(
        is_schema_admin(&state.pool, workspace, user).await,
        Ok(true)
    ) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    // Lock the Status row first: Task writers validate it with FOR SHARE, so none can commit a
    // Task onto it between the count below and the archive.
    let archived_key: String = match sqlx::query_scalar(
        "SELECT status_key FROM workspace_statuses WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(workspace)
    .bind(status)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(Some(key)) => key,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if archived_key == "backlog" {
        // New Tasks default to Backlog, so it must stay.
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({"error":"default_status"})),
        )
            .into_response();
    }
    let count: i64 = match sqlx::query_scalar("SELECT count(*) FROM tasks t JOIN workspace_statuses s ON s.workspace_id=t.workspace_id AND s.status_key=t.status WHERE t.workspace_id=$1 AND s.id=$2").bind(workspace).bind(status).fetch_one(&mut *tx).await { Ok(n) => n, Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
    let affected_views: i64 = match sqlx::query_scalar("SELECT count(DISTINCT l.id) FROM task_lists l WHERE l.workspace_id=$1 AND l.kind='smart' AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(l.query->'filters','[]'::jsonb)) AS filters(value) WHERE filters.value->>'field'='status' AND filters.value->>'value'=$2::text)").bind(workspace).bind(status).fetch_one(&mut *tx).await { Ok(n)=>n,Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
    if count > 0 && input.replacement_id.is_none() {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({"error":"replacement_required","affected_tasks":count})),
        )
            .into_response();
    }
    let replacement_key = if let Some(replacement) = input.replacement_id {
        match sqlx::query_scalar::<_, String>("SELECT status_key FROM workspace_statuses WHERE workspace_id=$1 AND id=$2 AND id<>$3 AND archived_at IS NULL FOR SHARE").bind(workspace).bind(replacement).bind(status).fetch_optional(&mut *tx).await { Ok(Some(key)) => Some(key), _ => return StatusCode::UNPROCESSABLE_ENTITY.into_response() }
    } else {
        None
    };
    if let Some(key) = replacement_key {
        if crate::tasks::restate_tasks(&mut tx, workspace, user, &archived_key, &key)
            .await
            .is_err()
        {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    if sqlx::query(
        "UPDATE workspace_statuses SET archived_at=now() WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(status)
    .execute(&mut *tx)
    .await
    .is_err()
        || tx.commit().await.is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    Json(json!({"archived":true,"affected_tasks":count,"affected_views":affected_views}))
        .into_response()
}

#[derive(Deserialize)]
struct NewAttribute {
    name: String,
    value_type: String,
    project_ids: Option<Vec<Uuid>>,
    options: Option<Vec<String>>,
}

async fn list_attributes(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return auth_error(s),
    };
    let member: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2)",
    )
    .bind(workspace)
    .bind(user)
    .fetch_one(&state.pool)
    .await
    .unwrap_or(false);
    if !member {
        return StatusCode::NOT_FOUND.into_response();
    }
    match sqlx::query("SELECT a.id,a.name,a.value_type,a.position,a.archived_at IS NOT NULL AS archived,COALESCE((SELECT array_agg(p.project_id) FROM project_attributes p WHERE p.attribute_id=a.id),'{}'::uuid[]) AS project_ids,COALESCE((SELECT json_agg(json_build_object('id',o.id,'key',o.option_key,'name',o.name) ORDER BY o.position) FROM attribute_options o WHERE o.attribute_id=a.id AND o.archived_at IS NULL),'[]'::json) AS options FROM attribute_schemas a WHERE a.workspace_id=$1 ORDER BY a.position,a.id").bind(workspace).fetch_all(&state.pool).await {
        Ok(rows) => {
            let mut attributes = Vec::with_capacity(rows.len());
            for row in rows {
                let mut visible_projects = Vec::new();
                for project in row.get::<Vec<Uuid>, _>("project_ids") {
                    match crate::tasks::can_read(&state.pool, project, user).await {
                        Ok(true) => visible_projects.push(project),
                        Ok(false) => {}
                        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                    }
                }
                attributes.push(json!({"id":row.get::<Uuid,_>("id"),"name":row.get::<String,_>("name"),"type":row.get::<String,_>("value_type"),"position":row.get::<i32,_>("position"),"project_ids":visible_projects,"options":row.get::<Value,_>("options"),"archived":row.get::<bool,_>("archived")}));
            }
            Json(json!({"attributes":attributes})).into_response()
        },
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn create_attribute(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<NewAttribute>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return auth_error(s),
    };
    if !matches!(
        is_schema_admin(&state.pool, workspace, user).await,
        Ok(true)
    ) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if input.name.trim().is_empty()
        || ![
            "text",
            "number",
            "date",
            "single_select",
            "multi_select",
            "user",
        ]
        .contains(&input.value_type.as_str())
        || ((input.value_type == "single_select" || input.value_type == "multi_select")
            && input.options.as_ref().is_none_or(Vec::is_empty))
    {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let id = Uuid::new_v4();
    let inserted = sqlx::query("INSERT INTO attribute_schemas(id,workspace_id,name,value_type,position) VALUES($1,$2,$3,$4,(SELECT COALESCE(max(position),-1)+1 FROM attribute_schemas WHERE workspace_id=$2))").bind(id).bind(workspace).bind(input.name.trim()).bind(&input.value_type).execute(&mut *tx).await;
    if inserted.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if let Some(projects) = input.project_ids {
        for project in projects {
            if sqlx::query("INSERT INTO project_attributes(workspace_id,project_id,attribute_id) SELECT $1,p.id,$3 FROM projects p WHERE p.workspace_id=$1 AND p.id=$2 AND p.archived_at IS NULL").bind(workspace).bind(project).bind(id).execute(&mut *tx).await.is_err() { return StatusCode::UNPROCESSABLE_ENTITY.into_response(); }
        }
    }
    if let Some(options) = input.options {
        for (position, name) in options.into_iter().enumerate() {
            if name.trim().is_empty() || sqlx::query("INSERT INTO attribute_options(id,workspace_id,attribute_id,option_key,name,position) VALUES($1,$2,$3,$4,$5,$6)").bind(Uuid::new_v4()).bind(workspace).bind(id).bind(name.trim().to_lowercase().replace(' ',"_")).bind(name.trim()).bind(position as i32).execute(&mut *tx).await.is_err() { return StatusCode::UNPROCESSABLE_ENTITY.into_response(); }
        }
    }
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    (
        StatusCode::CREATED,
        Json(json!({"id":id,"name":input.name.trim(),"type":input.value_type,"archived":false})),
    )
        .into_response()
}

#[derive(Deserialize)]
struct AttributePatch {
    name: Option<String>,
    position: Option<i32>,
    archived: Option<bool>,
}

async fn preview_attribute_archive(
    State(state): State<AuthState>,
    Path((workspace, attribute)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return auth_error(status),
    };
    if !matches!(
        is_schema_admin(&state.pool, workspace, user).await,
        Ok(true)
    ) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM attribute_schemas WHERE workspace_id=$1 AND id=$2)",
    )
    .bind(workspace)
    .bind(attribute)
    .fetch_one(&state.pool)
    .await
    .unwrap_or(false);
    if !exists {
        return StatusCode::NOT_FOUND.into_response();
    }
    match sqlx::query_scalar::<_, i64>(
        "SELECT count(DISTINCT l.id) FROM task_lists l WHERE l.workspace_id=$1 AND l.kind='smart' AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(l.query->'filters','[]'::jsonb)) AS filters(value) WHERE filters.value->>'field'=$2)",
    )
    .bind(workspace)
    .bind(format!("attribute:{attribute}"))
    .fetch_one(&state.pool)
    .await
    {
        Ok(affected_views) => Json(json!({"attribute_id":attribute,"affected_views":affected_views})).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn update_attribute(
    State(state): State<AuthState>,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(input): Json<AttributePatch>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return auth_error(s),
    };
    if !matches!(
        is_schema_admin(&state.pool, workspace, user).await,
        Ok(true)
    ) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if input.name.as_deref().is_some_and(|s| s.trim().is_empty()) {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let affected_views: i64 = if input.archived == Some(true) {
        sqlx::query_scalar("SELECT count(DISTINCT l.id) FROM task_lists l WHERE l.workspace_id=$1 AND l.kind='smart' AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(l.query->'filters','[]'::jsonb)) AS filters(value) WHERE filters.value->>'field'=$2)").bind(workspace).bind(format!("attribute:{id}")).fetch_one(&state.pool).await.unwrap_or(0)
    } else {
        0
    };
    let result = sqlx::query("UPDATE attribute_schemas SET name=COALESCE($3,name),position=COALESCE($4,position),archived_at=CASE WHEN $5 IS TRUE THEN COALESCE(archived_at,now()) WHEN $5 IS FALSE THEN NULL ELSE archived_at END WHERE workspace_id=$1 AND id=$2 RETURNING id,name,value_type,position,archived_at IS NOT NULL AS archived").bind(workspace).bind(id).bind(input.name.map(|s|s.trim().to_owned())).bind(input.position).bind(input.archived).fetch_optional(&state.pool).await;
    match result { Ok(Some(r)) => Json(json!({"id":r.get::<Uuid,_>("id"),"name":r.get::<String,_>("name"),"type":r.get::<String,_>("value_type"),"position":r.get::<i32,_>("position"),"archived":r.get::<bool,_>("archived"),"affected_views":affected_views})).into_response(), Ok(None) => StatusCode::NOT_FOUND.into_response(), Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response() }
}

#[derive(Deserialize)]
struct NewOption {
    name: String,
}

async fn create_option(
    State(state): State<AuthState>,
    Path((workspace, attribute)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(input): Json<NewOption>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return auth_error(s),
    };
    if !matches!(
        is_schema_admin(&state.pool, workspace, user).await,
        Ok(true)
    ) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if input.name.trim().is_empty() {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let key = input.name.trim().to_lowercase().replace(' ', "_");
    match sqlx::query("INSERT INTO attribute_options(id,workspace_id,attribute_id,option_key,name,position) VALUES($1,$2,$3,$4,$5,(SELECT COALESCE(max(position),-1)+1 FROM attribute_options WHERE attribute_id=$3)) RETURNING id,option_key,name,position,archived_at IS NOT NULL AS archived")
        .bind(Uuid::new_v4()).bind(workspace).bind(attribute).bind(key).bind(input.name.trim()).fetch_one(&state.pool).await {
        Ok(row) => (StatusCode::CREATED, Json(json!({"id":row.get::<Uuid,_>("id"),"key":row.get::<String,_>("option_key"),"name":row.get::<String,_>("name"),"position":row.get::<i32,_>("position"),"archived":row.get::<bool,_>("archived")}))).into_response(),
        Err(_) => StatusCode::UNPROCESSABLE_ENTITY.into_response(),
    }
}

#[derive(Deserialize)]
struct OptionPatch {
    name: Option<String>,
    position: Option<i32>,
    archived: Option<bool>,
}

async fn update_option(
    State(state): State<AuthState>,
    Path((workspace, attribute, option)): Path<(Uuid, Uuid, Uuid)>,
    headers: HeaderMap,
    Json(input): Json<OptionPatch>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return auth_error(s),
    };
    if !matches!(
        is_schema_admin(&state.pool, workspace, user).await,
        Ok(true)
    ) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if input.name.as_deref().is_some_and(|v| v.trim().is_empty()) {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let affected_views: i64 = if input.archived == Some(true) {
        sqlx::query_scalar("SELECT count(DISTINCT l.id) FROM task_lists l WHERE l.workspace_id=$1 AND l.kind='smart' AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(l.query->'filters','[]'::jsonb)) AS filters(value) WHERE filters.value->>'value'=$2::text)")
            .bind(workspace).bind(option).fetch_one(&state.pool).await.unwrap_or(0)
    } else {
        0
    };
    let result = sqlx::query("UPDATE attribute_options SET name=COALESCE($4,name),position=COALESCE($5,position),archived_at=CASE WHEN $6 IS TRUE THEN COALESCE(archived_at,now()) WHEN $6 IS FALSE THEN NULL ELSE archived_at END WHERE workspace_id=$1 AND attribute_id=$2 AND id=$3 RETURNING id,option_key,name,position,archived_at IS NOT NULL AS archived")
        .bind(workspace).bind(attribute).bind(option).bind(input.name.map(|s|s.trim().to_owned())).bind(input.position).bind(input.archived).fetch_optional(&state.pool).await;
    match result { Ok(Some(row)) => Json(json!({"id":row.get::<Uuid,_>("id"),"key":row.get::<String,_>("option_key"),"name":row.get::<String,_>("name"),"position":row.get::<i32,_>("position"),"archived":row.get::<bool,_>("archived"),"affected_views":affected_views})).into_response(), Ok(None) => StatusCode::NOT_FOUND.into_response(), Err(_) => StatusCode::UNPROCESSABLE_ENTITY.into_response() }
}

async fn read_task_attributes(
    State(state): State<AuthState>,
    Path(task): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return auth_error(s),
    };
    let project: Option<Uuid> = sqlx::query_scalar("SELECT project_id FROM tasks WHERE id=$1")
        .bind(task)
        .fetch_optional(&state.pool)
        .await
        .unwrap_or(None);
    let Some(project) = project else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !matches!(
        crate::tasks::can_read(&state.pool, project, user).await,
        Ok(true)
    ) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match sqlx::query("SELECT a.id,a.name,a.value_type,v.value FROM project_attributes p JOIN attribute_schemas a ON a.id=p.attribute_id LEFT JOIN task_attribute_values v ON v.attribute_id=a.id AND v.task_id=$2 WHERE p.project_id=$1 AND a.archived_at IS NULL ORDER BY a.position").bind(project).bind(task).fetch_all(&state.pool).await {
        Ok(rows) => Json(json!({"attributes":rows.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"name":r.get::<String,_>("name"),"type":r.get::<String,_>("value_type"),"value":r.get::<Option<Value>,_>("value").unwrap_or(Value::Null)})).collect::<Vec<_>>()})).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Deserialize)]
struct AttributeValues {
    values: Vec<AttributeChange>,
    command_id: Option<Uuid>,
}
#[derive(Deserialize)]
struct AttributeChange {
    attribute_id: Uuid,
    value: Option<Value>,
    expected_version: Option<i64>,
}

#[derive(Deserialize)]
struct BulkAttributeValues {
    items: Vec<BulkAttributeItem>,
    attribute_id: Uuid,
    value: Option<Value>,
    command_id: Option<Uuid>,
}
#[derive(Deserialize)]
struct BulkAttributeItem {
    task_id: Uuid,
    expected_version: i64,
}

async fn update_task_attributes(
    State(state): State<AuthState>,
    Path(task): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<AttributeValues>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return auth_error(s),
    };
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let row = match sqlx::query("SELECT workspace_id,project_id,version,archived_at IS NOT NULL AS archived FROM tasks WHERE id=$1 FOR UPDATE").bind(task).fetch_optional(&mut *tx).await { Ok(Some(r)) => r, Ok(None) => return StatusCode::NOT_FOUND.into_response(), Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
    let workspace: Uuid = row.get("workspace_id");
    let project: Uuid = row.get("project_id");
    let version: i64 = row.get("version");
    if row.get::<bool, _>("archived")
        || !matches!(
            crate::tasks::can_write(&mut *tx, project, user).await,
            Ok(true)
        )
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    if input.values.is_empty()
        || input.values.iter().any(|v| {
            v.expected_version
                .is_some_and(|expected| expected != version)
        })
    {
        return StatusCode::CONFLICT.into_response();
    }
    let mut changes = Vec::new();
    for change in input.values {
        let def = match sqlx::query("SELECT a.value_type FROM attribute_schemas a JOIN project_attributes p ON p.attribute_id=a.id AND p.project_id=$2 WHERE a.id=$1 AND a.workspace_id=$3 AND a.archived_at IS NULL").bind(change.attribute_id).bind(project).bind(workspace).fetch_optional(&mut *tx).await { Ok(Some(r)) => r, _ => return StatusCode::UNPROCESSABLE_ENTITY.into_response() };
        let kind: String = def.get("value_type");
        let old: Option<Value> = match sqlx::query_scalar(
            "SELECT value FROM task_attribute_values WHERE task_id=$1 AND attribute_id=$2",
        )
        .bind(task)
        .bind(change.attribute_id)
        .fetch_optional(&mut *tx)
        .await
        {
            Ok(v) => v,
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        };
        let new = change.value.unwrap_or(Value::Null);
        if let Err(status) =
            validate_attribute(&mut tx, workspace, &kind, &new, change.attribute_id).await
        {
            return status.into_response();
        }
        let before = old.unwrap_or(Value::Null);
        if before != new {
            changes.push((change.attribute_id, before, new));
        }
    }
    if changes.is_empty() {
        let _ = tx.rollback().await;
        return Json(json!({"version":version,"group_id":null})).into_response();
    }
    let group = Uuid::new_v4();
    let command = input.command_id.unwrap_or_else(Uuid::new_v4);
    if sqlx::query("INSERT INTO task_operation_groups(id,command_id,workspace_id,actor_id) VALUES($1,$2,$3,$4)").bind(group).bind(command).bind(workspace).bind(user).execute(&mut *tx).await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
    if sqlx::query("UPDATE task_operation_groups SET state='suppressed' WHERE workspace_id=$1 AND actor_id=$2 AND state='undone'").bind(workspace).bind(user).execute(&mut *tx).await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
    for (attribute, before, after) in &changes {
        let stored = if after.is_null() {
            sqlx::query("DELETE FROM task_attribute_values WHERE task_id=$1 AND attribute_id=$2")
                .bind(task)
                .bind(attribute)
                .execute(&mut *tx)
                .await
        } else {
            sqlx::query("INSERT INTO task_attribute_values(workspace_id,task_id,attribute_id,value) VALUES($1,$2,$3,$4) ON CONFLICT(task_id,attribute_id) DO UPDATE SET value=EXCLUDED.value,updated_at=now()").bind(workspace).bind(task).bind(attribute).bind(after).execute(&mut *tx).await
        };
        if stored.is_err() {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        let field = format!("attribute/{attribute}");
        if sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(Uuid::new_v4()).bind(group).bind(task).bind(field).bind(before).bind(after).bind(version+1).execute(&mut *tx).await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
    }
    let new_version: i64 = match sqlx::query_scalar(
        "UPDATE tasks SET version=version+1,updated_at=now() WHERE id=$1 RETURNING version",
    )
    .bind(task)
    .fetch_one(&mut *tx)
    .await
    {
        Ok(v) => v,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    Json(json!({"version":new_version,"group_id":group})).into_response()
}

async fn bulk_update_task_attributes(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<BulkAttributeValues>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return auth_error(s),
    };
    if input.items.is_empty() {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let mut ids: Vec<Uuid> = input.items.iter().map(|i| i.task_id).collect();
    ids.sort();
    ids.dedup();
    if ids.len() != input.items.len() {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let mut changes = Vec::new();
    for item in input.items {
        let row = match sqlx::query("SELECT project_id,version,archived_at IS NOT NULL AS archived FROM tasks WHERE id=$1 AND workspace_id=$2 FOR UPDATE").bind(item.task_id).bind(workspace).fetch_optional(&mut *tx).await { Ok(Some(r)) => r, Ok(None) => return StatusCode::NOT_FOUND.into_response(), Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
        let project: Uuid = row.get("project_id");
        let version: i64 = row.get("version");
        if row.get::<bool, _>("archived") || version != item.expected_version {
            return StatusCode::CONFLICT.into_response();
        }
        if !matches!(
            crate::tasks::can_write(&mut *tx, project, user).await,
            Ok(true)
        ) {
            return StatusCode::NOT_FOUND.into_response();
        }
        let kind: Option<String> = sqlx::query_scalar("SELECT a.value_type FROM attribute_schemas a JOIN project_attributes p ON p.attribute_id=a.id AND p.project_id=$2 WHERE a.workspace_id=$1 AND a.id=$3 AND a.archived_at IS NULL").bind(workspace).bind(project).bind(input.attribute_id).fetch_optional(&mut *tx).await.unwrap_or(None);
        let Some(kind) = kind else {
            return StatusCode::UNPROCESSABLE_ENTITY.into_response();
        };
        let value = input.value.clone().unwrap_or(Value::Null);
        if validate_attribute(&mut tx, workspace, &kind, &value, input.attribute_id)
            .await
            .is_err()
        {
            return StatusCode::UNPROCESSABLE_ENTITY.into_response();
        }
        let before: Option<Value> = match sqlx::query_scalar(
            "SELECT value FROM task_attribute_values WHERE task_id=$1 AND attribute_id=$2",
        )
        .bind(item.task_id)
        .bind(input.attribute_id)
        .fetch_optional(&mut *tx)
        .await
        {
            Ok(v) => v,
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        };
        let before = before.unwrap_or(Value::Null);
        if before != value {
            changes.push((item.task_id, version, before, value));
        }
    }
    if changes.is_empty() {
        let _ = tx.rollback().await;
        return Json(json!({"group_id":null,"tasks":[]})).into_response();
    }
    let group = Uuid::new_v4();
    if sqlx::query("INSERT INTO task_operation_groups(id,command_id,workspace_id,actor_id) VALUES($1,$2,$3,$4)").bind(group).bind(input.command_id.unwrap_or_else(Uuid::new_v4)).bind(workspace).bind(user).execute(&mut *tx).await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
    if sqlx::query("UPDATE task_operation_groups SET state='suppressed' WHERE workspace_id=$1 AND actor_id=$2 AND state='undone'").bind(workspace).bind(user).execute(&mut *tx).await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
    let mut changed = Vec::new();
    for (task, version, before, after) in changes {
        if after.is_null() { if sqlx::query("DELETE FROM task_attribute_values WHERE task_id=$1 AND attribute_id=$2").bind(task).bind(input.attribute_id).execute(&mut *tx).await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); } }
        else if sqlx::query("INSERT INTO task_attribute_values(workspace_id,task_id,attribute_id,value) VALUES($1,$2,$3,$4) ON CONFLICT(task_id,attribute_id) DO UPDATE SET value=EXCLUDED.value,updated_at=now()").bind(workspace).bind(task).bind(input.attribute_id).bind(&after).execute(&mut *tx).await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
        let next_version: i64 = match sqlx::query_scalar("UPDATE tasks SET version=version+1,updated_at=now() WHERE id=$1 AND version=$2 RETURNING version").bind(task).bind(version).fetch_one(&mut *tx).await { Ok(v) => v, Err(_) => return StatusCode::CONFLICT.into_response() };
        if sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(Uuid::new_v4()).bind(group).bind(task).bind(format!("attribute/{}",input.attribute_id)).bind(before).bind(after).bind(next_version).execute(&mut *tx).await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
        changed.push(task);
    }
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    Json(json!({"group_id":group,"tasks":changed})).into_response()
}

pub(crate) async fn validate_attribute(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace: Uuid,
    kind: &str,
    value: &Value,
    attribute: Uuid,
) -> Result<(), StatusCode> {
    if value.is_null() {
        return Ok(());
    }
    let valid = match kind {
        "text" => value.is_string(),
        "number" => value.as_f64().is_some(),
        "date" => {
            if let Some(date) = value.as_str().filter(|date| {
                date.len() == 10
                    && date.bytes().enumerate().all(|(i, b)| {
                        if i == 4 || i == 7 {
                            b == b'-'
                        } else {
                            b.is_ascii_digit()
                        }
                    })
            }) {
                sqlx::query_scalar::<_, String>("SELECT $1::date::text")
                    .bind(date)
                    .fetch_optional(&mut **tx)
                    .await
                    .ok()
                    .flatten()
                    .is_some()
            } else {
                false
            }
        }
        "user" => {
            if let Some(id) = value.as_str().and_then(|s| s.parse::<Uuid>().ok()) {
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2)").bind(workspace).bind(id).fetch_one(&mut **tx).await.unwrap_or(false)
            } else {
                false
            }
        }
        "single_select" => {
            if let Some(key) = value.as_str() {
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM attribute_options WHERE attribute_id=$1 AND option_key=$2 AND archived_at IS NULL)").bind(attribute).bind(key).fetch_one(&mut **tx).await.unwrap_or(false)
            } else {
                false
            }
        }
        "multi_select" => {
            if let Some(keys) = value.as_array().filter(|keys| keys.len() <= 100) {
                let mut valid = true;
                for key in keys {
                    let Some(key) = key.as_str() else {
                        valid = false;
                        break;
                    };
                    let found: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM attribute_options WHERE attribute_id=$1 AND option_key=$2 AND archived_at IS NULL)").bind(attribute).bind(key).fetch_one(&mut **tx).await.unwrap_or(false);
                    if !found {
                        valid = false;
                        break;
                    }
                }
                valid
            } else {
                false
            }
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(StatusCode::UNPROCESSABLE_ENTITY)
    }
}
