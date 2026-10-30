use std::time::Duration;

use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    response::sse::{Event, KeepAlive},
    response::{IntoResponse, Sse},
    routing::get,
    Json, Router,
};
use futures_util::stream;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    auth::{require_session, AuthState},
    projects::{self, Role},
};

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route("/workspaces/:workspace_id/realtime/snapshot", get(snapshot))
        .route("/workspaces/:workspace_id/realtime/events", get(events))
}

async fn snapshot(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> axum::response::Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let member = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2)",
    )
    .bind(workspace)
    .bind(user)
    .fetch_one(&state.pool)
    .await;
    if !matches!(member, Ok(true)) {
        return axum::http::StatusCode::NOT_FOUND.into_response();
    }
    let rows = match sqlx::query("SELECT id,project_id,archived_at IS NOT NULL AS archived FROM tasks WHERE workspace_id=$1 ORDER BY id")
        .bind(workspace).fetch_all(&state.pool).await { Ok(rows) => rows, Err(_) => return axum::http::StatusCode::INTERNAL_SERVER_ERROR.into_response() };
    let mut visible = Vec::new();
    for row in rows {
        let id: Uuid = row.get("id");
        let project: Uuid = row.get("project_id");
        let archived: bool = row.get("archived");
        let access = projects::evaluate_access(&state.pool, project, user).await;
        if matches!(access, Ok(Some(value)) if value.role >= Role::Viewer) && !archived {
            visible.push(id);
        } else {
            let _ = id;
        }
    }
    let cursor = sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(max(id),0) FROM realtime_outbox WHERE workspace_id=$1",
    )
    .bind(workspace)
    .fetch_one(&state.pool)
    .await
    .unwrap_or(0);
    Json(json!({"workspace_id":workspace,"cursor":cursor,"visible_task_ids":visible}))
        .into_response()
}

#[derive(Deserialize)]
struct EventQuery {
    after: Option<i64>,
}

async fn events(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    Query(query): Query<EventQuery>,
    headers: HeaderMap,
) -> axum::response::Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let membership = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2)",
    )
    .bind(workspace)
    .bind(user)
    .fetch_one(&state.pool)
    .await;
    if !matches!(membership, Ok(true)) {
        return axum::http::StatusCode::NOT_FOUND.into_response();
    }
    let pool = state.pool.clone();
    let cursor = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<i64>().ok())
        .or(query.after)
        .unwrap_or(0)
        .max(0);
    let output = stream::unfold(
        (pool, workspace, user, cursor),
        |(pool, workspace, user, mut cursor)| async move {
            tokio::time::sleep(Duration::from_millis(800)).await;
            let member = sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2)")
            .bind(workspace).bind(user).fetch_one(&pool).await.unwrap_or(false);
            if !member {
                let event = Event::default().event("scope_revoked").data("{}");
                return Some((
                    Ok::<_, std::convert::Infallible>(event),
                    (pool, workspace, user, cursor),
                ));
            }
            let rows = sqlx::query("SELECT id,project_id,entity_type,entity_id,operation_id,entity_version,event_type,actor_id FROM realtime_outbox WHERE workspace_id=$1 AND id>$2 ORDER BY id LIMIT 100")
            .bind(workspace).bind(cursor).fetch_all(&pool).await.unwrap_or_default();
            if rows.is_empty() {
                return Some((
                    Ok::<_, std::convert::Infallible>(Event::default().comment("keepalive")),
                    (pool, workspace, user, cursor),
                ));
            }
            let row = &rows[0];
            cursor = row.get("id");
            let project_id: Option<Uuid> = row.get("project_id");
            let allowed = if let Some(project) = project_id {
                matches!(projects::evaluate_access(&pool, project, user).await, Ok(Some(access)) if access.role >= Role::Viewer)
            } else {
                row.get::<Option<Uuid>, _>("actor_id") == Some(user)
            };
            if !allowed {
                return Some((
                    Ok::<_, std::convert::Infallible>(Event::default().comment("filtered")),
                    (pool, workspace, user, cursor),
                ));
            }
            let payload: Value = json!({"entity_type":row.get::<String,_>("entity_type"),"entity_id":row.get::<Uuid,_>("entity_id"),"operation_id":row.get::<Uuid,_>("operation_id"),"version":row.get::<i64,_>("entity_version"),"change":row.get::<String,_>("event_type")});
            let event = Event::default()
                .id(cursor.to_string())
                .event("change")
                .json_data(payload)
                .unwrap_or_else(|_| Event::default().comment("encoding error"));
            Some((
                Ok::<_, std::convert::Infallible>(event),
                (pool, workspace, user, cursor),
            ))
        },
    );
    Sse::new(output)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response()
}
