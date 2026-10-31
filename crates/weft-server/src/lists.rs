use crate::{
    auth::{require_session, AuthState},
    smart_query::{self, Clock},
    tasks::{can_read, can_write, serialize_task_summary},
};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use std::collections::{HashMap, HashSet};
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

fn invalid_query(message: String) -> Response {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        Json(json!({"error":"invalid_query","message":message})),
    )
        .into_response()
}

#[derive(Deserialize)]
struct Page {
    limit: Option<i64>,
    offset: Option<i64>,
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
            && input.query.as_ref().is_some_and(|q| {
                // A manual List keeps its members by hand: it takes display settings (visible
                // columns, grouping) but no filters and no sort rules.
                let empty = |key: &str| {
                    q.get(key)
                        .is_none_or(|v| v.is_null() || v.as_array().is_some_and(Vec::is_empty))
                };
                !q.is_object() || !empty("filters") || !empty("sort")
            }))
    {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let query=input.query.unwrap_or_else(||json!({"filters":[],"logic":"and","sort":[],"group":null,"columns":["title","status","priority"]}));
    if let Err(message) = smart_query::validate(&query) {
        return invalid_query(message);
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
    if input.name.as_ref().is_some_and(|n| n.trim().is_empty()) {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    if let Some(Err(message)) = input.query.as_ref().map(smart_query::validate) {
        return invalid_query(message);
    }
    match sqlx::query("UPDATE task_lists SET name=COALESCE($3,name),query=COALESCE($4,query),updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING id,name,kind,query,created_by").bind(workspace).bind(list).bind(input.name.map(|s|s.trim().to_owned())).bind(input.query).fetch_optional(&state.pool).await {
        Ok(Some(r))=>Json(json!({"id":r.get::<Uuid,_>("id"),"name":r.get::<String,_>("name"),"kind":r.get::<String,_>("kind"),"query":r.get::<Value,_>("query"),"created_by":r.get::<Uuid,_>("created_by")})).into_response(),Ok(None)=>StatusCode::NOT_FOUND.into_response(),Err(_)=>StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }
}

async fn read_list(
    State(state): State<AuthState>,
    Path((workspace, list)): Path<(Uuid, Uuid)>,
    Query(page): Query<Page>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return auth_error(s),
    };
    if !matches!(is_member(&state.pool, workspace, user).await, Ok(true)) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let offset = page.offset.unwrap_or(0);
    if page
        .limit
        .is_some_and(|limit| !(1..=smart_query::MAX_PAGE).contains(&limit))
        || offset < 0
    {
        return invalid_query(format!(
            "limit must be between 1 and {} and offset must not be negative",
            smart_query::MAX_PAGE
        ));
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
        sqlx::query("SELECT t.id,t.workspace_id,t.number,t.project_id,t.parent_task_id,t.title,t.description,t.status,t.priority,t.start_date::text AS start_date,t.due_date::text AS due_date,t.completed_at::text AS completed_at,t.version,t.rank,t.created_at::text AS created_at,t.updated_at::text AS updated_at,t.archived_at::text AS archived_at FROM task_list_memberships m JOIN tasks t ON t.id=m.task_id WHERE m.list_id=$1 AND t.archived_at IS NULL ORDER BY m.position,t.number").bind(list).fetch_all(&state.pool).await
    } else {
        sqlx::query("SELECT id,workspace_id,number,project_id,parent_task_id,title,description,status,priority,start_date::text AS start_date,due_date::text AS due_date,completed_at::text AS completed_at,version,rank,created_at::text AS created_at,updated_at::text AS updated_at,archived_at::text AS archived_at FROM tasks WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY number").bind(workspace).fetch_all(&state.pool).await
    };
    let rows = match rows {
        Ok(r) => r,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let Ok(readable) = readable_projects(&state.pool, workspace, user).await else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let data = if kind == "smart" {
        match QueryData::load(&state.pool, workspace, user, &query).await {
            Ok(data) => Some(data),
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    } else {
        None
    };
    let mut matched: Vec<(Vec<SortKey>, sqlx::postgres::PgRow)> = Vec::new();
    let order = (kind == "smart").then(|| ViewOrder::parse(&query));
    for task in rows {
        let project: Uuid = task.get("project_id");
        if !readable.contains(&project) {
            continue;
        }
        if data
            .as_ref()
            .is_some_and(|data| !matches_query(data, &task, &query))
        {
            continue;
        }
        let keys = match (&order, &data) {
            (Some(order), Some(data)) => order.keys(data, &task),
            _ => Vec::new(),
        };
        matched.push((keys, task));
    }
    if let Some(order) = order.as_ref().filter(|order| !order.is_empty()) {
        matched.sort_by(|left, right| order.compare(&left.0, &right.0));
    }
    let total = matched.len();
    // A Smart List defaults to one page; a manual List defaults to everything up to a hard cap,
    // and `total` keeps the true count so the client can say how many were left out.
    let limit = page.limit.unwrap_or(if kind == "manual" {
        MANUAL_LIST_CAP
    } else {
        smart_query::MAX_PAGE
    });
    // Only the page is serialized: that costs several queries per Task.
    let mut tasks: Vec<Value> = Vec::new();
    for (_, task) in matched
        .iter()
        .skip(offset as usize)
        .take(usize::try_from(limit).unwrap_or(usize::MAX))
    {
        match serialize_task_summary(&state.pool, task, Some(user)).await {
            Ok(value) => tasks.push(value),
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    }
    let view = json!({"filters":query.get("filters").cloned().unwrap_or(json!([])),"logic":query.get("logic").cloned().unwrap_or(json!("and")),"sort":query.get("sort").cloned().unwrap_or(json!([])),"group":query.get("group").cloned().unwrap_or(Value::Null),"columns":query.get("columns").cloned().unwrap_or(json!(["title","status","priority"]))});
    Json(json!({"id":list,"workspace_id":workspace,"name":row.get::<String,_>("name"),"kind":kind,"query":view,"tasks":tasks,"total":total,"limit":limit,"offset":offset})).into_response()
}

pub(crate) enum SortKey {
    Empty,
    Number(f64),
    Text(String),
}

pub(crate) fn compare_sort_keys(a: &SortKey, b: &SortKey) -> std::cmp::Ordering {
    use std::cmp::Ordering::{Equal, Greater, Less};
    match (a, b) {
        (SortKey::Empty, SortKey::Empty) => Equal,
        (SortKey::Empty, _) => Less,
        (_, SortKey::Empty) => Greater,
        (SortKey::Number(x), SortKey::Number(y)) => x.total_cmp(y),
        (SortKey::Number(_), SortKey::Text(_)) => Less,
        (SortKey::Text(_), SortKey::Number(_)) => Greater,
        (SortKey::Text(x), SortKey::Text(y)) => x.cmp(y),
    }
}

/// Largest response a manual List gives when the caller names no page size.
pub(crate) const MANUAL_LIST_CAP: i64 = 5000;

/// Group and sort rules of a view. Keys come from the same prefetched rows and `QueryData` the
/// filters use, so the List and the CSV export order Tasks identically without serializing them.
pub(crate) struct ViewOrder {
    group: Option<String>,
    rules: Vec<(String, bool)>,
}

impl ViewOrder {
    pub(crate) fn parse(query: &Value) -> Self {
        Self {
            group: query
                .get("group")
                .and_then(Value::as_str)
                .map(str::to_owned),
            rules: query
                .get("sort")
                .and_then(Value::as_array)
                .map(|rules| {
                    rules
                        .iter()
                        .map(|r| {
                            (
                                r.get("field")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_owned(),
                                r.get("direction").and_then(Value::as_str) == Some("desc"),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default(),
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.group.is_none() && self.rules.is_empty()
    }

    /// The group key first, then one key per sort rule.
    pub(crate) fn keys(&self, data: &QueryData, task: &sqlx::postgres::PgRow) -> Vec<SortKey> {
        self.group
            .iter()
            .chain(self.rules.iter().map(|(field, _)| field))
            .map(|field| sort_key(data, task, field))
            .collect()
    }

    pub(crate) fn compare(&self, left: &[SortKey], right: &[SortKey]) -> std::cmp::Ordering {
        let mut index = 0;
        if self.group.is_some() {
            // Tasks with no value in the group field come last, after the named groups.
            let ordering = match (&left[0], &right[0]) {
                (SortKey::Empty, SortKey::Empty) => std::cmp::Ordering::Equal,
                (SortKey::Empty, _) => std::cmp::Ordering::Greater,
                (_, SortKey::Empty) => std::cmp::Ordering::Less,
                (a, b) => compare_sort_keys(a, b),
            };
            if !ordering.is_eq() {
                return ordering;
            }
            index = 1;
        }
        for (offset, (_, desc)) in self.rules.iter().enumerate() {
            let ordering = compare_sort_keys(&left[index + offset], &right[index + offset]);
            if !ordering.is_eq() {
                return if *desc { ordering.reverse() } else { ordering };
            }
        }
        std::cmp::Ordering::Equal
    }
}

fn json_key(value: Option<&Value>) -> SortKey {
    match value {
        None | Some(Value::Null) => SortKey::Empty,
        Some(Value::Number(n)) => n.as_f64().map_or(SortKey::Empty, SortKey::Number),
        Some(Value::String(text)) => SortKey::Text(text.to_lowercase()),
        Some(other) => SortKey::Text(other.to_string()),
    }
}

fn sort_key(data: &QueryData, task: &sqlx::postgres::PgRow, field: &str) -> SortKey {
    let id: Uuid = task.get("id");
    let text = |column: &str| {
        task.try_get::<Option<String>, _>(column)
            .ok()
            .flatten()
            .map_or(SortKey::Empty, |v| SortKey::Text(v.to_lowercase()))
    };
    match field {
        "milestone" => data
            .milestones
            .get(&id)
            .map_or(SortKey::Empty, |m| SortKey::Text(m.2.to_lowercase())),
        "milestone_state" => data
            .milestones
            .get(&id)
            .map_or(SortKey::Empty, |m| SortKey::Text(m.1.to_lowercase())),
        "number" => SortKey::Number(task.get::<i64, _>("number") as f64),
        // The manual order: Tasks that carry no rank (a row read without it) sort last.
        "manual" => task
            .try_get::<i64, _>("rank")
            .map_or(SortKey::Empty, |rank| SortKey::Number(rank as f64)),
        "title" | "status" | "priority" | "due_date" | "start_date" | "created_at"
        | "updated_at" | "completed_at" => text(field),
        value if value.starts_with("attribute:") => {
            Uuid::parse_str(value.trim_start_matches("attribute:"))
                .ok()
                .and_then(|attribute| data.attributes.get(&attribute))
                .map_or(SortKey::Empty, |values| json_key(values.get(&id)))
        }
        _ => SortKey::Empty,
    }
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

/// Everything a Smart List condition reads from the database, loaded once per request so a
/// condition never costs a query per Task. A failed load is an error, never a silent "no match".
pub(crate) struct QueryData {
    pub(crate) clock: Clock,
    direct: HashSet<Uuid>,
    via_team: HashSet<Uuid>,
    /// Task to (Milestone id, state, name).
    milestones: HashMap<Uuid, (Uuid, String, String)>,
    attributes: HashMap<Uuid, HashMap<Uuid, Value>>,
    option_keys: HashMap<Uuid, String>,
    status_keys: HashMap<Uuid, String>,
    categories: HashMap<String, String>,
}

#[derive(Default)]
struct Needs {
    assignee: bool,
    team: bool,
    milestone: bool,
    attributes: HashSet<Uuid>,
    options: HashSet<Uuid>,
}

fn scan_needs(node: &Value, needs: &mut Needs) {
    for filter in node
        .get("filters")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        if filter.get("filters").is_some() {
            scan_needs(filter, needs);
            continue;
        }
        let field = filter.get("field").and_then(Value::as_str).unwrap_or("");
        match field {
            "assignee" => needs.assignee = true,
            "assignee_including_team" => {
                needs.assignee = true;
                needs.team = true;
            }
            "milestone" | "milestone_state" => needs.milestone = true,
            value if value.starts_with("attribute:") => {
                if let Ok(id) = Uuid::parse_str(value.trim_start_matches("attribute:")) {
                    needs.attributes.insert(id);
                }
                if let Some(option) = filter
                    .get("value")
                    .and_then(Value::as_str)
                    .and_then(|v| Uuid::parse_str(v).ok())
                {
                    needs.options.insert(option);
                }
            }
            _ => {}
        }
    }
}

/// Sort and group fields need the same prefetched Milestone and Attribute data as filters.
fn scan_order_needs(query: &Value, needs: &mut Needs) {
    let sorts = query
        .get("sort")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|rule| rule.get("field").and_then(Value::as_str));
    for field in sorts.chain(query.get("group").and_then(Value::as_str)) {
        match field {
            "milestone" | "milestone_state" => needs.milestone = true,
            value if value.starts_with("attribute:") => {
                if let Ok(id) = Uuid::parse_str(value.trim_start_matches("attribute:")) {
                    needs.attributes.insert(id);
                }
            }
            _ => {}
        }
    }
}

impl QueryData {
    pub(crate) async fn load(
        pool: &PgPool,
        workspace: Uuid,
        user: Uuid,
        query: &Value,
    ) -> Result<Self, sqlx::Error> {
        let clock = Clock::load(pool, workspace).await?;
        let mut needs = Needs::default();
        scan_needs(query, &mut needs);
        scan_order_needs(query, &mut needs);
        let statuses: Vec<(Uuid, String, String)> = sqlx::query_as(
            "SELECT id,status_key,category FROM workspace_statuses WHERE workspace_id=$1",
        )
        .bind(workspace)
        .fetch_all(pool)
        .await?;
        let mut data = Self {
            clock,
            direct: HashSet::new(),
            via_team: HashSet::new(),
            milestones: HashMap::new(),
            attributes: HashMap::new(),
            option_keys: HashMap::new(),
            status_keys: statuses
                .iter()
                .map(|(id, key, _)| (*id, key.clone()))
                .collect(),
            categories: statuses
                .into_iter()
                .map(|(_, key, category)| (key, category))
                .collect(),
        };
        if needs.assignee {
            data.direct = sqlx::query_scalar(
                "SELECT a.task_id FROM task_assignees a JOIN tasks t ON t.id=a.task_id WHERE t.workspace_id=$1 AND a.user_id=$2",
            )
            .bind(workspace)
            .bind(user)
            .fetch_all(pool)
            .await?
            .into_iter()
            .collect();
        }
        if needs.team {
            data.via_team = sqlx::query_scalar(
                "SELECT a.task_id FROM task_assignees a JOIN tasks t ON t.id=a.task_id JOIN team_memberships m ON m.team_id=a.team_id WHERE t.workspace_id=$1 AND m.user_id=$2",
            )
            .bind(workspace)
            .bind(user)
            .fetch_all(pool)
            .await?
            .into_iter()
            .collect();
        }
        if needs.milestone {
            let rows: Vec<(Uuid, Uuid, String, String)> = sqlx::query_as(
                "SELECT t.id,m.id,m.state,m.name FROM tasks t JOIN milestones m ON m.id=t.milestone_id WHERE t.workspace_id=$1",
            )
            .bind(workspace)
            .fetch_all(pool)
            .await?;
            data.milestones = rows
                .into_iter()
                .map(|(task, id, state, name)| (task, (id, state, name)))
                .collect();
        }
        for attribute in needs.attributes {
            let rows: Vec<(Uuid, Value)> = sqlx::query_as(
                "SELECT v.task_id,v.value FROM task_attribute_values v JOIN tasks t ON t.id=v.task_id WHERE t.workspace_id=$1 AND v.attribute_id=$2",
            )
            .bind(workspace)
            .bind(attribute)
            .fetch_all(pool)
            .await?;
            data.attributes
                .insert(attribute, rows.into_iter().collect());
        }
        if !needs.options.is_empty() {
            let options: Vec<Uuid> = needs.options.into_iter().collect();
            let rows: Vec<(Uuid, String)> =
                sqlx::query_as("SELECT id,option_key FROM attribute_options WHERE id=ANY($1)")
                    .bind(&options)
                    .fetch_all(pool)
                    .await?;
            data.option_keys = rows.into_iter().collect();
        }
        Ok(data)
    }
}

/// Projects of the Workspace the user can read, found once so no Task costs an access query.
pub(crate) async fn readable_projects(
    pool: &PgPool,
    workspace: Uuid,
    user: Uuid,
) -> Result<HashSet<Uuid>, sqlx::Error> {
    let projects: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM projects WHERE workspace_id=$1")
        .bind(workspace)
        .fetch_all(pool)
        .await?;
    let mut readable = HashSet::new();
    for project in projects {
        if can_read(pool, project, user).await? {
            readable.insert(project);
        }
    }
    Ok(readable)
}

pub(crate) fn matches_query(data: &QueryData, task: &sqlx::postgres::PgRow, query: &Value) -> bool {
    matches_group(data, task, query)
}

/// A group holds conditions and nested groups, joined by its own `logic`. An empty group matches.
fn matches_group(data: &QueryData, task: &sqlx::postgres::PgRow, group: &Value) -> bool {
    let filters = group
        .get("filters")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let any = group.get("logic").and_then(Value::as_str) == Some("or");
    if filters.is_empty() {
        return true;
    }
    for node in filters {
        let hit = if node.get("filters").is_some() {
            matches_group(data, task, node)
        } else {
            matches_filter(data, task, node)
        };
        if hit == any {
            return hit;
        }
    }
    !any
}

fn matches_filter(data: &QueryData, task: &sqlx::postgres::PgRow, f: &Value) -> bool {
    let field = f.get("field").and_then(Value::as_str).unwrap_or("");
    let op = f.get("op").and_then(Value::as_str).unwrap_or("eq");
    let expected = f.get("value").unwrap_or(&Value::Null);
    let id: Uuid = task.get("id");
    let actual = match field {
        "status" => json!(task.get::<String, _>("status")),
        "priority" => json!(task.get::<String, _>("priority")),
        "due_date" => json!(task.get::<Option<String>, _>("due_date")),
        "start_date" => json!(task.get::<Option<String>, _>("start_date")),
        "assignee" | "assignee_including_team" => json!(
            data.direct.contains(&id)
                || (field == "assignee_including_team" && data.via_team.contains(&id))
        ),
        "milestone" | "milestone_state" => match (field, data.milestones.get(&id)) {
            (_, None) => Value::Null,
            ("milestone", Some((milestone, _, _))) => json!(milestone.to_string()),
            (_, Some((_, state, _))) => json!(state),
        },
        value if value.starts_with("attribute:") => {
            let Ok(attribute) = Uuid::parse_str(value.trim_start_matches("attribute:")) else {
                return false;
            };
            data.attributes
                .get(&attribute)
                .and_then(|values| values.get(&id))
                .cloned()
                .unwrap_or(Value::Null)
        }
        _ => Value::Null,
    };
    if op == "relative" {
        let name = expected.as_str().unwrap_or("");
        let (Some(day), Some((from, to))) = (
            actual.as_str(),
            smart_query::relative_window(name, &data.clock),
        ) else {
            return false;
        };
        // Same rule as the Project overview: a finished Task is never overdue.
        if name == "overdue" {
            let open = data
                .categories
                .get(task.get::<String, _>("status").as_str())
                .is_some_and(|category| category != "completed" && category != "wont_do");
            if !open {
                return false;
            }
        }
        return from.as_deref().is_none_or(|from| day >= from)
            && to.as_deref().is_none_or(|to| day <= to);
    }
    let as_uuid = |value: &Value| value.as_str().and_then(|id| Uuid::parse_str(id).ok());
    let expected_value = if field == "status" {
        as_uuid(expected)
            .and_then(|status| data.status_keys.get(&status))
            .map_or_else(|| expected.clone(), |key| Value::String(key.clone()))
    } else if field.starts_with("attribute:") {
        as_uuid(expected)
            .and_then(|option| data.option_keys.get(&option))
            .map_or_else(|| expected.clone(), |key| Value::String(key.clone()))
    } else if field == "milestone" {
        // Ids are stored in lowercase; a Milestone id typed in uppercase still names the same one.
        expected
            .as_str()
            .map_or_else(|| expected.clone(), |id| json!(id.to_lowercase()))
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
