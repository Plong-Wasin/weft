//! Realtime change delivery.
//!
//! Every state change writes a `realtime_outbox` row in the same transaction (database triggers),
//! so an event can never exist for a change that rolled back, and a committed change always has
//! one. The stream replays the outbox after a cursor: delivery is at least once, ordered by the
//! outbox id, and clients deduplicate on `entity_id` + `version` / event id. Access is re-checked
//! on every poll: events outside the caller's readable Projects are dropped, and losing a Project
//! or the Workspace is announced with `scope_revoked`.
//!
//! Ordering and horizon: outbox ids come from a sequence, so a transaction can take a lower id and
//! commit after a higher one. Rows are therefore only read once their transaction id is below the
//! database's snapshot horizon (every older transaction has finished), for the stream and for the
//! snapshot cursor alike; a long-open transaction delays delivery but never loses an event.
//!
//! Retention: rows older than `OUTBOX_RETENTION_DAYS` are deleted and the highest pruned id is kept
//! per Workspace. A cursor below it is answered with `snapshot_required` (an SSE event, and a flag
//! in the snapshot response) and the client takes a new snapshot.
//!
//! Known limit: the comment events written by migrations 0042/0050 carry version 1 because
//! `task_comments` has no version column, and the proposal and run events use the proposal or run
//! id as `task_id`. Clients treat events as reconcile hints, so this is harmless; changing either
//! would alter event payloads that deployed clients deduplicate on.
use std::{
    collections::{HashMap, HashSet},
    convert::Infallible,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

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
const OUTBOX_RETENTION_DAYS: i32 = 7;
/// How long a stream trusts its readable-Project set, and how often it re-validates its session.
const REVALIDATE_INTERVAL: Duration = Duration::from_secs(2);
const PRUNE_INTERVAL: Duration = Duration::from_secs(60);
const MAX_STREAMS_PER_USER: usize = 8;
/// Upper bound on tombstone rows one snapshot returns.
const TOMBSTONE_LIMIT: i64 = 5000;
/// Rows of transactions below the snapshot horizon are final: committed, or rolled back.
const SETTLED: &str = "txid < pg_snapshot_xmin(pg_current_snapshot())::text::bigint";

fn stream_counts() -> &'static Mutex<HashMap<Uuid, usize>> {
    static COUNTS: OnceLock<Mutex<HashMap<Uuid, usize>>> = OnceLock::new();
    COUNTS.get_or_init(Default::default)
}

/// One open event stream of a person; frees the slot when the stream is dropped.
struct StreamSlot(Uuid);

impl StreamSlot {
    fn acquire(user: Uuid) -> Option<Arc<StreamSlot>> {
        let mut counts = stream_counts().lock().unwrap_or_else(|e| e.into_inner());
        let open = counts.entry(user).or_default();
        if *open >= MAX_STREAMS_PER_USER {
            return None;
        }
        *open += 1;
        Some(Arc::new(StreamSlot(user)))
    }
}

impl Drop for StreamSlot {
    fn drop(&mut self) {
        let mut counts = stream_counts().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(open) = counts.get_mut(&self.0) {
            *open -= 1;
            if *open == 0 {
                counts.remove(&self.0);
            }
        }
    }
}

/// Deletes rows past retention and records the highest pruned id per Workspace.
async fn prune_outbox(pool: &PgPool) {
    let _ = sqlx::query(
        "WITH gone AS (DELETE FROM realtime_outbox WHERE created_at < now()-make_interval(days=>$1) RETURNING workspace_id,id)
         INSERT INTO realtime_outbox_floor(workspace_id,pruned_through)
         SELECT workspace_id,max(id) FROM gone GROUP BY workspace_id
         ON CONFLICT (workspace_id) DO UPDATE SET pruned_through=GREATEST(realtime_outbox_floor.pruned_through,EXCLUDED.pruned_through)",
    )
    .bind(OUTBOX_RETENTION_DAYS)
    .execute(pool)
    .await;
}

/// True when events after `cursor` may already be pruned.
async fn cursor_is_stale(pool: &PgPool, workspace: Uuid, cursor: i64) -> bool {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM realtime_outbox_floor WHERE workspace_id=$1 AND pruned_through>$2)",
    )
    .bind(workspace)
    .bind(cursor)
    .fetch_one(pool)
    .await
    .unwrap_or(false)
}

async fn session_alive(pool: &PgPool, session: Uuid) -> bool {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=$1 AND revoked_at IS NULL AND expires_at>now())",
    )
    .bind(session)
    .fetch_one(pool)
    .await
    .unwrap_or(true)
}

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
    prune_outbox(&state.pool).await;
    // Read the cursor first: anything committed later is replayed by the stream. It stops at the
    // snapshot horizon, so a row of a still-open transaction with a lower id is replayed too.
    let cursor = match sqlx::query_scalar::<_, i64>(&format!(
        "SELECT COALESCE(max(id),0) FROM realtime_outbox WHERE workspace_id=$1 AND {SETTLED}"
    ))
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
    // A stale cursor must start over, so it needs no outbox history. Otherwise the history read is
    // bounded by retention and `TOMBSTONE_LIMIT`.
    let stale = after > 0 && cursor_is_stale(&state.pool, workspace, after).await;
    if stale {
        return Json(json!({"workspace_id":workspace,"cursor":cursor,"visible_task_ids":visible,"tombstones":[],"snapshot_required":stale}))
            .into_response();
    }
    let rows = match sqlx::query(
        "SELECT id,project_id,actor_id,entity_type,entity_id,task_id,entity_version,event_type FROM (
             SELECT DISTINCT ON (entity_type,entity_id) id,project_id,actor_id,entity_type,entity_id,task_id,entity_version,event_type
             FROM realtime_outbox WHERE workspace_id=$1 AND id>$2 AND id<=$3 AND event_type<>'operation'
             ORDER BY entity_type,entity_id,id DESC) latest
         ORDER BY id LIMIT $4",
    )
    .bind(workspace)
    .bind(after)
    .bind(cursor)
    .bind(TOMBSTONE_LIMIT)
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
    session: Uuid,
    cursor: i64,
    readable: HashSet<Uuid>,
    checked: Instant,
    last_prune: Instant,
    finished: bool,
    _slot: Arc<StreamSlot>,
}

/// One poll: the events to send now. Empty means nothing is ready yet.
async fn poll(sub: &mut Subscription) -> Vec<Event> {
    let revalidate = sub.checked.elapsed() >= REVALIDATE_INTERVAL;
    if revalidate && !session_alive(&sub.pool, sub.session).await {
        // Logout, revoke or expiry: nothing more is sent on this stream.
        sub.finished = true;
        return vec![Event::default()
            .event("scope_revoked")
            .data(json!({"workspace":true}).to_string())];
    }
    if !is_member(&sub.pool, sub.workspace, sub.user).await {
        sub.finished = true;
        return vec![Event::default()
            .event("scope_revoked")
            .data(json!({"workspace":true}).to_string())];
    }
    if sub.last_prune.elapsed() >= PRUNE_INTERVAL {
        sub.last_prune = Instant::now();
        prune_outbox(&sub.pool).await;
    }
    let mut out = Vec::new();
    // Access is evaluated per Project, so the set is cached between revalidations.
    let refreshed = if revalidate {
        readable_projects(&sub.pool, sub.workspace, sub.user)
            .await
            .ok()
    } else {
        None
    };
    if let Some(now) = refreshed {
        sub.checked = Instant::now();
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
    let rows = sqlx::query(&format!("SELECT id,project_id,entity_type,entity_id,task_id,operation_id,entity_version,event_type,actor_id FROM realtime_outbox WHERE workspace_id=$1 AND id>$2 AND {SETTLED} ORDER BY id LIMIT $3"))
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
    let (session, user) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    if !is_member(&state.pool, workspace, user).await {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(slot) = StreamSlot::acquire(user) else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    let cursor = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<i64>().ok())
        .or(query.after)
        .unwrap_or(0)
        .max(0);
    prune_outbox(&state.pool).await;
    let stale = cursor > 0 && cursor_is_stale(&state.pool, workspace, cursor).await;
    // Captured before the response is sent, so a revoke right after connecting is still seen.
    let Ok(readable) = readable_projects(&state.pool, workspace, user).await else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let sub = Subscription {
        pool: state.pool.clone(),
        workspace,
        user,
        session,
        cursor,
        readable,
        checked: Instant::now(),
        last_prune: Instant::now(),
        finished: stale,
        _slot: slot,
    };
    let output = stream::unfold(sub, move |mut sub| async move {
        if sub.finished && stale && sub.cursor == cursor {
            // Events after this cursor may be pruned: the client has to take a new snapshot.
            sub.cursor = -1;
            return Some((
                vec![Event::default().event("snapshot_required").data("{}")],
                sub,
            ));
        }
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
