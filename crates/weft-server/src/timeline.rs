//! Dependency lines for the Timeline.
//!
//! The Timeline draws bars from the ordinary Task list, so this module only answers which
//! `blocks` edges to draw. Every edge is read with the viewer's own access: an edge between two
//! readable Tasks is a link, an edge to a Task the viewer cannot read becomes a neutral stub on
//! the readable end (no id, title or count of the hidden Task), and an edge with no readable end
//! is not sent at all.

use crate::{
    auth::{require_session, AuthState},
    tasks::can_read,
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use sqlx::Row;
use std::collections::{BTreeSet, HashMap};
use uuid::Uuid;

pub(crate) fn routes() -> Router<AuthState> {
    Router::new().route(
        "/workspaces/:workspace_id/timeline-links",
        get(timeline_links),
    )
}

async fn timeline_links(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
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
    let rows = match sqlx::query(
        "SELECT r.source_task_id,s.project_id AS source_project,r.target_task_id,t.project_id AS target_project \
         FROM task_relations r \
         JOIN tasks s ON s.id=r.source_task_id AND s.archived_at IS NULL \
         JOIN tasks t ON t.id=r.target_task_id AND t.archived_at IS NULL \
         WHERE r.workspace_id=$1 AND r.kind='blocks' \
         ORDER BY r.source_task_id,r.target_task_id",
    )
    .bind(workspace)
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => rows,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let mut access: HashMap<Uuid, bool> = HashMap::new();
    let mut links: Vec<Value> = Vec::new();
    // One stub per readable Task and direction, however many hidden Tasks it touches.
    let mut stubs: BTreeSet<(Uuid, &'static str)> = BTreeSet::new();
    for row in rows {
        let (source, target): (Uuid, Uuid) = (row.get("source_task_id"), row.get("target_task_id"));
        let (source_project, target_project): (Uuid, Uuid) =
            (row.get("source_project"), row.get("target_project"));
        let mut can = Vec::with_capacity(2);
        for project in [source_project, target_project] {
            let allowed = match access.get(&project) {
                Some(known) => *known,
                None => match can_read(&state.pool, project, user).await {
                    Ok(value) => {
                        access.insert(project, value);
                        value
                    }
                    Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                },
            };
            can.push(allowed);
        }
        match (can[0], can[1]) {
            (true, true) => links.push(json!({"blocker_id":source,"blocked_id":target})),
            (true, false) => {
                stubs.insert((source, "blocks"));
            }
            (false, true) => {
                stubs.insert((target, "blocked_by"));
            }
            (false, false) => {}
        }
    }
    let stubs: Vec<Value> = stubs
        .into_iter()
        .map(|(task, direction)| json!({"task_id":task,"direction":direction}))
        .collect();
    Json(json!({"links":links,"stubs":stubs})).into_response()
}
