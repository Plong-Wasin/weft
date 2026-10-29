use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::auth::{require_session, AuthState};

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route("/workspaces/:workspace_id/skills", get(list).post(create))
        .route(
            "/workspaces/:workspace_id/skills/settings",
            patch(update_settings),
        )
        .route(
            "/workspaces/:workspace_id/skills/:skill_id",
            get(read).patch(update).delete(archive),
        )
        .route(
            "/workspaces/:workspace_id/skills/:skill_id/history",
            get(history),
        )
        .route(
            "/workspaces/:workspace_id/skills/:skill_id/undo",
            post(undo),
        )
        .route(
            "/workspaces/:workspace_id/skills/:skill_id/redo",
            post(redo),
        )
}

async fn member_role(
    pool: &PgPool,
    workspace: Uuid,
    user: Uuid,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2",
    )
    .bind(workspace)
    .bind(user)
    .fetch_optional(pool)
    .await
}

fn can_manage(role: Option<&str>) -> bool {
    role.is_some_and(|role| role == "owner" || role == "admin")
}

async fn list(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let role = match member_role(&state.pool, workspace, user).await {
        Ok(Some(role)) => role,
        Ok(None) => return StatusCode::FORBIDDEN.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let rows = match sqlx::query("SELECT id,name,description,enabled,version FROM skills WHERE workspace_id=$1 AND archived_at IS NULL AND (enabled OR $2) ORDER BY name")
        .bind(workspace).bind(can_manage(Some(role.as_str()))).fetch_all(&state.pool).await { Ok(rows)=>rows,Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
    Json(json!({"skills":rows.into_iter().map(|r| json!({"id":r.get::<Uuid,_>("id"),"name":r.get::<String,_>("name"),"description":r.get::<String,_>("description"),"enabled":r.get::<bool,_>("enabled"),"version":r.get::<i64,_>("version")})).collect::<Vec<_>>()})).into_response()
}

async fn read(
    State(state): State<AuthState>,
    Path((workspace, skill)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let role = match member_role(&state.pool, workspace, user).await {
        Ok(Some(role)) => role,
        Ok(None) => return StatusCode::FORBIDDEN.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    match sqlx::query("SELECT id,name,description,body,enabled,version FROM skills WHERE workspace_id=$1 AND id=$2 AND archived_at IS NULL AND (enabled OR $3)")
        .bind(workspace).bind(skill).bind(can_manage(Some(role.as_str()))).fetch_optional(&state.pool).await {
        Ok(Some(r))=>Json(json!({"id":r.get::<Uuid,_>("id"),"name":r.get::<String,_>("name"),"description":r.get::<String,_>("description"),"body":r.get::<String,_>("body"),"enabled":r.get::<bool,_>("enabled"),"version":r.get::<i64,_>("version")})).into_response(),
        Ok(None)=>StatusCode::NOT_FOUND.into_response(), Err(_)=>StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }
}

#[derive(Deserialize)]
struct SkillInput {
    name: String,
    description: String,
    body: String,
}

#[derive(Deserialize)]
struct SkillSettings {
    max_name_chars: Option<i32>,
    max_description_chars: Option<i32>,
    max_body_chars: Option<i32>,
}

async fn update_settings(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<SkillSettings>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    match member_role(&state.pool, workspace, user).await {
        Ok(role) if can_manage(role.as_deref()) => {}
        Ok(_) => return StatusCode::FORBIDDEN.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    if [
        input.max_name_chars,
        input.max_description_chars,
        input.max_body_chars,
    ]
    .iter()
    .flatten()
    .any(|v| *v < 1)
    {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    match sqlx::query("UPDATE workspace_skill_settings SET max_name_chars=COALESCE($2,max_name_chars),max_description_chars=COALESCE($3,max_description_chars),max_body_chars=COALESCE($4,max_body_chars) WHERE workspace_id=$1 RETURNING max_name_chars,max_description_chars,max_body_chars")
        .bind(workspace).bind(input.max_name_chars).bind(input.max_description_chars).bind(input.max_body_chars).fetch_optional(&state.pool).await {
        Ok(Some(row))=>Json(json!({"max_name_chars":row.get::<i32,_>("max_name_chars"),"max_description_chars":row.get::<i32,_>("max_description_chars"),"max_body_chars":row.get::<i32,_>("max_body_chars")})).into_response(),
        Ok(None)=>(StatusCode::NOT_FOUND,Json(json!({"error":"workspace_not_found"}))).into_response(),
        Err(sqlx::Error::Database(e)) if e.code().as_deref()==Some("23514")=>StatusCode::UNPROCESSABLE_ENTITY.into_response(),
        Err(_)=>StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }
}

async fn create(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<SkillInput>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    match member_role(&state.pool, workspace, user).await {
        Ok(role) if can_manage(role.as_deref()) => {}
        Ok(Some(_)) => return StatusCode::FORBIDDEN.into_response(),
        Ok(None) => return StatusCode::FORBIDDEN.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    let input = match validate(&state.pool, workspace, input).await {
        Ok(v) => v,
        Err(Some(code)) => return (code, Json(json!({"error":"invalid_skill"}))).into_response(),
        Err(None) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let id = Uuid::new_v4();
    let row = match sqlx::query("INSERT INTO skills(id,workspace_id,name,description,body,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,description,body,enabled,version")
        .bind(id).bind(workspace).bind(&input.name).bind(&input.description).bind(&input.body).bind(user).fetch_one(&mut *tx).await {
        Ok(row)=>row,
        Err(e) if is_unique_violation(&e)=> return (StatusCode::CONFLICT, Json(json!({"error":"skill_name_exists"}))).into_response(),
        Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response()
    };
    // Reversing a create archives it; redo restores the same stable Skill.
    if record_group(
        &mut tx,
        workspace,
        user,
        id,
        1,
        &[("archived", json!(true), json!(false))],
    )
    .await
    .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    (StatusCode::CREATED, Json(skill_json(&row))).into_response()
}

#[derive(Deserialize)]
struct SkillUpdate {
    expected_version: i64,
    name: Option<String>,
    description: Option<String>,
    body: Option<String>,
    enabled: Option<bool>,
}

async fn update(
    State(state): State<AuthState>,
    Path((workspace, skill)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(input): Json<SkillUpdate>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    match member_role(&state.pool, workspace, user).await {
        Ok(role) if can_manage(role.as_deref()) => {}
        Ok(_) => return StatusCode::FORBIDDEN.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let row=match sqlx::query("SELECT id,name,description,body,enabled,version FROM skills WHERE workspace_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE").bind(workspace).bind(skill).fetch_optional(&mut *tx).await {
        Ok(Some(r))=>r,Ok(None)=>return StatusCode::NOT_FOUND.into_response(),Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response()
    };
    let version: i64 = row.get("version");
    if version != input.expected_version {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"skill_version_conflict","current":skill_json(&row)})),
        )
            .into_response();
    }
    let current = SkillInput {
        name: input.name.unwrap_or_else(|| row.get("name")),
        description: input.description.unwrap_or_else(|| row.get("description")),
        body: input.body.unwrap_or_else(|| row.get("body")),
    };
    let current = match validate_tx(&mut tx, workspace, current).await {
        Ok(v) => v,
        Err(Some(code)) => return (code, Json(json!({"error":"invalid_skill"}))).into_response(),
        Err(None) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let enabled = input.enabled.unwrap_or_else(|| row.get("enabled"));
    let before = [
        json!(row.get::<String, _>("name")),
        json!(row.get::<String, _>("description")),
        json!(row.get::<String, _>("body")),
        json!(row.get::<bool, _>("enabled")),
    ];
    let after = [
        json!(current.name),
        json!(current.description),
        json!(current.body),
        json!(enabled),
    ];
    let fields = ["name", "description", "body", "enabled"];
    let changes: Vec<_> = fields
        .iter()
        .enumerate()
        .filter(|(i, _)| before[*i] != after[*i])
        .map(|(i, field)| (*field, before[i].clone(), after[i].clone()))
        .collect();
    if changes.is_empty() {
        return (StatusCode::OK, Json(skill_json(&row))).into_response();
    }
    let new_version = version + 1;
    if record_group(&mut tx, workspace, user, skill, new_version, &changes)
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let updated=match sqlx::query("UPDATE skills SET name=$3,description=$4,body=$5,enabled=$6,version=$7,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING id,name,description,body,enabled,version").bind(workspace).bind(skill).bind(&current.name).bind(&current.description).bind(&current.body).bind(enabled).bind(new_version).fetch_one(&mut *tx).await {
        Ok(r)=>r,Err(e) if is_unique_violation(&e)=>return (StatusCode::CONFLICT,Json(json!({"error":"skill_name_exists"}))).into_response(),Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response()
    };
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    Json(skill_json(&updated)).into_response()
}

async fn archive(
    State(state): State<AuthState>,
    Path((workspace, skill)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(input): Json<ArchiveInput>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    match member_role(&state.pool, workspace, user).await {
        Ok(role) if can_manage(role.as_deref()) => {}
        Ok(_) => return StatusCode::FORBIDDEN.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let version=match sqlx::query_scalar::<_,i64>("SELECT version FROM skills WHERE workspace_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE").bind(workspace).bind(skill).fetch_optional(&mut *tx).await{Ok(Some(v))=>v,Ok(None)=>return StatusCode::NOT_FOUND.into_response(),Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response()};
    if version != input.expected_version {
        return StatusCode::CONFLICT.into_response();
    }
    if record_group(
        &mut tx,
        workspace,
        user,
        skill,
        version + 1,
        &[("archived", json!(false), json!(true))],
    )
    .await
    .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    match sqlx::query("UPDATE skills SET archived_at=now(),version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2").bind(workspace).bind(skill).execute(&mut *tx).await {
        Ok(r) if r.rows_affected()==1=>{},
        Ok(_)=>return StatusCode::NOT_FOUND.into_response(),Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
struct ArchiveInput {
    expected_version: i64,
}

fn skill_json(row: &sqlx::postgres::PgRow) -> Value {
    json!({"id":row.get::<Uuid,_>("id"),"name":row.get::<String,_>("name"),"description":row.get::<String,_>("description"),"body":row.get::<String,_>("body"),"enabled":row.get::<bool,_>("enabled"),"version":row.get::<i64,_>("version")})
}

async fn validate(
    pool: &PgPool,
    workspace: Uuid,
    input: SkillInput,
) -> Result<SkillInput, Option<StatusCode>> {
    validate_limits(sqlx::query("SELECT max_name_chars,max_description_chars,max_body_chars FROM workspace_skill_settings WHERE workspace_id=$1").bind(workspace).fetch_optional(pool).await.map_err(|_|None)?,input)
}
async fn validate_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace: Uuid,
    input: SkillInput,
) -> Result<SkillInput, Option<StatusCode>> {
    validate_limits(sqlx::query("SELECT max_name_chars,max_description_chars,max_body_chars FROM workspace_skill_settings WHERE workspace_id=$1").bind(workspace).fetch_optional(&mut **tx).await.map_err(|_|None)?,input)
}
fn validate_limits(
    row: Option<sqlx::postgres::PgRow>,
    input: SkillInput,
) -> Result<SkillInput, Option<StatusCode>> {
    let Some(limits) = row else { return Err(None) };
    if input.name.trim().is_empty() || input.description.trim().is_empty() {
        return Err(Some(StatusCode::UNPROCESSABLE_ENTITY));
    }
    let name_limit: i32 = limits.get("max_name_chars");
    let description_limit: i32 = limits.get("max_description_chars");
    let body_limit: i32 = limits.get("max_body_chars");
    if input.name.trim().chars().count() > name_limit as usize
        || input.description.trim().chars().count() > description_limit as usize
        || input.body.chars().count() > body_limit as usize
    {
        return Err(Some(StatusCode::UNPROCESSABLE_ENTITY));
    }
    Ok(SkillInput {
        name: input.name.trim().to_owned(),
        description: input.description.trim().to_owned(),
        body: input.body,
    })
}
fn is_unique_violation(error: &sqlx::Error) -> bool {
    matches!(error,sqlx::Error::Database(e) if e.code().as_deref()==Some("23505"))
}

async fn record_group(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace: Uuid,
    user: Uuid,
    skill: Uuid,
    version: i64,
    changes: &[(&str, Value, Value)],
) -> Result<(), sqlx::Error> {
    let group = Uuid::new_v4();
    sqlx::query("UPDATE task_operation_groups SET state='suppressed' WHERE workspace_id=$1 AND actor_id=$2 AND state='undone'").bind(workspace).bind(user).execute(&mut **tx).await?;
    sqlx::query("INSERT INTO task_operation_groups(id,command_id,workspace_id,actor_id) VALUES($1,$2,$3,$4)").bind(group).bind(Uuid::new_v4()).bind(workspace).bind(user).execute(&mut **tx).await?;
    for (field, before, after) in changes {
        sqlx::query("INSERT INTO skill_operations(id,group_id,skill_id,field_key,before_value,after_value,skill_version) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(Uuid::new_v4()).bind(group).bind(skill).bind(field).bind(before).bind(after).bind(version).execute(&mut **tx).await?;
    }
    Ok(())
}

async fn history(
    State(state): State<AuthState>,
    Path((workspace, skill)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let role = match member_role(&state.pool, workspace, user).await {
        Ok(Some(role)) => role,
        Ok(None) => return StatusCode::FORBIDDEN.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let exists=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM skills WHERE id=$1 AND workspace_id=$2 AND ((enabled AND archived_at IS NULL) OR $3))").bind(skill).bind(workspace).bind(can_manage(Some(role.as_str()))).fetch_one(&state.pool).await;
    if !matches!(exists, Ok(true)) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let rows=match sqlx::query("SELECT o.id,o.group_id,o.field_key,o.before_value,o.after_value,o.skill_version,o.suppressed,g.actor_id,g.created_at::text AS created_at,g.state FROM skill_operations o JOIN task_operation_groups g ON g.id=o.group_id WHERE o.skill_id=$1 ORDER BY o.created_at,o.id").bind(skill).fetch_all(&state.pool).await{Ok(r)=>r,Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response()};
    let operations:Vec<_>=rows.into_iter().filter(|r|!r.get::<bool,_>("suppressed")&&r.get::<String,_>("state")=="active").map(|r|json!({"id":r.get::<Uuid,_>("id"),"group_id":r.get::<Uuid,_>("group_id"),"actor_id":r.get::<Uuid,_>("actor_id"),"created_at":r.get::<String,_>("created_at"),"field":r.get::<String,_>("field_key"),"before":r.get::<Value,_>("before_value"),"after":r.get::<Value,_>("after_value"),"version":r.get::<i64,_>("skill_version")})).collect();
    Json(json!({"operations":operations})).into_response()
}

async fn undo(
    State(state): State<AuthState>,
    Path((workspace, skill)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    apply_history(state, workspace, skill, headers, false).await
}
async fn redo(
    State(state): State<AuthState>,
    Path((workspace, skill)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    apply_history(state, workspace, skill, headers, true).await
}
async fn apply_history(
    state: AuthState,
    workspace: Uuid,
    skill: Uuid,
    headers: HeaderMap,
    redo: bool,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    match member_role(&state.pool, workspace, user).await {
        Ok(role) if can_manage(role.as_deref()) => {}
        Ok(_) => return StatusCode::FORBIDDEN.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    let target = if redo { "undone" } else { "active" };
    let group=match sqlx::query_scalar::<_,Uuid>("SELECT g.id FROM task_operation_groups g JOIN skill_operations o ON o.group_id=g.id WHERE g.workspace_id=$1 AND g.actor_id=$2 AND o.skill_id=$3 AND g.state=$4 ORDER BY g.created_at DESC LIMIT 1").bind(workspace).bind(user).bind(skill).bind(target).fetch_optional(&state.pool).await{Ok(Some(v))=>v,Ok(None)=>return (StatusCode::CONFLICT,Json(json!({"error":"undo_unavailable"}))).into_response(),Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response()};
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let row=match sqlx::query("SELECT id,name,description,body,enabled,archived_at IS NOT NULL AS archived,version FROM skills WHERE id=$1 AND workspace_id=$2 FOR UPDATE").bind(skill).bind(workspace).fetch_optional(&mut *tx).await{Ok(Some(r))=>r,Ok(None)=>return StatusCode::CONFLICT.into_response(),Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response()};
    let ops=match sqlx::query("SELECT field_key,before_value,after_value FROM skill_operations WHERE group_id=$1 ORDER BY field_key").bind(group).fetch_all(&mut *tx).await{Ok(r)=>r,Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response()};
    let mut values = std::collections::BTreeMap::from([
        ("name".to_owned(), json!(row.get::<String, _>("name"))),
        (
            "description".to_owned(),
            json!(row.get::<String, _>("description")),
        ),
        ("body".to_owned(), json!(row.get::<String, _>("body"))),
        ("enabled".to_owned(), json!(row.get::<bool, _>("enabled"))),
        ("archived".to_owned(), json!(row.get::<bool, _>("archived"))),
    ]);
    for op in &ops {
        let field: String = op.get("field_key");
        let expected: Value = if redo {
            op.get("before_value")
        } else {
            op.get("after_value")
        };
        if values.get(&field) != Some(&expected) {
            return (
                StatusCode::CONFLICT,
                Json(json!({"error":"undo_conflict","field":field})),
            )
                .into_response();
        }
        values.insert(
            field,
            if redo {
                op.get("after_value")
            } else {
                op.get("before_value")
            },
        );
    }
    let updated=match sqlx::query("UPDATE skills SET name=$2,description=$3,body=$4,enabled=$5,archived_at=CASE WHEN $6 THEN COALESCE(archived_at,now()) ELSE NULL END,version=version+1,updated_at=now() WHERE id=$1 RETURNING id,name,description,body,enabled,version").bind(skill).bind(values["name"].as_str().unwrap_or_default()).bind(values["description"].as_str().unwrap_or_default()).bind(values["body"].as_str().unwrap_or_default()).bind(values["enabled"].as_bool().unwrap_or(false)).bind(values["archived"].as_bool().unwrap_or(false)).fetch_one(&mut *tx).await{Ok(r)=>r,Err(e) if is_unique_violation(&e)=>return StatusCode::CONFLICT.into_response(),Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response()};
    if sqlx::query("UPDATE task_operation_groups SET state=$2 WHERE id=$1 AND state=$3")
        .bind(group)
        .bind(if redo { "active" } else { "undone" })
        .bind(target)
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    Json(skill_json(&updated)).into_response()
}
