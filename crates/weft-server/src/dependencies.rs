//! Dependency integrity and the Blocker view.
//!
//! Edge inserts that can close a loop (`blocks`, `duplicate`) are serialised per Workspace by
//! the callers (`WORKSPACE_GRAPH_LOCK`) and validated with [`loop_path`] inside the same
//! transaction. The Blocker view lists open Tasks that wait on open Tasks, reading every Task
//! with the viewer's own access: a blocker the viewer cannot read is one neutral placeholder.

use crate::{
    auth::{require_session, AuthState},
    tasks::can_read,
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
use sqlx::{PgConnection, PgPool, Row};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

pub(crate) fn routes() -> Router<AuthState> {
    Router::new().route("/workspaces/:workspace_id/blockers", get(blocker_view))
}

/// Shortest chain `from -> ... -> to` over edges of `kind`, or `None` when `to` is unreachable.
/// Adding the edge `to -> from` would close that chain into a loop.
pub(crate) async fn loop_path(
    conn: &mut PgConnection,
    kind: &str,
    from: Uuid,
    to: Uuid,
) -> Result<Option<Vec<Uuid>>, sqlx::Error> {
    let row = sqlx::query_scalar::<_, Vec<Uuid>>(
        "WITH RECURSIVE walk(id,path) AS (\
           SELECT $1::uuid,ARRAY[$1::uuid] \
           UNION ALL \
           SELECT r.target_task_id,w.path||r.target_task_id FROM walk w \
           JOIN task_relations r ON r.source_task_id=w.id AND r.kind=$3 \
           WHERE NOT r.target_task_id=ANY(w.path)) \
         SELECT path FROM walk WHERE id=$2 ORDER BY cardinality(path) LIMIT 1",
    )
    .bind(from)
    .bind(to)
    .bind(kind)
    .fetch_optional(conn)
    .await?;
    Ok(row)
}

async fn readable(
    pool: &PgPool,
    cache: &mut HashMap<Uuid, bool>,
    project: Uuid,
    user: Uuid,
) -> Result<bool, sqlx::Error> {
    if let Some(known) = cache.get(&project) {
        return Ok(*known);
    }
    let allowed = can_read(pool, project, user).await?;
    cache.insert(project, allowed);
    Ok(allowed)
}

/// Describe a looping chain for `user`: Tasks they can read keep id, number and title, any
/// other Task becomes `{"unreadable":true}` with no identifying field.
pub(crate) async fn describe_chain(
    pool: &PgPool,
    user: Uuid,
    path: &[Uuid],
) -> Result<Vec<Value>, sqlx::Error> {
    let rows = sqlx::query("SELECT id,number,title,project_id FROM tasks WHERE id=ANY($1)")
        .bind(path.to_vec())
        .fetch_all(pool)
        .await?;
    let mut by_id = HashMap::new();
    let mut access: HashMap<Uuid, bool> = HashMap::new();
    for row in rows {
        let project: Uuid = row.get("project_id");
        if readable(pool, &mut access, project, user).await? {
            by_id.insert(
                row.get::<Uuid, _>("id"),
                json!({"task_id":row.get::<Uuid,_>("id"),"number":row.get::<i64,_>("number"),"title":row.get::<String,_>("title"),"project_id":project}),
            );
        }
    }
    // Consecutive unreadable hops collapse into one placeholder so the hop count of hidden
    // Tasks does not leak.
    let mut chain: Vec<Value> = Vec::new();
    for id in path {
        match by_id.get(id) {
            Some(task) => chain.push(task.clone()),
            None => {
                if chain.last() != Some(&json!({"unreadable":true})) {
                    chain.push(json!({"unreadable":true}));
                }
            }
        }
    }
    Ok(chain)
}

#[derive(Deserialize)]
struct BlockerParams {
    project_id: Option<Uuid>,
}

async fn blocker_view(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    Query(params): Query<BlockerParams>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let member = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2)",
    )
    .bind(workspace)
    .bind(user)
    .fetch_one(&state.pool)
    .await;
    if !matches!(member, Ok(true)) {
        return StatusCode::NOT_FOUND.into_response();
    }
    // Open means not archived and not in a completed or wont_do Status category.
    let rows = match sqlx::query(
        "SELECT t.id AS blocked_id,t.number AS blocked_number,t.title AS blocked_title,t.project_id AS blocked_project,t.status AS blocked_status,t.due_date::text AS blocked_due,\
                b.id AS blocker_id,b.number AS blocker_number,b.title AS blocker_title,b.project_id AS blocker_project,b.status AS blocker_status \
         FROM task_relations r \
         JOIN tasks t ON t.id=r.target_task_id AND t.archived_at IS NULL \
         JOIN tasks b ON b.id=r.source_task_id AND b.archived_at IS NULL \
         JOIN workspace_statuses ts ON ts.workspace_id=t.workspace_id AND ts.status_key=t.status \
         JOIN workspace_statuses bs ON bs.workspace_id=b.workspace_id AND bs.status_key=b.status \
         WHERE r.workspace_id=$1 AND r.kind='blocks' \
           AND ts.category NOT IN ('completed','wont_do') AND bs.category NOT IN ('completed','wont_do') \
           AND ($2::uuid IS NULL OR t.project_id=$2) \
         ORDER BY t.number,b.number",
    )
    .bind(workspace)
    .bind(params.project_id)
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => rows,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let mut access: HashMap<Uuid, bool> = HashMap::new();
    let mut order: Vec<Uuid> = Vec::new();
    let mut seen: HashSet<Uuid> = HashSet::new();
    let mut blocked: HashMap<Uuid, Value> = HashMap::new();
    let mut blockers: HashMap<Uuid, Vec<Value>> = HashMap::new();
    let mut unreadable: HashSet<Uuid> = HashSet::new();
    for row in rows {
        let blocked_project: Uuid = row.get("blocked_project");
        match readable(&state.pool, &mut access, blocked_project, user).await {
            Ok(true) => {}
            Ok(false) => continue,
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
        let blocked_id: Uuid = row.get("blocked_id");
        if seen.insert(blocked_id) {
            order.push(blocked_id);
            blocked.insert(
                blocked_id,
                json!({"id":blocked_id,"number":row.get::<i64,_>("blocked_number"),"title":row.get::<String,_>("blocked_title"),"project_id":blocked_project,"status":row.get::<String,_>("blocked_status"),"due_date":row.get::<Option<String>,_>("blocked_due")}),
            );
        }
        let blocker_project: Uuid = row.get("blocker_project");
        let blocker_readable = match readable(&state.pool, &mut access, blocker_project, user).await
        {
            Ok(v) => v,
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        };
        if blocker_readable {
            blockers.entry(blocked_id).or_default().push(
                json!({"id":row.get::<Uuid,_>("blocker_id"),"number":row.get::<i64,_>("blocker_number"),"title":row.get::<String,_>("blocker_title"),"project_id":blocker_project,"status":row.get::<String,_>("blocker_status")}),
            );
        } else {
            unreadable.insert(blocked_id);
        }
    }
    let items: Vec<Value> = order
        .into_iter()
        .map(|id| {
            let mut list = blockers.remove(&id).unwrap_or_default();
            // One placeholder however many unreadable blockers there are, so the count of
            // hidden Tasks never shows.
            if unreadable.contains(&id) {
                list.push(json!({"unreadable":true}));
            }
            json!({"task":blocked.remove(&id),"blockers":list})
        })
        .collect();
    Json(json!({"blocked":items})).into_response()
}
