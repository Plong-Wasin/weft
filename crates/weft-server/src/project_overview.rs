//! The Project overview: state, target dates, Milestones with progress, overdue Tasks and the
//! number of blocked Tasks, computed for the viewer.
//!
//! Everything here lives inside one Project, so the single Project access check covers every
//! number and list. A Project the viewer cannot read answers exactly like a missing Project.
//! "Today" is the date in the Workspace time zone. Each item carries the query string of the
//! Task list it summarises (`GET /workspaces/:id/tasks?...`), built from the same fragments
//! (`OVERDUE`, `BLOCKED`) the list filters use, so a count and its list never disagree.
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    auth::{require_session, AuthState},
    projects::{evaluate_access, Role},
};

/// Most overdue Tasks listed inline; the count is always complete and the link opens the full list.
const OVERDUE_PREVIEW: i64 = 20;

/// Task `t` is overdue: due before today in the Workspace time zone and not completed or canceled.
pub(crate) const OVERDUE: &str = "(t.archived_at IS NULL AND t.due_date < (SELECT (now() AT TIME ZONE w.time_zone)::date FROM workspaces w WHERE w.id=t.workspace_id) AND (SELECT s.category FROM workspace_statuses s WHERE s.workspace_id=t.workspace_id AND s.status_key=t.status) NOT IN ('completed','canceled'))";

/// Task `t` is blocked: open, and some open Task blocks it (same rule as the Blocker view).
pub(crate) const BLOCKED: &str = "(t.archived_at IS NULL AND (SELECT s.category FROM workspace_statuses s WHERE s.workspace_id=t.workspace_id AND s.status_key=t.status) NOT IN ('completed','canceled') AND EXISTS(SELECT 1 FROM task_relations r JOIN tasks b ON b.id=r.source_task_id AND b.archived_at IS NULL JOIN workspace_statuses bs ON bs.workspace_id=b.workspace_id AND bs.status_key=b.status WHERE r.target_task_id=t.id AND r.kind='blocks' AND bs.category NOT IN ('completed','canceled')))";

pub(crate) fn routes() -> Router<AuthState> {
    Router::new().route("/projects/:project_id/overview", get(overview))
}

async fn overview(
    State(state): State<AuthState>,
    Path(project): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let access = match evaluate_access(&state.pool, project, user).await {
        Ok(Some(access)) if access.role >= Role::Viewer => access,
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    match build(&state.pool, project, access.role).await {
        Ok(Some(value)) => Json(value).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn build(
    pool: &sqlx::PgPool,
    project: Uuid,
    role: Role,
) -> Result<Option<Value>, sqlx::Error> {
    let Some(row) = sqlx::query("SELECT p.id,p.name,p.visibility,p.state,p.target_start_date::text AS target_start_date,p.target_end_date::text AS target_end_date,(now() AT TIME ZONE w.time_zone)::date::text AS today,w.time_zone FROM projects p JOIN workspaces w ON w.id=p.workspace_id WHERE p.id=$1 AND p.archived_at IS NULL")
        .bind(project)
        .fetch_optional(pool)
        .await?
    else {
        return Ok(None);
    };
    let manager = role == Role::Manager;
    let base = format!("project_id={project}");
    let milestone_rows = sqlx::query("SELECT id,name,state,target_date::text AS target_date FROM milestones WHERE project_id=$1 AND archived_at IS NULL ORDER BY target_date NULLS LAST,created_at,id")
        .bind(project)
        .fetch_all(pool)
        .await?;
    let mut milestones = Vec::new();
    for milestone in &milestone_rows {
        let id: Uuid = milestone.get("id");
        let state: String = milestone.get("state");
        milestones.push(json!({
            "id":id,
            "name":milestone.get::<String,_>("name"),
            "state":state,
            "target_date":milestone.get::<Option<String>,_>("target_date"),
            "progress":crate::milestones::progress(pool,id,&state,manager).await?,
            "tasks_query":format!("{base}&milestone_id={id}"),
        }));
    }
    let overdue_count: i64 = sqlx::query_scalar(&format!(
        "SELECT count(*) FROM tasks t WHERE t.project_id=$1 AND {OVERDUE}"
    ))
    .bind(project)
    .fetch_one(pool)
    .await?;
    let overdue_rows = sqlx::query(&format!(
        "SELECT t.id,t.number,t.title,t.status,t.due_date::text AS due_date FROM tasks t WHERE t.project_id=$1 AND {OVERDUE} ORDER BY t.due_date,t.number LIMIT $2"
    ))
    .bind(project)
    .bind(OVERDUE_PREVIEW)
    .fetch_all(pool)
    .await?;
    let overdue: Vec<Value> = overdue_rows
        .iter()
        .map(|task| json!({"id":task.get::<Uuid,_>("id"),"number":task.get::<i64,_>("number"),"title":task.get::<String,_>("title"),"status":task.get::<String,_>("status"),"due_date":task.get::<Option<String>,_>("due_date")}))
        .collect();
    let blocked_count: i64 = sqlx::query_scalar(&format!(
        "SELECT count(*) FROM tasks t WHERE t.project_id=$1 AND {BLOCKED}"
    ))
    .bind(project)
    .fetch_one(pool)
    .await?;
    Ok(Some(json!({
        "project":{
            "id":project,
            "name":row.get::<String,_>("name"),
            "visibility":row.get::<String,_>("visibility"),
            "state":row.get::<String,_>("state"),
            "target_start_date":row.get::<Option<String>,_>("target_start_date"),
            "target_end_date":row.get::<Option<String>,_>("target_end_date"),
            "role":role.name(),
        },
        "today":row.get::<String,_>("today"),
        "time_zone":row.get::<String,_>("time_zone"),
        "milestones":milestones,
        "overdue":{"count":overdue_count,"tasks":overdue,"tasks_query":format!("{base}&overdue=true")},
        "blocked":{"count":blocked_count,"tasks_query":format!("{base}&blocked=true")},
        "all_tasks_query":base,
    })))
}
