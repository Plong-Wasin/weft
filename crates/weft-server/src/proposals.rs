use crate::{
    auth::{require_session, AuthState},
    projects, vaults,
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route(
            "/workspaces/:workspace_id/proposals/mock",
            post(create_mock),
        )
        .route(
            "/workspaces/:workspace_id/proposals/:proposal_id",
            get(read).patch(edit),
        )
        .route(
            "/workspaces/:workspace_id/proposals/:proposal_id/validate",
            post(validate),
        )
        .route(
            "/workspaces/:workspace_id/proposals/:proposal_id/refresh",
            post(refresh),
        )
        .route(
            "/workspaces/:workspace_id/proposals/:proposal_id/approve",
            post(approve),
        )
        .route(
            "/workspaces/:workspace_id/proposals/:proposal_id/undo",
            post(undo),
        )
}

async fn user(state: &AuthState, headers: &HeaderMap, write: bool) -> Result<Uuid, StatusCode> {
    require_session(&state.pool, headers, write)
        .await
        .map(|(_, id)| id)
}
async fn member(
    pool: impl sqlx::PgExecutor<'_>,
    workspace: Uuid,
    user: Uuid,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2)",
    )
    .bind(workspace)
    .bind(user)
    .fetch_one(pool)
    .await
}

async fn scope_readable(pool: &PgPool, workspace: Uuid, actor: Uuid, scope: &Value) -> bool {
    let Some(projects_in_scope) = scope["project_ids"].as_array() else {
        return false;
    };
    for id in projects_in_scope {
        let Some(id) = id.as_str().and_then(|value| Uuid::parse_str(value).ok()) else {
            return false;
        };
        if !matches!(projects::evaluate_access(pool, id, actor).await, Ok(Some(access)) if access.workspace_id == workspace && access.role >= projects::Role::Viewer)
        {
            return false;
        }
    }
    if let Some(vaults_in_scope) = scope["vault_ids"].as_array() {
        for id in vaults_in_scope {
            let Some(id) = id.as_str().and_then(|value| Uuid::parse_str(value).ok()) else {
                return false;
            };
            if !matches!(vaults::evaluate_access(pool, id, actor).await, Ok(Some(access)) if access.workspace_id == workspace && access.role >= projects::Role::Viewer)
            {
                return false;
            }
        }
    }
    true
}
fn response(row: &sqlx::postgres::PgRow) -> Value {
    json!({"id":row.get::<Uuid,_>("id"),"workspace_id":row.get::<Uuid,_>("workspace_id"),"schema_version":row.get::<i32,_>("schema_version"),"revision":row.get::<i32,_>("revision"),"status":row.get::<String,_>("status"),"scope":row.get::<Value,_>("scope"),"items":row.get::<Value,_>("items"),"applied_revision":row.get::<Option<i32>,_>("applied_revision"),"assumptions":row.get::<Value,_>("assumptions"),"open_questions":row.get::<Value,_>("open_questions"),"expected_versions":row.get::<Value,_>("expected_versions"),"ai_run_id":row.get::<Option<Uuid>,_>("ai_run_id"),"provider":row.get::<Option<String>,_>("provider"),"remaining_in_original":row.get::<Value,_>("remaining_in_original")})
}
async fn load(
    pool: &PgPool,
    workspace: Uuid,
    id: Uuid,
) -> Result<Option<sqlx::postgres::PgRow>, sqlx::Error> {
    sqlx::query("SELECT id,workspace_id,initiator_id,schema_version,revision,status,scope,items,applied_revision,assumptions,open_questions,expected_versions,ai_run_id,provider,remaining_in_original FROM proposals WHERE workspace_id=$1 AND id=$2").bind(workspace).bind(id).fetch_optional(pool).await
}

async fn create_mock(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let actor = match user(&state, &headers, true).await {
        Ok(actor) => actor,
        Err(status) => return status.into_response(),
    };
    if !matches!(member(&state.pool, workspace, actor).await, Ok(true)) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let scope = body.get("scope").cloned().unwrap_or(Value::Null);
    let Some(project_ids) = scope.get("project_ids").and_then(Value::as_array) else {
        return invalid("scope.project_ids is required");
    };
    if project_ids.is_empty() {
        return invalid("scope must include a project");
    }
    for p in project_ids {
        let Some(project) = p.as_str().and_then(|s| Uuid::parse_str(s).ok()) else {
            return invalid("invalid project scope");
        };
        if !matches!(projects::evaluate_access(&state.pool,project,actor).await,Ok(Some(a)) if a.role>=projects::Role::Contributor)
        {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error":"scope_access_denied"})),
            )
                .into_response();
        }
        let belongs=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL)").bind(project).bind(workspace).fetch_one(&state.pool).await;
        if !matches!(belongs, Ok(true)) {
            return invalid("project is outside workspace");
        }
    }
    if let Some(vault_ids) = scope.get("vault_ids").and_then(Value::as_array) {
        for v in vault_ids {
            let Some(vault) = v.as_str().and_then(|s| Uuid::parse_str(s).ok()) else {
                return invalid("invalid Vault scope");
            };
            if !matches!(vaults::evaluate_access(&state.pool,vault,actor).await,Ok(Some(a)) if a.role>=projects::Role::Contributor)
            {
                return (
                    StatusCode::FORBIDDEN,
                    Json(json!({"error":"vault_scope_access_denied"})),
                )
                    .into_response();
            }
            let belongs = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM vaults WHERE id=$1 AND workspace_id=$2)",
            )
            .bind(vault)
            .bind(workspace)
            .fetch_one(&state.pool)
            .await;
            if !matches!(belongs, Ok(true)) {
                return invalid("Vault is outside workspace");
            }
        }
    }
    let Some(items) = body.get("items").and_then(Value::as_array) else {
        return invalid("mock provider items are required");
    };
    let items = items
        .iter()
        .map(|item| {
            let mut i = item.clone();
            if i.get("selected").is_none() {
                i["selected"] = json!(true);
            }
            i
        })
        .collect::<Vec<_>>();
    let mut items = Value::Array(items);
    if let Err(message) = validate_items(&state.pool, workspace, actor, &scope, &mut items).await {
        return invalid(&message);
    }
    let id = Uuid::new_v4();
    match sqlx::query("INSERT INTO proposals(id,workspace_id,initiator_id,scope,items) VALUES($1,$2,$3,$4,$5) RETURNING id,workspace_id,schema_version,revision,status,scope,items,applied_revision,assumptions,open_questions,expected_versions,ai_run_id,provider,remaining_in_original").bind(id).bind(workspace).bind(actor).bind(scope).bind(items).fetch_one(&state.pool).await {
        Ok(row)=>(StatusCode::CREATED,Json(response(&row))).into_response(), Err(_)=>StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }
}

async fn read(
    State(state): State<AuthState>,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let Ok(actor) = user(&state, &headers, false).await else {
        return user(&state, &headers, false)
            .await
            .unwrap_err()
            .into_response();
    };
    match load(&state.pool, workspace, id).await {
        Ok(Some(row)) => {
            let scope: Value = row.get("scope");
            if !matches!(member(&state.pool, workspace, actor).await, Ok(true))
                || !scope_readable(&state.pool, workspace, actor, &scope).await
            {
                return StatusCode::NOT_FOUND.into_response();
            }
            let Ok(mut conn) = state.pool.acquire().await else {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            };
            (
                StatusCode::OK,
                Json(response_with_stale(&mut conn, &row).await),
            )
                .into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
async fn edit(
    State(state): State<AuthState>,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let Ok(actor) = user(&state, &headers, true).await else {
        return user(&state, &headers, true)
            .await
            .unwrap_err()
            .into_response();
    };
    let Some(expected_revision) = body.get("expected_revision").and_then(Value::as_i64) else {
        return invalid("expected_revision is required");
    };
    let Ok(expected_revision_i32) = i32::try_from(expected_revision) else {
        return invalid("expected_revision is invalid");
    };
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let row = match sqlx::query("SELECT id,workspace_id,initiator_id,schema_version,revision,status,scope,items,applied_revision,assumptions,open_questions,expected_versions,ai_run_id,provider,remaining_in_original FROM proposals WHERE workspace_id=$1 AND id=$2 FOR UPDATE")
        .bind(workspace).bind(id).fetch_optional(&mut *tx).await {
        Ok(Some(row)) => row,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if !matches!(member(&mut *tx, workspace, actor).await, Ok(true)) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if row.get::<Uuid, _>("initiator_id") != actor {
        return StatusCode::FORBIDDEN.into_response();
    }
    let scope: Value = row.get("scope");
    let current_items: Value = row.get("items");
    if validate_undo_access_tx(&mut tx, workspace, actor, &scope, &current_items)
        .await
        .is_err()
    {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"proposal_access_denied"})),
        )
            .into_response();
    }
    if row.get::<i32, _>("revision") != expected_revision_i32 {
        return (StatusCode::CONFLICT, Json(json!({"error":"proposal_revision_changed","revision":row.get::<i32,_>("revision")}))).into_response();
    }
    if row.get::<String, _>("status") == "undone" {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"proposal_undone"})),
        )
            .into_response();
    }
    let mut items = body.get("items").cloned().unwrap_or(Value::Null);
    if !items.is_array() {
        return invalid("items must be an array");
    }
    let previous: Value = row.get("items");
    if let Some(toggle) = body.get("toggle") {
        let item_id = toggle["item_id"].as_str().unwrap_or("");
        let selected = toggle["selected"].as_bool().unwrap_or(false);
        apply_toggle(&mut items, item_id, selected);
    } else {
        cascade_selection(&previous, &mut items);
    }
    // Editing never needs fresh versions: a stale item stays visible and only blocks Approve.
    let authored = items.as_array().cloned().unwrap_or_default();
    if refresh_versions(&mut tx, &mut items, None, None)
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if let Err(message) = validate_items_tx(&mut tx, workspace, actor, &scope, &mut items).await {
        if [
            "duplicate_relation",
            "duplicate_schema",
            "skill_name_conflict",
        ]
        .contains(&message.as_str())
        {
            return (
                StatusCode::CONFLICT,
                Json(json!({"error":"proposal_conflict","detail":message})),
            )
                .into_response();
        }
        return invalid(&message);
    }
    restore_versions(&mut items, &authored);
    match sqlx::query("UPDATE proposals SET items=$3,revision=revision+1,status='pending',apply_result=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND revision=$4 RETURNING id,workspace_id,schema_version,revision,status,scope,items,applied_revision,assumptions,open_questions,expected_versions,ai_run_id,provider,remaining_in_original").bind(workspace).bind(id).bind(items).bind(expected_revision_i32).fetch_one(&mut *tx).await {
        Ok(row) => {
            let body = response_with_stale(&mut tx, &row).await;
            if tx.commit().await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
            (StatusCode::OK, Json(body)).into_response()
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
/// Bring the recorded Task versions of stale items (all, or the listed `item_ids`) up to the
/// current ones after the human has looked at them. Only the initiator may refresh.
async fn refresh(
    State(state): State<AuthState>,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let actor = match user(&state, &headers, true).await {
        Ok(actor) => actor,
        Err(status) => return status.into_response(),
    };
    let Some(expected_revision) = body
        .get("expected_revision")
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
    else {
        return invalid("expected_revision is required");
    };
    let only: Option<std::collections::HashSet<String>> =
        body.get("item_ids").and_then(Value::as_array).map(|ids| {
            ids.iter()
                .filter_map(|id| id.as_str().map(str::to_owned))
                .collect()
        });
    let Ok(mut tx) = state.pool.begin().await else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let row = match sqlx::query("SELECT initiator_id,revision,status,scope,items FROM proposals WHERE workspace_id=$1 AND id=$2 FOR UPDATE")
        .bind(workspace).bind(id).fetch_optional(&mut *tx).await {
        Ok(Some(row)) => row,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if row.get::<Uuid, _>("initiator_id") != actor
        || !matches!(member(&mut *tx, workspace, actor).await, Ok(true))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let scope: Value = row.get("scope");
    let mut items: Value = row.get("items");
    if validate_undo_access_tx(&mut tx, workspace, actor, &scope, &items)
        .await
        .is_err()
    {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"proposal_access_denied"})),
        )
            .into_response();
    }
    if row.get::<i32, _>("revision") != expected_revision {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"proposal_revision_changed","revision":row.get::<i32,_>("revision")})),
        )
            .into_response();
    }
    if !["pending", "ready"].contains(&row.get::<String, _>("status").as_str()) {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"proposal_not_pending"})),
        )
            .into_response();
    }
    if refresh_versions(&mut tx, &mut items, None, only.as_ref())
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if let Err(message) = validate_items_tx(&mut tx, workspace, actor, &scope, &mut items).await {
        return invalid(&message);
    }
    let versions = expected_versions(&items);
    match sqlx::query("UPDATE proposals SET items=$3,expected_versions=$4,revision=revision+1,status='pending',apply_result=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING id,workspace_id,schema_version,revision,status,scope,items,applied_revision,assumptions,open_questions,expected_versions,ai_run_id,provider,remaining_in_original")
        .bind(workspace).bind(id).bind(items).bind(versions).fetch_one(&mut *tx).await {
        Ok(row) => {
            let body = response_with_stale(&mut tx, &row).await;
            if tx.commit().await.is_err() {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
            (StatusCode::OK, Json(body)).into_response()
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
async fn validate(
    State(state): State<AuthState>,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let Ok(actor) = user(&state, &headers, false).await else {
        return user(&state, &headers, false)
            .await
            .unwrap_err()
            .into_response();
    };
    match load(&state.pool, workspace, id).await {
        Ok(Some(row)) => {
            if row.get::<Uuid, _>("initiator_id") != actor {
                return StatusCode::FORBIDDEN.into_response();
            }
            let scope: Value = row.get("scope");
            let mut items: Value = row.get("items");
            if !matches!(member(&state.pool, workspace, actor).await, Ok(true))
                || !proposal_access_valid(&state.pool, workspace, actor, &scope, &items).await
            {
                return StatusCode::FORBIDDEN.into_response();
            }
            match validate_items(&state.pool, workspace, actor, &scope, &mut items).await {
                Ok(()) => (
                    StatusCode::OK,
                    Json(json!({"valid":true,"revision":row.get::<i32,_>("revision")})),
                )
                    .into_response(),
                Err(error) => (
                    StatusCode::CONFLICT,
                    Json(json!({"valid":false,"error":error})),
                )
                    .into_response(),
            }
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn approve(
    State(state): State<AuthState>,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let Ok(actor) = user(&state, &headers, true).await else {
        return user(&state, &headers, true)
            .await
            .unwrap_err()
            .into_response();
    };
    let key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if key.is_empty() {
        return invalid("idempotency-key is required");
    }
    let Some(expected_revision) = body.get("revision").and_then(Value::as_i64) else {
        return invalid("revision is required");
    };
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(workspace.to_string())
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let row=match sqlx::query("SELECT id,initiator_id,revision,status,scope,items FROM proposals WHERE workspace_id=$1 AND id=$2 FOR UPDATE").bind(workspace).bind(id).fetch_optional(&mut *tx).await {Ok(Some(r))=>r,Ok(None)=>return StatusCode::NOT_FOUND.into_response(),Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response()};
    if row.get::<Uuid, _>("initiator_id") != actor {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !matches!(member(&mut *tx, workspace, actor).await, Ok(true)) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let scope: Value = row.get("scope");
    let mut items: Value = row.get("items");
    if validate_undo_access_tx(&mut tx, workspace, actor, &scope, &items)
        .await
        .is_err()
    {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"proposal_access_denied"})),
        )
            .into_response();
    }
    let rev: i32 = row.get("revision");
    if i64::from(rev) != expected_revision {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"proposal_revision_changed","revision":rev})),
        )
            .into_response();
    }
    let status: String = row.get("status");
    if status == "undone" {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"proposal_not_pending"})),
        )
            .into_response();
    }
    if status == "applied" {
        if let Ok(Some(applied)) = sqlx::query(
            "SELECT result FROM proposal_applications WHERE proposal_id=$1 AND revision=$2",
        )
        .bind(id)
        .bind(rev)
        .fetch_optional(&mut *tx)
        .await
        {
            let _ = tx.commit().await;
            return (StatusCode::OK, Json(applied.get::<Value, _>("result"))).into_response();
        }
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"proposal_not_pending"})),
        )
            .into_response();
    }
    if status != "pending" && status != "ready" {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"proposal_not_pending"})),
        )
            .into_response();
    }
    let selected = items
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|item| item["selected"] == true)
        .collect::<Vec<_>>();
    let task_count = selected
        .iter()
        .filter(|item| item["kind"] == "task")
        .count() as i64;
    let mut next_task_number = if task_count == 0 {
        None
    } else {
        match sqlx::query_scalar::<_, i64>(
            "UPDATE workspaces SET next_task_number=next_task_number+$2 WHERE id=$1 RETURNING next_task_number-$2",
        )
        .bind(workspace)
        .bind(task_count)
        .fetch_optional(&mut *tx)
        .await
        {
            Ok(Some(number)) => Some(number),
            _ => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    };
    let mut task_ids = selected
        .iter()
        .filter(|item| item["kind"] == "relation")
        .flat_map(|item| {
            ["source_task_id", "target_task_id"]
                .into_iter()
                .filter_map(|key| item[key].as_str().and_then(|id| Uuid::parse_str(id).ok()))
        })
        .collect::<Vec<_>>();
    task_ids.extend(
        selected
            .iter()
            .filter(|item| item["kind"] == "task")
            .filter_map(|item| item["source_task_id"].as_str()?.parse::<Uuid>().ok()),
    );
    task_ids.sort_unstable();
    task_ids.dedup();
    for task in &task_ids {
        match sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM tasks WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL FOR UPDATE",
        )
        .bind(task)
        .bind(workspace)
        .fetch_optional(&mut *tx)
        .await
        {
            Ok(Some(_)) => {}
            _ => return StatusCode::CONFLICT.into_response(),
        }
    }
    let mut skill_ids = selected
        .iter()
        .filter(|item| item["kind"] == "skill")
        .filter_map(|item| item["skill_id"].as_str()?.parse::<Uuid>().ok())
        .collect::<Vec<_>>();
    skill_ids.sort_unstable();
    skill_ids.dedup();
    for skill in &skill_ids {
        if sqlx::query("SELECT id FROM skills WHERE workspace_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE")
            .bind(workspace)
            .bind(skill)
            .fetch_optional(&mut *tx)
            .await
            .ok()
            .flatten()
            .is_none()
        {
            return StatusCode::CONFLICT.into_response();
        }
    }
    if let Err(error) = validate_items_tx(&mut tx, workspace, actor, &scope, &mut items).await {
        if [
            "duplicate_relation",
            "duplicate_schema",
            "skill_name_conflict",
        ]
        .contains(&error.as_str())
        {
            return (
                StatusCode::CONFLICT,
                Json(json!({"error":"proposal_conflict","detail":error})),
            )
                .into_response();
        }
        if error == "stale base version" {
            let stale = stale_ids(&mut tx, &items).await.unwrap_or_default();
            let selected_stale = stale
                .into_iter()
                .filter(|id| {
                    items
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|item| item["id"] == id.as_str() && item["selected"] == true)
                })
                .collect::<Vec<_>>();
            return (
                StatusCode::CONFLICT,
                Json(json!({"error":"proposal_stale","detail":error,"stale_items":selected_stale})),
            )
                .into_response();
        }
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"proposal_invalid","detail":error})),
        )
            .into_response();
    }
    let group = match sqlx::query_scalar::<_, Uuid>(
        "SELECT operation_group_id FROM proposal_undo_records WHERE proposal_id=$1",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(Some(group)) => group,
        _ => {
            let group = Uuid::new_v4();
            if sqlx::query("INSERT INTO task_operation_groups(id,command_id,workspace_id,actor_id,state) VALUES($1,$2,$3,$4,'recorded')").bind(group).bind(Uuid::new_v4()).bind(workspace).bind(actor).execute(&mut *tx).await.is_err(){return StatusCode::INTERNAL_SERVER_ERROR.into_response()}
            group
        }
    };
    let mut created = Vec::new();
    let mut ordered = selected.clone();
    ordered.sort_by_key(|item| if item["kind"] == "task" { 0 } else { 1 });
    let mut applied_relations = Vec::new();
    let mut skill_changes = Vec::new();
    let mut created_schemas = Vec::new();
    for item in &ordered {
        match item["kind"].as_str().unwrap_or("") {
            "task" => {
                let project = Uuid::parse_str(item["project_id"].as_str().unwrap_or("")).unwrap();
                let task = Uuid::new_v4();
                let Some(number) = next_task_number else {
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                };
                next_task_number = Some(number + 1);
                let parent = if item["split_mode"] == "peer" {
                    None
                } else {
                    item["source_task_id"]
                        .as_str()
                        .and_then(|id| Uuid::parse_str(id).ok())
                };
                if sqlx::query("INSERT INTO tasks(id,workspace_id,number,project_id,title,description,created_by,parent_task_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(task).bind(workspace).bind(number).bind(project).bind(item["title"].as_str().unwrap_or("" )).bind(item["description"].as_str().unwrap_or("")).bind(actor).bind(parent).execute(&mut *tx).await.is_err(){return StatusCode::INTERNAL_SERVER_ERROR.into_response()}
                created.push(json!({"id":task,"number":number,"item_id":item["id"]}));
            }
            "relation" => {
                let source = resolve_task(&created, item["source_task_id"].as_str().unwrap_or(""));
                let target = resolve_task(&created, item["target_task_id"].as_str().unwrap_or(""));
                let (Some(mut source), Some(mut target)) = (source, target) else {
                    return (StatusCode::CONFLICT, Json(json!({"error":"proposal_invalid","detail":"relation endpoint missing"}))).into_response();
                };
                let kind = item["relation"].as_str().unwrap_or("related");
                if kind == "parent" {
                    // source is the parent, target the child.
                    let child_is_new = created
                        .iter()
                        .any(|t| t["id"].as_str() == Some(&target.to_string()));
                    if child_is_new {
                        if sqlx::query("UPDATE tasks SET parent_task_id=$1 WHERE id=$2 AND parent_task_id IS NULL")
                            .bind(source).bind(target).execute(&mut *tx).await.is_err()
                        {
                            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                        }
                        continue;
                    }
                    let version = match sqlx::query_scalar::<_, i64>("UPDATE tasks SET parent_task_id=$1,version=version+1,updated_at=now() WHERE id=$2 AND parent_task_id IS NULL AND archived_at IS NULL RETURNING version")
                        .bind(source).bind(target).fetch_optional(&mut *tx).await
                    {
                        Ok(Some(version)) => version,
                        Ok(None) => return (StatusCode::CONFLICT, Json(json!({"error":"proposal_conflict","detail":"parent_already_set"}))).into_response(),
                        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                    };
                    if sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,'parent_task_id','null'::jsonb,$4,$5)")
                        .bind(Uuid::new_v4()).bind(group).bind(target).bind(json!(source)).bind(version)
                        .execute(&mut *tx).await.is_err()
                    {
                        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                    }
                    applied_relations.push(json!({"source":source,"target":target,"kind":"parent","target_version":version}));
                    continue;
                }
                if kind == "related" && target < source {
                    std::mem::swap(&mut source, &mut target);
                }
                if sqlx::query("INSERT INTO task_relations(workspace_id,source_task_id,target_task_id,kind) VALUES($1,$2,$3,$4)").bind(workspace).bind(source).bind(target).bind(kind).execute(&mut *tx).await.is_err(){return (StatusCode::CONFLICT, Json(json!({"error":"proposal_conflict","detail":"duplicate_relation"}))).into_response()}
                let versions = match sqlx::query(
                    "UPDATE tasks SET version=version+1,updated_at=now() WHERE id=ANY($1) RETURNING id,version",
                )
                .bind(vec![source, target])
                .fetch_all(&mut *tx)
                .await
                {
                    Ok(rows) => rows,
                    Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                };
                let mut relation_versions = std::collections::HashMap::new();
                for row in versions {
                    let task: Uuid = row.get("id");
                    let version: i64 = row.get("version");
                    relation_versions.insert(task, version);
                    let (prefix, peer) = if task == source {
                        ("relation", target)
                    } else {
                        ("relation_from", source)
                    };
                    let field = format!("{prefix}/{peer}/{kind}");
                    if sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,$4,'false'::jsonb,'true'::jsonb,$5)")
                        .bind(Uuid::new_v4())
                        .bind(group)
                        .bind(task)
                        .bind(field)
                        .bind(version)
                        .execute(&mut *tx)
                        .await
                        .is_err()
                    {
                        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                    }
                }
                let Some(source_version) = relation_versions.get(&source).copied() else {
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                };
                let Some(target_version) = relation_versions.get(&target).copied() else {
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                };
                applied_relations.push(json!({"source":source,"target":target,"kind":kind,"source_version":source_version,"target_version":target_version}));
            }
            "skill" => {
                let skill = Uuid::parse_str(item["skill_id"].as_str().unwrap_or("")).unwrap();
                let before=match sqlx::query("SELECT name,description,body,enabled,version FROM skills WHERE workspace_id=$1 AND id=$2 FOR UPDATE").bind(workspace).bind(skill).fetch_one(&mut *tx).await{Ok(row)=>json!({"id":skill,"name":row.get::<String,_>("name"),"description":row.get::<String,_>("description"),"body":row.get::<String,_>("body"),"enabled":row.get::<bool,_>("enabled"),"version":row.get::<i64,_>("version")}),Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response()};
                match sqlx::query("UPDATE skills SET name=COALESCE($3,name),description=COALESCE($4,description),body=COALESCE($5,body),enabled=COALESCE($6,enabled),version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2")
                    .bind(workspace)
                    .bind(skill)
                    .bind(item["name"].as_str())
                    .bind(item["description"].as_str())
                    .bind(item["body"].as_str())
                    .bind(item["enabled"].as_bool())
                    .execute(&mut *tx)
                    .await
                {
                    Ok(_) => {}
                    Err(sqlx::Error::Database(error)) if error.code().as_deref() == Some("23505") => {
                        return (StatusCode::CONFLICT, Json(json!({"error":"proposal_conflict","detail":"skill_name_conflict"}))).into_response();
                    }
                    Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                }
                let after = match sqlx::query(
                    "SELECT name,description,body,enabled,version FROM skills WHERE id=$1",
                )
                .bind(skill)
                .fetch_one(&mut *tx)
                .await
                {
                    Ok(row) => {
                        json!({"name":row.get::<String,_>("name"),"description":row.get::<String,_>("description"),"body":row.get::<String,_>("body"),"enabled":row.get::<bool,_>("enabled"),"version":row.get::<i64,_>("version")})
                    }
                    Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                };
                for field in ["name", "description", "body", "enabled"] {
                    if before[field]!=after[field] && sqlx::query("INSERT INTO skill_operations(id,group_id,skill_id,field_key,before_value,after_value,skill_version) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(group_id,skill_id,field_key) DO UPDATE SET after_value=EXCLUDED.after_value,skill_version=EXCLUDED.skill_version").bind(Uuid::new_v4()).bind(group).bind(skill).bind(field).bind(&before[field]).bind(&after[field]).bind(after["version"].as_i64().unwrap_or(1)).execute(&mut *tx).await.is_err(){return StatusCode::INTERNAL_SERVER_ERROR.into_response()}
                }
                skill_changes.push(before);
            }
            "schema" => {
                let schema = Uuid::new_v4();
                if sqlx::query("INSERT INTO attribute_schemas(id,workspace_id,name,value_type) VALUES($1,$2,$3,$4)").bind(schema).bind(workspace).bind(item["name"].as_str().unwrap_or("" )).bind(item["value_type"].as_str().unwrap_or("text")).execute(&mut *tx).await.is_err(){return (StatusCode::CONFLICT, Json(json!({"error":"proposal_conflict","detail":"duplicate_schema"}))).into_response()}
                created_schemas
                    .push(json!({"id":schema,"name":item["name"],"value_type":item["value_type"]}));
            }
            _ => {}
        }
    }
    let result = json!({"proposal_id":id,"revision":rev,"created_tasks":created,"applied":true});
    if sqlx::query("INSERT INTO proposal_applications(proposal_id,revision,idempotency_key,result) VALUES($1,$2,$3,$4)").bind(id).bind(rev).bind(key).bind(&result).execute(&mut *tx).await.is_err(){return StatusCode::CONFLICT.into_response()}
    if sqlx::query("UPDATE proposals SET status='applied',applied_revision=revision,apply_result=$2,updated_at=now() WHERE id=$1").bind(id).bind(&result).execute(&mut *tx).await.is_err(){return StatusCode::INTERNAL_SERVER_ERROR.into_response()}
    let task_ids = created
        .iter()
        .filter_map(|t| t["id"].as_str().and_then(|s| Uuid::parse_str(s).ok()))
        .collect::<Vec<_>>();
    for task in &task_ids {
        if sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,'archived','true'::jsonb,'false'::jsonb,1) ON CONFLICT(group_id,task_id,field_key) DO NOTHING").bind(Uuid::new_v4()).bind(group).bind(task).execute(&mut *tx).await.is_err(){return StatusCode::INTERNAL_SERVER_ERROR.into_response()}
    }
    if sqlx::query("INSERT INTO proposal_undo_records(proposal_id,operation_group_id,generated_tasks,relations,skill_changes,schema_items) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(proposal_id) DO UPDATE SET generated_tasks=proposal_undo_records.generated_tasks||EXCLUDED.generated_tasks,relations=proposal_undo_records.relations||EXCLUDED.relations,skill_changes=proposal_undo_records.skill_changes||EXCLUDED.skill_changes,schema_items=proposal_undo_records.schema_items||EXCLUDED.schema_items").bind(id).bind(group).bind(task_ids).bind(json!(applied_relations)).bind(json!(skill_changes)).bind(json!(created_schemas)).execute(&mut *tx).await.is_err(){return StatusCode::INTERNAL_SERVER_ERROR.into_response()}
    if crate::ai_provenance::record_approval(
        &mut tx,
        id,
        group,
        actor,
        rev,
        created.len() as i64,
        applied_relations.len() as i64,
    )
    .await
    .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    (StatusCode::OK, Json(result)).into_response()
}

async fn undo(
    State(state): State<AuthState>,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let Ok(actor) = user(&state, &headers, true).await else {
        return user(&state, &headers, true)
            .await
            .unwrap_err()
            .into_response();
    };
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(workspace.to_string())
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let proposal = match sqlx::query(
        "SELECT initiator_id,status,scope,items,applied_revision FROM proposals WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(workspace)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if !matches!(member(&mut *tx, workspace, actor).await, Ok(true)) {
        return StatusCode::CONFLICT.into_response();
    }
    if proposal.get::<Uuid, _>("initiator_id") != actor {
        return StatusCode::FORBIDDEN.into_response();
    }
    let scope: Value = proposal.get("scope");
    let items: Value = proposal.get("items");
    if validate_undo_access_tx(&mut tx, workspace, actor, &scope, &items)
        .await
        .is_err()
    {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"proposal_access_denied"})),
        )
            .into_response();
    }
    if proposal.get::<String, _>("status") != "applied"
        && proposal.get::<Option<i32>, _>("applied_revision").is_none()
    {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"proposal_not_applied"})),
        )
            .into_response();
    }
    let record=match sqlx::query("SELECT operation_group_id,generated_tasks,relations,skill_changes,schema_items FROM proposal_undo_records WHERE proposal_id=$1").bind(id).fetch_one(&mut *tx).await{Ok(r)=>r,Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response()};
    let group: Option<Uuid> = record.get("operation_group_id");
    let tasks: Vec<Uuid> = record.get("generated_tasks");
    let relations: Value = record.get("relations");
    let skill_changes: Value = record.get("skill_changes");
    let schema_items: Value = record.get("schema_items");
    let mut generated_task_versions = tasks
        .iter()
        .copied()
        .map(|task| (task, 1_i64))
        .collect::<std::collections::HashMap<_, _>>();
    let mut relation_task_versions = std::collections::BTreeMap::<Uuid, i64>::new();
    for relation in relations.as_array().into_iter().flatten() {
        if let Some(task) = relation["source"]
            .as_str()
            .and_then(|s| Uuid::parse_str(s).ok())
        {
            if let Some(version) = relation["source_version"].as_i64() {
                generated_task_versions.insert(task, version);
            }
        }
        if let Some(task) = relation["target"]
            .as_str()
            .and_then(|s| Uuid::parse_str(s).ok())
        {
            if let Some(version) = relation["target_version"].as_i64() {
                generated_task_versions.insert(task, version);
            }
        }
    }
    let mut conflicts = Vec::new();
    let mut locked_tasks = tasks.clone();
    for relation in relations.as_array().into_iter().flatten() {
        for key in ["source", "target"] {
            if let Some(task) = relation[key]
                .as_str()
                .and_then(|value| Uuid::parse_str(value).ok())
            {
                locked_tasks.push(task);
            }
        }
    }
    locked_tasks.sort_unstable();
    locked_tasks.dedup();
    for task in &locked_tasks {
        if sqlx::query("SELECT id FROM tasks WHERE workspace_id=$1 AND id=$2 FOR UPDATE")
            .bind(workspace)
            .bind(task)
            .fetch_optional(&mut *tx)
            .await
            .is_err()
        {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    for task in &tasks {
        let expected_version = generated_task_versions.get(task).copied().unwrap_or(1);
        let version = sqlx::query_scalar::<_, i64>(
            "SELECT version FROM tasks WHERE id=$1 AND archived_at IS NULL",
        )
        .bind(task)
        .fetch_optional(&mut *tx)
        .await;
        if !matches!(version, Ok(Some(version)) if version == expected_version) {
            conflicts.push(json!({"task_id":task,"reason":"task_changed_or_missing"}));
        }
    }
    for relation in relations.as_array().into_iter().flatten() {
        let source = relation["source"]
            .as_str()
            .and_then(|s| Uuid::parse_str(s).ok());
        let target = relation["target"]
            .as_str()
            .and_then(|s| Uuid::parse_str(s).ok());
        let kind = relation["kind"].as_str().unwrap_or("");
        if let (Some(source), Some(target)) = (source, target) {
            let exists = if kind == "parent" {
                sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=$1 AND parent_task_id=$2)",
                )
                .bind(target)
                .bind(source)
                .fetch_one(&mut *tx)
                .await
            } else {
                sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM task_relations WHERE source_task_id=$1 AND target_task_id=$2 AND kind=$3)").bind(source).bind(target).bind(kind).fetch_one(&mut *tx).await
            };
            if !matches!(exists, Ok(true)) {
                conflicts.push(json!({"source_task_id":source,"target_task_id":target,"reason":"relation_changed_or_missing"}));
            }
            for (task, key) in [(source, "source_version"), (target, "target_version")] {
                if let Some(expected) = relation[key].as_i64() {
                    relation_task_versions.insert(task, expected);
                }
            }
        }
    }
    for (task, expected) in relation_task_versions {
        let current = sqlx::query_scalar::<_, i64>(
            "SELECT version FROM tasks WHERE id=$1 AND archived_at IS NULL",
        )
        .bind(task)
        .fetch_optional(&mut *tx)
        .await;
        if !matches!(current, Ok(Some(current)) if current == expected) {
            conflicts.push(json!({"task_id":task,"reason":"relation_task_changed_or_missing"}));
        }
    }
    if let Some(changes) = skill_changes.as_array() {
        let mut latest = std::collections::HashMap::<String, i64>::new();
        for change in changes {
            if let (Some(id), Some(version)) = (change["id"].as_str(), change["version"].as_i64()) {
                latest.insert(id.to_owned(), version + 1);
            }
        }
        for (id, version) in latest {
            let skill = Uuid::parse_str(&id).unwrap();
            let current = sqlx::query_scalar::<_, i64>(
                "SELECT version FROM skills WHERE id=$1 AND archived_at IS NULL FOR UPDATE",
            )
            .bind(skill)
            .fetch_optional(&mut *tx)
            .await;
            if !matches!(current,Ok(Some(current)) if current==version) {
                conflicts.push(json!({"skill_id":skill,"reason":"skill_changed_or_missing"}));
            }
        }
    }
    for schema in schema_items.as_array().into_iter().flatten() {
        let Some(schema_id) = schema["id"]
            .as_str()
            .and_then(|value| Uuid::parse_str(value).ok())
        else {
            conflicts.push(json!({"reason":"invalid_schema_record"}));
            continue;
        };
        let current = sqlx::query(
                    "SELECT name,value_type FROM attribute_schemas WHERE id=$1 AND archived_at IS NULL FOR UPDATE",
        )
        .bind(schema_id)
        .fetch_optional(&mut *tx)
        .await;
        if !matches!(current,Ok(Some(ref row)) if row.get::<String,_>("name")==schema["name"].as_str().unwrap_or("") && row.get::<String,_>("value_type")==schema["value_type"].as_str().unwrap_or(""))
        {
            conflicts.push(json!({"schema_id":schema_id,"reason":"schema_changed_or_missing"}));
        }
    }
    if !conflicts.is_empty() {
        return (
            StatusCode::CONFLICT,
            Json(json!({"applied":false,"conflicts":conflicts})),
        )
            .into_response();
    }
    let undo_group = if tasks.is_empty() && relations.as_array().is_none_or(Vec::is_empty) {
        None
    } else {
        let group = Uuid::new_v4();
        if sqlx::query("INSERT INTO task_operation_groups(id,command_id,workspace_id,actor_id,state) VALUES($1,$2,$3,$4,'recorded')")
            .bind(group)
            .bind(Uuid::new_v4())
            .bind(workspace)
            .bind(actor)
            .execute(&mut *tx)
            .await
            .is_err()
        {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        Some(group)
    };
    for task in &tasks {
        let expected_version = generated_task_versions.get(task).copied().unwrap_or(1);
        let version = match sqlx::query_scalar::<_, i64>(
            "UPDATE tasks SET archived_at=now(),version=version+1,updated_at=now() WHERE id=$1 AND version=$2 AND archived_at IS NULL RETURNING version",
        )
        .bind(task)
        .bind(expected_version)
        .fetch_optional(&mut *tx)
        .await
        {
            Ok(Some(version)) => version,
            _ => return StatusCode::CONFLICT.into_response(),
        };
        if let Some(group) = undo_group {
            if sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,'archived','false'::jsonb,'true'::jsonb,$4)")
                .bind(Uuid::new_v4())
                .bind(group)
                .bind(task)
                .bind(version)
                .execute(&mut *tx)
                .await
                .is_err()
            {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        }
    }
    for relation in relations.as_array().into_iter().flatten() {
        let source = Uuid::parse_str(relation["source"].as_str().unwrap_or("")).unwrap();
        let target = Uuid::parse_str(relation["target"].as_str().unwrap_or("")).unwrap();
        if relation["kind"] == "parent" {
            let version = match sqlx::query_scalar::<_, i64>("UPDATE tasks SET parent_task_id=NULL,version=version+1,updated_at=now() WHERE id=$1 AND parent_task_id=$2 RETURNING version")
                .bind(target).bind(source).fetch_optional(&mut *tx).await
            {
                Ok(Some(version)) => version,
                _ => return StatusCode::CONFLICT.into_response(),
            };
            if let Some(group) = undo_group {
                if sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,'parent_task_id',$4,'null'::jsonb,$5)")
                    .bind(Uuid::new_v4()).bind(group).bind(target).bind(json!(source)).bind(version)
                    .execute(&mut *tx).await.is_err()
                {
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            }
            continue;
        }
        if sqlx::query(
            "DELETE FROM task_relations WHERE source_task_id=$1 AND target_task_id=$2 AND kind=$3",
        )
        .bind(source)
        .bind(target)
        .bind(relation["kind"].as_str().unwrap_or(""))
        .execute(&mut *tx)
        .await
        .is_err()
        {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        let versions = match sqlx::query(
            "UPDATE tasks SET version=version+1,updated_at=now() WHERE id=ANY($1) RETURNING id,version",
        )
        .bind(vec![source, target])
        .fetch_all(&mut *tx)
        .await
        {
            Ok(rows) => rows,
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        };
        for row in versions {
            let task: Uuid = row.get("id");
            let version: i64 = row.get("version");
            let (prefix, peer) = if task == source {
                ("relation", target)
            } else {
                ("relation_from", source)
            };
            let field = format!(
                "{prefix}/{peer}/{}",
                relation["kind"].as_str().unwrap_or("")
            );
            if let Some(group) = undo_group {
                if sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,$4,'true'::jsonb,'false'::jsonb,$5)")
                    .bind(Uuid::new_v4())
                    .bind(group)
                    .bind(task)
                    .bind(field)
                    .bind(version)
                    .execute(&mut *tx)
                    .await
                    .is_err()
                {
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            }
        }
    }
    if let Some(changes) = skill_changes.as_array() {
        for change in changes.iter().rev() {
            let skill = Uuid::parse_str(change["id"].as_str().unwrap_or("")).unwrap();
            if sqlx::query("UPDATE skills SET name=$2,description=$3,body=$4,enabled=$5,version=version+1,updated_at=now() WHERE id=$1").bind(skill).bind(change["name"].as_str().unwrap_or("")).bind(change["description"].as_str().unwrap_or("")).bind(change["body"].as_str().unwrap_or("")).bind(change["enabled"].as_bool().unwrap_or(true)).execute(&mut *tx).await.is_err(){return StatusCode::INTERNAL_SERVER_ERROR.into_response()}
        }
    }
    for schema in schema_items.as_array().into_iter().flatten() {
        if let Some(schema_id) = schema["id"]
            .as_str()
            .and_then(|value| Uuid::parse_str(value).ok())
        {
            if sqlx::query("UPDATE attribute_schemas SET archived_at=now() WHERE id=$1")
                .bind(schema_id)
                .execute(&mut *tx)
                .await
                .is_err()
            {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        }
    }
    if let Some(group) = group {
        if sqlx::query(
            "UPDATE task_operation_groups SET state='undone' WHERE id=$1 AND state='active'",
        )
        .bind(group)
        .execute(&mut *tx)
        .await
        .is_err()
        {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    if crate::ai_provenance::record_undo(&mut tx, id, undo_group, actor)
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if sqlx::query("UPDATE proposals SET status='undone',updated_at=now() WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .is_err()
        || tx.commit().await.is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    (
        StatusCode::OK,
        Json(json!({"undone":true,"archived_tasks":tasks.len()})),
    )
        .into_response()
}

fn resolve_task(created: &[Value], value: &str) -> Option<Uuid> {
    if let Some(id) = created
        .iter()
        .find(|t| t["item_id"] == value)
        .and_then(|t| t["id"].as_str())
    {
        Uuid::parse_str(id).ok()
    } else {
        Uuid::parse_str(value).ok()
    }
}

async fn validate_undo_access_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace: Uuid,
    actor: Uuid,
    scope: &Value,
    items: &Value,
) -> Result<(), String> {
    if !scope_readable_tx(tx, workspace, actor, scope).await {
        return Err("current read access to the Proposal scope is required".into());
    }
    let selected: Vec<_> = items
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item["selected"] == true)
        .collect();
    for item in &selected {
        match item["kind"].as_str().unwrap_or("") {
            "task" => {
                let project =
                    Uuid::parse_str(item["project_id"].as_str().ok_or("task project missing")?)
                        .map_err(|_| "invalid project")?;
                if !matches!(projects::evaluate_access(&mut **tx, project, actor).await, Ok(Some(access)) if access.workspace_id == workspace && access.role >= projects::Role::Contributor)
                {
                    return Err("current write access to every affected Project is required".into());
                }
            }
            "relation" => {
                for endpoint in ["source_task_id", "target_task_id"] {
                    let value = item[endpoint].as_str().ok_or("relation endpoint missing")?;
                    let project = if let Some(task) = selected
                        .iter()
                        .find(|candidate| candidate["id"] == value && candidate["kind"] == "task")
                    {
                        Uuid::parse_str(task["project_id"].as_str().ok_or("task project missing")?)
                            .map_err(|_| "invalid project")?
                    } else {
                        let task = Uuid::parse_str(value).map_err(|_| "relation task missing")?;
                        let row = sqlx::query("SELECT project_id FROM tasks WHERE workspace_id=$1 AND id=$2 AND archived_at IS NULL").bind(workspace).bind(task).fetch_optional(&mut **tx).await.map_err(|_| "task lookup failed")?.ok_or("relation task missing")?;
                        row.get("project_id")
                    };
                    if !matches!(projects::evaluate_access(&mut **tx, project, actor).await, Ok(Some(access)) if access.workspace_id == workspace && access.role >= projects::Role::Contributor)
                    {
                        return Err(
                            "current write access to every related Project is required".into()
                        );
                    }
                }
            }
            "skill" | "schema" => {
                let role: Option<String> = sqlx::query_scalar(
                    "SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2",
                )
                .bind(workspace)
                .bind(actor)
                .fetch_optional(&mut **tx)
                .await
                .map_err(|_| "membership lookup failed")?;
                if !role.is_some_and(|role| role == "owner" || role == "admin") {
                    return Err("current Workspace admin access is required".into());
                }
            }
            "note_edit" | "file_add" => {
                let vault = Uuid::parse_str(item["vault_id"].as_str().ok_or("Vault missing")?)
                    .map_err(|_| "invalid Vault")?;
                if !matches!(vaults::evaluate_access(&mut **tx, vault, actor).await, Ok(Some(access)) if access.workspace_id == workspace && access.role >= projects::Role::Contributor)
                {
                    return Err("current write access to every affected Vault is required".into());
                }
            }
            _ => return Err("unknown proposal item kind".into()),
        }
    }
    Ok(())
}

async fn scope_readable_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace: Uuid,
    actor: Uuid,
    scope: &Value,
) -> bool {
    let Some(project_ids) = scope["project_ids"].as_array() else {
        return false;
    };
    for id in project_ids {
        let Some(id) = id.as_str().and_then(|value| Uuid::parse_str(value).ok()) else {
            return false;
        };
        if !matches!(projects::evaluate_access(&mut **tx, id, actor).await, Ok(Some(access)) if access.workspace_id == workspace && access.role >= projects::Role::Viewer)
        {
            return false;
        }
    }
    if let Some(vault_ids) = scope["vault_ids"].as_array() {
        for id in vault_ids {
            let Some(id) = id.as_str().and_then(|value| Uuid::parse_str(value).ok()) else {
                return false;
            };
            if !matches!(vaults::evaluate_access(&mut **tx, id, actor).await, Ok(Some(access)) if access.workspace_id == workspace && access.role >= projects::Role::Viewer)
            {
                return false;
            }
        }
    }
    true
}

fn apply_toggle(items: &mut Value, item_id: &str, selected: bool) {
    let Some(all) = items.as_array_mut() else {
        return;
    };
    let ids = all
        .iter()
        .filter_map(|item| {
            item["id"].as_str().map(|id| {
                (
                    id.to_owned(),
                    item["depends_on"].as_array().cloned().unwrap_or_default(),
                )
            })
        })
        .collect::<std::collections::HashMap<_, _>>();
    let mut changed = std::collections::HashSet::new();
    fn enable(
        id: &str,
        all: &mut [Value],
        deps: &std::collections::HashMap<String, Vec<Value>>,
        changed: &mut std::collections::HashSet<String>,
    ) {
        if !changed.insert(id.to_owned()) {
            return;
        }
        for item in all.iter_mut().filter(|item| item["id"] == id) {
            item["selected"] = json!(true);
        }
        for dep in deps.get(id).into_iter().flatten().filter_map(Value::as_str) {
            enable(dep, all, deps, changed);
        }
    }
    if selected {
        enable(item_id, all, &ids, &mut changed);
    } else {
        for item in all.iter_mut().filter(|item| item["id"] == item_id) {
            item["selected"] = json!(false);
        }
        changed.insert(item_id.to_owned());
        loop {
            let mut new = false;
            for item in all.iter_mut().filter(|item| item["selected"] == true) {
                if item["depends_on"].as_array().is_some_and(|deps| {
                    deps.iter()
                        .any(|dep| changed.contains(dep.as_str().unwrap_or("")))
                }) {
                    let id = item["id"].as_str().unwrap_or("").to_owned();
                    item["selected"] = json!(false);
                    new |= changed.insert(id);
                }
            }
            if !new {
                break;
            }
        }
    }
}
fn cascade_selection(previous: &Value, items: &mut Value) {
    let (Some(old), Some(new)) = (previous.as_array(), items.as_array_mut()) else {
        return;
    };
    let now = new
        .iter()
        .filter_map(|item| {
            item["id"]
                .as_str()
                .map(|id| (id.to_owned(), item["selected"] == true))
        })
        .collect::<std::collections::HashMap<_, _>>();
    if let Some(item) = old.iter().find(|item| {
        item["selected"] == true
            && now
                .get(item["id"].as_str().unwrap_or(""))
                .is_some_and(|selected| !*selected)
    }) {
        apply_toggle(items, item["id"].as_str().unwrap_or(""), false);
    } else if let Some(item) = old.iter().find(|item| {
        item["selected"] != true
            && now
                .get(item["id"].as_str().unwrap_or(""))
                .is_some_and(|selected| *selected)
    }) {
        apply_toggle(items, item["id"].as_str().unwrap_or(""), true);
    }
}
fn invalid(detail: &str) -> Response {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        Json(json!({"error":"invalid_proposal","detail":detail})),
    )
        .into_response()
}

/// Everything the server derived from a model Proposal after validation.
pub(crate) struct PreparedProposal {
    workspace: Uuid,
    actor: Uuid,
    scope: Value,
    items: Value,
    provider: String,
    assumptions: Value,
    open_questions: Value,
    expected_versions: Value,
    remaining_in_original: Value,
}

/// Validate and persist the one Proposal produced by an AI run. The run and provider
/// are loaded from server state; neither the runner nor model can choose attribution.
pub(crate) async fn create_ai_proposal(
    pool: &PgPool,
    run: Uuid,
    proposal: &Value,
) -> Result<Uuid, String> {
    if let Some(existing) =
        sqlx::query_scalar::<_, Uuid>("SELECT id FROM proposals WHERE ai_run_id=$1")
            .bind(run)
            .fetch_optional(pool)
            .await
            .map_err(|_| "proposal_lookup_failed")?
    {
        return Ok(existing);
    }
    let prepared = prepare_ai_proposal(pool, run, proposal).await?;
    let proposal_id = Uuid::new_v4();
    sqlx::query("INSERT INTO proposals(id,workspace_id,initiator_id,scope,items,status,ai_run_id,provider,assumptions,open_questions,expected_versions,remaining_in_original) VALUES($1,$2,$3,$4,$5,'ready',$6,$7,$8,$9,$10,$11)")
        .bind(proposal_id).bind(prepared.workspace).bind(prepared.actor).bind(prepared.scope).bind(prepared.items)
        .bind(run).bind(prepared.provider).bind(prepared.assumptions).bind(prepared.open_questions).bind(prepared.expected_versions).bind(prepared.remaining_in_original)
        .execute(pool).await.map_err(|_| "proposal_insert_failed")?;
    Ok(proposal_id)
}

/// Dry-run validation: checks a model Proposal against the run's scope and the
/// requester's access without storing anything.
pub(crate) async fn validate_ai_proposal(
    pool: &PgPool,
    run: Uuid,
    proposal: &Value,
) -> Result<(), String> {
    prepare_ai_proposal(pool, run, proposal).await.map(|_| ())
}

async fn prepare_ai_proposal(
    pool: &PgPool,
    run: Uuid,
    proposal: &Value,
) -> Result<PreparedProposal, String> {
    if proposal["schema_version"].as_i64() != Some(1) {
        return Err("unsupported_schema_version".into());
    }
    let mut items = proposal["items"].clone();
    let Some(array) = items.as_array_mut() else {
        return Err("items_must_be_array".into());
    };
    if array.is_empty() || array.len() > 100 {
        return Err("item_ceiling_exceeded".into());
    }
    let edges = array
        .iter()
        .map(|item| item["depends_on"].as_array().map_or(0, Vec::len))
        .sum::<usize>()
        + array
            .iter()
            .filter(|item| item["kind"] == "relation")
            .count();
    if edges > 200 {
        return Err("edge_ceiling_exceeded".into());
    }
    let text_characters = serde_json::to_string(proposal)
        .map_err(|_| "invalid_proposal_json")?
        .chars()
        .count();
    if text_characters > 100_000 {
        return Err("text_ceiling_exceeded".into());
    }
    for item in array.iter() {
        let id = item["id"].as_str().ok_or("temporary_id_required")?;
        if !id.starts_with("tmp-") || id.len() > 80 {
            return Err("temporary_id_invalid".into());
        }
        for field in ["title", "reason"] {
            if item[field]
                .as_str()
                .is_some_and(|text| text.chars().count() > 4_000)
            {
                return Err("text_ceiling_exceeded".into());
            }
        }
        if item["kind"] == "relation" {
            for field in ["source_task_id", "target_task_id"] {
                let endpoint = item[field].as_str().ok_or("relation_endpoint_required")?;
                if Uuid::parse_str(endpoint).is_err() && !endpoint.starts_with("tmp-") {
                    return Err("temporary_id_invalid".into());
                }
            }
        }
    }
    for item in array.iter_mut() {
        if ![
            "task",
            "relation",
            "skill",
            "schema",
            "note_edit",
            "file_add",
        ]
        .contains(&item["kind"].as_str().unwrap_or(""))
        {
            return Err("item_kind_not_allowed".into());
        }
        // Drafts arrive selected; the human decides in review. Only the server sets these flags.
        item["selected"] = json!(true);
        if let Some(object) = item.as_object_mut() {
            object.remove("parent_task_id");
        }
        if !item["split_mode"].is_null()
            && !["child", "peer"].contains(&item["split_mode"].as_str().unwrap_or(""))
        {
            return Err("split_mode_invalid".into());
        }
    }
    reject_dependency_cycles(array)?;
    add_split_back_links(array);
    let assumptions = bounded_text_list(&proposal["assumptions"], "assumptions")?;
    let open_questions = bounded_text_list(&proposal["open_questions"], "open_questions")?;
    let row = sqlx::query("SELECT r.initiator_id,r.workspace_id,r.scope,r.capability,r.created_at::text AS started_at,COALESCE(c.provider,'mcp') AS provider FROM ai_runs r LEFT JOIN ai_connections c ON c.id=r.connection_id WHERE r.id=$1 AND r.state IN ('running','waiting_for_approval')")
        .bind(run).fetch_optional(pool).await.map_err(|_| "run_lookup_failed")?
        .ok_or("run_unavailable")?;
    let actor: Uuid = row.get("initiator_id");
    let workspace: Uuid = row.get("workspace_id");
    let run_scope: Value = row.get("scope");
    let provider: String = row.get("provider");
    let capability: String = row.get("capability");
    let started_at: String = row.get("started_at");
    enforce_capability(&capability, array)?;
    let remaining_in_original = if proposal["remaining_in_original"].is_null() {
        json!([])
    } else if capability == "split" {
        bounded_text_list(&proposal["remaining_in_original"], "remaining_in_original")?
    } else {
        return Err("remaining_in_original_only_for_split".into());
    };
    let read_sources = sqlx::query("SELECT source_kind,source_id FROM ai_run_sources WHERE run_id=$1 ORDER BY read_at,source_kind,source_id")
        .bind(run).fetch_all(pool).await.map_err(|_| "source_lookup_failed")?;
    let mut trusted_sources = vec![json!({"kind":"user_request","id":"run_prompt"})];
    trusted_sources.extend(read_sources.into_iter().map(|source| json!({"kind":source.get::<String,_>("source_kind"),"id":source.get::<String,_>("source_id")})));
    let mut project_ids = run_scope["projects"].clone();
    if !project_ids.is_array() {
        project_ids = json!([]);
    }
    // Task-only runs still need a concrete Project scope for the existing Proposal engine.
    if project_ids.as_array().is_some_and(Vec::is_empty) {
        for task in run_scope["tasks"].as_array().into_iter().flatten() {
            if let Some(task_id) = task.as_str().and_then(|id| Uuid::parse_str(id).ok()) {
                if let Some(project) = sqlx::query_scalar::<_, Uuid>(
                    "SELECT project_id FROM tasks WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL",
                )
                .bind(task_id)
                .bind(workspace)
                .fetch_optional(pool)
                .await
                .map_err(|_| "scope_lookup_failed")?
                {
                    project_ids.as_array_mut().unwrap().push(json!(project));
                }
            }
        }
    }
    let mut project_set = std::collections::HashSet::new();
    project_ids
        .as_array_mut()
        .ok_or("run_scope_invalid")?
        .retain(|value| {
            value
                .as_str()
                .is_some_and(|id| project_set.insert(id.to_owned()))
        });
    let scope = json!({"project_ids":project_ids,"vault_ids":run_scope["vaults"]});
    for item in array.iter().filter(|item| item["kind"] == "task") {
        let project = item["project_id"].as_str().ok_or("task_project_required")?;
        if !scope["project_ids"]
            .as_array()
            .is_some_and(|projects| projects.iter().any(|id| id.as_str() == Some(project)))
        {
            return Err("item_outside_scope".into());
        }
    }
    // A Task the requester changed after the run started is not an error: the item keeps the
    // version the model saw and shows up as stale until it is refreshed or removed.
    let original = array.clone();
    let mut normalized = Value::Array(array.clone());
    {
        let mut conn = pool.acquire().await.map_err(|_| "database_error")?;
        refresh_versions(&mut conn, &mut normalized, Some(&started_at), None).await?;
    }
    validate_items(pool, workspace, actor, &scope, &mut normalized)
        .await
        .map_err(|detail| format!("proposal_validation:{detail}"))?;
    validate_source_versions(pool, workspace, actor, &scope, &normalized).await?;
    restore_versions(&mut normalized, &original);
    if let Some(items) = normalized.as_array_mut() {
        for item in items {
            item["sources"] = Value::Array(trusted_sources.clone());
        }
    }
    annotate_similar_tasks(pool, &mut normalized).await?;
    annotate_link_labels(pool, &mut normalized).await?;
    let expected_versions = expected_versions(&normalized);
    Ok(PreparedProposal {
        workspace,
        actor,
        scope,
        items: normalized,
        provider,
        assumptions,
        open_questions,
        expected_versions,
        remaining_in_original,
    })
}

/// A Link run only proposes links between Tasks; a Split run only proposes new Tasks cut from
/// an existing source Task plus links. Generate keeps the wider item set.
fn enforce_capability(capability: &str, items: &[Value]) -> Result<(), String> {
    match capability {
        "knowledge"
            if items.iter().any(|item| {
                !["note_edit", "file_add"].contains(&item["kind"].as_str().unwrap_or(""))
            }) =>
        {
            Err("knowledge_run_allows_only_knowledge_items".into())
        }
        "generate" | "split" | "link"
            if items.iter().any(|item| {
                ["note_edit", "file_add"].contains(&item["kind"].as_str().unwrap_or(""))
            }) =>
        {
            Err("item_kind_not_allowed".into())
        }
        "link" if items.iter().any(|item| item["kind"] != "relation") => {
            Err("link_run_allows_only_links".into())
        }
        "split"
            if items.iter().any(|item| {
                item["kind"] != "relation"
                    && (item["kind"] != "task" || item["source_task_id"].as_str().is_none())
            }) =>
        {
            Err("split_run_requires_a_source_task".into())
        }
        _ => Ok(()),
    }
}

const VERSION_FIELDS: [&str; 3] = [
    "expected_version",
    "expected_source_version",
    "expected_target_version",
];

fn version_refs(item: &Value) -> Vec<(&'static str, Uuid)> {
    let mut refs = Vec::new();
    let uuid = |key: &str| item[key].as_str().and_then(|id| Uuid::parse_str(id).ok());
    if item["kind"] == "task" {
        if let Some(task) = uuid("source_task_id") {
            refs.push(("expected_version", task));
        }
    } else if item["kind"] == "relation" {
        if let Some(task) = uuid("source_task_id") {
            refs.push(("expected_source_version", task));
        }
        if let Some(task) = uuid("target_task_id") {
            refs.push(("expected_target_version", task));
        }
    }
    refs
}

/// Rewrite every recorded Task version that no longer matches to the current one and return the
/// ids of the items that were behind. With `started_at` only versions of Tasks changed after
/// that moment and older than the current one count (used for a fresh AI run).
async fn refresh_versions(
    conn: &mut sqlx::PgConnection,
    items: &mut Value,
    started_at: Option<&str>,
    only: Option<&std::collections::HashSet<String>>,
) -> Result<Vec<String>, String> {
    let mut behind = Vec::new();
    for item in items.as_array_mut().into_iter().flatten() {
        let id = item["id"].as_str().unwrap_or("").to_owned();
        if only.is_some_and(|only| !only.contains(&id)) {
            continue;
        }
        let mut changed = false;
        for (field, task) in version_refs(item) {
            let Some(expected) = item[field].as_i64() else {
                continue;
            };
            let current = sqlx::query("SELECT version,($2::text IS NULL OR updated_at>$2::timestamptz) AS eligible FROM tasks WHERE id=$1 AND archived_at IS NULL")
                .bind(task).bind(started_at).fetch_optional(&mut *conn).await
                .map_err(|_| "version_lookup_failed")?;
            let Some(current) = current else { continue };
            let version: i64 = current.get("version");
            if expected != version
                && current.get::<bool, _>("eligible")
                && (started_at.is_none() || expected < version)
            {
                item[field] = json!(version);
                if let Some(object) = item["expected_versions"].as_object_mut() {
                    let key = if field == "expected_target_version" {
                        "target_task_id"
                    } else {
                        "source_task_id"
                    };
                    if object.contains_key(key) {
                        object.insert(key.into(), json!(version));
                    }
                }
                changed = true;
            }
        }
        if changed {
            behind.push(id);
        }
    }
    Ok(behind)
}

/// Put the versions the author recorded back after items were validated against current ones.
fn restore_versions(items: &mut Value, original: &[Value]) {
    for item in items.as_array_mut().into_iter().flatten() {
        let Some(before) = original.iter().find(|other| other["id"] == item["id"]) else {
            continue;
        };
        for field in VERSION_FIELDS.into_iter().chain(["expected_versions"]) {
            match before.get(field) {
                Some(value) => item[field] = value.clone(),
                None => {
                    if let Some(object) = item.as_object_mut() {
                        object.remove(field);
                    }
                }
            }
        }
    }
}

/// Ids of items built on a Task that changed since the Proposal was drafted, plus every item
/// that depends on one of them or links to a draft that is itself stale.
async fn stale_ids(conn: &mut sqlx::PgConnection, items: &Value) -> Result<Vec<String>, String> {
    let mut probe = items.clone();
    let mut stale: std::collections::HashSet<String> =
        refresh_versions(conn, &mut probe, None, None)
            .await?
            .into_iter()
            .collect();
    let all = items.as_array().cloned().unwrap_or_default();
    loop {
        let mut grew = false;
        for item in &all {
            let id = item["id"].as_str().unwrap_or("");
            if stale.contains(id) {
                continue;
            }
            let depends = item["depends_on"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str);
            let ends = ["source_task_id", "target_task_id"]
                .into_iter()
                .filter_map(|key| item[key].as_str());
            if depends.chain(ends).any(|other| stale.contains(other)) {
                stale.insert(id.to_owned());
                grew = true;
            }
        }
        if !grew {
            break;
        }
    }
    Ok(all
        .iter()
        .filter_map(|item| item["id"].as_str())
        .filter(|id| stale.contains(*id))
        .map(str::to_owned)
        .collect())
}

async fn response_with_stale(conn: &mut sqlx::PgConnection, row: &sqlx::postgres::PgRow) -> Value {
    let mut body = response(row);
    body["stale_items"] = json!(stale_ids(conn, &row.get::<Value, _>("items"))
        .await
        .unwrap_or_default());
    body
}

fn reject_dependency_cycles(items: &[Value]) -> Result<(), String> {
    let graph = items
        .iter()
        .filter_map(|item| {
            Some((
                item["id"].as_str()?,
                item["depends_on"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>(),
            ))
        })
        .collect::<std::collections::HashMap<_, _>>();
    fn visit<'a>(
        node: &'a str,
        graph: &std::collections::HashMap<&'a str, Vec<&'a str>>,
        visiting: &mut std::collections::HashSet<&'a str>,
        done: &mut std::collections::HashSet<&'a str>,
    ) -> bool {
        if done.contains(node) {
            return false;
        }
        if !visiting.insert(node) {
            return true;
        }
        let cyclic = graph
            .get(node)
            .into_iter()
            .flatten()
            .any(|next| visit(next, graph, visiting, done));
        visiting.remove(node);
        done.insert(node);
        cyclic
    }
    let mut visiting = std::collections::HashSet::new();
    let mut done = std::collections::HashSet::new();
    if graph
        .keys()
        .any(|node| visit(node, &graph, &mut visiting, &mut done))
    {
        return Err("dependency_cycle".into());
    }
    Ok(())
}

/// A split links every new Task back to its source Task. The source Task itself is
/// never edited, archived or completed by the Proposal.
fn add_split_back_links(items: &mut Vec<Value>) {
    let mut links = Vec::new();
    for item in items.iter().filter(|item| item["kind"] == "task") {
        let (Some(source), Some(id)) = (item["source_task_id"].as_str(), item["id"].as_str())
        else {
            continue;
        };
        let link_id = format!("tmp-link-{id}");
        if items.iter().any(|other| other["id"] == link_id.as_str()) {
            continue;
        }
        links.push(json!({"id":link_id,"kind":"relation","relation":"related","source_task_id":source,"target_task_id":id,"expected_source_version":item["expected_version"],"depends_on":[id],"reason":"New Task split from its source Task","sources":[],"selected":true}));
    }
    items.extend(links);
}

fn bounded_text_list(value: &Value, field: &str) -> Result<Value, String> {
    let values = value
        .as_array()
        .ok_or_else(|| format!("{field}_must_be_array"))?;
    if values.len() > 25
        || values.iter().any(|value| {
            value
                .as_str()
                .is_none_or(|text| text.trim().is_empty() || text.chars().count() > 1_000)
        })
    {
        return Err(format!("{field}_invalid_or_over_limit"));
    }
    Ok(Value::Array(
        values
            .iter()
            .map(|value| Value::String(value.as_str().unwrap().trim().to_owned()))
            .collect(),
    ))
}

async fn validate_source_versions(
    pool: &PgPool,
    workspace: Uuid,
    actor: Uuid,
    scope: &Value,
    items: &Value,
) -> Result<(), String> {
    for item in items
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item["kind"] == "task")
    {
        let Some(source) = item["source_task_id"]
            .as_str()
            .and_then(|id| Uuid::parse_str(id).ok())
        else {
            continue;
        };
        let row = sqlx::query(
            "SELECT project_id,version,workspace_id FROM tasks WHERE id=$1 AND archived_at IS NULL",
        )
        .bind(source)
        .fetch_optional(pool)
        .await
        .map_err(|_| "source_task_lookup_failed")?
        .ok_or("source_task_missing")?;
        let project: Uuid = row.get("project_id");
        if row.get::<Uuid, _>("workspace_id") != workspace
            || !scope["project_ids"].as_array().is_some_and(|projects| {
                projects
                    .iter()
                    .any(|id| id.as_str() == Some(&project.to_string()))
            })
            || !matches!(projects::evaluate_access(pool, project, actor).await, Ok(Some(access)) if access.role >= projects::Role::Contributor)
        {
            return Err("source_task_outside_scope_or_access".into());
        }
        if item["expected_version"].as_i64() != Some(row.get::<i64, _>("version")) {
            return Err("stale_expected_version".into());
        }
    }
    Ok(())
}

async fn annotate_similar_tasks(pool: &PgPool, items: &mut Value) -> Result<(), String> {
    for item in items
        .as_array_mut()
        .into_iter()
        .flatten()
        .filter(|item| item["kind"] == "task")
    {
        let title = item["title"].as_str().unwrap_or("").to_owned();
        let project = item["project_id"]
            .as_str()
            .and_then(|id| Uuid::parse_str(id).ok())
            .ok_or("task_project_invalid")?;
        let similar = sqlx::query("SELECT id,title,public.similarity(title,$2) AS score FROM tasks WHERE project_id=$1 AND archived_at IS NULL AND public.similarity(title,$2)>=0.25 ORDER BY score DESC LIMIT 5")
            .bind(project).bind(&title).fetch_all(pool).await.map_err(|_| "similarity_lookup_failed")?;
        let covers = similar.iter().any(|row| row.get::<f32, _>("score") >= 0.75);
        item["similar_tasks"] = Value::Array(similar.into_iter().map(|row| json!({"id":row.get::<Uuid,_>("id"),"title":row.get::<String,_>("title"),"similarity":row.get::<f32,_>("score")})).collect());
        item["existing_task_covers_draft"] = json!(covers);
    }
    Ok(())
}

/// Name the existing Tasks a link joins so review shows `#12 Title`, never a bare id.
async fn annotate_link_labels(pool: &PgPool, items: &mut Value) -> Result<(), String> {
    for item in items
        .as_array_mut()
        .into_iter()
        .flatten()
        .filter(|item| item["kind"] == "relation")
    {
        for (key, label) in [
            ("source_task_id", "source_label"),
            ("target_task_id", "target_label"),
        ] {
            let Some(task) = item[key].as_str().and_then(|id| Uuid::parse_str(id).ok()) else {
                continue;
            };
            let row = sqlx::query("SELECT number,title FROM tasks WHERE id=$1")
                .bind(task)
                .fetch_optional(pool)
                .await
                .map_err(|_| "label_lookup_failed")?;
            if let Some(row) = row {
                item[label] = json!(format!(
                    "#{} {}",
                    row.get::<i64, _>("number"),
                    row.get::<String, _>("title")
                ));
            }
        }
    }
    Ok(())
}

fn expected_versions(items: &Value) -> Value {
    let mut versions = serde_json::Map::new();
    for item in items.as_array().into_iter().flatten() {
        if let Some(source) = item["source_task_id"].as_str() {
            if let Some(version) = item["expected_version"].as_i64() {
                versions.insert(source.to_owned(), json!(version));
            }
        }
        if item["kind"] == "relation" {
            for (key, expected) in [
                ("source_task_id", "expected_source_version"),
                ("target_task_id", "expected_target_version"),
            ] {
                if let (Some(id), Some(version)) = (item[key].as_str(), item[expected].as_i64()) {
                    versions.insert(id.to_owned(), json!(version));
                }
            }
        }
    }
    Value::Object(versions)
}
async fn validate_items(
    pool: &PgPool,
    workspace: Uuid,
    actor: Uuid,
    scope: &Value,
    items: &mut Value,
) -> Result<(), String> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|_| "database error".to_owned())?;
    let result = validate_items_tx(&mut tx, workspace, actor, scope, items).await;
    let _ = tx.rollback().await;
    result
}

async fn proposal_access_valid(
    pool: &PgPool,
    workspace: Uuid,
    actor: Uuid,
    scope: &Value,
    items: &Value,
) -> bool {
    let Ok(mut tx) = pool.begin().await else {
        return false;
    };
    let valid = validate_undo_access_tx(&mut tx, workspace, actor, scope, items)
        .await
        .is_ok();
    let _ = tx.rollback().await;
    valid
}
async fn validate_items_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace: Uuid,
    actor: Uuid,
    scope: &Value,
    items: &mut Value,
) -> Result<(), String> {
    let ids = scope["project_ids"]
        .as_array()
        .ok_or("scope project_ids missing")?
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<std::collections::HashSet<_>>();
    let items = items.as_array_mut().ok_or("items must be array")?;
    let all_items = items.clone();
    let mut known = std::collections::HashSet::new();
    let mut proposal_relations = std::collections::HashSet::new();
    let mut proposal_schemas = std::collections::HashSet::new();
    let mut proposal_skill_names = std::collections::HashSet::new();
    for item in items.iter() {
        let id = item["id"].as_str().ok_or("item id required")?;
        if !known.insert(id) {
            return Err("duplicate item id".into());
        }
    }
    for item in items.iter_mut().filter(|item| item["selected"] == true) {
        if item["reason"].as_str().is_none_or(str::is_empty) || item["sources"].as_array().is_none()
        {
            return Err("each item needs a reason and sources".into());
        }
        if let Some(deps) = item["depends_on"].as_array() {
            for dep in deps {
                let dependency = all_items.iter().find(|other| other["id"] == *dep);
                if dependency.is_none() {
                    return Err("unknown dependency".into());
                }
                if item["selected"] == true
                    && dependency.is_some_and(|dependency| dependency["selected"] != true)
                {
                    return Err("selected item has an unselected dependency".into());
                }
            }
        }
        match item["kind"].as_str().unwrap_or("") {
            "task" => {
                let project = item["project_id"]
                    .as_str()
                    .ok_or("task project_id required")?;
                if !ids.contains(project) {
                    return Err("item outside scope".into());
                }
                let pid = Uuid::parse_str(project).map_err(|_| "invalid project id")?;
                let access = projects::evaluate_access(&mut **tx, pid, actor)
                    .await
                    .map_err(|_| "access lookup failed")?;
                if !matches!(access,Some(a) if a.role>=projects::Role::Contributor) {
                    return Err("initiator cannot write project".into());
                }
                let title = item["title"].as_str().ok_or("task title required")?.trim();
                if title.is_empty() {
                    return Err("task title required".into());
                }
                if let Some(source) = item["source_task_id"].as_str() {
                    let source_id =
                        Uuid::parse_str(source).map_err(|_| "invalid source task id")?;
                    let source_row = sqlx::query("SELECT project_id,version,workspace_id FROM tasks WHERE id=$1 AND archived_at IS NULL")
                        .bind(source_id).fetch_optional(&mut **tx).await.map_err(|_| "source task lookup failed")?
                        .ok_or("source task missing")?;
                    let source_project: Uuid = source_row.get("project_id");
                    if source_row.get::<Uuid, _>("workspace_id") != workspace
                        || !ids.contains(&source_project.to_string())
                        || !matches!(projects::evaluate_access(&mut **tx, source_project, actor).await, Ok(Some(access)) if access.role >= projects::Role::Contributor)
                    {
                        return Err("source task outside scope or access".into());
                    }
                    if item["expected_version"].as_i64()
                        != Some(source_row.get::<i64, _>("version"))
                    {
                        return Err("stale base version".into());
                    }
                }
                item["title"] = Value::String(title.to_owned());
            }
            "relation" => {
                let kind = item["relation"].as_str().unwrap_or("related").to_owned();
                if !["blocks", "related", "duplicate", "parent"].contains(&kind.as_str()) {
                    return Err("invalid relation kind".into());
                }
                for key in ["source_task_id", "target_task_id"] {
                    let target = item[key].as_str().ok_or("relation endpoints required")?;
                    if let Ok(task) = Uuid::parse_str(target) {
                        item[key] = Value::String(task.to_string());
                        let row=sqlx::query("SELECT t.project_id,t.version,t.workspace_id FROM tasks t WHERE t.id=$1 AND t.archived_at IS NULL").bind(task).fetch_optional(&mut **tx).await.map_err(|_|"task lookup failed")?.ok_or("relation task missing")?;
                        if row.get::<Uuid, _>("workspace_id") != workspace {
                            return Err("relation outside workspace".into());
                        }
                        let project: Uuid = row.get("project_id");
                        if !ids.contains(&project.to_string()) {
                            return Err("relation outside scope".into());
                        }
                        let access = projects::evaluate_access(&mut **tx, project, actor)
                            .await
                            .map_err(|_| "access lookup failed")?;
                        if !matches!(access,Some(a) if a.role>=projects::Role::Contributor) {
                            return Err("initiator cannot write relation task".into());
                        }
                        let expected = item["expected_versions"][key].as_i64().or_else(|| {
                            item[if key == "source_task_id" {
                                "expected_source_version"
                            } else {
                                "expected_target_version"
                            }]
                            .as_i64()
                        });
                        if expected.is_some_and(|expected| expected != row.get::<i64, _>("version"))
                        {
                            return Err("stale base version".into());
                        }
                    } else if item["selected"] == true {
                        if !all_items
                            .iter()
                            .any(|i| i["id"] == target && i["kind"] == "task")
                        {
                            return Err("relation endpoint missing".into());
                        }
                        if all_items.iter().any(|i| {
                            i["id"] == target && i["kind"] == "task" && i["selected"] != true
                        }) {
                            return Err("relation endpoint is unselected".into());
                        }
                    }
                }
                if item["selected"] == true {
                    let mut source = item["source_task_id"].as_str().unwrap_or("").to_owned();
                    let mut target = item["target_task_id"].as_str().unwrap_or("").to_owned();
                    if source == target {
                        return Err("self_reference".into());
                    }
                    if kind == "related" && target < source {
                        std::mem::swap(&mut source, &mut target);
                    }
                    if !proposal_relations.insert((kind.to_owned(), source.clone(), target.clone()))
                    {
                        return Err("duplicate_relation".into());
                    }
                    if let (Ok(source_id), Ok(target_id)) =
                        (Uuid::parse_str(&source), Uuid::parse_str(&target))
                    {
                        // A parent link lives on the child Task, not in the relation table.
                        let exists: bool = kind != "parent" && sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM task_relations WHERE workspace_id=$1 AND kind=$2 AND source_task_id=$3 AND target_task_id=$4)")
                            .bind(workspace).bind(&kind).bind(source_id).bind(target_id).fetch_one(&mut **tx).await.map_err(|_| "relation lookup failed")?;
                        if exists {
                            return Err("duplicate_relation".into());
                        }
                    }
                }
            }
            "skill" => {
                let workspace_role: String = sqlx::query_scalar(
                    "SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2",
                )
                .bind(workspace)
                .bind(actor)
                .fetch_optional(&mut **tx)
                .await
                .map_err(|_| "membership lookup failed")?
                .ok_or("not a workspace member")?;
                if !["owner", "admin"].contains(&workspace_role.as_str()) {
                    return Err("initiator cannot edit Skills".into());
                }
                let id = Uuid::parse_str(item["skill_id"].as_str().ok_or("skill_id required")?)
                    .map_err(|_| "invalid skill id")?;
                let row=sqlx::query("SELECT s.name,s.description,s.body,s.version,settings.max_name_chars,settings.max_description_chars,settings.max_body_chars FROM skills s JOIN workspace_skill_settings settings ON settings.workspace_id=s.workspace_id WHERE s.workspace_id=$1 AND s.id=$2 AND s.archived_at IS NULL").bind(workspace).bind(id).fetch_optional(&mut **tx).await.map_err(|_|"skill lookup failed")?.ok_or("skill missing")?;
                if item["expected_version"].as_i64() != Some(row.get("version")) {
                    return Err("stale base version".into());
                }
                let has_name = item["name"].is_string();
                let has_description = item["description"].is_string();
                let name = item["name"]
                    .as_str()
                    .unwrap_or(row.get("name"))
                    .trim()
                    .to_owned();
                let description = item["description"]
                    .as_str()
                    .unwrap_or(row.get("description"))
                    .trim()
                    .to_owned();
                let body = item["body"].as_str().unwrap_or(row.get("body"));
                if name.is_empty()
                    || description.is_empty()
                    || name.chars().count() > row.get::<i32, _>("max_name_chars") as usize
                    || description.chars().count()
                        > row.get::<i32, _>("max_description_chars") as usize
                    || body.chars().count() > row.get::<i32, _>("max_body_chars") as usize
                {
                    return Err("invalid_skill_limits".into());
                }
                let name_conflict: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM skills WHERE workspace_id=$1 AND name=$2 AND id<>$3)",
                )
                .bind(workspace)
                .bind(&name)
                .bind(id)
                .fetch_one(&mut **tx)
                .await
                .map_err(|_| "skill lookup failed")?;
                if name_conflict {
                    return Err("skill_name_conflict".into());
                }
                if has_name {
                    item["name"] = Value::String(name.clone());
                }
                if has_description {
                    item["description"] = Value::String(description);
                }
                if !proposal_skill_names.insert(name) {
                    return Err("skill_name_conflict".into());
                }
            }
            "schema" => {
                let workspace_role: String = sqlx::query_scalar(
                    "SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2",
                )
                .bind(workspace)
                .bind(actor)
                .fetch_optional(&mut **tx)
                .await
                .map_err(|_| "membership lookup failed")?
                .ok_or("not a workspace member")?;
                if !["owner", "admin"].contains(&workspace_role.as_str()) {
                    return Err("initiator cannot change schema".into());
                }
                if item["name"].as_str().is_none_or(str::is_empty)
                    || !([
                        "text",
                        "number",
                        "date",
                        "single_select",
                        "multi_select",
                        "user",
                    ]
                    .contains(&item["value_type"].as_str().unwrap_or("")))
                {
                    return Err("invalid schema item".into());
                }
                if item["selected"] == true {
                    let name = item["name"].as_str().unwrap_or("").trim().to_lowercase();
                    if !proposal_schemas.insert(name.clone()) {
                        return Err("duplicate_schema".into());
                    }
                    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM attribute_schemas WHERE workspace_id=$1 AND archived_at IS NULL AND lower(trim(name))=$2)")
                        .bind(workspace).bind(name).fetch_one(&mut **tx).await.map_err(|_| "schema lookup failed")?;
                    if exists {
                        return Err("duplicate_schema".into());
                    }
                }
            }
            "note_edit" | "file_add" => {
                let vault = item["vault_id"].as_str().ok_or("vault_id required")?;
                if !scope["vault_ids"]
                    .as_array()
                    .is_some_and(|v| v.iter().any(|id| id.as_str() == Some(vault)))
                {
                    return Err("Vault item outside scope".into());
                }
                if item["path"].as_str().is_none_or(str::is_empty) {
                    return Err("Vault item path required".into());
                }
                let vault_id = Uuid::parse_str(vault).map_err(|_| "invalid Vault id")?;
                let access = vaults::evaluate_access(&mut **tx, vault_id, actor)
                    .await
                    .map_err(|_| "Vault access lookup failed")?
                    .ok_or("Vault access denied")?;
                if access.workspace_id != workspace || access.role < projects::Role::Contributor {
                    return Err("initiator cannot write Vault".into());
                }
                let path = item["path"].as_str().unwrap_or("");
                if path.starts_with('/')
                    || path
                        .split('/')
                        .any(|segment| segment == ".." || segment.is_empty())
                {
                    return Err("invalid Vault path".into());
                }
                if item["kind"] == "note_edit" && item["content"].as_str().is_none() {
                    return Err("note content required".into());
                }
                if item["kind"] == "file_add" && item["content_base64"].as_str().is_none() {
                    return Err("file content required".into());
                }
                if item["kind"] == "note_edit"
                    && item["content"]
                        .as_str()
                        .is_some_and(|s| s.len() > crate::ai_knowledge_proposals::MAX_NOTE_BYTES)
                {
                    return Err("note_too_large".into());
                }
                if item["kind"] == "file_add"
                    && item["content_base64"].as_str().is_some_and(|s| {
                        s.len() > crate::ai_knowledge_proposals::MAX_FILE_BYTES * 4 / 3 + 8
                    })
                {
                    return Err("file_too_large".into());
                }
            }
            _ => return Err("unknown proposal item kind".into()),
        }
    }
    validate_parent_links(tx, items).await?;
    let mut graphs =
        std::collections::HashMap::<String, std::collections::HashMap<String, Vec<String>>>::new();
    for item in items.iter().filter(|item| {
        item["kind"] == "relation"
            && item["selected"] == true
            && ["blocks", "duplicate"].contains(&item["relation"].as_str().unwrap_or(""))
    }) {
        let kind = item["relation"].as_str().unwrap_or("").to_owned();
        let source = item["source_task_id"].as_str().unwrap_or("").to_owned();
        let target = item["target_task_id"].as_str().unwrap_or("").to_owned();
        graphs
            .entry(kind)
            .or_default()
            .entry(source)
            .or_default()
            .push(target);
    }
    fn cycle(
        node: &str,
        g: &std::collections::HashMap<String, Vec<String>>,
        visiting: &mut std::collections::HashSet<String>,
        done: &mut std::collections::HashSet<String>,
    ) -> bool {
        if visiting.contains(node) {
            return true;
        }
        if done.contains(node) {
            return false;
        }
        visiting.insert(node.to_owned());
        for next in g.get(node).into_iter().flatten() {
            if cycle(next, g, visiting, done) {
                return true;
            }
        }
        visiting.remove(node);
        done.insert(node.to_owned());
        false
    }
    let mut visiting = std::collections::HashSet::new();
    let mut done = std::collections::HashSet::new();
    for graph in graphs.values() {
        for node in graph.keys() {
            if cycle(node, graph, &mut visiting, &mut done) {
                return Err("relation cycle".into());
            }
        }
        visiting.clear();
        done.clear();
    }
    let existing=sqlx::query("SELECT source_task_id,target_task_id,kind FROM task_relations WHERE workspace_id=$1 AND kind IN ('blocks','duplicate')").bind(workspace).fetch_all(&mut **tx).await.map_err(|_|"relation lookup failed")?;
    for row in existing {
        graphs
            .entry(row.get::<String, _>("kind"))
            .or_default()
            .entry(row.get::<Uuid, _>("source_task_id").to_string())
            .or_default()
            .push(row.get::<Uuid, _>("target_task_id").to_string());
    }
    for graph in graphs.values() {
        visiting.clear();
        done.clear();
        for node in graph.keys() {
            if cycle(node, graph, &mut visiting, &mut done) {
                return Err("relation cycle".into());
            }
        }
    }
    Ok(())
}

/// Parent links between drafts and existing Tasks: same Project, one parent per Task and no
/// cycle through drafts or the existing hierarchy. `source_task_id` is the parent.
async fn validate_parent_links(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    items: &[Value],
) -> Result<(), String> {
    let selected = |item: &&Value| item["selected"] == true;
    let links = items
        .iter()
        .filter(selected)
        .filter(|item| item["kind"] == "relation" && item["relation"] == "parent")
        .map(|item| {
            (
                item["source_task_id"].as_str().unwrap_or("").to_owned(),
                item["target_task_id"].as_str().unwrap_or("").to_owned(),
            )
        })
        .collect::<Vec<_>>();
    if links.is_empty() {
        return Ok(());
    }
    // Child -> parent for drafts that already get a parent from a split.
    let mut parent_of = std::collections::HashMap::<String, String>::new();
    for item in items
        .iter()
        .filter(selected)
        .filter(|item| item["kind"] == "task")
    {
        if let (Some(id), Some(source)) = (item["id"].as_str(), item["source_task_id"].as_str()) {
            if item["split_mode"] != "peer" {
                parent_of.insert(id.to_owned(), source.to_owned());
            }
        }
    }
    let project_of = |id: &str| {
        items
            .iter()
            .find(|item| item["id"] == id && item["kind"] == "task")
            .and_then(|item| item["project_id"].as_str().map(str::to_owned))
    };
    for (parent, child) in &links {
        if parent_of.insert(child.clone(), parent.clone()).is_some() {
            return Err("parent_already_set".into());
        }
        let mut projects = Vec::new();
        for end in [parent, child] {
            projects.push(match project_of(end) {
                Some(project) => project,
                None => {
                    let task = Uuid::parse_str(end).map_err(|_| "relation endpoint missing")?;
                    sqlx::query_scalar::<_, Uuid>("SELECT project_id FROM tasks WHERE id=$1")
                        .bind(task)
                        .fetch_optional(&mut **tx)
                        .await
                        .map_err(|_| "task lookup failed")?
                        .ok_or("relation task missing")?
                        .to_string()
                }
            });
        }
        if projects[0] != projects[1] {
            return Err("parent_in_other_project".into());
        }
        if let Ok(task) = Uuid::parse_str(child) {
            let existing: Option<Uuid> =
                sqlx::query_scalar("SELECT parent_task_id FROM tasks WHERE id=$1")
                    .bind(task)
                    .fetch_one(&mut **tx)
                    .await
                    .map_err(|_| "task lookup failed")?;
            if existing.is_some() {
                return Err("parent_already_set".into());
            }
        }
    }
    for (parent, child) in &links {
        let mut node = parent.clone();
        for _ in 0..10_000 {
            if &node == child {
                return Err("parent_cycle".into());
            }
            let next = match parent_of.get(&node) {
                Some(next) => Some(next.clone()),
                None => match Uuid::parse_str(&node) {
                    Ok(task) => sqlx::query_scalar::<_, Option<Uuid>>(
                        "SELECT parent_task_id FROM tasks WHERE id=$1",
                    )
                    .bind(task)
                    .fetch_optional(&mut **tx)
                    .await
                    .map_err(|_| "task lookup failed")?
                    .flatten()
                    .map(|id| id.to_string()),
                    Err(_) => None,
                },
            };
            let Some(next) = next else { break };
            node = next;
        }
    }
    Ok(())
}
