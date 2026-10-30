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
        .route(
            "/tasks/:task_id/comments/:comment_id/create-task",
            post(create_task_from_comment),
        )
        .route(
            "/tasks/:task_id/comments/:comment_id/reactions",
            post(add_reaction).delete(remove_reaction),
        )
        .route(
            "/workspaces/:workspace_id/mention-suggestions",
            get(mention_suggestions),
        )
        .route("/tasks/:task_id/activity", get(task_activity))
        // Content travels hex-encoded in JSON, so the body is twice the file: 10 MiB file => 20 MiB.
        .route(
            "/tasks/:task_id/attachments",
            post(create_attachment).layer(axum::extract::DefaultBodyLimit::max(21 * 1024 * 1024)),
        )
        .route("/workspaces/:workspace_id/search", get(search))
        .route("/tasks/:task_id/references", get(backlinks))
        .route(
            "/workspaces/:workspace_id/task-reference-suggestions",
            get(reference_suggestions),
        )
        .route("/workspaces/:workspace_id/export", get(export_workspace))
}

#[derive(Deserialize)]
struct CommentInput {
    request_id: Uuid,
    body: String,
    reply_to: Option<Uuid>,
}
#[derive(Deserialize)]
struct EditComment {
    body: String,
}
#[derive(Deserialize)]
struct CreateTaskFromComment {
    project_id: Uuid,
    title: String,
    description: String,
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

async fn comment_json(
    pool: &PgPool,
    row: &sqlx::postgres::PgRow,
    viewer: Uuid,
) -> Result<Value, sqlx::Error> {
    let body = row.get::<String, _>("body");
    let html = crate::task_reference_text::render_markdown(
        pool,
        row.get("workspace_id"),
        row.get("task_id"),
        "comment",
        Some(row.get("id")),
        Some(viewer),
        &body,
    )
    .await?;
    let id: Uuid = row.get("id");
    let safe_body = crate::note_reference_text::safe_body(
        pool,
        "comment",
        row.get("task_id"),
        Some(id),
        Some(viewer),
        &body,
    )
    .await?;
    let attachments = crate::comment_attachments::for_comment(pool, id).await?;
    let reactions = sqlx::query("SELECT emoji,count(*)::int AS count,bool_or(user_id=$2) AS reacted FROM task_comment_reactions WHERE comment_id=$1 GROUP BY emoji ORDER BY emoji")
        .bind(id).bind(viewer).fetch_all(pool).await?;
    let mentions = sqlx::query_scalar::<_, Uuid>(
        "SELECT recipient_id FROM task_comment_mentions WHERE comment_id=$1 ORDER BY recipient_id",
    )
    .bind(id)
    .fetch_all(pool)
    .await?;
    let reply_to = row
        .try_get::<Option<Uuid>, _>("reply_to_comment_id")
        .unwrap_or(None);
    let quote = if let Some(parent) = reply_to {
        sqlx::query("SELECT id,task_id,body FROM task_comments WHERE id=$1 AND deleted_at IS NULL")
            .bind(parent)
            .fetch_optional(pool)
            .await?
            .map(|r| {
                (
                    r.get::<Uuid, _>("id"),
                    r.get::<Uuid, _>("task_id"),
                    r.get::<String, _>("body"),
                )
            })
    } else {
        None
    };
    let quote = if let Some((quote_id, quote_task, quote_body)) = quote {
        let safe_quote = crate::note_reference_text::safe_body(
            pool,
            "comment",
            quote_task,
            Some(quote_id),
            Some(viewer),
            &quote_body,
        )
        .await?;
        Some(json!({"id":quote_id,"body":safe_quote}))
    } else {
        None
    };
    let linked = sqlx::query("SELECT t.id,t.number,t.title,p.id AS project_id FROM task_comment_created_tasks r JOIN tasks t ON t.id=r.task_id JOIN projects p ON p.id=t.project_id WHERE r.source_comment_id=$1 AND t.archived_at IS NULL AND p.archived_at IS NULL ORDER BY t.number")
        .bind(id).fetch_all(pool).await?;
    let mut created_tasks = Vec::new();
    for task in linked {
        if matches!(evaluate_access(pool, task.get("project_id"), viewer).await?, Some(access) if access.role >= Role::Viewer)
        {
            created_tasks.push(json!({"id":task.get::<Uuid,_>("id"),"number":task.get::<i64,_>("number"),"title":task.get::<String,_>("title")}));
        }
    }
    Ok(
        json!({"id":id,"task_id":row.get::<Uuid,_>("task_id"),"author_id":row.get::<Uuid,_>("author_id"),"body":safe_body,"html":html,"attachments":attachments,"edited":row.get::<Option<String>,_>("edited_at").is_some(),"created_at":row.get::<String,_>("created_at"),"edited_at":row.get::<Option<String>,_>("edited_at"),"reply_to":reply_to,"quote":quote,"mentions":mentions,"reactions":reactions.iter().map(|r|json!({"emoji":r.get::<String,_>("emoji"),"count":r.get::<i32,_>("count"),"reacted":r.get::<bool,_>("reacted")})).collect::<Vec<_>>(),"created_tasks":created_tasks}),
    )
}

async fn create_task_from_comment(
    State(state): State<AuthState>,
    Path((source_task, comment)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(input): Json<CreateTaskFromComment>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let source_project = match task_access(&state.pool, source_task, user, true).await {
        Ok(Some(project)) => project,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if input.title.trim().is_empty() || input.title.len() > 255 || input.description.len() > 20_000
    {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    match evaluate_access(&state.pool, input.project_id, user).await {
        Ok(Some(access)) if access.role >= Role::Contributor => {}
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let source = sqlx::query("SELECT c.workspace_id,t.project_id,t.number FROM task_comments c JOIN tasks t ON t.id=c.task_id WHERE c.id=$1 AND c.task_id=$2 AND c.deleted_at IS NULL FOR UPDATE OF c")
        .bind(comment).bind(source_task).fetch_optional(&mut *tx).await;
    let source = match source {
        Ok(Some(row)) if row.get::<Uuid, _>("project_id") == source_project => row,
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let workspace: Uuid = source.get("workspace_id");
    let project_workspace: Option<Uuid> =
        sqlx::query_scalar("SELECT workspace_id FROM projects WHERE id=$1 AND archived_at IS NULL")
            .bind(input.project_id)
            .fetch_optional(&mut *tx)
            .await
            .unwrap_or(None);
    if project_workspace != Some(workspace) {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let number: i64 = match sqlx::query_scalar("UPDATE workspaces SET next_task_number=next_task_number+1 WHERE id=$1 RETURNING next_task_number-1")
        .bind(workspace).fetch_optional(&mut *tx).await {
            Ok(Some(number)) => number,
            _ => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        };
    let id = Uuid::new_v4();
    if sqlx::query("INSERT INTO tasks(id,workspace_id,number,project_id,title,description,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)")
        .bind(id).bind(workspace).bind(number).bind(input.project_id).bind(input.title.trim()).bind(&input.description).bind(user).execute(&mut *tx).await.is_err() {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    if resolve_task_description_mentions(&mut tx, id, &input.description)
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let group = Uuid::new_v4();
    if sqlx::query("INSERT INTO task_operation_groups(id,command_id,workspace_id,actor_id) VALUES($1,$2,$3,$4)")
        .bind(group).bind(Uuid::new_v4()).bind(workspace).bind(user).execute(&mut *tx).await.is_err()
        || sqlx::query("UPDATE task_operation_groups SET state='suppressed' WHERE workspace_id=$1 AND actor_id=$2 AND state='undone'")
            .bind(workspace).bind(user).execute(&mut *tx).await.is_err()
        || sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,'archived','true'::jsonb,'false'::jsonb,1)")
            .bind(Uuid::new_v4()).bind(group).bind(id).execute(&mut *tx).await.is_err()
        || crate::task_reference_text::replace_index(&mut tx, workspace, id, "task_description", None, user, &input.description).await.is_err()
        || sqlx::query("INSERT INTO task_comment_created_tasks(workspace_id,task_id,source_task_id,source_comment_id) VALUES($1,$2,$3,$4)")
            .bind(workspace).bind(id).bind(source_task).bind(comment).execute(&mut *tx).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    match crate::tasks::task_row(&state.pool, workspace, number, false).await {
        Ok(Some(row)) => match crate::tasks::serialize_task(&state.pool, &row, Some(user)).await {
            Ok(mut task) => {
                let source_visible = matches!(evaluate_access(&state.pool, source_project, user).await, Ok(Some(access)) if access.role >= Role::Viewer);
                task["created_from"] = if source_visible {
                    json!({"task_id":source_task,"task_number":source.get::<i64,_>("number"),"comment_id":comment})
                } else {
                    Value::Null
                };
                (StatusCode::CREATED, Json(task)).into_response()
            }
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        },
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

fn mention_tokens(body: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut active = false;
    for ch in body.chars().chain(std::iter::once(' ')) {
        if active && (ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '@' | ':')) {
            current.push(ch);
        } else {
            if active && !current.is_empty() {
                tokens.push(current.to_lowercase());
            }
            current.clear();
            active = ch == '@';
        }
    }
    tokens.sort();
    tokens.dedup();
    // Each token costs queries inside the writing transaction.
    tokens.truncate(MAX_MENTION_TOKENS);
    tokens
}

const MAX_MENTION_TOKENS: usize = 50;

async fn resolve_task_description_mentions(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    task: Uuid,
    body: &str,
) -> Result<(), sqlx::Error> {
    for token in mention_tokens(body) {
        let rows = if let Some(team_name) = token.strip_prefix("team:") {
            sqlx::query("SELECT wm.user_id FROM tasks t JOIN projects p ON p.id=t.project_id JOIN teams tm ON tm.workspace_id=t.workspace_id AND lower(replace(tm.name,' ','-'))=$2 JOIN team_memberships team ON team.team_id=tm.id AND team.workspace_id=t.workspace_id JOIN workspace_memberships wm ON wm.workspace_id=t.workspace_id AND wm.user_id=team.user_id WHERE t.id=$1 AND (p.visibility='workspace' OR EXISTS(SELECT 1 FROM project_memberships pm WHERE pm.project_id=p.id AND pm.user_id=wm.user_id AND pm.role IN ('viewer','contributor','manager')) OR EXISTS(SELECT 1 FROM project_team_memberships pt JOIN team_memberships tm2 ON tm2.team_id=pt.team_id WHERE pt.project_id=p.id AND tm2.user_id=wm.user_id AND pt.role IN ('viewer','contributor','manager'))) ORDER BY wm.user_id")
                .bind(task).bind(team_name).fetch_all(&mut **tx).await?
        } else {
            sqlx::query("SELECT wm.user_id FROM tasks t JOIN projects p ON p.id=t.project_id JOIN users u ON lower(u.email)=$2 JOIN workspace_memberships wm ON wm.workspace_id=t.workspace_id AND wm.user_id=u.id WHERE t.id=$1 AND (p.visibility='workspace' OR EXISTS(SELECT 1 FROM project_memberships pm WHERE pm.project_id=p.id AND pm.user_id=u.id AND pm.role IN ('viewer','contributor','manager')) OR EXISTS(SELECT 1 FROM project_team_memberships pt JOIN team_memberships tm ON tm.team_id=pt.team_id WHERE pt.project_id=p.id AND tm.user_id=u.id AND pt.role IN ('viewer','contributor','manager')))")
                .bind(task).bind(&token).fetch_all(&mut **tx).await?
        };
        for row in rows {
            sqlx::query("INSERT INTO task_description_mentions(workspace_id,task_id,recipient_id,mention_key) SELECT workspace_id,id,$2,$3 FROM tasks WHERE id=$1 ON CONFLICT DO NOTHING")
                .bind(task).bind(row.get::<Uuid,_>("user_id")).bind(&token).execute(&mut **tx).await?;
        }
    }
    Ok(())
}

async fn resolve_mentions(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    task: Uuid,
    comment: Uuid,
    body: &str,
) -> Result<(), sqlx::Error> {
    for token in mention_tokens(body) {
        let rows = if let Some(team_name) = token.strip_prefix("team:") {
            sqlx::query("SELECT wm.user_id FROM tasks t JOIN projects p ON p.id=t.project_id JOIN teams tm ON tm.workspace_id=t.workspace_id AND lower(replace(tm.name,' ','-'))=$2 JOIN team_memberships team ON team.team_id=tm.id AND team.workspace_id=t.workspace_id JOIN workspace_memberships wm ON wm.workspace_id=t.workspace_id AND wm.user_id=team.user_id WHERE t.id=$1 AND (p.visibility='workspace' OR EXISTS(SELECT 1 FROM project_memberships pm WHERE pm.project_id=p.id AND pm.user_id=wm.user_id AND pm.role IN ('viewer','contributor','manager')) OR EXISTS(SELECT 1 FROM project_team_memberships pt JOIN team_memberships tm2 ON tm2.team_id=pt.team_id WHERE pt.project_id=p.id AND tm2.user_id=wm.user_id AND pt.role IN ('viewer','contributor','manager'))) ORDER BY wm.user_id")
                .bind(task).bind(team_name).fetch_all(&mut **tx).await?
        } else {
            sqlx::query("SELECT wm.user_id FROM tasks t JOIN projects p ON p.id=t.project_id JOIN users u ON lower(u.email)=$2 JOIN workspace_memberships wm ON wm.workspace_id=t.workspace_id AND wm.user_id=u.id WHERE t.id=$1 AND (p.visibility='workspace' OR EXISTS(SELECT 1 FROM project_memberships pm WHERE pm.project_id=p.id AND pm.user_id=u.id AND pm.role IN ('viewer','contributor','manager')) OR EXISTS(SELECT 1 FROM project_team_memberships pt JOIN team_memberships tm ON tm.team_id=pt.team_id WHERE pt.project_id=p.id AND tm.user_id=u.id AND pt.role IN ('viewer','contributor','manager')))")
                .bind(task).bind(&token).fetch_all(&mut **tx).await?
        };
        for row in rows {
            sqlx::query("INSERT INTO task_comment_mentions(workspace_id,task_id,comment_id,recipient_id,mention_key) SELECT workspace_id,id,$2,$3,$4 FROM tasks WHERE id=$1 ON CONFLICT DO NOTHING")
                .bind(task).bind(comment).bind(row.get::<Uuid,_>("user_id")).bind(&token).execute(&mut **tx).await?;
        }
    }
    Ok(())
}

async fn replace_comment_references(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace: Uuid,
    task: Uuid,
    comment: Uuid,
    actor: Uuid,
    body: &str,
) -> Result<(), sqlx::Error> {
    crate::task_reference_text::replace_index(
        tx,
        workspace,
        task,
        "comment",
        Some(comment),
        actor,
        body,
    )
    .await?;
    crate::note_reference_text::replace_index(
        tx,
        workspace,
        task,
        "comment",
        Some(comment),
        actor,
        body,
    )
    .await
}

#[derive(Deserialize)]
struct ReferenceQuery {
    q: String,
}

async fn reference_suggestions(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    Query(query): Query<ReferenceQuery>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    if query.q.len() > 100 {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let pattern = format!("%{}%", query.q.replace('%', "\\%").replace('_', "\\_"));
    let rows = sqlx::query("SELECT t.id,t.number,t.title,t.status FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.workspace_id=$1 AND t.archived_at IS NULL AND p.archived_at IS NULL AND (t.number::text=$2 OR t.title ILIKE $3 ESCAPE E'\\\\') AND EXISTS(SELECT 1 FROM workspace_memberships wm WHERE wm.workspace_id=t.workspace_id AND wm.user_id=$4) AND (p.visibility='workspace' OR EXISTS(SELECT 1 FROM project_memberships pm WHERE pm.project_id=p.id AND pm.user_id=$4 AND pm.role IN ('viewer','contributor','manager')) OR EXISTS(SELECT 1 FROM project_team_memberships pt JOIN team_memberships tm ON tm.team_id=pt.team_id WHERE pt.project_id=p.id AND tm.user_id=$4 AND pt.role IN ('viewer','contributor','manager'))) ORDER BY t.number LIMIT 10")
        .bind(workspace).bind(&query.q).bind(pattern).bind(user).fetch_all(&state.pool).await;
    match rows { Ok(rows)=>Json(json!({"results":rows.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"number":r.get::<i64,_>("number"),"title":r.get::<String,_>("title"),"status":r.get::<String,_>("status")})).collect::<Vec<_>>()})).into_response(), Err(_)=>StatusCode::INTERNAL_SERVER_ERROR.into_response() }
}

async fn backlinks(
    State(state): State<AuthState>,
    Path(task): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    if !matches!(
        task_access(&state.pool, task, user, false).await,
        Ok(Some(_))
    ) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let rows = sqlx::query("SELECT r.source_kind,r.source_task_id,r.source_comment_id,r.position,st.number,st.title,c.body FROM task_references r JOIN tasks st ON st.id=r.source_task_id JOIN projects sp ON sp.id=st.project_id LEFT JOIN task_comments c ON c.id=r.source_comment_id WHERE r.target_task_id=$1 AND st.archived_at IS NULL AND sp.archived_at IS NULL AND (r.source_comment_id IS NULL OR c.deleted_at IS NULL) AND EXISTS(SELECT 1 FROM workspace_memberships wm WHERE wm.workspace_id=st.workspace_id AND wm.user_id=$2) AND (sp.visibility='workspace' OR EXISTS(SELECT 1 FROM project_memberships pm WHERE pm.project_id=sp.id AND pm.user_id=$2 AND pm.role IN ('viewer','contributor','manager')) OR EXISTS(SELECT 1 FROM project_team_memberships pt JOIN team_memberships tm ON tm.team_id=pt.team_id WHERE pt.project_id=sp.id AND tm.user_id=$2 AND pt.role IN ('viewer','contributor','manager'))) ORDER BY st.number,r.position").bind(task).bind(user).fetch_all(&state.pool).await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let mut references = Vec::with_capacity(rows.len());
    for r in &rows {
        let comment = r.get::<Option<Uuid>, _>("source_comment_id");
        let snippet = match r.get::<Option<String>, _>("body") {
            Some(body) => {
                let safe = match crate::note_reference_text::safe_body(
                    &state.pool,
                    "comment",
                    r.get("source_task_id"),
                    comment,
                    Some(user),
                    &body,
                )
                .await
                {
                    Ok(safe) => safe,
                    Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                };
                Some(safe.chars().take(160).collect::<String>())
            }
            None => None,
        };
        references.push(json!({"source_kind":r.get::<String,_>("source_kind"),"task_number":r.get::<i64,_>("number"),"task_title":r.get::<String,_>("title"),"comment_id":comment,"position":r.get::<i32,_>("position"),"snippet":snippet}));
    }
    Json(json!({"references":references})).into_response()
}

pub(crate) async fn task_access(
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
        Ok(Some(_)) => match sqlx::query("SELECT id,workspace_id,task_id,author_id,body,edited_at::text AS edited_at,created_at::text AS created_at,reply_to_comment_id FROM task_comments WHERE task_id=$1 AND deleted_at IS NULL ORDER BY created_at,id").bind(task).fetch_all(&state.pool).await {
            Ok(rows)=>{ let mut comments=Vec::new(); for row in &rows { match comment_json(&state.pool,row,user).await { Ok(comment)=>comments.push(comment), Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response() } } Json(json!({"comments":comments})).into_response() }, Err(_)=>StatusCode::INTERNAL_SERVER_ERROR.into_response()
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
    if let Some(reply_to) = input.reply_to {
        let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM task_comments WHERE id=$1 AND task_id=$2 AND deleted_at IS NULL)")
            .bind(reply_to).bind(task).fetch_one(&state.pool).await.unwrap_or(false);
        if !valid {
            return StatusCode::UNPROCESSABLE_ENTITY.into_response();
        }
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let row=sqlx::query("INSERT INTO task_comments(id,workspace_id,task_id,author_id,request_id,body,reply_to_comment_id) SELECT $1,t.workspace_id,t.id,$2,$3,$4,$5 FROM tasks t WHERE t.id=$6 ON CONFLICT(task_id,author_id,request_id) DO UPDATE SET request_id=EXCLUDED.request_id RETURNING id,workspace_id,task_id,author_id,body,edited_at::text AS edited_at,created_at::text AS created_at,reply_to_comment_id,(xmax=0) AS inserted")
        .bind(Uuid::new_v4()).bind(user).bind(input.request_id).bind(&input.body).bind(input.reply_to).bind(task).fetch_optional(&mut *tx).await;
    match row {
        Ok(Some(row)) if row.get::<String, _>("body") == input.body => {
            if row.get::<bool, _>("inserted")
                && (replace_comment_references(
                    &mut tx,
                    row.get("workspace_id"),
                    task,
                    row.get("id"),
                    user,
                    &input.body,
                )
                .await
                .is_err()
                    || resolve_mentions(&mut tx, task, row.get("id"), &input.body)
                        .await
                        .is_err())
            {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
            if row.get::<bool, _>("inserted") {
                let group = Uuid::new_v4();
                let group_created = sqlx::query("INSERT INTO task_operation_groups(id,command_id,workspace_id,actor_id) VALUES($1,$2,$3,$4)")
                    .bind(group).bind(Uuid::new_v4()).bind(row.get::<Uuid,_>("workspace_id")).bind(user)
                    .execute(&mut *tx).await;
                if group_created.is_err()
                    || sqlx::query("UPDATE task_comments SET operation_group_id=$2 WHERE id=$1")
                        .bind(row.get::<Uuid,_>("id")).bind(group).execute(&mut *tx).await.is_err()
                    || sqlx::query("INSERT INTO notification_intents(id,workspace_id,task_id,recipient_id,actor_id,reason,operation_group_id,source_comment_id) \
                        SELECT gen_random_uuid(),m.workspace_id,m.task_id,m.recipient_id,$2,'mentioned',$3,m.comment_id \
                        FROM task_comment_mentions m JOIN tasks t ON t.id=m.task_id JOIN projects p ON p.id=t.project_id \
                        WHERE m.comment_id=$1 AND m.recipient_id<>$2 AND (p.visibility='workspace' OR EXISTS(SELECT 1 FROM project_memberships pm WHERE pm.project_id=p.id AND pm.user_id=m.recipient_id AND pm.role IN ('viewer','contributor','manager')) OR EXISTS(SELECT 1 FROM project_team_memberships pt JOIN team_memberships tm ON tm.team_id=pt.team_id WHERE pt.project_id=p.id AND tm.user_id=m.recipient_id AND pt.role IN ('viewer','contributor','manager'))) ")
                        .bind(row.get::<Uuid,_>("id")).bind(user).bind(group).execute(&mut *tx).await.is_err()
                    || sqlx::query("INSERT INTO notification_intents(id,workspace_id,task_id,recipient_id,actor_id,reason,operation_group_id,source_comment_id) \
                        SELECT gen_random_uuid(),t.workspace_id,t.id,w.user_id,$2,'watched',$3,$4 \
                        FROM task_watchers w JOIN tasks t ON t.id=w.task_id JOIN projects p ON p.id=t.project_id \
                        LEFT JOIN task_notification_preferences pref ON pref.task_id=t.id AND pref.user_id=w.user_id \
                        WHERE t.id=$5 AND w.user_id<>$2 AND COALESCE(pref.muted,false)=false \
                          AND (CASE WHEN $6::uuid IS NULL THEN 'comment' ELSE 'reply' END)=ANY(COALESCE(pref.events,ARRAY[]::text[])) \
                          AND (p.visibility='workspace' OR EXISTS(SELECT 1 FROM project_memberships pm WHERE pm.project_id=p.id AND pm.user_id=w.user_id AND pm.role IN ('viewer','contributor','manager')) OR EXISTS(SELECT 1 FROM project_team_memberships pt JOIN team_memberships tm ON tm.team_id=pt.team_id WHERE pt.project_id=p.id AND tm.user_id=w.user_id AND pt.role IN ('viewer','contributor','manager'))) ")
                        .bind(row.get::<Uuid,_>("id")).bind(user).bind(group).bind(row.get::<Uuid,_>("id")).bind(task).bind(input.reply_to).execute(&mut *tx).await.is_err()
                    || sqlx::query("INSERT INTO notification_intents(id,workspace_id,task_id,recipient_id,actor_id,reason,operation_group_id,source_comment_id) \
                        SELECT gen_random_uuid(),t.workspace_id,t.id,w.user_id,$2,'watched',$3,$4 \
                        FROM task_watchers w JOIN tasks t ON t.id=w.task_id JOIN projects p ON p.id=t.project_id \
                        LEFT JOIN task_notification_preferences pref ON pref.task_id=t.id AND pref.user_id=w.user_id \
                        JOIN task_comment_mentions m ON m.comment_id=$4 AND m.recipient_id=w.user_id \
                        WHERE t.id=$5 AND w.user_id<>$2 AND COALESCE(pref.muted,false)=false AND 'mention'=ANY(COALESCE(pref.events,ARRAY[]::text[])) \
                          AND (p.visibility='workspace' OR EXISTS(SELECT 1 FROM project_memberships pm WHERE pm.project_id=p.id AND pm.user_id=w.user_id AND pm.role IN ('viewer','contributor','manager')) OR EXISTS(SELECT 1 FROM project_team_memberships pt JOIN team_memberships tm ON tm.team_id=pt.team_id WHERE pt.project_id=p.id AND tm.user_id=w.user_id AND pt.role IN ('viewer','contributor','manager'))) ")
                        .bind(row.get::<Uuid,_>("id")).bind(user).bind(group).bind(row.get::<Uuid,_>("id")).bind(task).execute(&mut *tx).await.is_err()
                    || if let Some(parent) = input.reply_to {
                        sqlx::query("INSERT INTO notification_intents(id,workspace_id,task_id,recipient_id,actor_id,reason,operation_group_id,source_comment_id) \
                            SELECT gen_random_uuid(),c.workspace_id,c.task_id,c.author_id,$2,'replied',$3,$4 FROM task_comments c \
                            JOIN tasks t ON t.id=c.task_id JOIN projects p ON p.id=t.project_id \
                            WHERE c.id=$1 AND c.author_id<>$2 AND (p.visibility='workspace' OR EXISTS(SELECT 1 FROM project_memberships pm WHERE pm.project_id=p.id AND pm.user_id=c.author_id AND pm.role IN ('viewer','contributor','manager')) OR EXISTS(SELECT 1 FROM project_team_memberships pt JOIN team_memberships tm ON tm.team_id=pt.team_id WHERE pt.project_id=p.id AND tm.user_id=c.author_id AND pt.role IN ('viewer','contributor','manager'))) ")
                            .bind(parent).bind(user).bind(group).bind(row.get::<Uuid,_>("id")).execute(&mut *tx).await.is_err()
                    } else { false }
                {
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            }
            if tx.commit().await.is_err() {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
            let status = if row.get::<bool, _>("inserted") {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            };
            match comment_json(&state.pool, &row, user).await {
                Ok(comment) => (status, Json(comment)).into_response(),
                Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            }
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
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let row=sqlx::query("UPDATE task_comments SET body=$3,edited_at=now() WHERE id=$1 AND task_id=$2 AND author_id=$4 AND deleted_at IS NULL RETURNING id,workspace_id,task_id,author_id,body,edited_at::text AS edited_at,created_at::text AS created_at").bind(comment).bind(task).bind(&input.body).bind(user).fetch_optional(&mut *tx).await;
    match row {
        Ok(Some(row)) => {
            if replace_comment_references(
                &mut tx,
                row.get("workspace_id"),
                task,
                comment,
                user,
                &input.body,
            )
            .await
            .is_err()
                || sqlx::query("DELETE FROM task_comment_mentions WHERE comment_id=$1")
                    .bind(comment)
                    .execute(&mut *tx)
                    .await
                    .is_err()
                || resolve_mentions(&mut tx, task, comment, &input.body)
                    .await
                    .is_err()
                || tx.commit().await.is_err()
            {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
            match comment_json(&state.pool, &row, user).await {
                Ok(comment) => Json(comment).into_response(),
                Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            }
        }
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
    let Ok(Some(project)) = task_access(&state.pool, task, user, true).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let manager = matches!(
        evaluate_access(&state.pool, project, user).await,
        Ok(Some(access)) if access.role == Role::Manager
    );
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    match sqlx::query("UPDATE task_comments SET deleted_at=now() WHERE id=$1 AND task_id=$2 AND deleted_at IS NULL AND (author_id=$3 OR $4)").bind(comment).bind(task).bind(user).bind(manager).execute(&mut *tx).await {
        Ok(r) if r.rows_affected()==1=>{ if sqlx::query("DELETE FROM task_references WHERE source_kind='comment' AND source_comment_id=$1").bind(comment).execute(&mut *tx).await.is_err() || tx.commit().await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); } StatusCode::NO_CONTENT.into_response() },Ok(_)=>StatusCode::NOT_FOUND.into_response(),Err(_)=>StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }
}

#[derive(Deserialize)]
struct ReactionInput {
    emoji: String,
}

async fn add_reaction(
    State(state): State<AuthState>,
    Path((task, comment)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(input): Json<ReactionInput>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    if input.emoji.trim().is_empty()
        || input.emoji.chars().count() > 8
        || input.emoji.chars().any(char::is_control)
    {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    if !matches!(
        task_access(&state.pool, task, user, true).await,
        Ok(Some(_))
    ) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match sqlx::query("INSERT INTO task_comment_reactions(workspace_id,task_id,comment_id,user_id,emoji) SELECT workspace_id,task_id,id,$3,$4 FROM task_comments WHERE id=$1 AND task_id=$2 AND deleted_at IS NULL ON CONFLICT DO NOTHING")
        .bind(comment).bind(task).bind(user).bind(input.emoji.trim()).execute(&state.pool).await {
        Ok(_)=>StatusCode::OK.into_response(), Err(_)=>StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }
}

async fn remove_reaction(
    State(state): State<AuthState>,
    Path((task, comment)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Query(query): Query<ReactionInput>,
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
    match sqlx::query("DELETE FROM task_comment_reactions WHERE task_id=$1 AND comment_id=$2 AND user_id=$3 AND emoji=$4").bind(task).bind(comment).bind(user).bind(query.emoji).execute(&state.pool).await {
        Ok(_)=>StatusCode::NO_CONTENT.into_response(), Err(_)=>StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }
}

async fn mention_suggestions(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    Query(query): Query<MentionQuery>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    if query.q.len() > 100 {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    if !matches!(
        task_access(&state.pool, query.task_id, user, false).await,
        Ok(Some(_))
    ) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let pattern = format!("%{}%", query.q.replace('%', "\\%").replace('_', "\\_"));
    let belongs: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM tasks WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL)").bind(query.task_id).bind(workspace).fetch_one(&state.pool).await.unwrap_or(false);
    if !belongs {
        return StatusCode::NOT_FOUND.into_response();
    }
    let rows = sqlx::query("SELECT u.id,u.email FROM tasks t JOIN projects p ON p.id=t.project_id JOIN workspace_memberships wm ON wm.workspace_id=t.workspace_id JOIN users u ON u.id=wm.user_id WHERE t.id=$1 AND u.email ILIKE $2 ESCAPE E'\\\\' AND (p.visibility='workspace' OR EXISTS(SELECT 1 FROM project_memberships pm WHERE pm.project_id=p.id AND pm.user_id=u.id AND pm.role IN ('viewer','contributor','manager')) OR EXISTS(SELECT 1 FROM project_team_memberships pt JOIN team_memberships tm ON tm.team_id=pt.team_id WHERE pt.project_id=p.id AND tm.user_id=u.id AND pt.role IN ('viewer','contributor','manager'))) ORDER BY u.email LIMIT 10")
        .bind(query.task_id).bind(&pattern).fetch_all(&state.pool).await;
    let team_rows = sqlx::query("SELECT tm.id,tm.name FROM tasks t JOIN teams tm ON tm.workspace_id=t.workspace_id WHERE t.id=$1 AND tm.name ILIKE $2 ESCAPE E'\\\\' AND EXISTS(SELECT 1 FROM team_memberships member WHERE member.team_id=tm.id AND (EXISTS(SELECT 1 FROM project_memberships pm WHERE pm.project_id=t.project_id AND pm.user_id=member.user_id AND pm.role IN ('viewer','contributor','manager')) OR EXISTS(SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.visibility='workspace') OR EXISTS(SELECT 1 FROM project_team_memberships pt JOIN team_memberships access_team ON access_team.team_id=pt.team_id WHERE pt.project_id=t.project_id AND access_team.user_id=member.user_id AND pt.role IN ('viewer','contributor','manager')))) ORDER BY tm.name LIMIT 10")
        .bind(query.task_id).bind(&pattern).fetch_all(&state.pool).await;
    match (rows, team_rows) {
        (Ok(rows), Ok(team_rows)) => {
            let mut results=rows.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"label":r.get::<String,_>("email"),"mention":format!("@{}",r.get::<String,_>("email"))})).collect::<Vec<_>>();
            results.extend(team_rows.iter().map(|r| {let name=r.get::<String,_>("name");json!({"id":r.get::<Uuid,_>("id"),"label":format!("Team · {name}"),"mention":format!("@team:{}",name.to_lowercase().replace(' ',"-"))})}));
            Json(json!({"results":results})).into_response()
        }
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Deserialize)]
struct MentionQuery {
    q: String,
    task_id: Uuid,
}

#[derive(Deserialize)]
struct ActivityFilter {
    filter: Option<String>,
}
async fn task_activity(
    State(state): State<AuthState>,
    Path(task): Path<Uuid>,
    Query(query): Query<ActivityFilter>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    if !matches!(
        task_access(&state.pool, task, user, false).await,
        Ok(Some(_))
    ) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let filter = query.filter.as_deref().unwrap_or("all");
    if !matches!(filter, "all" | "discussion" | "changes") {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let mut items = Vec::new();
    if filter != "changes" {
        let rows = match sqlx::query("SELECT id,workspace_id,task_id,author_id,body,edited_at::text AS edited_at,created_at::text AS created_at,reply_to_comment_id FROM task_comments WHERE task_id=$1 ORDER BY created_at,id").bind(task).fetch_all(&state.pool).await { Ok(v)=>v, Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
        for row in rows {
            let deleted: bool =
                sqlx::query_scalar("SELECT deleted_at IS NOT NULL FROM task_comments WHERE id=$1")
                    .bind(row.get::<Uuid, _>("id"))
                    .fetch_one(&state.pool)
                    .await
                    .unwrap_or(true);
            if deleted {
                items.push(json!({"kind":"comment_deleted","id":row.get::<Uuid,_>("id"),"created_at":row.get::<String,_>("created_at"),"text":null}));
            } else {
                match comment_json(&state.pool, &row, user).await {
                    Ok(mut item) => {
                        item["kind"] = json!("comment");
                        items.push(item)
                    }
                    Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                }
            }
        }
    }
    if filter != "discussion" {
        let rows = match sqlx::query("SELECT o.id,o.field_key,o.before_value,o.after_value,o.task_version,g.actor_id,g.created_at::text AS created_at FROM task_operations o JOIN task_operation_groups g ON g.id=o.group_id WHERE o.task_id=$1 AND NOT o.suppressed AND g.state NOT IN ('suppressed','undone') ORDER BY g.created_at,o.id").bind(task).fetch_all(&state.pool).await { Ok(v)=>v, Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
        for r in rows {
            let field = r.get::<String, _>("field_key");
            let label = if field.starts_with("relation/") || field.starts_with("relation_from/") {
                "relation"
            } else {
                field.as_str()
            };
            items.push(json!({"kind":"change","id":r.get::<Uuid,_>("id"),"field":label,"actor_id":r.get::<Uuid,_>("actor_id"),"created_at":r.get::<String,_>("created_at"),"version":r.get::<i64,_>("task_version")}));
        }
    }
    items.sort_by(|a, b| a["created_at"].as_str().cmp(&b["created_at"].as_str()));
    Json(json!({"items":items,"filter":filter})).into_response()
}

#[derive(Deserialize)]
struct SearchParams {
    q: String,
    page: Option<u32>,
    limit: Option<u32>,
    cursor: Option<i64>,
}

fn search_error(code: &'static str, message: &'static str) -> Response {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        Json(json!({"error":{"code":code,"message":message}})),
    )
        .into_response()
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
    let query = params.q.trim();
    let query_length = query.chars().count();
    if query_length == 0 {
        return search_error("search_query_empty", "Enter a search query.");
    }
    if query_length > 100 {
        return search_error(
            "search_query_too_long",
            "Search queries must be 100 characters or fewer.",
        );
    }
    if query.split_whitespace().count() > 8 {
        return search_error(
            "search_too_many_terms",
            "Search queries may contain at most 8 terms.",
        );
    }
    if page == 0 || page > 10_000 {
        return search_error("search_invalid_page", "Page must be between 1 and 10000.");
    }
    if limit == 0 || limit > 50 {
        return search_error(
            "search_invalid_limit",
            "Page size must be between 1 and 50.",
        );
    }
    if matches!(params.cursor, Some(cursor) if cursor < 0) {
        return search_error("search_invalid_cursor", "Search cursor is invalid.");
    }
    let pattern = format!(
        "%{}%",
        query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let condition="(t.number::text=$2 OR t.title ILIKE $3 ESCAPE E'\\\\' OR t.description ILIKE $3 ESCAPE E'\\\\' OR EXISTS(SELECT 1 FROM task_comments c WHERE c.task_id=t.id AND c.deleted_at IS NULL AND c.body ILIKE $3 ESCAPE E'\\\\') OR EXISTS(SELECT 1 FROM task_attribute_values av WHERE av.task_id=t.id AND av.value::text ILIKE $3 ESCAPE E'\\\\'))";
    let acl="EXISTS(SELECT 1 FROM workspace_memberships wm WHERE wm.workspace_id=t.workspace_id AND wm.user_id=$4) AND (p.visibility='workspace' OR EXISTS(SELECT 1 FROM project_memberships pm WHERE pm.project_id=p.id AND pm.user_id=$4 AND pm.role IN ('viewer','contributor','manager')) OR EXISTS(SELECT 1 FROM project_team_memberships pt JOIN team_memberships tm ON tm.team_id=pt.team_id WHERE pt.project_id=p.id AND tm.user_id=$4 AND pt.role IN ('viewer','contributor','manager')))";
    // Candidates carry no body text. Text inside an unreadable note reference is redacted before
    // matching, so a Task whose only hit sits inside such a reference is not a result: otherwise
    // the result list would confirm that the hidden note exists.
    let sql=format!("SELECT t.id,t.number,t.title,t.project_id,(t.number::text=$2 OR t.title ILIKE $3 ESCAPE E'\\\\' OR EXISTS(SELECT 1 FROM task_attribute_values av WHERE av.task_id=t.id AND av.value::text ILIKE $3 ESCAPE E'\\\\')) AS other_match,EXISTS(SELECT 1 FROM task_note_references r WHERE r.source_task_id=t.id) AS has_note_refs FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.workspace_id=$1 AND t.archived_at IS NULL AND p.archived_at IS NULL AND {acl} AND {condition} AND ($5::bigint IS NULL OR t.number>$5) ORDER BY t.number");
    let candidates = match sqlx::query(&sql)
        .bind(workspace)
        .bind(query)
        .bind(&pattern)
        .bind(user)
        .bind(params.cursor)
        .fetch_all(&state.pool)
        .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, "task search query failed");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let mut matched = Vec::with_capacity(candidates.len());
    for row in &candidates {
        let id: Uuid = row.get("id");
        if row.get::<bool, _>("has_note_refs") && !row.get::<bool, _>("other_match") {
            match visible_text_matches(&state.pool, id, user, query).await {
                Ok(true) => {}
                Ok(false) => continue,
                Err(error) => {
                    tracing::error!(%error, "task search visibility check failed");
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            }
        }
        matched.push(row);
    }
    let count = matched.len() as i64;
    let offset = if params.cursor.is_some() {
        0
    } else {
        (page as usize - 1) * limit as usize
    };
    let window = matched
        .iter()
        .skip(offset)
        .take(limit as usize + 1)
        .collect::<Vec<_>>();
    let has_more = window.len() > limit as usize;
    let next_cursor = if has_more {
        window
            .get(limit as usize - 1)
            .map(|row| row.get::<i64, _>("number"))
    } else {
        None
    };
    let mut results = Vec::new();
    for r in window.iter().take(limit as usize) {
        let id: Uuid = r.get("id");
        let matched_text = match match_text(&state.pool, id, user, query, &pattern).await {
            Ok(text) => text.unwrap_or_else(|| r.get::<String, _>("title")),
            Err(error) => {
                tracing::error!(%error, "task search snippet failed");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        };
        results.push(json!({"task_id":id,"task_number":r.get::<i64,_>("number"),"title":r.get::<String,_>("title"),"snippet":crate::knowledge::index::snippet(&matched_text, query),"project_id":r.get::<Uuid,_>("project_id")}));
    }
    Json(json!({"page":page,"limit":limit,"count":count,"next_cursor":next_cursor.map(|cursor| cursor.to_string()),"results":results})).into_response()
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
    let result = build_export(&state.pool, workspace, user).await;
    match result {
        Ok(value) => Json(value).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

// A Workspace admin does not read Restricted content automatically, so the export only holds
// Projects the exporting user can read through their own grants. Each export is audited.
async fn build_export(pool: &PgPool, workspace: Uuid, user: Uuid) -> Result<Value, sqlx::Error> {
    let workspace_row =
        sqlx::query("SELECT id,name,created_at::text AS created_at FROM workspaces WHERE id=$1")
            .bind(workspace)
            .fetch_optional(pool)
            .await?;
    let Some(w) = workspace_row else {
        return Ok(json!({"schema_version":"1.0","workspace":null}));
    };
    let mut readable: Vec<Uuid> = Vec::new();
    let project_ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM projects WHERE workspace_id=$1 ORDER BY id")
            .bind(workspace)
            .fetch_all(pool)
            .await?;
    for project in project_ids {
        if matches!(evaluate_access(pool, project, user).await?, Some(access) if access.role >= Role::Viewer)
        {
            readable.push(project);
        }
    }
    sqlx::query("INSERT INTO security_audit_events(actor_id,workspace_id,event,subject_id) VALUES($1,$2,'workspace.export',$2)")
        .bind(user)
        .bind(workspace)
        .execute(pool)
        .await?;
    let projects=sqlx::query("SELECT id,name,visibility,created_at::text AS created_at FROM projects WHERE workspace_id=$1 AND id=ANY($2) ORDER BY id").bind(workspace).bind(&readable).fetch_all(pool).await?;
    let tasks=sqlx::query("SELECT id,number,project_id,parent_task_id,title,description,status,priority,start_date::text AS start_date,due_date::text AS due_date,version,created_at::text AS created_at,updated_at::text AS updated_at,archived_at::text AS archived_at FROM tasks WHERE workspace_id=$1 AND project_id=ANY($2) ORDER BY number").bind(workspace).bind(&readable).fetch_all(pool).await?;
    let comments=sqlx::query("SELECT id,task_id,author_id,request_id,body,created_at::text AS created_at,edited_at::text AS edited_at,deleted_at::text AS deleted_at FROM task_comments WHERE workspace_id=$1 AND task_id IN (SELECT id FROM tasks WHERE workspace_id=$1 AND project_id=ANY($2)) ORDER BY created_at,id").bind(workspace).bind(&readable).fetch_all(pool).await?;
    let attachments=sqlx::query("SELECT id,task_id,comment_id,storage_key,uploaded_by,file_name,content_type,encode(content,'hex') AS content_hex,created_at::text AS created_at FROM task_attachments WHERE workspace_id=$1 AND task_id IN (SELECT id FROM tasks WHERE workspace_id=$1 AND project_id=ANY($2)) ORDER BY id").bind(workspace).bind(&readable).fetch_all(pool).await?;
    let attributes=sqlx::query("SELECT id,name,value_type,position,archived_at::text AS archived_at FROM attribute_schemas WHERE workspace_id=$1 ORDER BY position,id").bind(workspace).fetch_all(pool).await?;
    let values=sqlx::query("SELECT task_id,attribute_id,value FROM task_attribute_values WHERE workspace_id=$1 AND task_id IN (SELECT id FROM tasks WHERE workspace_id=$1 AND project_id=ANY($2)) ORDER BY task_id,attribute_id").bind(workspace).bind(&readable).fetch_all(pool).await?;
    Ok(
        json!({"schema_version":"1.0","workspace":{"id":w.get::<Uuid,_>("id"),"name":w.get::<String,_>("name"),"created_at":w.get::<String,_>("created_at")},"projects":projects.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"name":r.get::<String,_>("name"),"visibility":r.get::<String,_>("visibility"),"created_at":r.get::<String,_>("created_at")})).collect::<Vec<_>>(),"tasks":tasks.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"number":r.get::<i64,_>("number"),"project_id":r.get::<Uuid,_>("project_id"),"parent_task_id":r.get::<Option<Uuid>,_>("parent_task_id"),"title":r.get::<String,_>("title"),"description":r.get::<String,_>("description"),"status":r.get::<String,_>("status"),"priority":r.get::<String,_>("priority"),"start_date":r.get::<Option<String>,_>("start_date"),"due_date":r.get::<Option<String>,_>("due_date"),"version":r.get::<i64,_>("version"),"created_at":r.get::<String,_>("created_at"),"updated_at":r.get::<String,_>("updated_at"),"archived_at":r.get::<Option<String>,_>("archived_at")})).collect::<Vec<_>>(),"comments":comments.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"task_id":r.get::<Uuid,_>("task_id"),"author_id":r.get::<Uuid,_>("author_id"),"request_id":r.get::<Uuid,_>("request_id"),"body":r.get::<String,_>("body"),"created_at":r.get::<String,_>("created_at"),"edited_at":r.get::<Option<String>,_>("edited_at"),"deleted_at":r.get::<Option<String>,_>("deleted_at")})).collect::<Vec<_>>(),"attributes":attributes.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"name":r.get::<String,_>("name"),"type":r.get::<String,_>("value_type"),"position":r.get::<i32,_>("position"),"archived_at":r.get::<Option<String>,_>("archived_at")})).collect::<Vec<_>>(),"attribute_values":values.iter().map(|r|json!({"task_id":r.get::<Uuid,_>("task_id"),"attribute_id":r.get::<Uuid,_>("attribute_id"),"value":r.get::<Value,_>("value")})).collect::<Vec<_>>(),"attachments":attachments.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"storage_key":r.get::<Uuid,_>("storage_key"),"comment_id":r.get::<Option<Uuid>,_>("comment_id"),"task_id":r.get::<Uuid,_>("task_id"),"uploaded_by":r.get::<Uuid,_>("uploaded_by"),"file_name":r.get::<String,_>("file_name"),"content_type":r.get::<String,_>("content_type"),"content_hex":r.get::<String,_>("content_hex"),"created_at":r.get::<String,_>("created_at")})).collect::<Vec<_>>()}),
    )
}

fn contains_ignore_case(text: &str, query: &str) -> bool {
    text.to_lowercase().contains(&query.to_lowercase())
}

/// The Task's description and live comments as `viewer` may read them, in snippet order
/// (comments first), with unreadable note references already replaced.
async fn visible_texts(
    pool: &PgPool,
    task: Uuid,
    viewer: Uuid,
) -> Result<Vec<String>, sqlx::Error> {
    let mut texts = Vec::new();
    let comments = sqlx::query("SELECT id,body FROM task_comments WHERE task_id=$1 AND deleted_at IS NULL ORDER BY created_at,id")
        .bind(task)
        .fetch_all(pool)
        .await?;
    for comment in comments {
        texts.push(
            crate::note_reference_text::safe_body(
                pool,
                "comment",
                task,
                Some(comment.get("id")),
                Some(viewer),
                &comment.get::<String, _>("body"),
            )
            .await?,
        );
    }
    let description: String = sqlx::query_scalar("SELECT description FROM tasks WHERE id=$1")
        .bind(task)
        .fetch_one(pool)
        .await?;
    texts.push(
        crate::note_reference_text::safe_body(
            pool,
            "task_description",
            task,
            None,
            Some(viewer),
            &description,
        )
        .await?,
    );
    Ok(texts)
}

async fn visible_text_matches(
    pool: &PgPool,
    task: Uuid,
    viewer: Uuid,
    query: &str,
) -> Result<bool, sqlx::Error> {
    Ok(visible_texts(pool, task, viewer)
        .await?
        .iter()
        .any(|text| contains_ignore_case(text, query)))
}

/// The text a search snippet is cut from: the first matching comment, then the description,
/// the title and an attribute value, never text the viewer cannot read.
async fn match_text(
    pool: &PgPool,
    task: Uuid,
    viewer: Uuid,
    query: &str,
    pattern: &str,
) -> Result<Option<String>, sqlx::Error> {
    let texts = visible_texts(pool, task, viewer).await?;
    if let Some(text) = texts.iter().find(|text| contains_ignore_case(text, query)) {
        return Ok(Some(text.clone()));
    }
    let title: String = sqlx::query_scalar("SELECT title FROM tasks WHERE id=$1")
        .bind(task)
        .fetch_one(pool)
        .await?;
    if contains_ignore_case(&title, query) {
        return Ok(Some(title));
    }
    sqlx::query_scalar("SELECT av.value::text FROM task_attribute_values av WHERE av.task_id=$1 AND av.value::text ILIKE $2 ESCAPE E'\\\\' LIMIT 1")
        .bind(task)
        .bind(pattern)
        .fetch_optional(pool)
        .await
}

#[cfg(test)]
mod mention_tests {
    use super::{mention_tokens, MAX_MENTION_TOKENS};

    #[test]
    fn a_huge_comment_resolves_a_bounded_number_of_distinct_mentions() {
        let body = (0..5_000)
            .map(|i| format!("@user{i}@example.com"))
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(mention_tokens(&body).len(), MAX_MENTION_TOKENS);
    }
}
