use axum::{
    extract::{Path, Query, State},
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
            "/tasks/:task_id/comments",
            get(list_comments).post(create_comment),
        )
        .route(
            "/tasks/:task_id/comments/:comment_id",
            axum::routing::patch(edit_comment).delete(delete_comment),
        )
        .route("/tasks/:task_id/attachments", post(create_attachment))
        .route("/workspaces/:workspace_id/search", get(search))
        .route("/workspaces/:workspace_id/export", get(export_workspace))
}

#[derive(Deserialize)]
struct CommentInput {
    request_id: Uuid,
    body: String,
}
#[derive(Deserialize)]
struct EditComment {
    body: String,
}

#[derive(Deserialize)]
struct AttachmentInput {
    file_name: String,
    content_type: String,
    content_hex: String,
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    if !value.len().is_multiple_of(2) {
        return None;
    }
    value
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            let digit = |byte: u8| match byte {
                b'0'..=b'9' => Some(byte - b'0'),
                b'a'..=b'f' => Some(byte - b'a' + 10),
                b'A'..=b'F' => Some(byte - b'A' + 10),
                _ => None,
            };
            Some(digit(pair[0])? * 16 + digit(pair[1])?)
        })
        .collect()
}

async fn create_attachment(
    State(state): State<AuthState>,
    Path(task): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<AttachmentInput>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let file_name = input.file_name.trim();
    let content_type = input.content_type.trim();
    let Some(content) = decode_hex(&input.content_hex) else {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    };
    if file_name.is_empty()
        || file_name.len() > 255
        || file_name.contains('/')
        || file_name.contains('\\')
        || file_name.chars().any(char::is_control)
        || content_type.is_empty()
        || content_type.len() > 255
        || content.len() > 10 * 1024 * 1024
    {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    if !matches!(
        task_access(&state.pool, task, user, true).await,
        Ok(Some(_))
    ) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let result = sqlx::query("INSERT INTO task_attachments(id,workspace_id,task_id,uploaded_by,file_name,content_type,content) SELECT $1,workspace_id,id,$2,$3,$4,$5 FROM tasks WHERE id=$6 RETURNING id,task_id,file_name,content_type,octet_length(content) AS size,created_at::text AS created_at")
        .bind(Uuid::new_v4()).bind(user).bind(file_name).bind(content_type).bind(content).bind(task)
        .fetch_optional(&state.pool).await;
    match result {
        Ok(Some(row)) => (
            StatusCode::CREATED,
            Json(json!({"id":row.get::<Uuid,_>("id"),"task_id":row.get::<Uuid,_>("task_id"),"file_name":row.get::<String,_>("file_name"),"content_type":row.get::<String,_>("content_type"),"size":row.get::<i32,_>("size"),"created_at":row.get::<String,_>("created_at")})),
        )
            .into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

fn comment_json(row: &sqlx::postgres::PgRow) -> Value {
    json!({"id":row.get::<Uuid,_>("id"),"task_id":row.get::<Uuid,_>("task_id"),"author_id":row.get::<Uuid,_>("author_id"),"body":row.get::<String,_>("body"),"edited":row.get::<Option<String>,_>("edited_at").is_some(),"created_at":row.get::<String,_>("created_at"),"edited_at":row.get::<Option<String>,_>("edited_at")})
}

async fn task_access(
    pool: &PgPool,
    task: Uuid,
    user: Uuid,
    write: bool,
) -> Result<Option<Uuid>, sqlx::Error> {
    let project: Option<(Uuid,)> =
        sqlx::query_as("SELECT project_id FROM tasks WHERE id=$1 AND archived_at IS NULL")
            .bind(task)
            .fetch_optional(pool)
            .await?;
    let Some((project,)) = project else {
        return Ok(None);
    };
    let allowed = matches!(evaluate_access(pool, project, user).await?, Some(access) if access.role >= if write { Role::Contributor } else { Role::Viewer });
    Ok(allowed.then_some(project))
}

async fn list_comments(
    State(state): State<AuthState>,
    Path(task): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    match task_access(&state.pool,task,user,false).await {
        Ok(Some(_)) => match sqlx::query("SELECT id,task_id,author_id,body,edited_at::text AS edited_at,created_at::text AS created_at FROM task_comments WHERE task_id=$1 AND deleted_at IS NULL ORDER BY created_at,id").bind(task).fetch_all(&state.pool).await {
            Ok(rows)=>Json(json!({"comments":rows.iter().map(comment_json).collect::<Vec<_>>()})).into_response(), Err(_)=>StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }, Ok(None)=>StatusCode::NOT_FOUND.into_response(), Err(_)=>StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }
}

async fn create_comment(
    State(state): State<AuthState>,
    Path(task): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<CommentInput>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    if input.body.trim().is_empty() || input.body.len() > 20_000 {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    if !matches!(
        task_access(&state.pool, task, user, true).await,
        Ok(Some(_))
    ) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let row=sqlx::query("INSERT INTO task_comments(id,workspace_id,task_id,author_id,request_id,body) SELECT $1,t.workspace_id,t.id,$2,$3,$4 FROM tasks t WHERE t.id=$5 ON CONFLICT(task_id,author_id,request_id) DO UPDATE SET request_id=EXCLUDED.request_id RETURNING id,task_id,author_id,body,edited_at::text AS edited_at,created_at::text AS created_at,(xmax=0) AS inserted")
        .bind(Uuid::new_v4()).bind(user).bind(input.request_id).bind(&input.body).bind(task).fetch_optional(&state.pool).await;
    match row {
        Ok(Some(row)) if row.get::<String, _>("body") == input.body => {
            let status = if row.get::<bool, _>("inserted") {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            };
            (status, Json(comment_json(&row))).into_response()
        }
        Ok(Some(_)) => StatusCode::CONFLICT.into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn edit_comment(
    State(state): State<AuthState>,
    Path((task, comment)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(input): Json<EditComment>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    if input.body.trim().is_empty() || input.body.len() > 20_000 {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    if !matches!(
        task_access(&state.pool, task, user, true).await,
        Ok(Some(_))
    ) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let row=sqlx::query("UPDATE task_comments SET body=$3,edited_at=now() WHERE id=$1 AND task_id=$2 AND author_id=$4 AND deleted_at IS NULL RETURNING id,task_id,author_id,body,edited_at::text AS edited_at,created_at::text AS created_at").bind(comment).bind(task).bind(input.body).bind(user).fetch_optional(&state.pool).await;
    match row {
        Ok(Some(row)) => Json(comment_json(&row)).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn delete_comment(
    State(state): State<AuthState>,
    Path((task, comment)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    if !matches!(
        task_access(&state.pool, task, user, true).await,
        Ok(Some(_))
    ) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match sqlx::query("UPDATE task_comments SET deleted_at=now() WHERE id=$1 AND task_id=$2 AND deleted_at IS NULL").bind(comment).bind(task).execute(&state.pool).await {
        Ok(r) if r.rows_affected()==1=>StatusCode::NO_CONTENT.into_response(),Ok(_)=>StatusCode::NOT_FOUND.into_response(),Err(_)=>StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }
}

#[derive(Deserialize)]
struct SearchParams {
    q: String,
    page: Option<u32>,
    limit: Option<u32>,
}

async fn search(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    Query(params): Query<SearchParams>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let page = params.page.unwrap_or(1);
    let limit = params.limit.unwrap_or(20);
    if params.q.trim().chars().count() < 1
        || params.q.chars().count() > 100
        || page == 0
        || page > 10_000
        || limit == 0
        || limit > 50
    {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let pattern = format!(
        "%{}%",
        params
            .q
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let condition="(t.number::text=$2 OR t.title ILIKE $3 ESCAPE E'\\\\' OR t.description ILIKE $3 ESCAPE E'\\\\' OR EXISTS(SELECT 1 FROM task_comments c WHERE c.task_id=t.id AND c.deleted_at IS NULL AND c.body ILIKE $3 ESCAPE E'\\\\') OR EXISTS(SELECT 1 FROM task_attribute_values av WHERE av.task_id=t.id AND av.value::text ILIKE $3 ESCAPE E'\\\\'))";
    let acl="EXISTS(SELECT 1 FROM workspace_memberships wm WHERE wm.workspace_id=t.workspace_id AND wm.user_id=$4) AND (p.visibility='workspace' OR EXISTS(SELECT 1 FROM project_memberships pm WHERE pm.project_id=p.id AND pm.user_id=$4 AND pm.role IN ('viewer','contributor','manager')) OR EXISTS(SELECT 1 FROM project_team_memberships pt JOIN team_memberships tm ON tm.team_id=pt.team_id WHERE pt.project_id=p.id AND tm.user_id=$4 AND pt.role IN ('viewer','contributor','manager')))";
    let sql=format!("SELECT t.id,t.number,t.title,t.description,p.id AS project_id,COALESCE((SELECT left(c.body,240) FROM task_comments c WHERE c.task_id=t.id AND c.deleted_at IS NULL AND c.body ILIKE $3 ESCAPE E'\\\\' ORDER BY c.created_at LIMIT 1),left(t.description,240)) AS snippet FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.workspace_id=$1 AND t.archived_at IS NULL AND p.archived_at IS NULL AND {acl} AND {condition} ORDER BY t.number LIMIT $5 OFFSET $6");
    let count_sql=format!("SELECT count(*)::bigint FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.workspace_id=$1 AND t.archived_at IS NULL AND p.archived_at IS NULL AND {acl} AND {condition}");
    let rows = match sqlx::query(&sql)
        .bind(workspace)
        .bind(&params.q)
        .bind(&pattern)
        .bind(user)
        .bind(i64::from(limit))
        .bind(i64::from(page - 1) * i64::from(limit))
        .fetch_all(&state.pool)
        .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, "task search query failed");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let count = match sqlx::query_scalar::<_, i64>(&count_sql)
        .bind(workspace)
        .bind(&params.q)
        .bind(&pattern)
        .bind(user)
        .fetch_one(&state.pool)
        .await
    {
        Ok(count) => count,
        Err(error) => {
            tracing::error!(%error, "task search count query failed");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    Json(json!({"page":page,"limit":limit,"count":count,"results":rows.iter().map(|r|json!({"task_id":r.get::<Uuid,_>("id"),"task_number":r.get::<i64,_>("number"),"title":r.get::<String,_>("title"),"snippet":r.get::<String,_>("snippet"),"project_id":r.get::<Uuid,_>("project_id")})).collect::<Vec<_>>()})).into_response()
}

async fn export_workspace(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let role = sqlx::query_scalar::<_, String>(
        "SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2",
    )
    .bind(workspace)
    .bind(user)
    .fetch_optional(&state.pool)
    .await;
    if !matches!(role,Ok(Some(ref r)) if r=="owner" || r=="admin") {
        return StatusCode::FORBIDDEN.into_response();
    }
    let result = build_export(&state.pool, workspace).await;
    match result {
        Ok(value) => Json(value).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn build_export(pool: &PgPool, workspace: Uuid) -> Result<Value, sqlx::Error> {
    let workspace_row =
        sqlx::query("SELECT id,name,created_at::text AS created_at FROM workspaces WHERE id=$1")
            .bind(workspace)
            .fetch_optional(pool)
            .await?;
    let Some(w) = workspace_row else {
        return Ok(json!({"schema_version":"1.0","workspace":null}));
    };
    let projects=sqlx::query("SELECT id,name,visibility,created_at::text AS created_at FROM projects WHERE workspace_id=$1 ORDER BY id").bind(workspace).fetch_all(pool).await?;
    let tasks=sqlx::query("SELECT id,number,project_id,parent_task_id,title,description,status,priority,start_date::text AS start_date,due_date::text AS due_date,version,created_at::text AS created_at,updated_at::text AS updated_at,archived_at::text AS archived_at FROM tasks WHERE workspace_id=$1 ORDER BY number").bind(workspace).fetch_all(pool).await?;
    let comments=sqlx::query("SELECT id,task_id,author_id,request_id,body,created_at::text AS created_at,edited_at::text AS edited_at,deleted_at::text AS deleted_at FROM task_comments WHERE workspace_id=$1 ORDER BY created_at,id").bind(workspace).fetch_all(pool).await?;
    let attachments=sqlx::query("SELECT id,task_id,uploaded_by,file_name,content_type,encode(content,'hex') AS content_hex,created_at::text AS created_at FROM task_attachments WHERE workspace_id=$1 ORDER BY id").bind(workspace).fetch_all(pool).await?;
    let attributes=sqlx::query("SELECT id,name,value_type,position,archived_at::text AS archived_at FROM attribute_schemas WHERE workspace_id=$1 ORDER BY position,id").bind(workspace).fetch_all(pool).await?;
    let values=sqlx::query("SELECT task_id,attribute_id,value FROM task_attribute_values WHERE workspace_id=$1 ORDER BY task_id,attribute_id").bind(workspace).fetch_all(pool).await?;
    Ok(
        json!({"schema_version":"1.0","workspace":{"id":w.get::<Uuid,_>("id"),"name":w.get::<String,_>("name"),"created_at":w.get::<String,_>("created_at")},"projects":projects.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"name":r.get::<String,_>("name"),"visibility":r.get::<String,_>("visibility"),"created_at":r.get::<String,_>("created_at")})).collect::<Vec<_>>(),"tasks":tasks.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"number":r.get::<i64,_>("number"),"project_id":r.get::<Uuid,_>("project_id"),"parent_task_id":r.get::<Option<Uuid>,_>("parent_task_id"),"title":r.get::<String,_>("title"),"description":r.get::<String,_>("description"),"status":r.get::<String,_>("status"),"priority":r.get::<String,_>("priority"),"start_date":r.get::<Option<String>,_>("start_date"),"due_date":r.get::<Option<String>,_>("due_date"),"version":r.get::<i64,_>("version"),"created_at":r.get::<String,_>("created_at"),"updated_at":r.get::<String,_>("updated_at"),"archived_at":r.get::<Option<String>,_>("archived_at")})).collect::<Vec<_>>(),"comments":comments.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"task_id":r.get::<Uuid,_>("task_id"),"author_id":r.get::<Uuid,_>("author_id"),"request_id":r.get::<Uuid,_>("request_id"),"body":r.get::<String,_>("body"),"created_at":r.get::<String,_>("created_at"),"edited_at":r.get::<Option<String>,_>("edited_at"),"deleted_at":r.get::<Option<String>,_>("deleted_at")})).collect::<Vec<_>>(),"attributes":attributes.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"name":r.get::<String,_>("name"),"type":r.get::<String,_>("value_type"),"position":r.get::<i32,_>("position"),"archived_at":r.get::<Option<String>,_>("archived_at")})).collect::<Vec<_>>(),"attribute_values":values.iter().map(|r|json!({"task_id":r.get::<Uuid,_>("task_id"),"attribute_id":r.get::<Uuid,_>("attribute_id"),"value":r.get::<Value,_>("value")})).collect::<Vec<_>>(),"attachments":attachments.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"task_id":r.get::<Uuid,_>("task_id"),"uploaded_by":r.get::<Uuid,_>("uploaded_by"),"file_name":r.get::<String,_>("file_name"),"content_type":r.get::<String,_>("content_type"),"content_hex":r.get::<String,_>("content_hex"),"created_at":r.get::<String,_>("created_at")})).collect::<Vec<_>>()}),
    )
}
