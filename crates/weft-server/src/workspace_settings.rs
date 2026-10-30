//! Workspace-level calendar settings: the time zone that decides what "today" is and the
//! first day of the week (0 = Sunday .. 6 = Saturday). Dates stay date-only everywhere.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::auth::{require_session, AuthState};

pub(crate) fn routes() -> Router<AuthState> {
    Router::new().route(
        "/workspaces/:workspace_id/settings",
        get(read_settings).patch(update_settings),
    )
}

#[derive(Deserialize)]
struct SettingsInput {
    week_start: Option<i16>,
    time_zone: Option<String>,
}

/// Current settings plus today's date in the Workspace time zone, computed by Postgres.
async fn settings_value(
    conn: &mut sqlx::PgConnection,
    workspace: Uuid,
) -> Result<Option<serde_json::Value>, sqlx::Error> {
    let row = sqlx::query("SELECT week_start,time_zone,(now() AT TIME ZONE time_zone)::date::text AS today FROM workspaces WHERE id=$1")
        .bind(workspace)
        .fetch_optional(conn)
        .await?;
    Ok(row.map(|row| {
        json!({
            "week_start": i32::from(row.get::<i16, _>("week_start")),
            "time_zone": row.get::<String, _>("time_zone"),
            "today": row.get::<String, _>("today"),
        })
    }))
}

async fn role(conn: &mut sqlx::PgConnection, workspace: Uuid, user: Uuid) -> Option<String> {
    sqlx::query_scalar(
        "SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2",
    )
    .bind(workspace)
    .bind(user)
    .fetch_optional(conn)
    .await
    .ok()
    .flatten()
}

async fn read_settings(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let Ok(mut conn) = state.pool.acquire().await else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    if role(&mut conn, workspace, user).await.is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    match settings_value(&mut conn, workspace).await {
        Ok(Some(value)) => Json(value).into_response(),
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn update_settings(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<SettingsInput>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let Ok(mut tx) = state.pool.begin().await else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    match role(&mut tx, workspace, user).await.as_deref() {
        Some("owner" | "admin") => {}
        Some(_) => return StatusCode::FORBIDDEN.into_response(),
        None => return StatusCode::NOT_FOUND.into_response(),
    }
    if input.week_start.is_some_and(|day| !(0..=6).contains(&day)) {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    if let Some(zone) = input.time_zone.as_deref() {
        let known = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=$1)",
        )
        .bind(zone)
        .fetch_one(&mut *tx)
        .await;
        match known {
            Ok(true) => {}
            Ok(false) => return StatusCode::UNPROCESSABLE_ENTITY.into_response(),
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    }
    if sqlx::query("UPDATE workspaces SET week_start=COALESCE($2,week_start),time_zone=COALESCE($3,time_zone) WHERE id=$1")
        .bind(workspace)
        .bind(input.week_start)
        .bind(input.time_zone)
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let value = settings_value(&mut tx, workspace).await;
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    match value {
        Ok(Some(value)) => Json(value).into_response(),
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
