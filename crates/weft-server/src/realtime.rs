//! Realtime change delivery.
//!
//! Every state change writes a `realtime_outbox` row in the same transaction (database triggers),
//! so an event can never exist for a change that rolled back, and a committed change always has
//! one. The stream replays the outbox after a cursor: delivery is at least once, ordered by the
//! outbox id, and clients deduplicate on `entity_id` + `version` / event id. Access is re-checked
//! on every poll: events outside the caller's readable Projects are dropped, and losing a Project
//! or the Workspace is announced with `scope_revoked`.
use std::{collections::HashSet, convert::Infallible, time::Duration};

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::sse::{Event, KeepAlive},
    response::{IntoResponse, Response, Sse},
    routing::get,
    Json, Router,
};
use futures_util::{stream, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{
    auth::{require_session, AuthState},
    projects::{self, Role},
};

const POLL_INTERVAL: Duration = Duration::from_millis(500);
const BATCH: i64 = 200;

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route("/workspaces/:workspace_id/realtime/snapshot", get(snapshot))
        .route("/workspaces/:workspace_id/realtime/events", get(events))
}

async fn is_member(pool: &PgPool, workspace: Uuid, user: Uuid) -> bool {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2)",
    )
    .bind(workspace)
    .bind(user)
    .fetch_one(pool)
    .await
    .unwrap_or(false)
}

/// Projects of the Workspace the caller can read right now (the single access decision).
async fn readable_projects(
    pool: &PgPool,
    workspace: Uuid,
    user: Uuid,
) -> Result<HashSet<Uuid>, sqlx::Error> {
    let ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM projects WHERE workspace_id=$1")
        .bind(workspace)
        .fetch_all(pool)
        .await?;
    let mut readable = HashSet::new();
    for id in ids {
        if matches!(projects::evaluate_access(pool, id, user).await, Ok(Some(a)) if a.role >= Role::Viewer)
        {
            readable.insert(id);
        }
    }
    Ok(readable)
}

/// An outbox row is deliverable when its Project is readable; Project-less rows (runs, Proposals)
/// belong to the person who started them.
fn deliverable(
    project: Option<Uuid>,
    actor: Option<Uuid>,
    readable: &HashSet<Uuid>,
    user: Uuid,
) -> bool {
    match project {
        Some(project) => readable.contains(&project),
        None => actor == Some(user),
    }
}

#[derive(Deserialize)]
struct EventQuery {
    after: Option<i64>,
}

/// Current visible Tasks plus tombstones for items removed since `after`. Items the caller can no
/// longer read are not named: the client drops anything missing from `visible_task_ids`.
async fn snapshot(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    Query(query): Query<EventQuery>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    if !is_member(&state.pool, workspace, user).await {
        return StatusCode::NOT_FOUND.into_response();
    }
    // Read the cursor first: anything committed later is replayed by the stream.
    let cursor = match sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(max(id),0) FROM realtime_outbox WHERE workspace_id=$1",
    )
    .bind(workspace)
    .fetch_one(&state.pool)
    .await
    {
        Ok(value) => value,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let Ok(readable) = readable_projects(&state.pool, workspace, user).await else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let projects: Vec<Uuid> = readable.iter().copied().collect();
    let visible: Vec<Uuid> = match sqlx::query_scalar(
        "SELECT id FROM tasks WHERE workspace_id=$1 AND project_id=ANY($2) AND archived_at IS NULL ORDER BY id",
    )
    .bind(workspace)
    .bind(&projects)
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => rows,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let after = query.after.unwrap_or(0).max(0);
    let rows = match sqlx::query(
        "SELECT DISTINCT ON (entity_type,entity_id) id,project_id,actor_id,entity_type,entity_id,task_id,entity_version,event_type
         FROM realtime_outbox WHERE workspace_id=$1 AND id>$2 AND id<=$3 AND event_type<>'operation'
         ORDER BY entity_type,entity_id,id DESC",
    )
    .bind(workspace)
    .bind(after)
    .bind(cursor)
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => rows,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let tombstones: Vec<Value> = rows
        .iter()
        .filter(|row| {
            matches!(row.get::<String, _>("event_type").as_str(), "delete" | "archive")
                && deliverable(row.get("project_id"), row.get("actor_id"), &readable, user)
        })
        .map(|row| {
            let reason = if row.get::<String, _>("event_type") == "delete" { "deleted" } else { "archived" };
            json!({"entity_type":row.get::<String,_>("entity_type"),"entity_id":row.get::<Uuid,_>("entity_id"),"task_id":row.get::<Option<Uuid>,_>("task_id"),"version":row.get::<i64,_>("entity_version"),"reason":reason})
        })
        .collect();
    Json(json!({"workspace_id":workspace,"cursor":cursor,"visible_task_ids":visible,"tombstones":tombstones}))
        .into_response()
}

struct Subscription {
    pool: PgPool,
    workspace: Uuid,
    user: Uuid,
    cursor: i64,
    readable: HashSet<Uuid>,
    finished: bool,
}

/// One poll: the events to send now. Empty means nothing is ready yet.
async fn poll(sub: &mut Subscription) -> Vec<Event> {
    if !is_member(&sub.pool, sub.workspace, sub.user).await {
        sub.finished = true;
        return vec![Event::default()
            .event("scope_revoked")
            .data(json!({"workspace":true}).to_string())];
    }
    let mut out = Vec::new();
    if let Ok(now) = readable_projects(&sub.pool, sub.workspace, sub.user).await {
        let lost: Vec<Uuid> = sub.readable.difference(&now).copied().collect();
        let gained: Vec<Uuid> = now.difference(&sub.readable).copied().collect();
        sub.readable = now;
        if !lost.is_empty() {
            out.push(
                Event::default()
                    .event("scope_revoked")
                    .data(json!({"project_ids":lost}).to_string()),
            );
        }
        if !gained.is_empty() {
            out.push(
                Event::default()
                    .event("scope_granted")
                    .data(json!({"project_ids":gained}).to_string()),
            );
        }
    }
    let rows = sqlx::query("SELECT id,project_id,entity_type,entity_id,task_id,operation_id,entity_version,event_type,actor_id FROM realtime_outbox WHERE workspace_id=$1 AND id>$2 ORDER BY id LIMIT $3")
        .bind(sub.workspace).bind(sub.cursor).bind(BATCH).fetch_all(&sub.pool).await.unwrap_or_default();
    for row in &rows {
        let id: i64 = row.get("id");
        sub.cursor = id;
        if !deliverable(
            row.get("project_id"),
            row.get("actor_id"),
            &sub.readable,
            sub.user,
        ) {
            continue;
        }
        let payload = json!({"entity_type":row.get::<String,_>("entity_type"),"entity_id":row.get::<Uuid,_>("entity_id"),"task_id":row.get::<Option<Uuid>,_>("task_id"),"project_id":row.get::<Option<Uuid>,_>("project_id"),"operation_id":row.get::<Uuid,_>("operation_id"),"version":row.get::<i64,_>("entity_version"),"change":row.get::<String,_>("event_type")});
        if let Ok(event) = Event::default()
            .id(id.to_string())
            .event("change")
            .json_data(payload)
        {
            out.push(event);
        }
    }
    out
}

async fn events(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    Query(query): Query<EventQuery>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    if !is_member(&state.pool, workspace, user).await {
        return StatusCode::NOT_FOUND.into_response();
    }
    let cursor = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<i64>().ok())
        .or(query.after)
        .unwrap_or(0)
        .max(0);
    // Captured before the response is sent, so a revoke right after connecting is still seen.
    let Ok(readable) = readable_projects(&state.pool, workspace, user).await else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let sub = Subscription {
        pool: state.pool.clone(),
        workspace,
        user,
        cursor,
        readable,
        finished: false,
    };
    let output = stream::unfold(sub, |mut sub| async move {
        if sub.finished {
            return None;
        }
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            let batch = poll(&mut sub).await;
            if !batch.is_empty() {
                return Some((batch, sub));
            }
        }
    })
    .flat_map(|batch| stream::iter(batch.into_iter().map(Ok::<_, Infallible>)));
    // The stream is plain HTTP on the API origin, so the single-origin proxy forwards it as is;
    // the header stops proxies that buffer by default from holding events back.
    let mut response = Sse::new(output)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response();
    response.headers_mut().insert(
        "x-accel-buffering",
        axum::http::HeaderValue::from_static("no"),
    );
    response
}
