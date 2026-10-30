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
        .route(
            "/workspaces/:workspace_id/tasks/:number/take",
            post(take_task),
        )
        .route("/tasks/:task_id/history", get(task_history))
        .route(
            "/workspaces/:workspace_id/history/undo",
            get(preview_undo).post(undo_latest),
        )
        .route(
            "/workspaces/:workspace_id/history/redo",
            get(preview_redo).post(redo_latest),
        )
        .route("/tasks/:task_id/move-preview", post(move_preview))
        .route("/tasks/:task_id/relations", post(create_relation))
        .route(
            "/tasks/:task_id/relations/:target_task_id/:kind",
            axum::routing::delete(delete_relation),
        )
        .route(
            "/tasks/:task_id/checklist",
            get(list_checklist).post(create_checklist_item),
        )
        .route(
            "/tasks/:task_id/checklist/:item_id",
            axum::routing::patch(update_checklist_item).delete(delete_checklist_item),
        )
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
    assignees: Option<Vec<AssigneeInput>>,
    parent_task_id: Option<Uuid>,
}

#[derive(Clone, Deserialize)]
struct AssigneeInput {
    #[serde(rename = "type")]
    kind: String,
    id: Uuid,
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
    assignees: Option<Vec<AssigneeInput>>,
    project_id: Option<Uuid>,
    confirm_move: Option<bool>,
}

#[derive(Deserialize)]
struct VersionInput {
    expected_version: i64,
    command_id: Option<Uuid>,
}

fn valid_priority(value: &str) -> bool {
    ["low", "normal", "high", "urgent"].contains(&value)
}

pub(crate) async fn can_read(
    pool: impl sqlx::PgExecutor<'_>,
    project: Uuid,
    user: Uuid,
) -> Result<bool, sqlx::Error> {
    Ok(matches!(evaluate_access(pool, project, user).await?, Some(a) if a.role >= Role::Viewer))
}

pub(crate) async fn can_write(
    pool: impl sqlx::PgExecutor<'_>,
    project: Uuid,
    user: Uuid,
) -> Result<bool, sqlx::Error> {
    Ok(
        matches!(evaluate_access(pool, project, user).await?, Some(a) if a.role >= Role::Contributor),
    )
}

pub(crate) async fn task_row(
    pool: &PgPool,
    workspace: Uuid,
    number: i64,
    include_archived: bool,
) -> Result<Option<sqlx::postgres::PgRow>, sqlx::Error> {
    sqlx::query("SELECT id,workspace_id,number,project_id,parent_task_id,title,description,status,priority,start_date::text AS start_date,due_date::text AS due_date,completed_at::text AS completed_at,version,created_at::text AS created_at,updated_at::text AS updated_at,archived_at::text AS archived_at FROM tasks WHERE workspace_id=$1 AND number=$2 AND ($3 OR archived_at IS NULL)")
        .bind(workspace).bind(number).bind(include_archived).fetch_optional(pool).await
}

pub(crate) async fn serialize_task(
    pool: &PgPool,
    row: &sqlx::postgres::PgRow,
    user: Option<Uuid>,
) -> Result<Value, sqlx::Error> {
    let id: Uuid = row.get("id");
    let watchers: Vec<Uuid> =
        sqlx::query_scalar("SELECT user_id FROM task_watchers WHERE task_id=$1 ORDER BY user_id")
            .bind(id)
            .fetch_all(pool)
            .await?;
    let task_id: Uuid = row.get("id");
    let subtasks = sqlx::query("SELECT id,number,title,project_id FROM tasks WHERE parent_task_id=$1 AND archived_at IS NULL ORDER BY number")
        .bind(task_id).fetch_all(pool).await?;
    let mut visible_subtasks = Vec::new();
    for subtask in subtasks {
        let readable = match user {
            Some(user) => can_read(pool, subtask.get("project_id"), user)
                .await
                .unwrap_or(false),
            None => false,
        };
        if readable {
            visible_subtasks.push(json!({"id":subtask.get::<Uuid,_>("id"),"number":subtask.get::<i64,_>("number"),"title":subtask.get::<String,_>("title")}));
        }
    }
    let checklist = sqlx::query("SELECT id,title,checked,position,version FROM task_checklist_items WHERE task_id=$1 ORDER BY position,created_at,id")
        .bind(task_id).fetch_all(pool).await?;
    let relations = sqlx::query("SELECT r.target_task_id,r.kind,t.number,t.title,t.project_id FROM task_relations r JOIN tasks t ON t.id=r.target_task_id WHERE r.source_task_id=$1 UNION ALL SELECT r.source_task_id,CASE WHEN r.kind='blocks' THEN 'blocked_by' WHEN r.kind='duplicate' THEN 'duplicated_by' ELSE r.kind END AS kind,t.number,t.title,t.project_id FROM task_relations r JOIN tasks t ON t.id=r.source_task_id WHERE r.target_task_id=$1 AND r.kind IN ('related','blocks','duplicate') ORDER BY 1")
        .bind(task_id).fetch_all(pool).await?;
    let mut visible_relations = Vec::new();
    for relation in relations {
        let readable = match user {
            Some(user) => can_read(pool, relation.get("project_id"), user)
                .await
                .unwrap_or(false),
            None => false,
        };
        if readable {
            visible_relations.push(json!({"task_id":relation.get::<Uuid,_>("target_task_id"),"number":relation.get::<i64,_>("number"),"title":relation.get::<String,_>("title"),"kind":relation.get::<String,_>("kind")}));
        }
    }
    // Similarity is only a candidate generator. Filter each candidate through the same
    // Project access evaluator used by Task reads before exposing any identifying data.
    let mut duplicate_hints = Vec::new();
    let mut duplicate_hints_complete = true;
    if let Some(user) = user {
        let candidates = sqlx::query("SELECT id,number,title,project_id,public.similarity(title,$2) AS score FROM tasks WHERE workspace_id=$1 AND id<>$3 AND archived_at IS NULL AND public.similarity(title,$2)>=0.25 ORDER BY score DESC,number LIMIT 11")
            .bind(row.get::<Uuid,_>("workspace_id")).bind(row.get::<String,_>("title")).bind(id)
            .fetch_all(pool).await?;
        // One row beyond the examined window tells the reader the list was cut short without
        // saying anything about the Tasks they cannot open.
        duplicate_hints_complete = candidates.len() <= 10;
        for candidate in candidates.into_iter().take(10) {
            if can_read(pool, candidate.get("project_id"), user)
                .await
                .unwrap_or(false)
            {
                duplicate_hints.push(json!({"id":candidate.get::<Uuid,_>("id"),"number":candidate.get::<i64,_>("number"),"title":candidate.get::<String,_>("title"),"similarity":candidate.get::<f32,_>("score")}));
            }
        }
    }
    let assignees = sqlx::query("SELECT CASE WHEN a.user_id IS NULL THEN 'team' ELSE 'user' END AS kind,COALESCE(a.user_id,a.team_id) AS id,COALESCE(u.email,t.name) AS name FROM task_assignees a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN teams t ON t.id=a.team_id WHERE a.task_id=$1 ORDER BY kind,id")
        .bind(id)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|row| json!({"type":row.get::<String,_>("kind"),"id":row.get::<Uuid,_>("id"),"name":row.get::<String,_>("name")}))
        .collect::<Vec<_>>();
    let attributes: serde_json::Map<String, Value> =
        sqlx::query("SELECT attribute_id,value FROM task_attribute_values WHERE task_id=$1")
            .bind(id)
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(|r| (r.get::<Uuid, _>("attribute_id").to_string(), r.get("value")))
            .collect();
    let description = row.get::<String, _>("description");
    let description_html = crate::task_reference_text::render_markdown(
        pool,
        row.get("workspace_id"),
        id,
        "task_description",
        None,
        user,
        &description,
    )
    .await?;
    let safe_description = crate::note_reference_text::safe_body(
        pool,
        "task_description",
        id,
        None,
        user,
        &description,
    )
    .await?;
    let mut created_from = Value::Null;
    if row.get::<Option<String>, _>("archived_at").is_none() {
        if let Some(viewer) = user {
            if let Some(source) = sqlx::query("SELECT r.source_task_id,r.source_comment_id,st.number,st.project_id,c.deleted_at IS NOT NULL AS deleted FROM task_comment_created_tasks r JOIN tasks st ON st.id=r.source_task_id JOIN task_comments c ON c.id=r.source_comment_id WHERE r.task_id=$1 AND st.archived_at IS NULL")
                .bind(id).fetch_optional(pool).await? {
                if !source.get::<bool, _>("deleted") && can_read(pool, source.get("project_id"), viewer).await? {
                    created_from = json!({"task_id":source.get::<Uuid,_>("source_task_id"),"task_number":source.get::<i64,_>("number"),"comment_id":source.get::<Uuid,_>("source_comment_id")});
                }
            }
        }
    }
    let mut mentions = Vec::new();
    if row.get::<Option<String>, _>("archived_at").is_none() && user.is_some() {
        let recipients = sqlx::query_scalar::<_, Uuid>("SELECT recipient_id FROM task_description_mentions WHERE task_id=$1 ORDER BY recipient_id")
            .bind(id).fetch_all(pool).await?;
        for recipient in recipients {
            if can_read(pool, row.get("project_id"), recipient).await? {
                mentions.push(recipient);
            }
        }
    }
    Ok(
        json!({"id":id,"workspace_id":row.get::<Uuid,_>("workspace_id"),"number":row.get::<i64,_>("number"),"project_id":row.get::<Uuid,_>("project_id"),"parent_task_id":row.get::<Option<Uuid>,_>("parent_task_id"),"title":row.get::<String,_>("title"),"description":safe_description,"description_html":description_html,"status":row.get::<String,_>("status"),"priority":row.get::<String,_>("priority"),"start_date":row.get::<Option<String>,_>("start_date"),"due_date":row.get::<Option<String>,_>("due_date"),"completed_at":row.get::<Option<String>,_>("completed_at"),"attributes":attributes,"watchers":watchers,"assignees":assignees,"subtasks":visible_subtasks,"checklist":checklist.into_iter().map(|item|json!({"id":item.get::<Uuid,_>("id"),"title":item.get::<String,_>("title"),"checked":item.get::<bool,_>("checked"),"position":item.get::<i32,_>("position"),"version":item.get::<i64,_>("version")})).collect::<Vec<_>>(),"relations":visible_relations,"similar_tasks":duplicate_hints,"similar_tasks_complete":duplicate_hints_complete,"mentions":mentions,"created_from":created_from,"version":row.get::<i64,_>("version"),"created_at":row.get::<String,_>("created_at"),"updated_at":row.get::<String,_>("updated_at"),"archived_at":row.get::<Option<String>,_>("archived_at")}),
    )
}

async fn assignees_value(
    pool: impl sqlx::PgExecutor<'_>,
    task: Uuid,
) -> Result<Value, sqlx::Error> {
    let rows = sqlx::query("SELECT CASE WHEN user_id IS NULL THEN 'team' ELSE 'user' END AS kind,COALESCE(user_id,team_id) AS id FROM task_assignees WHERE task_id=$1 ORDER BY kind,id")
        .bind(task)
        .fetch_all(pool)
        .await?;
    Ok(Value::Array(
        rows.into_iter()
            .map(|row| json!({"type":row.get::<String,_>("kind"),"id":row.get::<Uuid,_>("id")}))
            .collect(),
    ))
}

fn normalize_assignees(requested: Vec<AssigneeInput>) -> Result<Value, ()> {
    let mut assignees = Vec::new();
    for assignee in requested {
        if !["user", "team"].contains(&assignee.kind.as_str()) {
            return Err(());
        }
        assignees.push((assignee.kind, assignee.id));
    }
    assignees.sort();
    assignees.dedup();
    Ok(Value::Array(
        assignees
            .into_iter()
            .map(|(kind, id)| json!({"type":kind,"id":id}))
            .collect(),
    ))
}

async fn validate_assignees(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace: Uuid,
    project: Uuid,
    assignees: &Value,
) -> Result<bool, sqlx::Error> {
    for assignee in assignees.as_array().into_iter().flatten() {
        let Some(kind) = assignee.get("type").and_then(Value::as_str) else {
            return Ok(false);
        };
        let Some(id) = assignee
            .get("id")
            .and_then(Value::as_str)
            .and_then(|id| Uuid::parse_str(id).ok())
        else {
            return Ok(false);
        };
        let valid = match kind {
            "user" => can_read(&mut **tx, project, id).await?,
            "team" => {
                sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS(SELECT 1 FROM teams WHERE workspace_id=$1 AND id=$2)",
                )
                .bind(workspace)
                .bind(id)
                .fetch_one(&mut **tx)
                .await?
            }
            _ => return Ok(false),
        };
        if !valid {
            return Ok(false);
        }
    }
    Ok(true)
}

async fn replace_assignees(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    task: Uuid,
    workspace: Uuid,
    assignees: &Value,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM task_assignees WHERE task_id=$1")
        .bind(task)
        .execute(&mut **tx)
        .await?;
    for assignee in assignees.as_array().into_iter().flatten() {
        let kind = assignee["type"].as_str().unwrap_or_default();
        let id = assignee["id"]
            .as_str()
            .and_then(|id| Uuid::parse_str(id).ok())
            .unwrap_or_default();
        let (user_id, team_id) = if kind == "user" {
            (Some(id), None)
        } else {
            (None, Some(id))
        };
        sqlx::query(
            "INSERT INTO task_assignees(workspace_id,task_id,user_id,team_id) VALUES($1,$2,$3,$4)",
        )
        .bind(workspace)
        .bind(task)
        .bind(user_id)
        .bind(team_id)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
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
    {
        let status = input.status.as_deref().unwrap_or("backlog");
        let valid: bool = sqlx::query_scalar::<_, i32>("SELECT 1 FROM workspace_statuses WHERE workspace_id=$1 AND status_key=$2 AND archived_at IS NULL FOR SHARE").bind(workspace).bind(status).fetch_optional(&mut *tx).await.map(|row| row.is_some()).unwrap_or(false);
        if !valid {
            return StatusCode::UNPROCESSABLE_ENTITY.into_response();
        }
    }
    if let Some(parent) = input.parent_task_id {
        let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM tasks WHERE id=$1 AND workspace_id=$2 AND project_id=$3 AND archived_at IS NULL)").bind(parent).bind(workspace).bind(input.project_id).fetch_one(&mut *tx).await.unwrap_or(false);
        if !valid {
            return StatusCode::UNPROCESSABLE_ENTITY.into_response();
        }
    }
    let number: i64 = match sqlx::query_scalar("UPDATE workspaces SET next_task_number=next_task_number+1 WHERE id=$1 RETURNING next_task_number-1").bind(workspace).fetch_optional(&mut *tx).await { Ok(Some(n)) => n, _ => return StatusCode::NOT_FOUND.into_response() };
    let id = Uuid::new_v4();
    let initial_status = input.status.unwrap_or_else(|| "backlog".into());
    let created = sqlx::query("INSERT INTO tasks(id,workspace_id,number,project_id,parent_task_id,title,description,status,priority,start_date,due_date,completed_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11::date,CASE WHEN (SELECT category FROM workspace_statuses WHERE workspace_id=$2 AND status_key=$8)='completed' THEN now() ELSE NULL END,$12)")
        .bind(id).bind(workspace).bind(number).bind(input.project_id).bind(input.parent_task_id).bind(input.title.trim()).bind(input.description.unwrap_or_default()).bind(initial_status).bind(input.priority.unwrap_or_else(||"normal".into())).bind(input.start_date).bind(input.due_date).bind(user).execute(&mut *tx).await;
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
    if let Some(parent) = input.parent_task_id {
        let parent_value = json!(parent);
        if record_task_operation(
            &mut tx,
            TaskOperationRecord {
                workspace,
                user,
                task: id,
                field: "parent_task_id",
                before: &Value::Null,
                after: &parent_value,
                task_version: 1,
            },
        )
        .await
        .is_err()
        {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    if let Some(requested) = input.assignees {
        let requested = match normalize_assignees(requested) {
            Ok(value) => value,
            Err(()) => return StatusCode::UNPROCESSABLE_ENTITY.into_response(),
        };
        match validate_assignees(&mut tx, workspace, input.project_id, &requested).await {
            Ok(true) => {}
            Ok(false) => return StatusCode::UNPROCESSABLE_ENTITY.into_response(),
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
        if replace_assignees(&mut tx, id, workspace, &requested)
            .await
            .is_err()
        {
            return StatusCode::UNPROCESSABLE_ENTITY.into_response();
        }
        if record_task_operation(
            &mut tx,
            TaskOperationRecord {
                workspace,
                user,
                task: id,
                field: "assignees",
                before: &json!([]),
                after: &requested,
                task_version: 1,
            },
        )
        .await
        .is_err()
        {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    match task_row(&state.pool, workspace, number, false).await {
        Ok(Some(row)) => match serialize_task(&state.pool, &row, Some(user)).await {
            Ok(value) => (StatusCode::CREATED, Json(value)).into_response(),
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        },
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Deserialize)]
struct ListParams {
    archived: Option<bool>,
    status: Option<String>,
    project_id: Option<Uuid>,
    attribute_id: Option<Uuid>,
    attribute_value: Option<String>,
    sort: Option<String>,
    group_by: Option<String>,
    columns: Option<String>,
}

async fn list_tasks(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    Query(params): Query<ListParams>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let sort_attribute = params
        .sort
        .as_deref()
        .and_then(|v| v.strip_prefix("attribute/"))
        .and_then(|id| Uuid::parse_str(id).ok());
    let sort = params
        .sort
        .as_deref()
        .filter(|v| ["number", "title", "status", "priority", "due_date"].contains(v))
        .unwrap_or(if sort_attribute.is_some() {
            "attribute"
        } else {
            "number"
        });
    let rows = match sqlx::query("SELECT t.id,t.workspace_id,t.number,t.project_id,t.parent_task_id,t.title,t.description,t.status,t.priority,t.start_date::text AS start_date,t.due_date::text AS due_date,t.completed_at::text AS completed_at,t.version,t.created_at::text AS created_at,t.updated_at::text AS updated_at,t.archived_at::text AS archived_at FROM tasks t WHERE t.workspace_id=$1 AND (t.archived_at IS NOT NULL)=$2 AND ($3::text IS NULL OR t.status=$3) AND ($4::uuid IS NULL OR t.project_id=$4) AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM task_attribute_values av WHERE av.task_id=t.id AND av.attribute_id=$5 AND ($6::jsonb IS NULL OR av.value=$6::jsonb))) ORDER BY CASE WHEN $7='number' THEN lpad(t.number::text,20,'0') END,CASE WHEN $7='title' THEN lower(t.title) END,CASE WHEN $7='status' THEN t.status END,CASE WHEN $7='priority' THEN t.priority END,CASE WHEN $7='due_date' THEN t.due_date::text END,CASE WHEN $7='attribute' THEN (SELECT value FROM task_attribute_values av WHERE av.task_id=t.id AND av.attribute_id=$8) END,t.number").bind(workspace).bind(params.archived.unwrap_or(false)).bind(params.status).bind(params.project_id).bind(params.attribute_id).bind(params.attribute_value).bind(sort).bind(sort_attribute).fetch_all(&state.pool).await { Ok(rows) => rows, Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
    let mut tasks = Vec::new();
    for row in rows {
        let project: Uuid = row.get("project_id");
        match can_read(&state.pool, project, user).await {
            Ok(true) => match serialize_task(&state.pool, &row, Some(user)).await {
                Ok(task) => tasks.push(task),
                Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            },
            Ok(false) => {}
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    }
    let group_by = params
        .group_by
        .filter(|v| v == "status" || v.starts_with("attribute/"));
    let mut groups = serde_json::Map::new();
    if let Some(field) = &group_by {
        for task in &tasks {
            let key = if field == "status" {
                task["status"].as_str().unwrap_or("(none)").to_owned()
            } else {
                task["attributes"]
                    .get(field.trim_start_matches("attribute/"))
                    .filter(|value| !value.is_null())
                    .map(Value::to_string)
                    .unwrap_or_else(|| "(none)".into())
            };
            groups
                .entry(key)
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .expect("group is an array")
                .push(task.clone());
        }
    }
    let columns: Vec<String> = params
        .columns
        .unwrap_or_default()
        .split(',')
        .filter(|v| {
            [
                "number",
                "title",
                "status",
                "priority",
                "start_date",
                "due_date",
            ]
            .contains(v)
                || v.starts_with("attribute/")
        })
        .map(str::to_owned)
        .collect();
    Json(json!({"tasks":tasks,"groups":groups,"group_by":group_by,"columns":columns}))
        .into_response()
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
    match task_row(&state.pool, workspace, number, true).await {
        Ok(Some(row)) => {
            let project: Uuid = row.get("project_id");
            match can_read(&state.pool, project, user).await {
                Ok(true) => match serialize_task(&state.pool, &row, Some(user)).await {
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
    let existing=match sqlx::query("SELECT workspace_id,number,project_id,version,title,description,status,priority,start_date::text AS start_date,due_date::text AS due_date,completed_at::text AS completed_at FROM tasks WHERE id=$1 AND archived_at IS NULL").bind(id).fetch_optional(&state.pool).await {Ok(Some(r))=>r,Ok(None)=>return StatusCode::NOT_FOUND.into_response(),Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response()};
    let workspace: Uuid = existing.get("workspace_id");
    let number: i64 = existing.get("number");
    let old_project: Uuid = existing.get("project_id");
    let version: i64 = existing.get("version");
    let old_status: String = existing.get("status");
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
        || input
            .priority
            .as_deref()
            .is_some_and(|v| !valid_priority(v))
    {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    if let Some(status) = input.status.as_deref() {
        let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_statuses WHERE workspace_id=$1 AND status_key=$2 AND archived_at IS NULL)").bind(workspace).bind(status).fetch_one(&state.pool).await.unwrap_or(false);
        if !valid {
            return StatusCode::UNPROCESSABLE_ENTITY.into_response();
        }
    }
    for date in [&mut input.start_date, &mut input.due_date] {
        if let Some(Some(value)) = date {
            match sqlx::query_scalar::<_, String>("SELECT $1::date::text")
                .bind(value.as_str())
                .fetch_one(&state.pool)
                .await
            {
                Ok(canonical) => *value = canonical,
                Err(e)
                    if e.as_database_error()
                        .and_then(|d| d.code())
                        .is_some_and(|code| code.starts_with("22")) =>
                {
                    return StatusCode::UNPROCESSABLE_ENTITY.into_response();
                }
                Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            }
        }
    }
    let next_status = input.status.as_deref().unwrap_or(&old_status);
    let old_category: String = sqlx::query_scalar(
        "SELECT category FROM workspace_statuses WHERE workspace_id=$1 AND status_key=$2",
    )
    .bind(workspace)
    .bind(&old_status)
    .fetch_one(&state.pool)
    .await
    .unwrap_or_else(|_| "not_started".into());
    let next_category: String = sqlx::query_scalar(
        "SELECT category FROM workspace_statuses WHERE workspace_id=$1 AND status_key=$2",
    )
    .bind(workspace)
    .bind(next_status)
    .fetch_one(&state.pool)
    .await
    .unwrap_or_else(|_| "not_started".into());
    let old_completed_at: Option<String> = existing.get("completed_at");
    let new_completed_at = if next_category == "completed" {
        if old_category == "completed" {
            old_completed_at.clone()
        } else {
            sqlx::query_scalar::<_, String>("SELECT now()::text")
                .fetch_one(&state.pool)
                .await
                .ok()
        }
    } else {
        None
    };
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
    field_change!("status", old_status, input.status.as_ref().cloned());
    if old_completed_at != new_completed_at {
        changes.push((
            "completed_at".into(),
            json!(old_completed_at),
            json!(new_completed_at),
        ));
    }
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
    if let Some(mut requested) = input.watchers.take() {
        let current: Vec<Uuid> = sqlx::query_scalar(
            "SELECT user_id FROM task_watchers WHERE task_id=$1 ORDER BY user_id",
        )
        .bind(id)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default();
        requested.sort();
        requested.dedup();
        if requested != current {
            changes.push(("watchers".into(), json!(current), json!(requested)));
            input.watchers = Some(requested);
        }
    }
    let mut assignees_change = None;
    let assignees_before = match assignees_value(&state.pool, id).await {
        Ok(value) => value,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if let Some(requested) = input.assignees.take() {
        let requested = match normalize_assignees(requested) {
            Ok(value) => value,
            Err(()) => return StatusCode::UNPROCESSABLE_ENTITY.into_response(),
        };
        if requested != assignees_before {
            changes.push((
                "assignees".into(),
                assignees_before.clone(),
                requested.clone(),
            ));
            assignees_change = Some(requested);
        }
    }
    if changes.is_empty() && input.watchers.is_none() {
        return match task_row(&state.pool, workspace, number, false).await {
            Ok(Some(row)) => match serialize_task(&state.pool, &row, Some(user)).await {
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
    if let Some(status) = input.status.as_deref() {
        // FOR SHARE pairs with archive_status's FOR UPDATE so a Task cannot land on a Status
        // that is being archived.
        let valid = sqlx::query_scalar::<_, i32>("SELECT 1 FROM workspace_statuses WHERE workspace_id=$1 AND status_key=$2 AND archived_at IS NULL FOR SHARE").bind(workspace).bind(status).fetch_optional(&mut *tx).await.map(|row| row.is_some());
        match valid {
            Ok(true) => {}
            Ok(false) => return StatusCode::UNPROCESSABLE_ENTITY.into_response(),
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    }
    if let Some(requested) = assignees_change.as_ref() {
        match validate_assignees(&mut tx, workspace, new_project, requested).await {
            Ok(true) => {}
            Ok(false) => return StatusCode::UNPROCESSABLE_ENTITY.into_response(),
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    } else if new_project != old_project {
        match validate_assignees(&mut tx, workspace, new_project, &assignees_before).await {
            Ok(true) => {}
            Ok(false) => return StatusCode::UNPROCESSABLE_ENTITY.into_response(),
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    }
    if new_project != old_project {
        // The subtree moves with the Task, so every person attached to it must still be able
        // to read the destination Project (assignment never grants access).
        let attached: Vec<Uuid> = match sqlx::query_scalar("WITH RECURSIVE descendants(id) AS (SELECT id FROM tasks WHERE parent_task_id=$1 UNION SELECT t.id FROM tasks t JOIN descendants d ON t.parent_task_id=d.id) SELECT user_id FROM task_assignees WHERE task_id IN (SELECT id FROM descendants) AND user_id IS NOT NULL UNION SELECT user_id FROM task_watchers WHERE task_id IN (SELECT id FROM descendants) UNION SELECT user_id FROM task_watchers WHERE task_id=$1 AND $2")
            .bind(id)
            .bind(input.watchers.is_none())
            .fetch_all(&mut *tx)
            .await
        {
            Ok(users) => users,
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        };
        for person in attached {
            match can_read(&mut *tx, new_project, person).await {
                Ok(true) => {}
                Ok(false) => return StatusCode::UNPROCESSABLE_ENTITY.into_response(),
                Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            }
        }
    }
    let row=sqlx::query("UPDATE tasks SET title=COALESCE($3,title),description=COALESCE($4,description),status=COALESCE($5,status),priority=COALESCE($6,priority),start_date=CASE WHEN $7 THEN $8::date ELSE start_date END,due_date=CASE WHEN $9 THEN $10::date ELSE due_date END,completed_at=CASE WHEN $12 THEN $13::timestamptz ELSE completed_at END,project_id=$11,updated_at=now(),version=version+1 WHERE id=$1 AND version=$2 RETURNING id")
        .bind(id).bind(input.expected_version).bind(input.title.map(|v|v.trim().to_owned())).bind(input.description).bind(input.status).bind(input.priority).bind(input.start_date.is_some()).bind(input.start_date.flatten()).bind(input.due_date.is_some()).bind(input.due_date.flatten()).bind(new_project).bind(old_completed_at != new_completed_at).bind(new_completed_at).fetch_optional(&mut *tx).await;
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
    let description_changed = changes.iter().any(|(field, _, _)| field == "description");
    if description_changed {
        let body: String = match sqlx::query_scalar("SELECT description FROM tasks WHERE id=$1")
            .bind(id)
            .fetch_one(&mut *tx)
            .await
        {
            Ok(body) => body,
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        };
        if crate::task_reference_text::replace_index(
            &mut tx,
            workspace,
            id,
            "task_description",
            None,
            user,
            &body,
        )
        .await
        .is_err()
            || crate::note_reference_text::replace_index(
                &mut tx,
                workspace,
                id,
                "task_description",
                None,
                user,
                &body,
            )
            .await
            .is_err()
        {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
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
    if let Some(assignees) = assignees_change.as_ref() {
        if replace_assignees(&mut tx, id, workspace, assignees)
            .await
            .is_err()
        {
            return StatusCode::UNPROCESSABLE_ENTITY.into_response();
        }
    }
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    match task_row(&state.pool, workspace, number, false).await {
        Ok(Some(row)) => match serialize_task(&state.pool, &row, Some(user)).await {
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
struct TakeInput {
    expected_version: i64,
    command_id: Option<Uuid>,
}

async fn take_task(
    State(state): State<AuthState>,
    Path((workspace, number)): Path<(Uuid, i64)>,
    headers: HeaderMap,
    Json(input): Json<TakeInput>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let task = match sqlx::query("SELECT id,workspace_id,project_id,version FROM tasks WHERE workspace_id=$1 AND number=$2 AND archived_at IS NULL FOR UPDATE")
        .bind(workspace)
        .bind(number)
        .fetch_optional(&mut *tx)
        .await
    {
        Ok(Some(task)) => task,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let id: Uuid = task.get("id");
    let project: Uuid = task.get("project_id");
    match can_write(&mut *tx, project, user).await {
        Ok(true) => {}
        Ok(false) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    if task.get::<i64, _>("version") != input.expected_version {
        let _ = tx.rollback().await;
        return conflict(&state.pool, workspace, number).await;
    }
    let current = match assignees_value(&mut *tx, id).await {
        Ok(value) => value,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let team_ids: Vec<Uuid> = match sqlx::query_scalar(
        "SELECT team_id FROM team_memberships WHERE workspace_id=$1 AND user_id=$2 ORDER BY team_id",
    )
    .bind(workspace)
    .bind(user)
    .fetch_all(&mut *tx)
    .await
    {
        Ok(values) => values,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let mut after = current.clone();
    let Some(assignees) = after.as_array_mut() else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    assignees.retain(|assignee| {
        let is_member_team = assignee.get("type").and_then(Value::as_str) == Some("team")
            && assignee
                .get("id")
                .and_then(Value::as_str)
                .and_then(|id| Uuid::parse_str(id).ok())
                .is_some_and(|id| team_ids.contains(&id));
        !is_member_team
    });
    let already_assigned = assignees.iter().any(|assignee| {
        assignee.get("type").and_then(Value::as_str) == Some("user")
            && assignee
                .get("id")
                .and_then(Value::as_str)
                .and_then(|id| Uuid::parse_str(id).ok())
                == Some(user)
    });
    if !already_assigned {
        assignees.push(json!({"type":"user","id":user}));
    }
    assignees.sort_by_key(|assignee| {
        (
            assignee["type"].as_str().unwrap_or_default().to_owned(),
            assignee["id"].as_str().unwrap_or_default().to_owned(),
        )
    });
    if after != current {
        let version: i64 = match sqlx::query_scalar("UPDATE tasks SET version=version+1,updated_at=now() WHERE id=$1 AND version=$2 RETURNING version")
            .bind(id)
            .bind(input.expected_version)
            .fetch_optional(&mut *tx)
            .await
        {
            Ok(Some(version)) => version,
            Ok(None) => {
                let _ = tx.rollback().await;
                return conflict(&state.pool, workspace, number).await;
            }
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        };
        let command = input.command_id.unwrap_or_else(Uuid::new_v4);
        let group = Uuid::new_v4();
        if sqlx::query("INSERT INTO task_operation_groups(id,command_id,workspace_id,actor_id) VALUES($1,$2,$3,$4)")
            .bind(group)
            .bind(command)
            .bind(workspace)
            .bind(user)
            .execute(&mut *tx)
            .await
            .is_err()
            || sqlx::query("UPDATE task_operation_groups SET state='suppressed' WHERE workspace_id=$1 AND actor_id=$2 AND state='undone'")
                .bind(workspace)
                .bind(user)
                .execute(&mut *tx)
                .await
                .is_err()
            || sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,'assignees',$4,$5,$6)")
                .bind(Uuid::new_v4())
                .bind(group)
                .bind(id)
                .bind(&current)
                .bind(&after)
                .bind(version)
                .execute(&mut *tx)
                .await
                .is_err()
        {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        if replace_assignees(&mut tx, id, workspace, &after)
            .await
            .is_err()
        {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    match task_row(&state.pool, workspace, number, false).await {
        Ok(Some(row)) => match serialize_task(&state.pool, &row, Some(user)).await {
            Ok(value) => Json(value).into_response(),
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        },
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
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
    let mut statuses: Vec<String> = input
        .items
        .iter()
        .filter_map(|i| i.status.clone())
        .collect();
    statuses.sort();
    statuses.dedup();
    // Same order as archive_status: Status rows first, then Task rows.
    for status in &statuses {
        let valid = sqlx::query_scalar::<_, i32>("SELECT 1 FROM workspace_statuses WHERE workspace_id=$1 AND status_key=$2 AND archived_at IS NULL FOR SHARE").bind(workspace).bind(status).fetch_optional(&mut *tx).await.map(|row| row.is_some());
        match valid {
            Ok(true) => {}
            Ok(false) => return StatusCode::UNPROCESSABLE_ENTITY.into_response(),
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    }
    let mut plans: Vec<BulkPlan> = Vec::new();
    for item in input.items {
        let row=match sqlx::query("SELECT workspace_id,number,project_id,version,title,description,status,priority,completed_at::text AS completed_at FROM tasks WHERE id=$1 AND archived_at IS NULL FOR UPDATE").bind(item.task_id).fetch_optional(&mut *tx).await {Ok(Some(r))=>r,Ok(None)=>return StatusCode::NOT_FOUND.into_response(),Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response()};
        if row.get::<Uuid, _>("workspace_id") != workspace
            || !matches!(
                can_write(&mut *tx, row.get("project_id"), user).await,
                Ok(true)
            )
        {
            return StatusCode::NOT_FOUND.into_response();
        }
        if let Some(status) = item.status.as_deref() {
            let valid: bool = sqlx::query_scalar::<_, i32>("SELECT 1 FROM workspace_statuses WHERE workspace_id=$1 AND status_key=$2 AND archived_at IS NULL FOR SHARE").bind(workspace).bind(status).fetch_optional(&mut *tx).await.map(|row| row.is_some()).unwrap_or(false);
            if !valid {
                return StatusCode::UNPROCESSABLE_ENTITY.into_response();
            }
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
        if let Some(status) = item.status.as_deref() {
            let old_status: String = row.get("status");
            if status != old_status {
                let old_completed_at: Option<String> = row.get("completed_at");
                let new_completed_at = match completed_at_after_status_change(
                    &mut tx,
                    workspace,
                    &old_status,
                    status,
                    old_completed_at.clone(),
                )
                .await
                {
                    Ok(value) => value,
                    Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                };
                if old_completed_at != new_completed_at {
                    changes.push((
                        "completed_at".to_owned(),
                        json!(old_completed_at),
                        json!(new_completed_at),
                    ));
                }
            }
        }
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
        Ok(Some(row)) => match serialize_task(pool, &row, None).await {
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
        return match serialize_task(&state.pool, &row, Some(user)).await {
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
        Ok(Some(r)) => match serialize_task(&state.pool, &r, Some(user)).await {
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
    let result=sqlx::query("INSERT INTO tasks(id,workspace_id,number,project_id,title,description,status,priority,start_date,due_date,completed_at,created_by) SELECT $1,workspace_id,$2,project_id,title || ' (copy)',description,status,priority,start_date,due_date,CASE WHEN (SELECT category FROM workspace_statuses ws WHERE ws.workspace_id=tasks.workspace_id AND ws.status_key=tasks.status)='completed' THEN now() ELSE NULL END,$3 FROM tasks WHERE id=$4").bind(id).bind(new_number).bind(user).bind(source.get::<Uuid,_>("id")).execute(&mut *tx).await;
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
        Ok(Some(r)) => match serialize_task(&state.pool, &r, Some(user)).await {
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
        || !["blocks", "blocked_by", "related", "duplicate"].contains(&input.kind.as_str())
    {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    };
    let requested_kind = input.kind.as_str();
    let kind = if requested_kind == "blocked_by" {
        "blocks"
    } else {
        requested_kind
    };
    let (source, target) = if requested_kind == "blocked_by" {
        (input.target_task_id, source)
    } else {
        (source, input.target_task_id)
    };
    let rows = sqlx::query(
        "SELECT id,workspace_id,project_id FROM tasks WHERE id=ANY($1) AND archived_at IS NULL",
    )
    .bind(vec![source, target])
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
    let mut tx = match state.pool.begin().await {
        Ok(v) => v,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    // Serialize graph mutations in a Workspace so opposing requests cannot both validate
    // against the same acyclic snapshot and commit a cycle.
    if sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(workspace.to_string())
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let mut relation_source = source;
    let mut relation_target = target;
    if kind == "related" && relation_target < relation_source {
        std::mem::swap(&mut relation_source, &mut relation_target);
    }
    let already = sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM task_relations WHERE source_task_id=$1 AND target_task_id=$2 AND kind=$3)")
        .bind(relation_source).bind(relation_target).bind(kind).fetch_one(&mut *tx).await;
    match already {
        Ok(true) => {
            return (
                StatusCode::CONFLICT,
                Json(json!({"error":"relation_already_exists"})),
            )
                .into_response()
        }
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        Ok(false) => {}
    }
    if kind == "blocks" || kind == "duplicate" {
        let cycle = sqlx::query_scalar::<_, bool>("WITH RECURSIVE reachable(id) AS (SELECT target_task_id FROM task_relations WHERE source_task_id=$1 AND kind=$3 UNION SELECT r.target_task_id FROM task_relations r JOIN reachable p ON r.source_task_id=p.id WHERE r.kind=$3) SELECT EXISTS(SELECT 1 FROM reachable WHERE id=$2)")
            .bind(relation_target).bind(relation_source).bind(kind).fetch_one(&mut *tx).await;
        match cycle {
            Ok(true) => {
                return (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    Json(json!({"error":"relation_cycle"})),
                )
                    .into_response()
            }
            Ok(false) => {}
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    }
    if sqlx::query("INSERT INTO task_relations(workspace_id,source_task_id,target_task_id,kind) VALUES($1,$2,$3,$4)").bind(workspace).bind(relation_source).bind(relation_target).bind(kind).execute(&mut *tx).await.is_err(){return StatusCode::INTERNAL_SERVER_ERROR.into_response();}
    let versions = match sqlx::query(
        "UPDATE tasks SET version=version+1,updated_at=now() WHERE id=ANY($1) RETURNING id,version",
    )
    .bind(vec![relation_source, relation_target])
    .fetch_all(&mut *tx)
    .await
    {
        Ok(rows) => rows,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let group = Uuid::new_v4();
    let command = Uuid::new_v4();
    if sqlx::query("INSERT INTO task_operation_groups(id,command_id,workspace_id,actor_id) VALUES($1,$2,$3,$4)").bind(group).bind(command).bind(workspace).bind(user).execute(&mut *tx).await.is_err()
        || sqlx::query("UPDATE task_operation_groups SET state='suppressed' WHERE workspace_id=$1 AND actor_id=$2 AND state='undone'").bind(workspace).bind(user).execute(&mut *tx).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    for row in versions {
        let task_id: Uuid = row.get("id");
        let (prefix, other) = if task_id == relation_source {
            ("relation", relation_target)
        } else {
            ("relation_from", relation_source)
        };
        let field = format!("{prefix}/{other}/{kind}");
        if sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,$4,'false'::jsonb,'true'::jsonb,$5)")
            .bind(Uuid::new_v4()).bind(group).bind(task_id).bind(field).bind(row.get::<i64,_>("version")).execute(&mut *tx).await.is_err() {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    (StatusCode::CREATED,Json(json!({"source_task_id":relation_source,"target_task_id":relation_target,"kind":requested_kind}))).into_response()
}

async fn delete_relation(
    State(state): State<AuthState>,
    Path((source, target, requested_kind)): Path<(Uuid, Uuid, String)>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    if source == target
        || !["blocks", "blocked_by", "related", "duplicate"].contains(&requested_kind.as_str())
    {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let mut kind = requested_kind.as_str();
    let (source, target) = if kind == "blocked_by" {
        kind = "blocks";
        (target, source)
    } else {
        (source, target)
    };
    let rows = match sqlx::query("SELECT id,workspace_id,project_id,archived_at IS NOT NULL AS archived FROM tasks WHERE id=ANY($1)").bind(vec![source,target]).fetch_all(&state.pool).await { Ok(rows)=>rows, Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
    if rows.len() != 2 {
        return StatusCode::NOT_FOUND.into_response();
    }
    let workspace: Uuid = rows[0].get("workspace_id");
    if rows.iter().any(|row| {
        row.get::<Uuid, _>("workspace_id") != workspace || row.get::<bool, _>("archived")
    }) {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    for row in &rows {
        match can_write(&state.pool, row.get("project_id"), user).await {
            Ok(true) => {}
            Ok(false) => return StatusCode::NOT_FOUND.into_response(),
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    }
    let (mut relation_source, mut relation_target) = (source, target);
    if kind == "related" && relation_target < relation_source {
        std::mem::swap(&mut relation_source, &mut relation_target);
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(workspace.to_string())
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let deleted=sqlx::query("DELETE FROM task_relations WHERE workspace_id=$1 AND source_task_id=$2 AND target_task_id=$3 AND kind=$4").bind(workspace).bind(relation_source).bind(relation_target).bind(kind).execute(&mut *tx).await;
    match deleted {
        Ok(result) if result.rows_affected() == 1 => {}
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    let versions = match sqlx::query(
        "UPDATE tasks SET version=version+1,updated_at=now() WHERE id=ANY($1) RETURNING id,version",
    )
    .bind(vec![relation_source, relation_target])
    .fetch_all(&mut *tx)
    .await
    {
        Ok(rows) => rows,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let group = Uuid::new_v4();
    if sqlx::query("INSERT INTO task_operation_groups(id,command_id,workspace_id,actor_id) VALUES($1,$2,$3,$4)").bind(group).bind(Uuid::new_v4()).bind(workspace).bind(user).execute(&mut *tx).await.is_err()
        || sqlx::query("UPDATE task_operation_groups SET state='suppressed' WHERE workspace_id=$1 AND actor_id=$2 AND state='undone'").bind(workspace).bind(user).execute(&mut *tx).await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
    for row in versions {
        let id: Uuid = row.get("id");
        let (prefix, other) = if id == relation_source {
            ("relation", relation_target)
        } else {
            ("relation_from", relation_source)
        };
        let field = format!("{prefix}/{other}/{kind}");
        if sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,$4,'true'::jsonb,'false'::jsonb,$5)").bind(Uuid::new_v4()).bind(group).bind(id).bind(field).bind(row.get::<i64,_>("version")).execute(&mut *tx).await.is_err(){return StatusCode::INTERNAL_SERVER_ERROR.into_response();}
    }
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    StatusCode::NO_CONTENT.into_response()
}
#[derive(Deserialize)]
struct RelationInput {
    target_task_id: Uuid,
    kind: String,
}

#[derive(Deserialize)]
struct ChecklistCreate {
    title: String,
}

#[derive(Deserialize)]
struct ChecklistUpdate {
    expected_version: i64,
    title: Option<String>,
    checked: Option<bool>,
}

async fn checklist_task(
    pool: &PgPool,
    task: Uuid,
    user: Uuid,
    write: bool,
) -> Result<Option<(Uuid, Uuid, bool)>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT workspace_id,project_id,archived_at IS NOT NULL AS archived FROM tasks WHERE id=$1",
    )
    .bind(task)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let project: Uuid = row.get("project_id");
    let allowed = if write {
        can_write(pool, project, user).await?
    } else {
        can_read(pool, project, user).await?
    };
    if !allowed {
        return Ok(None);
    }
    Ok(Some((
        row.get("workspace_id"),
        project,
        row.get("archived"),
    )))
}

async fn list_checklist(
    State(state): State<AuthState>,
    Path(task): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    match checklist_task(&state.pool, task, user, false).await {
        Ok(Some(_)) => match sqlx::query("SELECT id,title,checked,position,version FROM task_checklist_items WHERE task_id=$1 ORDER BY position,created_at,id").bind(task).fetch_all(&state.pool).await {
            Ok(rows) => Json(json!({"items":rows.into_iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"title":r.get::<String,_>("title"),"checked":r.get::<bool,_>("checked"),"position":r.get::<i32,_>("position"),"version":r.get::<i64,_>("version")})).collect::<Vec<_>>()})).into_response(),
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        },
        Ok(None) => StatusCode::NOT_FOUND.into_response(), Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn create_checklist_item(
    State(state): State<AuthState>,
    Path(task): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<ChecklistCreate>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    if input.title.trim().is_empty() {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let (workspace, _, archived) = match checklist_task(&state.pool, task, user, true).await {
        Ok(Some(v)) => v,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if archived {
        return StatusCode::CONFLICT.into_response();
    }
    let mut tx = match state.pool.begin().await {
        Ok(v) => v,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let position: i32 = sqlx::query_scalar(
        "SELECT COALESCE(max(position)+1,0) FROM task_checklist_items WHERE task_id=$1",
    )
    .bind(task)
    .fetch_one(&mut *tx)
    .await
    .unwrap_or(0);
    let id = Uuid::new_v4();
    let value =
        json!({"id":id,"title":input.title.trim(),"checked":false,"position":position,"version":1});
    if sqlx::query("INSERT INTO task_checklist_items(id,workspace_id,task_id,title,position) VALUES($1,$2,$3,$4,$5)").bind(id).bind(workspace).bind(task).bind(input.title.trim()).bind(position).execute(&mut *tx).await.is_err() { return StatusCode::UNPROCESSABLE_ENTITY.into_response(); }
    let task_version: i64 = match sqlx::query_scalar(
        "UPDATE tasks SET version=version+1,updated_at=now() WHERE id=$1 RETURNING version",
    )
    .bind(task)
    .fetch_one(&mut *tx)
    .await
    {
        Ok(v) => v,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if record_task_operation(
        &mut tx,
        TaskOperationRecord {
            workspace,
            user,
            task,
            field: &format!("checklist/{id}"),
            before: &Value::Null,
            after: &value,
            task_version,
        },
    )
    .await
    .is_err()
        || tx.commit().await.is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    (StatusCode::CREATED, Json(value)).into_response()
}

async fn update_checklist_item(
    State(state): State<AuthState>,
    Path((task, item)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(input): Json<ChecklistUpdate>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let (workspace, _, archived) = match checklist_task(&state.pool, task, user, true).await {
        Ok(Some(v)) => v,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if archived {
        return StatusCode::CONFLICT.into_response();
    }
    let mut tx = match state.pool.begin().await {
        Ok(v) => v,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let row = match sqlx::query("SELECT id,title,checked,position,version FROM task_checklist_items WHERE id=$1 AND task_id=$2 FOR UPDATE").bind(item).bind(task).fetch_optional(&mut *tx).await { Ok(Some(v))=>v, Ok(None)=>return StatusCode::NOT_FOUND.into_response(), Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
    let version: i64 = row.get("version");
    if version != input.expected_version {
        return StatusCode::CONFLICT.into_response();
    }
    let before = json!({"id":item,"title":row.get::<String,_>("title"),"checked":row.get::<bool,_>("checked"),"position":row.get::<i32,_>("position"),"version":version});
    let title = input.title.unwrap_or_else(|| row.get("title"));
    if title.trim().is_empty() {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let checked = input.checked.unwrap_or_else(|| row.get("checked"));
    let after = json!({"id":item,"title":title.trim(),"checked":checked,"position":row.get::<i32,_>("position"),"version":version+1});
    if before == after {
        let _ = tx.rollback().await;
        return Json(before).into_response();
    }
    if sqlx::query(
        "UPDATE task_checklist_items SET title=$2,checked=$3,version=version+1 WHERE id=$1",
    )
    .bind(item)
    .bind(title.trim())
    .bind(checked)
    .execute(&mut *tx)
    .await
    .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let task_version: i64 = match sqlx::query_scalar(
        "UPDATE tasks SET version=version+1,updated_at=now() WHERE id=$1 RETURNING version",
    )
    .bind(task)
    .fetch_one(&mut *tx)
    .await
    {
        Ok(v) => v,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if record_task_operation(
        &mut tx,
        TaskOperationRecord {
            workspace,
            user,
            task,
            field: &format!("checklist/{item}"),
            before: &before,
            after: &after,
            task_version,
        },
    )
    .await
    .is_err()
        || tx.commit().await.is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    Json(after).into_response()
}

async fn delete_checklist_item(
    State(state): State<AuthState>,
    Path((task, item)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let (workspace, _, archived) = match checklist_task(&state.pool, task, user, true).await {
        Ok(Some(v)) => v,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if archived {
        return StatusCode::CONFLICT.into_response();
    }
    let mut tx = match state.pool.begin().await {
        Ok(v) => v,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let row = match sqlx::query("SELECT id,title,checked,position,version FROM task_checklist_items WHERE id=$1 AND task_id=$2 FOR UPDATE").bind(item).bind(task).fetch_optional(&mut *tx).await { Ok(Some(v))=>v, Ok(None)=>return StatusCode::NOT_FOUND.into_response(), Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
    let before = json!({"id":item,"title":row.get::<String,_>("title"),"checked":row.get::<bool,_>("checked"),"position":row.get::<i32,_>("position"),"version":row.get::<i64,_>("version")});
    if sqlx::query("DELETE FROM task_checklist_items WHERE id=$1")
        .bind(item)
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let task_version: i64 = match sqlx::query_scalar(
        "UPDATE tasks SET version=version+1,updated_at=now() WHERE id=$1 RETURNING version",
    )
    .bind(task)
    .fetch_one(&mut *tx)
    .await
    {
        Ok(v) => v,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if record_task_operation(
        &mut tx,
        TaskOperationRecord {
            workspace,
            user,
            task,
            field: &format!("checklist/{item}"),
            before: &before,
            after: &Value::Null,
            task_version,
        },
    )
    .await
    .is_err()
        || tx.commit().await.is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    StatusCode::NO_CONTENT.into_response()
}

struct TaskOperationRecord<'a> {
    workspace: Uuid,
    user: Uuid,
    task: Uuid,
    field: &'a str,
    before: &'a Value,
    after: &'a Value,
    task_version: i64,
}

/// `completed_at` after a Task moves between Statuses: set when it enters a completed
/// category, kept while it stays in one, cleared when it leaves.
async fn completed_at_after_status_change(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace: Uuid,
    old_status: &str,
    new_status: &str,
    old_completed_at: Option<String>,
) -> Result<Option<String>, sqlx::Error> {
    let new_category: String = sqlx::query_scalar(
        "SELECT category FROM workspace_statuses WHERE workspace_id=$1 AND status_key=$2",
    )
    .bind(workspace)
    .bind(new_status)
    .fetch_one(&mut **tx)
    .await?;
    if new_category != "completed" {
        return Ok(None);
    }
    let old_category: Option<String> = sqlx::query_scalar(
        "SELECT category FROM workspace_statuses WHERE workspace_id=$1 AND status_key=$2",
    )
    .bind(workspace)
    .bind(old_status)
    .fetch_optional(&mut **tx)
    .await?;
    if old_category.as_deref() == Some("completed") && old_completed_at.is_some() {
        return Ok(old_completed_at);
    }
    sqlx::query_scalar::<_, String>("SELECT now()::text")
        .fetch_one(&mut **tx)
        .await
        .map(Some)
}

/// Moves every live Task from one Status key to another, or only reconciles `completed_at`
/// when the keys are equal (a Status changed category). The writes form one ledger group so
/// per-Task history shows them and the actor can undo them together.
pub(crate) async fn restate_tasks(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace: Uuid,
    user: Uuid,
    from_key: &str,
    to_key: &str,
) -> Result<i64, sqlx::Error> {
    let rows = sqlx::query("SELECT id,version,completed_at::text AS completed_at FROM tasks WHERE workspace_id=$1 AND status=$2 ORDER BY id FOR UPDATE")
        .bind(workspace)
        .bind(from_key)
        .fetch_all(&mut **tx)
        .await?;
    let mut plans = Vec::new();
    for row in rows {
        let old_completed_at: Option<String> = row.get("completed_at");
        let new_completed_at = completed_at_after_status_change(
            tx,
            workspace,
            from_key,
            to_key,
            old_completed_at.clone(),
        )
        .await?;
        let mut changes: Vec<FieldChange> = Vec::new();
        if from_key != to_key {
            changes.push(("status".into(), json!(from_key), json!(to_key)));
        }
        if old_completed_at != new_completed_at {
            changes.push((
                "completed_at".into(),
                json!(old_completed_at),
                json!(new_completed_at),
            ));
        }
        if !changes.is_empty() {
            plans.push((
                row.get::<Uuid, _>("id"),
                row.get::<i64, _>("version"),
                changes,
            ));
        }
    }
    if plans.is_empty() {
        return Ok(0);
    }
    let group = Uuid::new_v4();
    // 'recorded': visible in Task history, never the actor's undo target, so a Status that
    // can no longer be restored cannot block the rest of the undo stack.
    sqlx::query("INSERT INTO task_operation_groups(id,command_id,workspace_id,actor_id,state) VALUES($1,$2,$3,$4,'recorded')").bind(group).bind(Uuid::new_v4()).bind(workspace).bind(user).execute(&mut **tx).await?;
    let moved = plans.len() as i64;
    for (task, version, changes) in plans {
        for (field, _, after) in &changes {
            set_field(tx, task, field, after).await?;
        }
        let new_version: i64 = sqlx::query_scalar("UPDATE tasks SET version=version+1,updated_at=now() WHERE id=$1 AND version=$2 RETURNING version").bind(task).bind(version).fetch_one(&mut **tx).await?;
        for (field, before, after) in changes {
            sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(Uuid::new_v4()).bind(group).bind(task).bind(field).bind(before).bind(after).bind(new_version).execute(&mut **tx).await?;
        }
    }
    Ok(moved)
}

async fn record_task_operation(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    operation: TaskOperationRecord<'_>,
) -> Result<(), sqlx::Error> {
    let TaskOperationRecord {
        workspace,
        user,
        task,
        field,
        before,
        after,
        task_version,
    } = operation;
    let group = Uuid::new_v4();
    sqlx::query("INSERT INTO task_operation_groups(id,command_id,workspace_id,actor_id) VALUES($1,$2,$3,$4)").bind(group).bind(Uuid::new_v4()).bind(workspace).bind(user).execute(&mut **tx).await?;
    sqlx::query("UPDATE task_operation_groups SET state='suppressed' WHERE workspace_id=$1 AND actor_id=$2 AND state='undone'").bind(workspace).bind(user).execute(&mut **tx).await?;
    sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(Uuid::new_v4()).bind(group).bind(task).bind(field).bind(before).bind(after).bind(task_version).execute(&mut **tx).await?;
    Ok(())
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
    let rows = match sqlx::query("SELECT o.id,o.group_id,o.field_key,o.before_value,o.after_value,o.task_version,o.suppressed,g.actor_id,g.created_at::text AS created_at,g.state,g.source_run_id,g.source_proposal_id,g.source_provider FROM task_operations o JOIN task_operation_groups g ON g.id=o.group_id WHERE o.task_id=$1 ORDER BY o.created_at,o.id").bind(id).fetch_all(&state.pool).await { Ok(v)=>v,Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
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
        if field.starts_with("relation/") || field.starts_with("relation_from/") {
            let prefix = if field.starts_with("relation_from/") {
                "relation_from/"
            } else {
                "relation/"
            };
            let Some(peer) = field
                .trim_start_matches(prefix)
                .split('/')
                .next()
                .and_then(|value| Uuid::parse_str(value).ok())
            else {
                continue;
            };
            let project =
                match sqlx::query_scalar::<_, Uuid>("SELECT project_id FROM tasks WHERE id=$1")
                    .bind(peer)
                    .fetch_optional(&state.pool)
                    .await
                {
                    Ok(Some(project)) => project,
                    Ok(None) => continue,
                    Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                };
            if !matches!(can_read(&state.pool, project, user).await, Ok(true)) {
                continue;
            }
        }
        let actor: Uuid = row.get("actor_id");
        // Changes created from an approved AI Proposal name the run, provider and Proposal.
        let source = match row.get::<Option<Uuid>, _>("source_run_id") {
            Some(run) => {
                json!({"kind":"ai_proposal","run_id":run,"proposal_id":row.get::<Option<Uuid>,_>("source_proposal_id"),"provider":row.get::<Option<String>,_>("source_provider")})
            }
            None => Value::Null,
        };
        if let Some(previous) = visible.iter_mut().rev().find(|v| v["field"] == field) {
            // Repeated changes compact only for the same person and the same source: never across
            // different AI runs, nor between an AI-created change and a hand edit.
            if previous["actor_id"] == json!(actor) && previous["source"] == source {
                previous["after"] = row.get::<Value, _>("after_value");
                previous["version"] = json!(row.get::<i64, _>("task_version"));
                previous["suppressed"] = json!(false);
                if previous["before"] == previous["after"] {
                    previous["suppressed"] = json!(true);
                }
                continue;
            }
        }
        visible.push(json!({"id":row.get::<Uuid,_>("id"),"group_id":row.get::<Uuid,_>("group_id"),"actor_id":actor,"created_at":row.get::<String,_>("created_at"),"field":field,"before":row.get::<Value,_>("before_value"),"after":row.get::<Value,_>("after_value"),"version":row.get::<i64,_>("task_version"),"source":source,"suppressed":false}));
    }
    visible.retain(|v| !v["suppressed"].as_bool().unwrap_or(false));
    Json(json!({"operations":visible})).into_response()
}

async fn undo_latest(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    apply_history(state, workspace, headers, false, false).await
}
// Runs the same eligibility and precondition checks as undo and rolls back, so a UI can show why
// Undo is disabled without performing it.
async fn preview_undo(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    apply_history(state, workspace, headers, false, true).await
}
async fn preview_redo(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    apply_history(state, workspace, headers, true, true).await
}
async fn redo_latest(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    apply_history(state, workspace, headers, true, false).await
}

async fn apply_history(
    state: AuthState,
    workspace: Uuid,
    headers: HeaderMap,
    redo: bool,
    dry_run: bool,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, !dry_run).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let target_state = if redo { "undone" } else { "active" };
    let group=match sqlx::query("SELECT g.id FROM task_operation_groups g WHERE g.workspace_id=$1 AND g.actor_id=$2 AND g.state=$3 AND EXISTS (SELECT 1 FROM task_operations o WHERE o.group_id=g.id) ORDER BY CASE WHEN $3='undone' THEN -extract(epoch FROM g.created_at) ELSE extract(epoch FROM g.created_at) END DESC LIMIT 1").bind(workspace).bind(user).bind(target_state).fetch_optional(&state.pool).await { Ok(Some(r))=>r.get::<Uuid,_>("id"),Ok(None)=>return (StatusCode::CONFLICT,Json(json!({"error":"undo_unavailable","reason":"No eligible operation group"}))).into_response(),Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
    let mut tx = match state.pool.begin().await {
        Ok(t) => t,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let has_relation: bool = match sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM task_operations WHERE group_id=$1 AND (field_key LIKE 'relation/%' OR field_key LIKE 'relation_from/%'))").bind(group).fetch_one(&mut *tx).await {
        Ok(v) => v,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if has_relation {
        // Same lock, and same position before any Task row lock, as create_relation and
        // delete_relation, so a restore cannot race a new edge or deadlock with one.
        if sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
            .bind(workspace.to_string())
            .execute(&mut *tx)
            .await
            .is_err()
        {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    let operations=match sqlx::query("SELECT o.task_id,o.field_key,o.before_value,o.after_value,t.workspace_id,t.number,t.project_id,t.version,t.archived_at IS NOT NULL AS archived FROM task_operations o JOIN tasks t ON t.id=o.task_id WHERE o.group_id=$1 ORDER BY o.task_id,o.field_key FOR UPDATE OF t").bind(group).fetch_all(&mut *tx).await {Ok(v)=>v,Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response()};
    if operations.is_empty() {
        return StatusCode::CONFLICT.into_response();
    }
    let mut assignee_projects = std::collections::HashMap::new();
    for op in &operations {
        if op.get::<String, _>("field_key") == "project_id" {
            let destination = if redo {
                op.get::<Value, _>("after_value")
            } else {
                op.get::<Value, _>("before_value")
            };
            if let Some(destination) = destination
                .as_str()
                .and_then(|value| Uuid::parse_str(value).ok())
            {
                assignee_projects.insert(op.get::<Uuid, _>("task_id"), destination);
            }
        }
    }
    let mut conflicts = Vec::new();
    for op in &operations {
        let task: Uuid = op.get("task_id");
        let project: Uuid = op.get("project_id");
        let field: String = op.get("field_key");
        let task_workspace: Uuid = op.get("workspace_id");
        if field != "archived" && op.get::<bool, _>("archived") {
            conflicts.push(json!({"task_id":task,"field":field,"cause":"task is archived"}));
            continue;
        }
        match can_write(&mut *tx, project, user).await {
            Ok(true) => {}
            Ok(false) => {
                conflicts.push(json!({"task_id":task,"cause":"write access was removed"}));
                continue;
            }
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
        if field == "watchers" {
            let restored = if redo {
                op.get::<Value, _>("after_value")
            } else {
                op.get::<Value, _>("before_value")
            };
            for watcher in restored
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().and_then(|v| Uuid::parse_str(v).ok()))
            {
                match can_read(&mut *tx, project, watcher).await {
                    Ok(true) => {}
                    Ok(false) => {
                        conflicts.push(json!({"task_id":task,"field":field,"cause":"a watcher no longer has access"}));
                        break;
                    }
                    Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                }
            }
        }
        if field == "status" {
            let restored = if redo {
                op.get::<Value, _>("after_value")
            } else {
                op.get::<Value, _>("before_value")
            };
            let active: bool = match sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_statuses WHERE workspace_id=$1 AND status_key=$2 AND archived_at IS NULL)")
                .bind(task_workspace)
                .bind(restored.as_str().unwrap_or_default())
                .fetch_one(&mut *tx)
                .await
            {
                Ok(active) => active,
                Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            };
            if !active {
                conflicts
                    .push(json!({"task_id":task,"field":field,"cause":"the Status is archived"}));
            }
        }
        if field == "assignees" {
            let restored = if redo {
                op.get::<Value, _>("after_value")
            } else {
                op.get::<Value, _>("before_value")
            };
            let assignee_project = assignee_projects.get(&task).copied().unwrap_or(project);
            match validate_assignees(
                &mut tx,
                op.get("workspace_id"),
                assignee_project,
                &restored,
            )
            .await
            {
                Ok(true) => {}
                Ok(false) => conflicts.push(json!({"task_id":task,"field":field,"cause":"an assignee can no longer read the Project"})),
                Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            }
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
        let referenced = if field == "parent_task_id" {
            let value = if redo {
                op.get::<Value, _>("after_value")
            } else {
                op.get::<Value, _>("before_value")
            };
            value.as_str().and_then(|id| Uuid::parse_str(id).ok())
        } else if field.starts_with("relation/") || field.starts_with("relation_from/") {
            let prefix = if field.starts_with("relation_from/") {
                "relation_from/"
            } else {
                "relation/"
            };
            field
                .trim_start_matches(prefix)
                .split('/')
                .next()
                .and_then(|id| Uuid::parse_str(id).ok())
        } else {
            None
        };
        if let Some(referenced) = referenced {
            let target = match sqlx::query("SELECT workspace_id,project_id,archived_at IS NOT NULL AS archived FROM tasks WHERE id=$1")
                .bind(referenced).fetch_optional(&mut *tx).await {
                Ok(Some(target)) => target,
                Ok(None) => { conflicts.push(json!({"task_id":task,"field":field,"cause":"referenced task no longer exists"})); continue; },
                Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            };
            if target.get::<Uuid, _>("workspace_id") != task_workspace
                || target.get::<bool, _>("archived")
            {
                conflicts.push(json!({"task_id":task,"field":field,"cause":"referenced task is archived or outside the Workspace"}));
                continue;
            }
            match can_write(&mut *tx, target.get("project_id"), user).await {
                Ok(true) => {}
                Ok(false) => {
                    conflicts.push(json!({"task_id":task,"field":field,"cause":"write access to referenced task was removed"}));
                    continue;
                }
                Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            }
            if field == "parent_task_id" && target.get::<Uuid, _>("project_id") != project {
                conflicts.push(json!({"task_id":task,"field":field,"cause":"parent task moved to another Project"}));
                continue;
            }
            if redo && field == "parent_task_id" {
                let would_cycle = match sqlx::query_scalar::<_, bool>("WITH RECURSIVE descendants(id) AS (SELECT id FROM tasks WHERE parent_task_id=$1 UNION SELECT t.id FROM tasks t JOIN descendants d ON t.parent_task_id=d.id) SELECT EXISTS(SELECT 1 FROM descendants WHERE id=$2)")
                    .bind(task).bind(referenced).fetch_one(&mut *tx).await { Ok(value)=>value, Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
                if would_cycle {
                    conflicts.push(json!({"task_id":task,"field":field,"cause":"restoring the parent would create a cycle"}));
                    continue;
                }
            }
            let restoring_relation = if redo {
                op.get::<Value, _>("after_value")
            } else {
                op.get::<Value, _>("before_value")
            }
            .as_bool()
            .unwrap_or(false);
            if restoring_relation
                && (field.starts_with("relation/") || field.starts_with("relation_from/"))
            {
                let prefix = if field.starts_with("relation_from/") {
                    "relation_from/"
                } else {
                    "relation/"
                };
                let kind = field
                    .trim_start_matches(prefix)
                    .split('/')
                    .nth(1)
                    .unwrap_or_default();
                if kind == "blocks" || kind == "duplicate" {
                    let (source, destination) = if field.starts_with("relation_from/") {
                        (referenced, task)
                    } else {
                        (task, referenced)
                    };
                    let would_cycle = match sqlx::query_scalar::<_, bool>("WITH RECURSIVE reachable(id) AS (SELECT target_task_id FROM task_relations WHERE source_task_id=$1 AND kind=$3 UNION SELECT r.target_task_id FROM task_relations r JOIN reachable p ON r.source_task_id=p.id WHERE r.kind=$3) SELECT EXISTS(SELECT 1 FROM reachable WHERE id=$2)")
                        .bind(destination).bind(source).bind(kind).fetch_one(&mut *tx).await { Ok(value)=>value, Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
                    if would_cycle {
                        conflicts.push(json!({"task_id":task,"field":field,"cause":"restoring the relation would create a cycle"}));
                        continue;
                    }
                }
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
    if dry_run {
        let _ = tx.rollback().await;
        return Json(json!({"available":true,"group_id":group})).into_response();
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
        if field == "description" {
            let workspace: Uuid = op.get("workspace_id");
            let body: String = match sqlx::query_scalar("SELECT description FROM tasks WHERE id=$1")
                .bind(task)
                .fetch_one(&mut *tx)
                .await
            {
                Ok(body) => body,
                Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            };
            if crate::task_reference_text::replace_index(
                &mut tx,
                workspace,
                task,
                "task_description",
                None,
                user,
                &body,
            )
            .await
            .is_err()
                || crate::note_reference_text::replace_index(
                    &mut tx,
                    workspace,
                    task,
                    "task_description",
                    None,
                    user,
                    &body,
                )
                .await
                .is_err()
            {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
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
    if !redo && sqlx::query("UPDATE notification_intents SET retracted_at=now() WHERE operation_group_id=$1 AND read_at IS NULL AND retracted_at IS NULL")
        .bind(group).execute(&mut *tx).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
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
        Ok(Some(r)) => match serialize_task(&state.pool, &r, Some(user)).await {
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
        "completed_at" => "SELECT COALESCE(to_jsonb(completed_at::text),'null'::jsonb) AS value FROM tasks WHERE id=$1",
        "project_id" => "SELECT to_jsonb(project_id) AS value FROM tasks WHERE id=$1",
        "parent_task_id" => "SELECT COALESCE(to_jsonb(parent_task_id),'null'::jsonb) AS value FROM tasks WHERE id=$1",
        "archived" => "SELECT to_jsonb(archived_at IS NOT NULL) AS value FROM tasks WHERE id=$1",
        value if value.starts_with("attribute/") => {
            let Ok(attribute) = Uuid::parse_str(value.trim_start_matches("attribute/")) else { return Ok(None) };
            return sqlx::query_scalar("SELECT COALESCE((SELECT value FROM task_attribute_values WHERE task_id=$1 AND attribute_id=$2),'null'::jsonb)")
                .bind(task).bind(attribute).fetch_optional(&mut **tx).await;
        }
        value if value.starts_with("list_membership:") => {
            let Ok(list) = Uuid::parse_str(value.trim_start_matches("list_membership:")) else { return Ok(None) };
            return sqlx::query_scalar("SELECT to_jsonb(EXISTS(SELECT 1 FROM task_list_memberships WHERE task_id=$1 AND list_id=$2))")
                .bind(task).bind(list).fetch_optional(&mut **tx).await;
        }
        "watchers" => "SELECT COALESCE((SELECT jsonb_agg(user_id ORDER BY user_id) FROM task_watchers WHERE task_id=$1),'[]'::jsonb) AS value FROM tasks WHERE id=$1",
        "assignees" => "SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('type',kind,'id',id) ORDER BY kind,id) FROM (SELECT CASE WHEN user_id IS NULL THEN 'team' ELSE 'user' END AS kind,COALESCE(user_id,team_id) AS id FROM task_assignees WHERE task_id=$1) a),'[]'::jsonb) AS value FROM tasks WHERE id=$1",
        value if value.starts_with("relation/") || value.starts_with("relation_from/") => {
            let from = value.starts_with("relation_from/");
            let prefix = if from { "relation_from/" } else { "relation/" };
            let Some((target,kind))=value.trim_start_matches(prefix).split_once('/') else {return Ok(None)};
            let Ok(target)=Uuid::parse_str(target) else {return Ok(None)};
            let (source, destination) = if from { (target, task) } else { (task, target) };
            let exists=if kind == "related" {
                sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM task_relations WHERE kind='related' AND ((source_task_id=$1 AND target_task_id=$2) OR (source_task_id=$2 AND target_task_id=$1)))").bind(source).bind(destination).fetch_one(&mut **tx).await?
            } else {
                sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM task_relations WHERE source_task_id=$1 AND target_task_id=$2 AND kind=$3)").bind(source).bind(destination).bind(kind).fetch_one(&mut **tx).await?
            };
            return Ok(Some(json!(exists)));
        }
        value if value.starts_with("checklist/") => {
            let Ok(item) = Uuid::parse_str(value.trim_start_matches("checklist/")) else {
                return Ok(None);
            };
            return sqlx::query_scalar("SELECT COALESCE((SELECT jsonb_build_object('id',id,'title',title,'checked',checked,'position',position,'version',version) FROM task_checklist_items WHERE id=$1 AND task_id=$2),'null'::jsonb)")
                .bind(item).bind(task).fetch_optional(&mut **tx).await;
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
        key if key.starts_with("list_membership:") => {
            let Ok(list) = Uuid::parse_str(key.trim_start_matches("list_membership:")) else {
                return Ok(());
            };
            if value.as_bool().unwrap_or(false) {
                sqlx::query("INSERT INTO task_list_memberships(workspace_id,list_id,task_id,position) SELECT t.workspace_id,l.id,t.id,COALESCE((SELECT MAX(position)+1 FROM task_list_memberships WHERE list_id=l.id),0) FROM tasks t JOIN task_lists l ON l.workspace_id=t.workspace_id WHERE t.id=$1 AND l.id=$2 ON CONFLICT(list_id,task_id) DO NOTHING")
                    .bind(task).bind(list).execute(&mut **tx).await?;
            } else {
                sqlx::query("DELETE FROM task_list_memberships WHERE task_id=$1 AND list_id=$2")
                    .bind(task)
                    .bind(list)
                    .execute(&mut **tx)
                    .await?;
            }
        }
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
        "completed_at" => {
            sqlx::query("UPDATE tasks SET completed_at=$2::timestamptz WHERE id=$1")
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
        "parent_task_id" => {
            sqlx::query("UPDATE tasks SET parent_task_id=$2 WHERE id=$1")
                .bind(task)
                .bind(value.as_str().and_then(|v| Uuid::parse_str(v).ok()))
                .execute(&mut **tx)
                .await?;
        }
        "watchers" => {
            let watchers: Vec<Uuid> = value
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|v| v.as_str().and_then(|v| Uuid::parse_str(v).ok()))
                        .collect()
                })
                .unwrap_or_default();
            sqlx::query("DELETE FROM task_watchers WHERE task_id=$1")
                .bind(task)
                .execute(&mut **tx)
                .await?;
            sqlx::query("INSERT INTO task_watchers(workspace_id,task_id,user_id) SELECT t.workspace_id,t.id,u FROM tasks t, unnest($2::uuid[]) u WHERE t.id=$1")
                .bind(task)
                .bind(watchers)
                .execute(&mut **tx)
                .await?;
        }
        "assignees" => {
            let workspace: Uuid = sqlx::query_scalar("SELECT workspace_id FROM tasks WHERE id=$1")
                .bind(task)
                .fetch_one(&mut **tx)
                .await?;
            replace_assignees(tx, task, workspace, value).await?;
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
        field_name
            if field_name.starts_with("relation/") || field_name.starts_with("relation_from/") =>
        {
            let from = field_name.starts_with("relation_from/");
            let prefix = if from { "relation_from/" } else { "relation/" };
            let Some((target, kind)) = field_name.trim_start_matches(prefix).split_once('/') else {
                return Ok(());
            };
            let Ok(target) = Uuid::parse_str(target) else {
                return Ok(());
            };
            let (mut source, mut destination) = if from { (target, task) } else { (task, target) };
            if kind == "related" && destination < source {
                std::mem::swap(&mut source, &mut destination);
            }
            if value.as_bool().unwrap_or(false) {
                sqlx::query("INSERT INTO task_relations(workspace_id,source_task_id,target_task_id,kind) SELECT workspace_id,$1,$2,$3 FROM tasks WHERE id=$1 ON CONFLICT DO NOTHING")
                    .bind(source).bind(destination).bind(kind).execute(&mut **tx).await?;
            } else {
                sqlx::query("DELETE FROM task_relations WHERE source_task_id=$1 AND target_task_id=$2 AND kind=$3")
                    .bind(source).bind(destination).bind(kind).execute(&mut **tx).await?;
            }
        }
        field_name if field_name.starts_with("checklist/") => {
            let Ok(item) = Uuid::parse_str(field_name.trim_start_matches("checklist/")) else {
                return Ok(());
            };
            if value.is_null() {
                sqlx::query("DELETE FROM task_checklist_items WHERE id=$1 AND task_id=$2")
                    .bind(item)
                    .bind(task)
                    .execute(&mut **tx)
                    .await?;
            } else {
                sqlx::query("INSERT INTO task_checklist_items(id,workspace_id,task_id,title,checked,position,version) SELECT $1,workspace_id,id,$3,$4,$5,$6 FROM tasks WHERE id=$2 ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,checked=EXCLUDED.checked,position=EXCLUDED.position,version=EXCLUDED.version")
                    .bind(item).bind(task).bind(value["title"].as_str().unwrap_or_default()).bind(value["checked"].as_bool().unwrap_or(false)).bind(value["position"].as_i64().unwrap_or(0) as i32).bind(value["version"].as_i64().unwrap_or(1)).execute(&mut **tx).await?;
            }
        }
        field_name if field_name.starts_with("attribute/") => {
            let Ok(attribute) = Uuid::parse_str(field_name.trim_start_matches("attribute/")) else {
                return Ok(());
            };
            if value.is_null() {
                sqlx::query(
                    "DELETE FROM task_attribute_values WHERE task_id=$1 AND attribute_id=$2",
                )
                .bind(task)
                .bind(attribute)
                .execute(&mut **tx)
                .await?;
            } else {
                let workspace: Uuid =
                    sqlx::query_scalar("SELECT workspace_id FROM tasks WHERE id=$1")
                        .bind(task)
                        .fetch_one(&mut **tx)
                        .await?;
                sqlx::query("INSERT INTO task_attribute_values(workspace_id,task_id,attribute_id,value) VALUES($1,$2,$3,$4) ON CONFLICT(task_id,attribute_id) DO UPDATE SET value=EXCLUDED.value,updated_at=now()")
                    .bind(workspace).bind(task).bind(attribute).bind(value).execute(&mut **tx).await?;
            }
        }
        _ => {}
    }
    Ok(())
}
