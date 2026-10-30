use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{
    auth::{require_session, AuthState},
    projects::{evaluate_access, Role},
};

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route("/workspaces/:workspace_id/inbox", get(list_inbox))
        .route("/inbox/:entry_id", patch(update_entry))
        .route("/tasks/:task_id/watch", get(get_watch).put(update_watch))
}

pub(crate) async fn readable_project(
    pool: &PgPool,
    task: Uuid,
    user: Uuid,
) -> Result<Option<Uuid>, sqlx::Error> {
    let project: Option<Uuid> =
        sqlx::query_scalar("SELECT project_id FROM tasks WHERE id=$1 AND archived_at IS NULL")
            .bind(task)
            .fetch_optional(pool)
            .await?;
    let Some(project) = project else {
        return Ok(None);
    };
    Ok(matches!(evaluate_access(pool, project, user).await?, Some(access) if access.role >= Role::Viewer).then_some(project))
}

async fn list_inbox(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let member: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2)",
    )
    .bind(workspace)
    .bind(user)
    .fetch_one(&state.pool)
    .await
    .unwrap_or(false);
    if !member {
        return StatusCode::NOT_FOUND.into_response();
    }
    // One row per Task, newest first. Unreadable Tasks are dropped after the query, so keep
    // paging until 200 readable entries are found instead of letting them use up the cap.
    const CAP: usize = 200;
    let mut entries = Vec::new();
    let mut offset = 0i64;
    loop {
        let rows = sqlx::query(
            "SELECT * FROM (SELECT DISTINCT ON (n.task_id) n.id,n.task_id,n.reason,n.operation_group_id,n.source_comment_id,n.created_at AS created_ts,n.created_at::text AS created_at,\
             (SELECT count(*) FROM notification_intents u WHERE u.task_id=n.task_id AND u.recipient_id=n.recipient_id AND u.read_at IS NULL AND u.dismissed_at IS NULL AND u.retracted_at IS NULL)::int AS unread_count,\
             (SELECT array_agg(DISTINCT r.reason ORDER BY r.reason) FROM notification_intents r WHERE r.task_id=n.task_id AND r.recipient_id=n.recipient_id AND r.dismissed_at IS NULL AND r.retracted_at IS NULL) AS reasons,\
             t.project_id,t.number,t.title,t.status \
             FROM notification_intents n JOIN tasks t ON t.id=n.task_id \
             LEFT JOIN task_notification_preferences p ON p.task_id=n.task_id AND p.user_id=n.recipient_id \
             WHERE n.workspace_id=$1 AND n.recipient_id=$2 AND n.dismissed_at IS NULL AND n.retracted_at IS NULL AND COALESCE(p.muted,false)=false \
               AND (n.operation_group_id IS NULL OR NOT EXISTS(SELECT 1 FROM task_operation_groups g WHERE g.id=n.operation_group_id AND g.state='undone' AND n.read_at IS NULL)) \
             ORDER BY n.task_id,n.created_at DESC,n.id DESC) latest \
             ORDER BY created_ts DESC,id DESC LIMIT $3 OFFSET $4"
        ).bind(workspace).bind(user).bind(CAP as i64).bind(offset).fetch_all(&state.pool).await;
        let Ok(rows) = rows else {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        };
        let fetched = rows.len();
        for row in rows {
            let task: Uuid = row.get("task_id");
            match readable_project(&state.pool, task, user).await {
                Ok(Some(_)) => entries.push(json!({
                    "id": row.get::<Uuid,_>("id"),
                    "task": {"id": task, "number": row.get::<i64,_>("number"), "title": row.get::<String,_>("title"), "status": row.get::<String,_>("status")},
                    "reason": row.get::<String,_>("reason"),
                    "reasons": row.get::<Vec<String>,_>("reasons"),
                    "operation_group_id": row.get::<Option<Uuid>,_>("operation_group_id"),
                    "source_comment_id": row.get::<Option<Uuid>,_>("source_comment_id"),
                    "created_at": row.get::<String,_>("created_at"),
                    "unread_count": row.get::<i32,_>("unread_count"),
                    "read": row.get::<i32,_>("unread_count") == 0
                })),
                Ok(None) => {},
                Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            }
            if entries.len() == CAP {
                break;
            }
        }
        if entries.len() >= CAP || fetched < CAP {
            break;
        }
        offset += CAP as i64;
    }
    Json(json!({"entries":entries})).into_response()
}

#[derive(Deserialize)]
struct EntryUpdate {
    read: Option<bool>,
    dismissed: Option<bool>,
}

async fn update_entry(
    State(state): State<AuthState>,
    Path(entry): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<EntryUpdate>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    if input.read.is_none() && input.dismissed.is_none() {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let task: Option<Uuid> = sqlx::query_scalar("SELECT task_id FROM notification_intents WHERE id=$1 AND recipient_id=$2 AND dismissed_at IS NULL AND retracted_at IS NULL")
        .bind(entry).bind(user).fetch_optional(&state.pool).await.unwrap_or(None);
    let Some(task) = task else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !matches!(readable_project(&state.pool, task, user).await, Ok(Some(_))) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let updated = sqlx::query("UPDATE notification_intents SET read_at=CASE WHEN $2::boolean IS NULL THEN read_at WHEN $2 THEN COALESCE(read_at,now()) ELSE NULL END,dismissed_at=CASE WHEN $3::boolean IS NULL THEN dismissed_at WHEN $3 THEN now() ELSE NULL END WHERE task_id=$4 AND recipient_id=$1 AND dismissed_at IS NULL AND retracted_at IS NULL RETURNING id")
        .bind(user).bind(input.read).bind(input.dismissed).bind(task).fetch_optional(&state.pool).await;
    match updated {
        Ok(Some(_)) => {
            Json(json!({"id":entry,"read":input.read,"dismissed":input.dismissed})).into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Deserialize)]
struct WatchUpdate {
    watching: Option<bool>,
    events: Option<Vec<String>>,
    muted: Option<bool>,
}

async fn get_watch(
    State(state): State<AuthState>,
    Path(task): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    if !matches!(readable_project(&state.pool, task, user).await, Ok(Some(_))) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let row = sqlx::query("SELECT EXISTS(SELECT 1 FROM task_watchers WHERE task_id=$1 AND user_id=$2) AS watching,COALESCE(p.events,ARRAY[]::text[]) AS events,COALESCE(p.muted,false) AS muted FROM tasks t LEFT JOIN task_notification_preferences p ON p.task_id=t.id AND p.user_id=$2 WHERE t.id=$1")
        .bind(task).bind(user).fetch_one(&state.pool).await;
    match row {
        Ok(row) => Json(json!({"task_id":task,"watching":row.get::<bool,_>("watching"),"events":row.get::<Vec<String>,_>("events"),"muted":row.get::<bool,_>("muted")})).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }
}

async fn update_watch(
    State(state): State<AuthState>,
    Path(task): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<WatchUpdate>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    if !matches!(readable_project(&state.pool, task, user).await, Ok(Some(_))) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let events = input.events.unwrap_or_default();
    if events.iter().any(|event| {
        !matches!(
            event.as_str(),
            "updated" | "comment" | "reply" | "mention" | "assignment"
        )
    }) {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if input.watching == Some(false) {
        if sqlx::query("DELETE FROM task_watchers WHERE task_id=$1 AND user_id=$2")
            .bind(task)
            .bind(user)
            .execute(&mut *tx)
            .await
            .is_err()
            || sqlx::query(
                "DELETE FROM task_notification_preferences WHERE task_id=$1 AND user_id=$2",
            )
            .bind(task)
            .bind(user)
            .execute(&mut *tx)
            .await
            .is_err()
        {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    } else {
        if sqlx::query("INSERT INTO task_watchers(workspace_id,task_id,user_id) SELECT workspace_id,id,$2 FROM tasks WHERE id=$1 ON CONFLICT DO NOTHING").bind(task).bind(user).execute(&mut *tx).await.is_err()
            || sqlx::query("INSERT INTO task_notification_preferences(task_id,user_id,events,muted) VALUES($1,$2,$3,$4) ON CONFLICT(task_id,user_id) DO UPDATE SET events=EXCLUDED.events,muted=EXCLUDED.muted,updated_at=now()")
                .bind(task).bind(user).bind(&events).bind(input.muted.unwrap_or(false)).execute(&mut *tx).await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
    }
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    Json(json!({"task_id":task,"watching":input.watching != Some(false),"events":events,"muted":input.muted.unwrap_or(false)})).into_response()
}
