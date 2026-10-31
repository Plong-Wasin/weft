//! Manual Task order: the drag-and-drop move, and per-person Project view settings.
//!
//! A Task's `rank` is a number on one line per Workspace. Siblings (same Project and parent) and
//! the Tasks of one Status bucket are ordered by it, so one rank serves the Project list, the
//! Subtask list and every board column. A move that only changes the rank is not an edit: it
//! does not bump `version`, writes no History and cannot be undone. A move into another Status
//! is an ordinary Status edit and is recorded (and undoable) exactly like one.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    auth::{require_session, AuthState},
    smart_query,
    tasks::{
        can_read, can_write, completed_at_after_status_change, conflict, serialize_task, task_row,
    },
};

/// Distance between neighbouring ranks after a renumber (2^24): about 24 drops between the
/// same two Tasks before the gap closes and the Workspace is renumbered.
const GAP: i64 = 16_777_216;

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route(
            "/workspaces/:workspace_id/tasks/:number/move",
            post(move_task),
        )
        .route(
            "/projects/:project_id/view-settings",
            get(read_view_settings).put(write_view_settings),
        )
}

fn refuse(error: &str, message: &str) -> Response {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        Json(json!({"error":error,"message":message})),
    )
        .into_response()
}

fn server_error() -> Response {
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}

#[derive(Deserialize)]
struct MoveRequest {
    /// Optional guard: when present it must equal the Task's version, else 409 `version_conflict`.
    expected_version: Option<i64>,
    command_id: Option<Uuid>,
    /// Status key to move the Task into (the drop target column).
    status: Option<String>,
    /// Place the Task right before / right after this sibling, or at the end of its siblings.
    before_task_id: Option<Uuid>,
    after_task_id: Option<Uuid>,
    to_end: Option<bool>,
    /// Reorder inside a manual List (its own order) instead of among Project siblings.
    list_id: Option<Uuid>,
}

enum Place {
    None,
    Before(Uuid),
    After(Uuid),
    End,
}

async fn move_task(
    State(state): State<AuthState>,
    Path((workspace, number)): Path<(Uuid, i64)>,
    headers: HeaderMap,
    Json(input): Json<MoveRequest>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let chosen = usize::from(input.before_task_id.is_some())
        + usize::from(input.after_task_id.is_some())
        + usize::from(input.to_end == Some(true));
    if chosen > 1 {
        return refuse(
            "invalid_position",
            "give at most one of before_task_id, after_task_id and to_end",
        );
    }
    let place = match (input.before_task_id, input.after_task_id, input.to_end) {
        (Some(id), _, _) => Place::Before(id),
        (_, Some(id), _) => Place::After(id),
        (_, _, Some(true)) => Place::End,
        _ => Place::None,
    };
    if input.status.is_none() && matches!(place, Place::None) {
        return refuse("empty_move", "name a status, a position or both");
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return server_error(),
    };
    // The Task is first read without a lock: Milestone and Status locks must precede the Task
    // row lock, the order every other Task writer uses.
    let found = match sqlx::query("SELECT id,project_id FROM tasks WHERE workspace_id=$1 AND number=$2 AND archived_at IS NULL")
        .bind(workspace)
        .bind(number)
        .fetch_optional(&mut *tx)
        .await
    {
        Ok(Some(row)) => row,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return server_error(),
    };
    let id: Uuid = found.get("id");
    let project: Uuid = found.get("project_id");
    match can_read(&mut *tx, project, user).await {
        Ok(true) => {}
        Ok(false) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return server_error(),
    }
    match can_write(&mut *tx, project, user).await {
        Ok(true) => {}
        Ok(false) => return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":"forbidden","message":"write access to the Project is required"})),
        )
            .into_response(),
        Err(_) => return server_error(),
    }
    if input.status.is_some()
        && crate::milestones::lock_for_tasks(&mut tx, &[id])
            .await
            .is_err()
    {
        return server_error();
    }
    if let Some(status) = input.status.as_deref() {
        // FOR SHARE pairs with archive_status's FOR UPDATE: no Task lands on a Status being archived.
        match sqlx::query_scalar::<_, i32>("SELECT 1 FROM workspace_statuses WHERE workspace_id=$1 AND status_key=$2 AND archived_at IS NULL FOR SHARE")
            .bind(workspace)
            .bind(status)
            .fetch_optional(&mut *tx)
            .await
        {
            Ok(Some(_)) => {}
            Ok(None) => return refuse("invalid_status", "unknown or archived status"),
            Err(_) => return server_error(),
        }
    }
    if !matches!(place, Place::None)
        && sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
            .bind(format!("task-rank:{workspace}"))
            .execute(&mut *tx)
            .await
            .is_err()
    {
        return server_error();
    }
    let task = match sqlx::query("SELECT parent_task_id,version,status,rank,completed_at::text AS completed_at FROM tasks WHERE id=$1 AND archived_at IS NULL FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
    {
        Ok(Some(row)) => row,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return server_error(),
    };
    let version: i64 = task.get("version");
    if input
        .expected_version
        .is_some_and(|expected| expected != version)
    {
        let _ = tx.rollback().await;
        return conflict(&state.pool, workspace, number, user).await;
    }
    let parent: Option<Uuid> = task.get("parent_task_id");
    let old_status: String = task.get("status");
    let old_completed_at: Option<String> = task.get("completed_at");

    // 1. Position.
    let ranked = match input.list_id {
        None => match place_among_siblings(&mut tx, workspace, project, parent, id, &place).await {
            Ok(Ok(changed)) => changed,
            Ok(Err(response)) => return response,
            Err(_) => return server_error(),
        },
        Some(list) => match place_in_list(&mut tx, workspace, user, list, id, &place).await {
            Ok(Ok(changed)) => changed,
            Ok(Err(response)) => return response,
            Err(_) => return server_error(),
        },
    };

    // 2. Status: an ordinary edit, recorded as one Operation group so Undo restores it.
    let mut group = None;
    let mut status_changed = false;
    if let Some(next) = input.status.as_deref().filter(|next| *next != old_status) {
        status_changed = true;
        let new_completed_at = match completed_at_after_status_change(
            &mut tx,
            workspace,
            &old_status,
            next,
            old_completed_at.clone(),
        )
        .await
        {
            Ok(value) => value,
            Err(_) => return server_error(),
        };
        let new_version: i64 = match sqlx::query_scalar("UPDATE tasks SET status=$2,completed_at=$3::timestamptz,updated_at=now(),version=version+1 WHERE id=$1 AND version=$4 RETURNING version")
            .bind(id)
            .bind(next)
            .bind(&new_completed_at)
            .bind(version)
            .fetch_one(&mut *tx)
            .await
        {
            Ok(version) => version,
            Err(_) => return server_error(),
        };
        let command = input.command_id.unwrap_or_else(Uuid::new_v4);
        let group_id = Uuid::new_v4();
        let mut changes = vec![("status", json!(old_status), json!(next))];
        if old_completed_at != new_completed_at {
            changes.push((
                "completed_at",
                json!(old_completed_at),
                json!(new_completed_at),
            ));
        }
        if sqlx::query("INSERT INTO task_operation_groups(id,command_id,workspace_id,actor_id) VALUES($1,$2,$3,$4)")
            .bind(group_id)
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
        {
            return server_error();
        }
        for (field, before, after) in changes {
            if sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,$4,$5,$6,$7)")
                .bind(Uuid::new_v4())
                .bind(group_id)
                .bind(id)
                .bind(field)
                .bind(before)
                .bind(after)
                .bind(new_version)
                .execute(&mut *tx)
                .await
                .is_err()
            {
                return server_error();
            }
        }
        let completing = old_completed_at.is_none() && new_completed_at.is_some();
        if completing
            && crate::recurrence::spawn_next(&mut tx, id, group_id, user, None)
                .await
                .is_err()
        {
            return server_error();
        }
        group = Some(group_id);
    }
    if tx.commit().await.is_err() {
        return server_error();
    }
    match task_row(&state.pool, workspace, number, false).await {
        Ok(Some(row)) => match serialize_task(&state.pool, &row, Some(user)).await {
            Ok(value) => Json(json!({
                "task": value,
                "tasks": [value],
                "group_id": group,
                "status_changed": status_changed,
                "reordered": ranked,
            }))
            .into_response(),
            Err(_) => server_error(),
        },
        _ => server_error(),
    }
}

/// Sets the Task's rank so it sits where `place` says among its siblings. `Ok(Err(response))`
/// is a refusal; `Ok(Ok(true))` means the rank changed.
async fn place_among_siblings(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace: Uuid,
    project: Uuid,
    parent: Option<Uuid>,
    task: Uuid,
    place: &Place,
) -> Result<Result<bool, Response>, sqlx::Error> {
    if matches!(place, Place::None) {
        return Ok(Ok(false));
    }
    let anchor = match place {
        Place::Before(id) | Place::After(id) => Some(*id),
        _ => None,
    };
    if anchor == Some(task) {
        return Ok(Err(refuse(
            "invalid_position",
            "a task cannot be placed relative to itself",
        )));
    }
    for attempt in 0..2 {
        let siblings = sqlx::query(
            "SELECT id,rank,number FROM tasks WHERE workspace_id=$1 AND project_id=$2 AND parent_task_id IS NOT DISTINCT FROM $3 AND archived_at IS NULL AND id<>$4 ORDER BY rank,number",
        )
        .bind(workspace)
        .bind(project)
        .bind(parent)
        .bind(task)
        .fetch_all(&mut **tx)
        .await?;
        let line: Vec<(Uuid, i64)> = siblings
            .iter()
            .map(|row| (row.get("id"), row.get("rank")))
            .collect();
        let current: i64 = sqlx::query_scalar("SELECT rank FROM tasks WHERE id=$1")
            .bind(task)
            .fetch_one(&mut **tx)
            .await?;
        let index = match place {
            Place::End => line.len(),
            Place::Before(id) | Place::After(id) => {
                let Some(position) = line.iter().position(|(sibling, _)| sibling == id) else {
                    return Ok(Err(refuse(
                        "anchor_not_in_scope",
                        "the anchor task is not a sibling of this task",
                    )));
                };
                if matches!(place, Place::Before(_)) {
                    position
                } else {
                    position + 1
                }
            }
            Place::None => unreachable!("handled above"),
        };
        let previous = index.checked_sub(1).map(|i| line[i].1);
        let next = line.get(index).map(|(_, rank)| *rank);
        let target = match (previous, next) {
            (None, None) => current,
            (None, Some(next)) => next - GAP,
            (Some(previous), None) => previous + GAP,
            (Some(previous), Some(next)) if next - previous >= 2 => {
                previous + (next - previous) / 2
            }
            // The gap is closed: renumber the Workspace once and look again.
            (Some(_), Some(_)) if attempt == 0 => {
                renumber(tx, workspace).await?;
                continue;
            }
            (Some(_), Some(_)) => return Ok(Err(server_error())),
        };
        if target == current {
            return Ok(Ok(false));
        }
        sqlx::query("UPDATE tasks SET rank=$2 WHERE id=$1")
            .bind(task)
            .bind(target)
            .execute(&mut **tx)
            .await?;
        return Ok(Ok(true));
    }
    Ok(Err(server_error()))
}

/// Renumbers every Task of the Workspace to evenly spaced ranks, keeping the current order.
async fn renumber(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE tasks t SET rank=r.n*$2 FROM (SELECT id,row_number() OVER (ORDER BY rank,number) AS n FROM tasks WHERE workspace_id=$1) r WHERE r.id=t.id AND t.rank<>r.n*$2")
        .bind(workspace)
        .bind(GAP)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Reorders a manual List: positions are dense integers, rewritten only where they change.
async fn place_in_list(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace: Uuid,
    user: Uuid,
    list: Uuid,
    task: Uuid,
    place: &Place,
) -> Result<Result<bool, Response>, sqlx::Error> {
    let kind: Option<String> =
        sqlx::query_scalar("SELECT kind FROM task_lists WHERE id=$1 AND workspace_id=$2")
            .bind(list)
            .bind(workspace)
            .fetch_optional(&mut **tx)
            .await?;
    let manageable: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND role<>'viewer')")
        .bind(workspace)
        .bind(user)
        .fetch_one(&mut **tx)
        .await?;
    match kind.as_deref() {
        None => return Ok(Err(StatusCode::NOT_FOUND.into_response())),
        Some("manual") if manageable => {}
        Some("manual") => return Ok(Err(StatusCode::FORBIDDEN.into_response())),
        Some(_) => {
            return Ok(Err(refuse(
                "not_a_manual_list",
                "only a manual List has a hand-kept order",
            )))
        }
    }
    // Lock the List's order so two moves cannot interleave their rewrites.
    sqlx::query(
        "SELECT task_id FROM task_list_memberships WHERE list_id=$1 ORDER BY task_id FOR UPDATE",
    )
    .bind(list)
    .fetch_all(&mut **tx)
    .await?;
    let mut order: Vec<Uuid> = sqlx::query_scalar("SELECT m.task_id FROM task_list_memberships m JOIN tasks t ON t.id=m.task_id WHERE m.list_id=$1 ORDER BY m.position,t.number")
        .bind(list)
        .fetch_all(&mut **tx)
        .await?;
    let Some(own) = order.iter().position(|id| *id == task) else {
        return Ok(Err(refuse(
            "not_in_list",
            "the task is not a member of this List",
        )));
    };
    if matches!(place, Place::None) {
        return Ok(Ok(false));
    }
    order.remove(own);
    let index = match place {
        Place::End => order.len(),
        Place::Before(id) | Place::After(id) => {
            let Some(position) = order.iter().position(|member| member == id) else {
                return Ok(Err(refuse(
                    "anchor_not_in_scope",
                    "the anchor task is not a member of this List",
                )));
            };
            if matches!(place, Place::Before(_)) {
                position
            } else {
                position + 1
            }
        }
        Place::None => unreachable!("handled above"),
    };
    order.insert(index, task);
    let positions: Vec<i32> = (0..order.len() as i32).collect();
    let changed = sqlx::query("UPDATE task_list_memberships m SET position=v.position FROM unnest($2::uuid[],$3::int[]) AS v(task_id,position) WHERE m.list_id=$1 AND m.task_id=v.task_id AND m.position<>v.position")
        .bind(list)
        .bind(&order)
        .bind(&positions)
        .execute(&mut **tx)
        .await?
        .rows_affected();
    Ok(Ok(changed > 0))
}

fn default_settings() -> Value {
    json!({"columns":["title","status","priority","due_date"],"sort":"manual","direction":"asc","group_by":null})
}

async fn read_view_settings(
    State(state): State<AuthState>,
    Path(project): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    match can_read(&state.pool, project, user).await {
        Ok(true) => {}
        Ok(false) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return server_error(),
    }
    match sqlx::query_scalar::<_, Value>(
        "SELECT settings FROM project_view_settings WHERE project_id=$1 AND user_id=$2",
    )
    .bind(project)
    .bind(user)
    .fetch_optional(&state.pool)
    .await
    {
        Ok(stored) => Json(json!({
            "project_id": project,
            "stored": stored.is_some(),
            "settings": stored.unwrap_or_else(default_settings),
        }))
        .into_response(),
        Err(_) => server_error(),
    }
}

#[derive(Deserialize)]
struct ViewSettings {
    columns: Vec<String>,
    sort: Option<String>,
    direction: Option<String>,
    group_by: Option<String>,
}

async fn write_view_settings(
    State(state): State<AuthState>,
    Path(project): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<ViewSettings>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    match can_read(&state.pool, project, user).await {
        Ok(true) => {}
        Ok(false) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return server_error(),
    }
    if input.columns.is_empty()
        || input.columns.len() > smart_query::MAX_COLUMNS
        || input.columns.iter().any(|c| !smart_query::is_column(c))
    {
        return refuse(
            "invalid_settings",
            "columns must be known built-in columns or attribute:<id>",
        );
    }
    if let Some(sort) = input.sort.as_deref() {
        if !smart_query::is_sort_field(sort) {
            return refuse("invalid_settings", "unknown sort field");
        }
    }
    if !matches!(input.direction.as_deref(), None | Some("asc" | "desc")) {
        return refuse("invalid_settings", "direction must be asc or desc");
    }
    if input
        .group_by
        .as_deref()
        .is_some_and(|g| g != "status" && !smart_query::is_column(g))
    {
        return refuse("invalid_settings", "cannot group by that field");
    }
    let workspace: Option<Uuid> =
        sqlx::query_scalar("SELECT workspace_id FROM projects WHERE id=$1")
            .bind(project)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten();
    let Some(workspace) = workspace else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let settings = json!({
        "columns": input.columns,
        "sort": input.sort.unwrap_or_else(|| "manual".into()),
        "direction": input.direction.unwrap_or_else(|| "asc".into()),
        "group_by": input.group_by,
    });
    match sqlx::query("INSERT INTO project_view_settings(workspace_id,project_id,user_id,settings) VALUES($1,$2,$3,$4) ON CONFLICT (project_id,user_id) DO UPDATE SET settings=EXCLUDED.settings,updated_at=now()")
        .bind(workspace)
        .bind(project)
        .bind(user)
        .bind(&settings)
        .execute(&state.pool)
        .await
    {
        Ok(_) => Json(json!({"project_id":project,"settings":settings,"stored":true})).into_response(),
        Err(_) => server_error(),
    }
}
