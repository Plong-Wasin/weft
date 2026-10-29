use crate::{
    auth::{require_session, AuthState},
    tasks::{can_read, can_write, serialize_task},
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route(
            "/workspaces/:workspace_id/lists",
            get(list_lists).post(create_list),
        )
        .route(
            "/workspaces/:workspace_id/lists/:list_id",
            get(read_list).patch(update_list),
        )
        .route("/lists/:list_id/tasks", axum::routing::post(add_task))
        .route(
            "/lists/:list_id/tasks/:task_id",
            axum::routing::delete(remove_task),
        )
}

fn auth_error(status: StatusCode) -> Response {
    status.into_response()
}
async fn is_member(pool: &PgPool, workspace: Uuid, user: Uuid) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2)",
    )
    .bind(workspace)
    .bind(user)
    .fetch_one(pool)
    .await
}
async fn can_manage_lists(pool: &PgPool, workspace: Uuid, user: Uuid) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND role<>'viewer')")
        .bind(workspace).bind(user).fetch_one(pool).await
}

#[derive(Deserialize)]
struct NewList {
    name: String,
    kind: Option<String>,
    query: Option<Value>,
}
#[derive(Deserialize)]
struct UpdateList {
    name: Option<String>,
    query: Option<Value>,
}
#[derive(Deserialize)]
struct MembershipInput {
    task_id: Uuid,
    request_id: Option<Uuid>,
}

async fn list_lists(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return auth_error(s),
    };
    if !matches!(is_member(&state.pool, workspace, user).await, Ok(true)) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match sqlx::query("SELECT id,name,kind,query,created_by FROM task_lists WHERE workspace_id=$1 ORDER BY name,id").bind(workspace).fetch_all(&state.pool).await {
        Ok(rows)=>Json(json!({"lists":rows.iter().map(|r| json!({"id":r.get::<Uuid,_>("id"),"name":r.get::<String,_>("name"),"kind":r.get::<String,_>("kind"),"query":r.get::<Value,_>("query"),"created_by":r.get::<Uuid,_>("created_by")})).collect::<Vec<_>>()})).into_response(), Err(_)=>StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }
}

async fn create_list(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<NewList>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return auth_error(s),
    };
    if !matches!(
        can_manage_lists(&state.pool, workspace, user).await,
        Ok(true)
    ) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let name = input.name.trim();
    let kind = input.kind.as_deref().unwrap_or("manual");
    if name.is_empty()
        || !["manual", "smart"].contains(&kind)
        || (kind == "manual"
            && input
                .query
                .as_ref()
                .is_some_and(|q| !q.as_object().is_none_or(|o| o.is_empty())))
    {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let query=input.query.unwrap_or_else(||json!({"filters":[],"logic":"and","sort":[],"group":null,"columns":["title","status","priority"]}));
    if !valid_query(&query) {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let id = Uuid::new_v4();
    match sqlx::query("INSERT INTO task_lists(id,workspace_id,name,kind,query,created_by) VALUES($1,$2,$3,$4,$5,$6)").bind(id).bind(workspace).bind(name).bind(kind).bind(&query).bind(user).execute(&state.pool).await {
        Ok(_)=>(StatusCode::CREATED,Json(json!({"id":id,"workspace_id":workspace,"name":name,"kind":kind,"query":query,"created_by":user}))).into_response(), Err(_)=>StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }
}

async fn update_list(
    State(state): State<AuthState>,
    Path((workspace, list)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(input): Json<UpdateList>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return auth_error(s),
    };
    if !matches!(
        can_manage_lists(&state.pool, workspace, user).await,
        Ok(true)
    ) {
        return StatusCode::NOT_FOUND.into_response();
    }
    if input.name.as_ref().is_some_and(|n| n.trim().is_empty())
        || input.query.as_ref().is_some_and(|q| !valid_query(q))
    {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    match sqlx::query("UPDATE task_lists SET name=COALESCE($3,name),query=COALESCE($4,query),updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING id,name,kind,query,created_by").bind(workspace).bind(list).bind(input.name.map(|s|s.trim().to_owned())).bind(input.query).fetch_optional(&state.pool).await {
        Ok(Some(r))=>Json(json!({"id":r.get::<Uuid,_>("id"),"name":r.get::<String,_>("name"),"kind":r.get::<String,_>("kind"),"query":r.get::<Value,_>("query"),"created_by":r.get::<Uuid,_>("created_by")})).into_response(),Ok(None)=>StatusCode::NOT_FOUND.into_response(),Err(_)=>StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }
}

async fn read_list(
    State(state): State<AuthState>,
    Path((workspace, list)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return auth_error(s),
    };
    if !matches!(is_member(&state.pool, workspace, user).await, Ok(true)) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let row = match sqlx::query(
        "SELECT id,name,kind,query,created_by FROM task_lists WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(list)
    .fetch_optional(&state.pool)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let kind: String = row.get("kind");
    let query: Value = row.get("query");
    let rows = if kind == "manual" {
        sqlx::query("SELECT t.id,t.workspace_id,t.number,t.project_id,t.parent_task_id,t.title,t.description,t.status,t.priority,t.start_date::text AS start_date,t.due_date::text AS due_date,t.completed_at::text AS completed_at,t.version,t.created_at::text AS created_at,t.updated_at::text AS updated_at,t.archived_at::text AS archived_at FROM task_list_memberships m JOIN tasks t ON t.id=m.task_id WHERE m.list_id=$1 AND t.archived_at IS NULL ORDER BY m.position,t.number").bind(list).fetch_all(&state.pool).await
    } else {
        sqlx::query("SELECT id,workspace_id,number,project_id,parent_task_id,title,description,status,priority,start_date::text AS start_date,due_date::text AS due_date,completed_at::text AS completed_at,version,created_at::text AS created_at,updated_at::text AS updated_at,archived_at::text AS archived_at FROM tasks WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY number").bind(workspace).fetch_all(&state.pool).await
    };
    let rows = match rows {
        Ok(r) => r,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let mut tasks = Vec::new();
    for task in rows {
        let project: Uuid = task.get("project_id");
        if !matches!(can_read(&state.pool, project, user).await, Ok(true)) {
            continue;
        }
        if kind == "smart" && !matches_query(&state.pool, &task, user, &query).await {
            continue;
        }
        match serialize_task(&state.pool, &task, Some(user)).await {
            Ok(value) => tasks.push(value),
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    }
    if kind == "smart" {
        if let Some(rules) = query.get("sort").and_then(Value::as_array) {
            tasks.sort_by(|left, right| {
                for rule in rules {
                    let field = rule.get("field").and_then(Value::as_str).unwrap_or("");
                    let direction = rule
                        .get("direction")
                        .and_then(Value::as_str)
                        .unwrap_or("asc");
                    let a = sort_value(left, field);
                    let b = sort_value(right, field);
                    let ordering = a.cmp(&b);
                    if !ordering.is_eq() {
                        return if direction == "desc" {
                            ordering.reverse()
                        } else {
                            ordering
                        };
                    }
                }
                std::cmp::Ordering::Equal
            });
        }
    }
    let view = json!({"filters":query.get("filters").cloned().unwrap_or(json!([])),"logic":query.get("logic").cloned().unwrap_or(json!("and")),"sort":query.get("sort").cloned().unwrap_or(json!([])),"group":query.get("group").cloned().unwrap_or(Value::Null),"columns":query.get("columns").cloned().unwrap_or(json!(["title","status","priority"]))});
    Json(json!({"id":list,"workspace_id":workspace,"name":row.get::<String,_>("name"),"kind":kind,"query":view,"tasks":tasks})).into_response()
}

fn sort_value(task: &Value, field: &str) -> String {
    let value = match field {
        "title" | "status" | "priority" | "number" | "due_date" | "start_date" => task.get(field),
        value if value.starts_with("attribute:") => task
            .get("attributes")
            .and_then(|a| a.get(value.trim_start_matches("attribute:"))),
        _ => None,
    };
    value
        .map(|v| {
            v.as_str()
                .map(str::to_lowercase)
                .unwrap_or_else(|| v.to_string())
        })
        .unwrap_or_default()
}

async fn add_task(
    State(state): State<AuthState>,
    Path(list): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<MembershipInput>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return auth_error(s),
    };
    let info = match sqlx::query("SELECT workspace_id,kind FROM task_lists WHERE id=$1")
        .bind(list)
        .fetch_optional(&state.pool)
        .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let workspace: Uuid = info.get("workspace_id");
    if info.get::<String, _>("kind") != "manual" {
        return StatusCode::CONFLICT.into_response();
    }
    let task=match sqlx::query("SELECT id,workspace_id,number,project_id,version,archived_at FROM tasks WHERE id=$1 AND workspace_id=$2").bind(input.task_id).bind(workspace).fetch_optional(&state.pool).await {Ok(Some(r))=>r,Ok(None)=>return StatusCode::NOT_FOUND.into_response(),Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response()};
    let project: Uuid = task.get("project_id");
    if !matches!(can_write(&state.pool, project, user).await, Ok(true)) {
        return StatusCode::NOT_FOUND.into_response();
    }
    if task.get::<Option<String>, _>("archived_at").is_some() {
        return StatusCode::CONFLICT.into_response();
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let already = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM task_list_memberships WHERE list_id=$1 AND task_id=$2)",
    )
    .bind(list)
    .bind(input.task_id)
    .fetch_one(&mut *tx)
    .await
    .unwrap_or(false);
    if already {
        let _ = tx.rollback().await;
        return StatusCode::NO_CONTENT.into_response();
    }
    let command = input.request_id.unwrap_or_else(Uuid::new_v4);
    let group = Uuid::new_v4();
    let version: i64 = task.get("version");
    let inserted = sqlx::query("INSERT INTO task_list_memberships(workspace_id,list_id,task_id,position) SELECT $1,$2,$3,COALESCE(MAX(position)+1,0) FROM task_list_memberships WHERE list_id=$2 ON CONFLICT(list_id,task_id) DO NOTHING").bind(workspace).bind(list).bind(input.task_id).execute(&mut *tx).await;
    if matches!(inserted, Ok(ref result) if result.rows_affected() == 0) {
        let _ = tx.rollback().await;
        return StatusCode::NO_CONTENT.into_response();
    }
    if inserted.is_err()
      || sqlx::query("UPDATE tasks SET version=version+1,updated_at=now() WHERE id=$1").bind(input.task_id).execute(&mut *tx).await.is_err()
      || sqlx::query("INSERT INTO task_operation_groups(id,command_id,workspace_id,actor_id) VALUES($1,$2,$3,$4)").bind(group).bind(command).bind(workspace).bind(user).execute(&mut *tx).await.is_err()
      || sqlx::query("UPDATE task_operation_groups SET state='suppressed' WHERE workspace_id=$1 AND actor_id=$2 AND state='undone'").bind(workspace).bind(user).execute(&mut *tx).await.is_err()
      || sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,$4,'false'::jsonb,'true'::jsonb,$5)").bind(Uuid::new_v4()).bind(group).bind(input.task_id).bind(format!("list_membership:{list}")).bind(version+1).execute(&mut *tx).await.is_err() {let _=tx.rollback().await;return StatusCode::INTERNAL_SERVER_ERROR.into_response();}
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    StatusCode::CREATED.into_response()
}

async fn remove_task(
    State(state): State<AuthState>,
    Path((list, task)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return auth_error(s),
    };
    let row=match sqlx::query("SELECT l.workspace_id,l.kind,t.project_id,t.version,t.archived_at IS NOT NULL AS archived FROM task_lists l JOIN task_list_memberships m ON m.list_id=l.id JOIN tasks t ON t.id=m.task_id WHERE l.id=$1 AND t.id=$2").bind(list).bind(task).fetch_optional(&state.pool).await {Ok(Some(r))=>r,Ok(None)=>return StatusCode::NOT_FOUND.into_response(),Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response()};
    let workspace: Uuid = row.get("workspace_id");
    let project: Uuid = row.get("project_id");
    if row.get::<String, _>("kind") != "manual" {
        return StatusCode::CONFLICT.into_response();
    }
    if row.get::<bool, _>("archived") {
        return StatusCode::CONFLICT.into_response();
    }
    if !matches!(can_write(&state.pool, project, user).await, Ok(true)) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let mut tx = match state.pool.begin().await {
        Ok(v) => v,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let version: i64 = row.get("version");
    let group = Uuid::new_v4();
    if sqlx::query("DELETE FROM task_list_memberships WHERE list_id=$1 AND task_id=$2").bind(list).bind(task).execute(&mut *tx).await.is_err() || sqlx::query("UPDATE tasks SET version=version+1,updated_at=now() WHERE id=$1").bind(task).execute(&mut *tx).await.is_err() || sqlx::query("INSERT INTO task_operation_groups(id,command_id,workspace_id,actor_id) VALUES($1,$2,$3,$4)").bind(group).bind(Uuid::new_v4()).bind(workspace).bind(user).execute(&mut *tx).await.is_err() || sqlx::query("UPDATE task_operation_groups SET state='suppressed' WHERE workspace_id=$1 AND actor_id=$2 AND state='undone'").bind(workspace).bind(user).execute(&mut *tx).await.is_err() || sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,$4,'true'::jsonb,'false'::jsonb,$5)").bind(Uuid::new_v4()).bind(group).bind(task).bind(format!("list_membership:{list}")).bind(version+1).execute(&mut *tx).await.is_err(){let _=tx.rollback().await;return StatusCode::INTERNAL_SERVER_ERROR.into_response();}
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    StatusCode::NO_CONTENT.into_response()
}

fn valid_query(query: &Value) -> bool {
    if !query.is_object() {
        return false;
    }
    let filters = query.get("filters").and_then(Value::as_array);
    let Some(filters) = filters else { return false };
    if !["and", "or"].contains(&query.get("logic").and_then(Value::as_str).unwrap_or("and")) {
        return false;
    }
    filters.iter().all(|f| {
        f.get("field").and_then(Value::as_str).is_some_and(|field| {
            [
                "status",
                "priority",
                "assignee",
                "assignee_including_team",
                "due_date",
                "start_date",
            ]
            .contains(&field)
                || field.starts_with("attribute:")
        }) && f.get("op").and_then(Value::as_str).is_some_and(|op| {
            ["eq", "neq", "contains", "before", "after", "relative"].contains(&op)
        })
    })
}

async fn matches_query(
    pool: &PgPool,
    task: &sqlx::postgres::PgRow,
    user: Uuid,
    query: &Value,
) -> bool {
    let filters = query
        .get("filters")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let logic = query.get("logic").and_then(Value::as_str).unwrap_or("and");
    let mut results = Vec::new();
    for filter in filters {
        results.push(matches_filter(pool, task, user, &filter).await);
    }
    if results.is_empty() {
        true
    } else if logic == "or" {
        results.into_iter().any(|v| v)
    } else {
        results.into_iter().all(|v| v)
    }
}

async fn matches_filter(
    pool: &PgPool,
    task: &sqlx::postgres::PgRow,
    user: Uuid,
    f: &Value,
) -> bool {
    let field = f.get("field").and_then(Value::as_str).unwrap_or("");
    let op = f.get("op").and_then(Value::as_str).unwrap_or("eq");
    let expected = f.get("value").unwrap_or(&Value::Null);
    let actual = match field {
        "status" => {
            let key = expected
                .as_str()
                .and_then(|id| Uuid::parse_str(id).ok())
                .map(|id| (id, task.get::<Uuid, _>("workspace_id")));
            if let Some((id, workspace)) = key {
                let stable = sqlx::query_scalar::<_, String>(
                    "SELECT status_key FROM workspace_statuses WHERE id=$1 AND workspace_id=$2",
                )
                .bind(id)
                .bind(workspace)
                .fetch_optional(pool)
                .await
                .unwrap_or(None);
                json!(stable.unwrap_or_default())
            } else {
                json!(task.get::<String, _>("status"))
            }
        }
        "priority" => json!(task.get::<String, _>("priority")),
        "due_date" => json!(task.get::<Option<String>, _>("due_date")),
        "start_date" => json!(task.get::<Option<String>, _>("start_date")),
        "assignee" | "assignee_including_team" => {
            let direct: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM task_assignees WHERE task_id=$1 AND user_id=$2)",
            )
            .bind(task.get::<Uuid, _>("id"))
            .bind(user)
            .fetch_one(pool)
            .await
            .unwrap_or(false);
            let team: bool = if field == "assignee_including_team" {
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM task_assignees a JOIN team_memberships m ON m.team_id=a.team_id WHERE a.task_id=$1 AND m.user_id=$2)").bind(task.get::<Uuid,_>("id")).bind(user).fetch_one(pool).await.unwrap_or_else(|error| {
                    tracing::error!(%error, "smart list team assignee lookup failed");
                    false
                })
            } else {
                false
            };
            json!(direct || team)
        }
        value if value.starts_with("attribute:") => {
            let Ok(id) = Uuid::parse_str(value.trim_start_matches("attribute:")) else {
                return false;
            };
            sqlx::query_scalar(
                "SELECT value FROM task_attribute_values WHERE task_id=$1 AND attribute_id=$2",
            )
            .bind(task.get::<Uuid, _>("id"))
            .bind(id)
            .fetch_optional(pool)
            .await
            .unwrap_or(None)
            .unwrap_or(Value::Null)
        }
        _ => Value::Null,
    };
    if op == "relative" {
        let Some(day) = actual.as_str() else {
            return false;
        };
        let today = chrono_today();
        let end = add_days(today.clone(), 7);
        return match expected.as_str().unwrap_or("") {
            "today" => day == today.as_str(),
            "overdue" => day < today.as_str(),
            "next_7_days" => day >= today.as_str() && day <= end.as_str(),
            _ => false,
        };
    }
    let expected_value = if field == "status" {
        if let Some(id) = expected.as_str().and_then(|id| Uuid::parse_str(id).ok()) {
            let status = sqlx::query_scalar::<_, String>(
                "SELECT status_key FROM workspace_statuses WHERE id=$1 AND workspace_id=$2",
            )
            .bind(id)
            .bind(task.get::<Uuid, _>("workspace_id"))
            .fetch_optional(pool)
            .await
            .unwrap_or(None);
            status
                .map(Value::String)
                .unwrap_or_else(|| expected.clone())
        } else {
            expected.clone()
        }
    } else if field.starts_with("attribute:") {
        if let Some(option) = expected.as_str().and_then(|id| Uuid::parse_str(id).ok()) {
            let option_key = sqlx::query_scalar::<_, String>(
                "SELECT option_key FROM attribute_options WHERE id=$1",
            )
            .bind(option)
            .fetch_optional(pool)
            .await
            .unwrap_or(None);
            option_key
                .map(Value::String)
                .unwrap_or_else(|| expected.clone())
        } else {
            expected.clone()
        }
    } else if (field == "assignee" || field == "assignee_including_team") && expected == "me" {
        json!(true)
    } else {
        expected.clone()
    };
    match op {
        "eq" => actual == expected_value,
        "neq" => actual != expected_value,
        "contains" => actual
            .as_str()
            .zip(expected_value.as_str())
            .is_some_and(|(a, b)| a.to_lowercase().contains(&b.to_lowercase())),
        "before" => actual
            .as_str()
            .zip(expected_value.as_str())
            .is_some_and(|(a, b)| a < b),
        "after" => actual
            .as_str()
            .zip(expected_value.as_str())
            .is_some_and(|(a, b)| a > b),
        _ => false,
    }
}
fn chrono_today() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let days = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        / 86400;
    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    if m <= 2 {
        y += 1;
    }
    format!("{y:04}-{m:02}-{d:02}")
}
fn add_days(day: String, count: i32) -> String {
    let parts: Vec<i32> = day.split('-').filter_map(|v| v.parse().ok()).collect();
    if parts.len() != 3 {
        return day;
    }
    let mut d = parts[2];
    let mut m = parts[1];
    let mut y = parts[0];
    for _ in 0..count.max(0) {
        d += 1;
        let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
        let days_in_month = match m {
            2 if leap => 29,
            2 => 28,
            4 | 6 | 9 | 11 => 30,
            _ => 31,
        };
        if d > days_in_month {
            d = 1;
            m += 1;
            if m > 12 {
                m = 1;
                y += 1;
            }
        }
    }
    format!("{y:04}-{m:02}-{d:02}")
}
