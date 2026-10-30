use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    auth::{require_session, AuthState},
    projects::{evaluate_access, Role},
    tasks::{serialize_task_summary, task_row},
};

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route(
            "/workspaces/:workspace_id/teams",
            get(list_teams).post(create_team),
        )
        .route(
            "/teams/:team_id",
            axum::routing::patch(rename_team).delete(delete_team),
        )
        .route(
            "/teams/:team_id/members",
            get(list_team_members).post(add_team_member),
        )
        .route(
            "/teams/:team_id/members/:user_id",
            delete(remove_team_member),
        )
        .route("/teams/:team_id/queue", get(team_queue))
        .route("/workspaces/:workspace_id/my-work", get(my_work))
}

async fn list_teams(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
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
        return StatusCode::NOT_FOUND.into_response();
    }
    match sqlx::query("SELECT id,name,created_at::text AS created_at,updated_at::text AS updated_at FROM teams WHERE workspace_id=$1 ORDER BY name,id")
        .bind(workspace)
        .fetch_all(&state.pool)
        .await
    {
        Ok(rows) => Json(json!({"teams": rows.into_iter().map(|row| json!({
            "id": row.get::<Uuid, _>("id"),
            "name": row.get::<String, _>("name"),
            "created_at": row.get::<String, _>("created_at"),
            "updated_at": row.get::<String, _>("updated_at"),
        })).collect::<Vec<Value>>()})).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Deserialize)]
struct TeamName {
    name: String,
}

async fn create_team(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<TeamName>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let role = workspace_role(&state, workspace, user).await;
    let Ok(Some(role)) = role else {
        return StatusCode::FORBIDDEN.into_response();
    };
    if !is_workspace_admin(&role) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let name = input.name.trim();
    if name.is_empty() {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let id = Uuid::new_v4();
    match sqlx::query("INSERT INTO teams(id,workspace_id,name) VALUES($1,$2,$3) RETURNING id,name,created_at::text AS created_at,updated_at::text AS updated_at")
        .bind(id)
        .bind(workspace)
        .bind(name)
        .fetch_one(&state.pool)
        .await
    {
        Ok(row) => (StatusCode::CREATED, Json(team_json(&row))).into_response(),
        Err(error) if error.as_database_error().is_some_and(|e| e.code().as_deref() == Some("23505")) => {
            (StatusCode::CONFLICT, Json(json!({"error":"team_name_exists"}))).into_response()
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn rename_team(
    State(state): State<AuthState>,
    Path(team): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<TeamName>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let workspace = match team_workspace(&state, team).await {
        Ok(Some(workspace)) => workspace,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if !is_admin_for(&state, workspace, user).await {
        return StatusCode::FORBIDDEN.into_response();
    }
    let name = input.name.trim();
    if name.is_empty() {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    match sqlx::query("UPDATE teams SET name=$2,updated_at=now() WHERE id=$1 RETURNING id,name,created_at::text AS created_at,updated_at::text AS updated_at")
        .bind(team)
        .bind(name)
        .fetch_optional(&state.pool)
        .await
    {
        Ok(Some(row)) => Json(team_json(&row)).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(error) if error.as_database_error().is_some_and(|e| e.code().as_deref() == Some("23505")) => {
            (StatusCode::CONFLICT, Json(json!({"error":"team_name_exists"}))).into_response()
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn delete_team(
    State(state): State<AuthState>,
    Path(team): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let workspace = match team_workspace(&state, team).await {
        Ok(Some(workspace)) => workspace,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if !is_admin_for(&state, workspace, user).await {
        return StatusCode::FORBIDDEN.into_response();
    }
    // Deleting would drop Task assignments with no ledger entry; ask the admin to reassign first.
    match sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM task_assignees WHERE team_id=$1)",
    )
    .bind(team)
    .fetch_one(&state.pool)
    .await
    {
        Ok(false) => {}
        Ok(true) => {
            return (
                StatusCode::CONFLICT,
                Json(json!({"error":"team_has_assigned_tasks"})),
            )
                .into_response()
        }
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    match sqlx::query("DELETE FROM teams WHERE id=$1")
        .bind(team)
        .execute(&state.pool)
        .await
    {
        Ok(result) if result.rows_affected() == 1 => StatusCode::NO_CONTENT.into_response(),
        Ok(_) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn list_team_members(
    State(state): State<AuthState>,
    Path(team): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let workspace = match team_workspace(&state, team).await {
        Ok(Some(workspace)) => workspace,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if !is_member_for(&state, workspace, user).await {
        return StatusCode::NOT_FOUND.into_response();
    }
    match sqlx::query("SELECT u.id,u.email FROM team_memberships tm JOIN users u ON u.id=tm.user_id WHERE tm.team_id=$1 ORDER BY u.email")
        .bind(team)
        .fetch_all(&state.pool)
        .await
    {
        Ok(rows) => Json(json!({"members": rows.into_iter().map(|row| json!({"id":row.get::<Uuid,_>("id"),"email":row.get::<String,_>("email")})).collect::<Vec<Value>>()})).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Deserialize)]
struct TeamMember {
    user_id: Uuid,
}

async fn add_team_member(
    State(state): State<AuthState>,
    Path(team): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<TeamMember>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let workspace = match team_workspace(&state, team).await {
        Ok(Some(workspace)) => workspace,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if !is_admin_for(&state, workspace, user).await {
        return StatusCode::FORBIDDEN.into_response();
    }
    let result = sqlx::query("INSERT INTO team_memberships(workspace_id,team_id,user_id) SELECT $1,$2,$3 WHERE EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$3) ON CONFLICT(team_id,user_id) DO NOTHING")
        .bind(workspace)
        .bind(team)
        .bind(input.user_id)
        .execute(&state.pool)
        .await;
    match result {
        Ok(_) if is_member_for(&state, workspace, input.user_id).await => {
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(_) => StatusCode::UNPROCESSABLE_ENTITY.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn remove_team_member(
    State(state): State<AuthState>,
    Path((team, target)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let workspace = match team_workspace(&state, team).await {
        Ok(Some(workspace)) => workspace,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if !is_admin_for(&state, workspace, user).await {
        return StatusCode::FORBIDDEN.into_response();
    }
    match sqlx::query("DELETE FROM team_memberships WHERE team_id=$1 AND user_id=$2")
        .bind(team)
        .bind(target)
        .execute(&state.pool)
        .await
    {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

fn team_json(row: &sqlx::postgres::PgRow) -> Value {
    json!({
        "id": row.get::<Uuid, _>("id"),
        "name": row.get::<String, _>("name"),
        "created_at": row.get::<String, _>("created_at"),
        "updated_at": row.get::<String, _>("updated_at"),
    })
}

async fn team_workspace(state: &AuthState, team: Uuid) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar("SELECT workspace_id FROM teams WHERE id=$1")
        .bind(team)
        .fetch_optional(&state.pool)
        .await
}

async fn workspace_role(
    state: &AuthState,
    workspace: Uuid,
    user: Uuid,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2",
    )
    .bind(workspace)
    .bind(user)
    .fetch_optional(&state.pool)
    .await
}

async fn is_admin_for(state: &AuthState, workspace: Uuid, user: Uuid) -> bool {
    workspace_role(state, workspace, user)
        .await
        .is_ok_and(|role| role.is_some_and(|role| is_workspace_admin(&role)))
}

async fn is_member_for(state: &AuthState, workspace: Uuid, user: Uuid) -> bool {
    workspace_role(state, workspace, user)
        .await
        .is_ok_and(|role| role.is_some())
}

fn is_workspace_admin(role: &str) -> bool {
    role == "owner" || role == "admin"
}

async fn team_queue(
    State(state): State<AuthState>,
    Path(team): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let workspace = match team_workspace(&state, team).await {
        Ok(Some(workspace)) => workspace,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let is_team_member = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM team_memberships WHERE team_id=$1 AND user_id=$2)",
    )
    .bind(team)
    .bind(user)
    .fetch_one(&state.pool)
    .await;
    if !matches!(is_team_member, Ok(true)) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match task_summaries(&state, workspace, user, "team", team).await {
        Ok(tasks) => Json(json!({"tasks":tasks})).into_response(),
        Err(status) => status.into_response(),
    }
}

#[derive(Deserialize)]
struct MyWorkParams {
    include_via_team: Option<bool>,
}

async fn my_work(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    Query(params): Query<MyWorkParams>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    if !is_member_for(&state, workspace, user).await {
        return StatusCode::NOT_FOUND.into_response();
    }
    let direct = match task_summaries(&state, workspace, user, "user", user).await {
        Ok(tasks) => tasks,
        Err(status) => return status.into_response(),
    };
    let teams: Vec<Uuid> = match sqlx::query_scalar(
        "SELECT team_id FROM team_memberships WHERE workspace_id=$1 AND user_id=$2 ORDER BY team_id",
    )
    .bind(workspace)
    .bind(user)
    .fetch_all(&state.pool)
    .await
    {
        Ok(teams) => teams,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let mut via_team = Vec::new();
    for team in teams {
        let tasks = match task_summaries(&state, workspace, user, "team", team).await {
            Ok(tasks) => tasks,
            Err(status) => return status.into_response(),
        };
        for task in tasks {
            if !via_team
                .iter()
                .any(|existing: &Value| existing["id"] == task["id"])
            {
                via_team.push(task);
            }
        }
    }
    let mut tasks = direct.clone();
    if params.include_via_team.unwrap_or(false) {
        for task in &via_team {
            if !tasks.iter().any(|existing| existing["id"] == task["id"]) {
                tasks.push(task.clone());
            }
        }
    }
    Json(json!({"tasks":tasks,"direct_tasks":direct,"via_team_tasks":via_team})).into_response()
}

async fn task_summaries(
    state: &AuthState,
    workspace: Uuid,
    user: Uuid,
    assignee_kind: &str,
    assignee_id: Uuid,
) -> Result<Vec<Value>, StatusCode> {
    let condition = if assignee_kind == "user" {
        "a.user_id=$2"
    } else {
        "a.team_id=$2"
    };
    let query = format!("SELECT t.number,t.project_id FROM tasks t JOIN task_assignees a ON a.task_id=t.id WHERE t.workspace_id=$1 AND {condition} AND t.archived_at IS NULL ORDER BY t.number");
    let rows = sqlx::query(&query)
        .bind(workspace)
        .bind(assignee_id)
        .fetch_all(&state.pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut tasks = Vec::new();
    for row in rows {
        let project: Uuid = row.get("project_id");
        match evaluate_access(&state.pool, project, user)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        {
            Some(access) if access.role >= Role::Viewer => {}
            _ => continue,
        }
        let number: i64 = row.get("number");
        let row = task_row(&state.pool, workspace, number, false)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .ok_or(StatusCode::NOT_FOUND)?;
        tasks.push(
            serialize_task_summary(&state.pool, &row, Some(user))
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
        );
    }
    Ok(tasks)
}
