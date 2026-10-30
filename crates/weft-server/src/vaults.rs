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

use crate::{
    auth::{require_session, AuthState},
    projects::Role,
};

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route(
            "/workspaces/:workspace_id/vaults",
            get(list_vaults).post(create_vault),
        )
        .route(
            "/vaults/:vault_id/members",
            get(list_members).post(add_member),
        )
        .route("/vaults/:vault_id/contents", get(read_contents))
        .route(
            "/vaults/:vault_id/members/:principal_type/:principal_id",
            delete(remove_member),
        )
}

#[derive(Clone)]
pub(crate) struct VaultAccess {
    pub(crate) workspace_id: Uuid,
    pub(crate) role: Role,
    pub(crate) workspace_role: String,
}

pub(crate) async fn evaluate_access(
    pool: impl sqlx::PgExecutor<'_>,
    vault_id: Uuid,
    user_id: Uuid,
) -> Result<Option<VaultAccess>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT v.workspace_id,wm.role AS workspace_role,v.visibility,
            GREATEST(
                COALESCE((SELECT CASE vm.role WHEN 'manager' THEN 3 WHEN 'contributor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END FROM vault_user_memberships vm WHERE vm.vault_id=v.id AND vm.user_id=$2),0),
                COALESCE((SELECT max(CASE vtm.role WHEN 'manager' THEN 3 WHEN 'contributor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END) FROM vault_team_memberships vtm JOIN team_memberships tm ON tm.team_id=vtm.team_id AND tm.user_id=$2 WHERE vtm.vault_id=v.id),0),
                CASE WHEN v.visibility='workspace' THEN 1 ELSE 0 END,
                COALESCE((SELECT max(CASE vpm.role WHEN 'manager' THEN 3 WHEN 'contributor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END)
                    FROM vault_project_memberships vpm
                    JOIN projects p ON p.id=vpm.project_id AND p.archived_at IS NULL
                    WHERE vpm.vault_id=v.id AND EXISTS (
                        SELECT 1 FROM workspace_memberships project_member
                        WHERE project_member.workspace_id=p.workspace_id AND project_member.user_id=$2
                        AND (
                            p.visibility='workspace'
                            OR EXISTS (SELECT 1 FROM project_memberships pm WHERE pm.project_id=p.id AND pm.user_id=$2)
                            OR EXISTS (SELECT 1 FROM project_team_memberships ptm JOIN team_memberships project_team ON project_team.team_id=ptm.team_id AND project_team.user_id=$2 WHERE ptm.project_id=p.id)
                        )
                    )),0)
            ) AS access_grade
        FROM vaults v JOIN workspace_memberships wm ON wm.workspace_id=v.workspace_id AND wm.user_id=$2
        WHERE v.id=$1",
    )
    .bind(vault_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let workspace_role: String = row.get("workspace_role");
    let mut grade: i32 = row.get("access_grade");
    if workspace_role == "viewer" {
        grade = grade.min(1);
    }
    let role = match grade {
        1 => Role::Viewer,
        2 => Role::Contributor,
        3.. => Role::Manager,
        _ => Role::None,
    };
    Ok(Some(VaultAccess {
        workspace_id: row.get("workspace_id"),
        role,
        workspace_role,
    }))
}

async fn list_vaults(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let workspace_role = sqlx::query_scalar::<_, String>(
        "SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2",
    )
    .bind(workspace)
    .bind(user)
    .fetch_optional(&state.pool)
    .await;
    let Ok(Some(workspace_role)) = workspace_role else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let rows = sqlx::query("SELECT id,workspace_id,name,visibility,created_at::text AS created_at,updated_at::text AS updated_at FROM vaults WHERE workspace_id=$1 ORDER BY name,id")
        .bind(workspace)
        .fetch_all(&state.pool)
        .await;
    let Ok(rows) = rows else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let mut vaults = Vec::new();
    for row in rows {
        let vault_id: Uuid = row.get("id");
        let admin = matches!(workspace_role.as_str(), "owner" | "admin");
        if admin {
            vaults.push(vault_json(&row, Role::None));
            continue;
        }
        match evaluate_access(&state.pool, vault_id, user).await {
            Ok(Some(access)) if access.role >= Role::Viewer => {
                vaults.push(vault_json(&row, access.role))
            }
            Ok(_) => {}
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    }
    Json(json!({"vaults": vaults})).into_response()
}

#[derive(Deserialize)]
struct NewVault {
    name: String,
    visibility: Option<String>,
}

async fn create_vault(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<NewVault>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
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
    let visibility = input.visibility.as_deref().unwrap_or("restricted");
    if name.is_empty() || !["restricted", "workspace"].contains(&visibility) {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let id = Uuid::new_v4();
    let repository_path = state.vault_root.join(format!("{id}.git"));
    if std::fs::create_dir_all(&state.vault_root).is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let initialized = crate::vault_import::git_command()
        .arg("init")
        .arg("--bare")
        .arg("--initial-branch=main")
        .arg(&repository_path)
        .output();
    if !initialized.is_ok_and(|result| result.status.success()) {
        let _ = std::fs::remove_dir_all(&repository_path);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let result = async {
        let mut tx = state.pool.begin().await?;
        sqlx::query("INSERT INTO vaults(id,workspace_id,name,visibility,repository_path,created_by) VALUES($1,$2,$3,$4,$5,$6)")
            .bind(id)
            .bind(workspace)
            .bind(name)
            .bind(visibility)
            .bind(repository_path.to_string_lossy().as_ref())
            .bind(user)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO vault_user_memberships(workspace_id,vault_id,user_id,role) VALUES($1,$2,$3,'manager')")
            .bind(workspace)
            .bind(id)
            .bind(user)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok::<(), sqlx::Error>(())
    }
    .await;
    match result {
        Ok(()) => (
            StatusCode::CREATED,
            Json(json!({"id":id,"workspace_id":workspace,"name":name,"visibility":visibility})),
        )
            .into_response(),
        Err(error)
            if error
                .as_database_error()
                .is_some_and(|database| database.code().as_deref() == Some("23505")) =>
        {
            let _ = std::fs::remove_dir_all(&repository_path);
            (
                StatusCode::CONFLICT,
                Json(json!({"error":"vault_name_exists"})),
            )
                .into_response()
        }
        Err(_) => {
            let _ = std::fs::remove_dir_all(&repository_path);
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn list_members(
    State(state): State<AuthState>,
    Path(vault): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let access = match evaluate_access(&state.pool, vault, user).await {
        Ok(Some(access)) => access,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if access.role != Role::Manager && !is_workspace_admin(&access.workspace_role) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let rows = sqlx::query(
        "SELECT 'user' AS principal_type,m.user_id AS principal_id,u.email AS name,m.role FROM vault_user_memberships m JOIN users u ON u.id=m.user_id WHERE m.vault_id=$1
        UNION ALL SELECT 'team',m.team_id,t.name,m.role FROM vault_team_memberships m JOIN teams t ON t.id=m.team_id WHERE m.vault_id=$1
        UNION ALL SELECT 'project',m.project_id,p.name,m.role FROM vault_project_memberships m JOIN projects p ON p.id=m.project_id WHERE m.vault_id=$1
        ORDER BY principal_type,name,principal_id",
    )
    .bind(vault)
    .fetch_all(&state.pool)
    .await;
    match rows {
        Ok(rows) => Json(json!({"members":rows.into_iter().map(|row| json!({
            "principal_type":row.get::<String,_>("principal_type"),
            "principal_id":row.get::<Uuid,_>("principal_id"),
            "name":row.get::<String,_>("name"),
            "role":row.get::<String,_>("role"),
        })).collect::<Vec<Value>>()}))
        .into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn read_contents(
    State(state): State<AuthState>,
    Path(vault): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let access = match evaluate_access(&state.pool, vault, user).await {
        Ok(Some(access)) if access.role >= Role::Viewer => access,
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let repository_path =
        sqlx::query_scalar::<_, String>("SELECT repository_path FROM vaults WHERE id=$1")
            .bind(vault)
            .fetch_optional(&state.pool)
            .await;
    let Ok(Some(repository_path)) = repository_path else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let has_head = crate::vault_import::git_readonly_command()
        .arg("--git-dir")
        .arg(&repository_path)
        .args(["rev-parse", "--verify", "--quiet", "HEAD"])
        .output();
    let files = match has_head {
        Ok(result) if result.status.success() => {
            let listed = crate::vault_import::git_readonly_command()
                .arg("--git-dir")
                .arg(&repository_path)
                .args(["ls-tree", "-r", "--name-only", "HEAD"])
                .output();
            match listed {
                Ok(result) if result.status.success() => match String::from_utf8(result.stdout) {
                    Ok(output) => output
                        .lines()
                        .filter(|path| *path != ".obsidian" && !path.starts_with(".obsidian/"))
                        .map(str::to_owned)
                        .collect::<Vec<_>>(),
                    Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                },
                _ => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            }
        }
        Ok(result) if result.status.code() == Some(1) => Vec::new(),
        _ => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if sqlx::query("INSERT INTO security_audit_events(actor_id,workspace_id,event,subject_id) VALUES($1,$2,'vault.contents.read',$3)")
        .bind(user)
        .bind(access.workspace_id)
        .bind(vault)
        .execute(&state.pool)
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    Json(json!({"files":files})).into_response()
}

#[derive(Deserialize)]
struct NewMember {
    principal_type: String,
    principal_id: Uuid,
    role: String,
}

async fn add_member(
    State(state): State<AuthState>,
    Path(vault): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<NewMember>,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, true).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let access = match evaluate_access(&state.pool, vault, actor).await {
        Ok(Some(access)) => access,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let is_self_admin = input.principal_type == "user"
        && input.principal_id == actor
        && is_workspace_admin(&access.workspace_role);
    if access.role != Role::Manager && !is_self_admin {
        return StatusCode::NOT_FOUND.into_response();
    }
    if !["viewer", "contributor", "manager"].contains(&input.role.as_str())
        || !["user", "team", "project"].contains(&input.principal_type.as_str())
    {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let valid = match input.principal_type.as_str() {
        "user" => sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2)")
            .bind(access.workspace_id).bind(input.principal_id).fetch_one(&mut *tx).await,
        "team" => sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM teams WHERE workspace_id=$1 AND id=$2)")
            .bind(access.workspace_id).bind(input.principal_id).fetch_one(&mut *tx).await,
        "project" => sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM projects WHERE workspace_id=$1 AND id=$2)")
            .bind(access.workspace_id).bind(input.principal_id).fetch_one(&mut *tx).await,
        _ => unreachable!(),
    };
    match valid {
        Ok(true) => {}
        Ok(false) => return StatusCode::UNPROCESSABLE_ENTITY.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    let sql = match input.principal_type.as_str() {
        "user" => "INSERT INTO vault_user_memberships(workspace_id,vault_id,user_id,role) VALUES($1,$2,$3,$4) ON CONFLICT(vault_id,user_id) DO UPDATE SET role=EXCLUDED.role",
        "team" => "INSERT INTO vault_team_memberships(workspace_id,vault_id,team_id,role) VALUES($1,$2,$3,$4) ON CONFLICT(vault_id,team_id) DO UPDATE SET role=EXCLUDED.role",
        "project" => "INSERT INTO vault_project_memberships(workspace_id,vault_id,project_id,role) VALUES($1,$2,$3,$4) ON CONFLICT(vault_id,project_id) DO UPDATE SET role=EXCLUDED.role",
        _ => unreachable!(),
    };
    if sqlx::query(sql)
        .bind(access.workspace_id)
        .bind(vault)
        .bind(input.principal_id)
        .bind(&input.role)
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if is_self_admin
        && sqlx::query("INSERT INTO security_audit_events(actor_id,workspace_id,event,subject_id) VALUES($1,$2,'vault.admin_self_membership',$3)")
            .bind(actor)
            .bind(access.workspace_id)
            .bind(vault)
            .execute(&mut *tx)
            .await
            .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn remove_member(
    State(state): State<AuthState>,
    Path((vault, principal_type, principal_id)): Path<(Uuid, String, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, true).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let access = match evaluate_access(&state.pool, vault, actor).await {
        Ok(Some(access)) => access,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if access.role != Role::Manager {
        return StatusCode::NOT_FOUND.into_response();
    }
    let sql = match principal_type.as_str() {
        "user" => "DELETE FROM vault_user_memberships WHERE vault_id=$1 AND user_id=$2",
        "team" => "DELETE FROM vault_team_memberships WHERE vault_id=$1 AND team_id=$2",
        "project" => "DELETE FROM vault_project_memberships WHERE vault_id=$1 AND project_id=$2",
        _ => return StatusCode::UNPROCESSABLE_ENTITY.into_response(),
    };
    match sqlx::query(sql)
        .bind(vault)
        .bind(principal_id)
        .execute(&state.pool)
        .await
    {
        Ok(result) if result.rows_affected() == 1 => StatusCode::NO_CONTENT.into_response(),
        Ok(_) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

fn is_workspace_admin(role: &str) -> bool {
    matches!(role, "owner" | "admin")
}

fn vault_json(row: &sqlx::postgres::PgRow, role: Role) -> Value {
    json!({
        "id": row.get::<Uuid, _>("id"),
        "workspace_id": row.get::<Uuid, _>("workspace_id"),
        "name": row.get::<String, _>("name"),
        "visibility": row.get::<String, _>("visibility"),
        "role": role.name(),
        "created_at": row.get::<String, _>("created_at"),
        "updated_at": row.get::<String, _>("updated_at"),
    })
}
