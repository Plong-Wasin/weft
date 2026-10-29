use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::auth::{require_session, AuthState};

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route(
            "/workspaces/:workspace_id/projects",
            get(list_projects).post(create_project),
        )
        .route(
            "/projects/:project_id",
            get(read_project)
                .patch(update_project)
                .delete(archive_project),
        )
        .route(
            "/projects/:project_id/members",
            get(list_members).post(add_member),
        )
        .route(
            "/projects/:project_id/members/:user_id",
            delete(remove_member),
        )
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Role {
    None,
    Viewer,
    Contributor,
    Manager,
}

impl Role {
    pub(crate) fn parse(value: &str) -> Self {
        match value {
            "viewer" => Self::Viewer,
            "contributor" => Self::Contributor,
            "manager" => Self::Manager,
            _ => Self::None,
        }
    }
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Viewer => "viewer",
            Self::Contributor => "contributor",
            Self::Manager => "manager",
            Self::None => "none",
        }
    }
}

#[derive(Clone)]
pub(crate) struct ProjectAccess {
    pub(crate) workspace_id: Uuid,
    pub(crate) role: Role,
    pub(crate) workspace_role: String,
}

// The access evaluator is the only place project grants and the Workspace read-only ceiling are combined.
pub(crate) async fn evaluate_access(
    pool: impl sqlx::PgExecutor<'_>,
    project_id: Uuid,
    user_id: Uuid,
) -> Result<Option<ProjectAccess>, sqlx::Error> {
    let row = sqlx::query("SELECT p.workspace_id,p.visibility,p.archived_at::text AS archived_at,m.role AS project_role,w.role AS workspace_role FROM projects p JOIN workspace_memberships w ON w.workspace_id=p.workspace_id AND w.user_id=$2 LEFT JOIN project_memberships m ON m.project_id=p.id AND m.user_id=$2 WHERE p.id=$1")
        .bind(project_id).bind(user_id).fetch_optional(pool).await?;
    let Some(row) = row else { return Ok(None) };
    if row.get::<Option<String>, _>("archived_at").is_some() {
        return Ok(None);
    }
    let workspace_role: String = row.get("workspace_role");
    let mut role = Role::parse(
        row.get::<Option<String>, _>("project_role")
            .as_deref()
            .unwrap_or("none"),
    );
    if row.get::<String, _>("visibility") == "workspace" {
        role = role.max(Role::Viewer);
    }
    if workspace_role == "viewer" {
        role = role.min(Role::Viewer);
    }
    Ok(Some(ProjectAccess {
        workspace_id: row.get("workspace_id"),
        role,
        workspace_role,
    }))
}

async fn list_projects(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let rows = sqlx::query("SELECT id,name,visibility,version,created_at::text AS created_at,updated_at::text AS updated_at FROM projects WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY name")
        .bind(workspace).fetch_all(&state.pool).await;
    match rows {
        Ok(rows) => {
            let mut projects = Vec::new();
            for row in rows {
                let id: Uuid = row.get("id");
                match evaluate_access(&state.pool, id, user).await {
                    Ok(Some(access)) if access.role >= Role::Viewer => {
                        projects.push(project_json(&row))
                    }
                    Ok(_) => {}
                    Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                }
            }
            Json(json!({"projects": projects})).into_response()
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Deserialize)]
struct NewProject {
    name: String,
    visibility: String,
}

async fn create_project(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<NewProject>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let workspace_role = sqlx::query_scalar::<_, String>(
        "SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2",
    )
    .bind(workspace)
    .bind(user)
    .fetch_optional(&state.pool)
    .await;
    let Ok(Some(workspace_role)) = workspace_role else {
        return StatusCode::FORBIDDEN.into_response();
    };
    if workspace_role == "viewer" {
        return StatusCode::FORBIDDEN.into_response();
    }
    let name = input.name.trim();
    if name.is_empty() || !["restricted", "workspace"].contains(&input.visibility.as_str()) {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let id = Uuid::new_v4();
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let result = sqlx::query(
        "INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(id)
    .bind(workspace)
    .bind(name)
    .bind(&input.visibility)
    .bind(user)
    .execute(&mut *tx)
    .await;
    if result.is_err() || sqlx::query("INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2,$3,'manager')").bind(workspace).bind(id).bind(user).execute(&mut *tx).await.is_err() || tx.commit().await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
    (StatusCode::CREATED, Json(json!({"id":id,"workspace_id":workspace,"name":name,"visibility":input.visibility,"role":"manager","version":1}))).into_response()
}

async fn read_project(
    State(state): State<AuthState>,
    Path(project): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    match evaluate_access(&state.pool, project, user).await {
        Ok(Some(access)) if access.role >= Role::Viewer => {
            match sqlx::query("SELECT id,workspace_id,name,visibility,version,created_at::text AS created_at,updated_at::text AS updated_at FROM projects WHERE id=$1 AND archived_at IS NULL").bind(project).fetch_one(&state.pool).await {
                Ok(row) => { let mut value = project_json(&row); value["role"] = json!(access.role.name()); Json(value).into_response() },
                Err(_) => StatusCode::NOT_FOUND.into_response(),
            }
        }
        Ok(_) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Deserialize)]
struct ProjectUpdate {
    name: Option<String>,
    visibility: Option<String>,
}

async fn update_project(
    State(state): State<AuthState>,
    Path(project): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<ProjectUpdate>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    match evaluate_access(&state.pool, project, user).await {
        Ok(Some(access)) if access.role == Role::Manager => {
            let name = input.name.map(|v| v.trim().to_owned());
            if name.as_deref().is_some_and(str::is_empty)
                || input
                    .visibility
                    .as_deref()
                    .is_some_and(|v| !["restricted", "workspace"].contains(&v))
            {
                return StatusCode::UNPROCESSABLE_ENTITY.into_response();
            }
            if name.is_none() && input.visibility.is_none() {
                return StatusCode::UNPROCESSABLE_ENTITY.into_response();
            }
            let row = sqlx::query("UPDATE projects SET name=COALESCE($2,name),visibility=COALESCE($3,visibility),updated_at=now(),version=version+1 WHERE id=$1 AND archived_at IS NULL RETURNING id,workspace_id,name,visibility,version,created_at::text AS created_at,updated_at::text AS updated_at")
                .bind(project).bind(name).bind(input.visibility).fetch_optional(&state.pool).await;
            match row {
                Ok(Some(row)) => Json(project_json(&row)).into_response(),
                Ok(None) => StatusCode::NOT_FOUND.into_response(),
                Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            }
        }
        Ok(_) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn archive_project(
    State(state): State<AuthState>,
    Path(project): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    match evaluate_access(&state.pool, project, user).await {
        Ok(Some(access)) if access.role == Role::Manager => match sqlx::query("UPDATE projects SET archived_at=now(),updated_at=now(),version=version+1 WHERE id=$1 AND archived_at IS NULL").bind(project).execute(&state.pool).await {
            Ok(result) if result.rows_affected() == 1 => StatusCode::NO_CONTENT.into_response(),
            Ok(_) => StatusCode::NOT_FOUND.into_response(), Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        },
        Ok(_) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn list_members(
    State(state): State<AuthState>,
    Path(project): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let access = match evaluate_access(&state.pool, project, user).await {
        Ok(Some(a)) if a.role >= Role::Viewer => a,
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let rows = sqlx::query("SELECT u.id,u.email,m.role FROM project_memberships m JOIN users u ON u.id=m.user_id WHERE m.project_id=$1 ORDER BY u.email").bind(project).fetch_all(&state.pool).await;
    match rows { Ok(rows) => Json(json!({"workspace_id":access.workspace_id,"members":rows.into_iter().map(|r|json!({"user_id":r.get::<Uuid,_>("id"),"email":r.get::<String,_>("email"),"role":r.get::<String,_>("role")})).collect::<Vec<_>>()})).into_response(), Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response() }
}

#[derive(Deserialize)]
struct NewMember {
    user_id: Uuid,
    role: String,
}

async fn add_member(
    State(state): State<AuthState>,
    Path(project): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<NewMember>,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let access = match evaluate_access(&state.pool, project, actor).await {
        Ok(Some(a)) => a,
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let is_self_admin =
        actor == input.user_id && matches!(access.workspace_role.as_str(), "admin" | "owner");
    if access.role != Role::Manager && !is_self_admin {
        return StatusCode::NOT_FOUND.into_response();
    }
    if !["viewer", "contributor", "manager"].contains(&input.role.as_str()) {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let valid_member = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2)",
    )
    .bind(access.workspace_id)
    .bind(input.user_id)
    .fetch_one(&mut *tx)
    .await;
    if !matches!(valid_member, Ok(true)) {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let result = sqlx::query("INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2,$3,$4) ON CONFLICT(project_id,user_id) DO UPDATE SET role=EXCLUDED.role").bind(access.workspace_id).bind(project).bind(input.user_id).bind(&input.role).execute(&mut *tx).await;
    if result.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if is_self_admin && sqlx::query("INSERT INTO security_audit_events(actor_id,workspace_id,event,subject_id) VALUES($1,$2,'project.admin_self_membership',$3)").bind(actor).bind(access.workspace_id).bind(project).execute(&mut *tx).await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    (StatusCode::NO_CONTENT).into_response()
}

async fn remove_member(
    State(state): State<AuthState>,
    Path((project, target)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    match evaluate_access(&state.pool, project, user).await {
        Ok(Some(access)) if access.role == Role::Manager => {
            match sqlx::query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2")
                .bind(project)
                .bind(target)
                .execute(&state.pool)
                .await
            {
                Ok(result) if result.rows_affected() == 1 => StatusCode::NO_CONTENT.into_response(),
                Ok(_) => StatusCode::NOT_FOUND.into_response(),
                Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            }
        }
        Ok(_) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

fn project_json(row: &sqlx::postgres::PgRow) -> Value {
    json!({"id":row.get::<Uuid,_>("id"),"workspace_id":row.get::<Uuid,_>("workspace_id"),"name":row.get::<String,_>("name"),"visibility":row.get::<String,_>("visibility"),"version":row.get::<i64,_>("version"),"created_at":row.get::<String,_>("created_at"),"updated_at":row.get::<String,_>("updated_at")})
}
