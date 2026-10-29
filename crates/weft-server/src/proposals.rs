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
    json!({"id":row.get::<Uuid,_>("id"),"workspace_id":row.get::<Uuid,_>("workspace_id"),"schema_version":row.get::<i32,_>("schema_version"),"revision":row.get::<i32,_>("revision"),"status":row.get::<String,_>("status"),"scope":row.get::<Value,_>("scope"),"items":row.get::<Value,_>("items"),"applied_revision":row.get::<Option<i32>,_>("applied_revision")})
}
async fn load(
    pool: &PgPool,
    workspace: Uuid,
    id: Uuid,
) -> Result<Option<sqlx::postgres::PgRow>, sqlx::Error> {
    sqlx::query("SELECT id,workspace_id,initiator_id,schema_version,revision,status,scope,items,applied_revision FROM proposals WHERE workspace_id=$1 AND id=$2").bind(workspace).bind(id).fetch_optional(pool).await
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
    let items = Value::Array(items);
    if let Err(message) = validate_items(&state.pool, workspace, actor, &scope, &items).await {
        return invalid(&message);
    }
    let id = Uuid::new_v4();
    match sqlx::query("INSERT INTO proposals(id,workspace_id,initiator_id,scope,items) VALUES($1,$2,$3,$4,$5) RETURNING id,workspace_id,schema_version,revision,status,scope,items,applied_revision").bind(id).bind(workspace).bind(actor).bind(scope).bind(items).fetch_one(&state.pool).await {
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
            (StatusCode::OK, Json(response(&row))).into_response()
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
    let row = match sqlx::query("SELECT id,workspace_id,initiator_id,schema_version,revision,status,scope,items,applied_revision FROM proposals WHERE workspace_id=$1 AND id=$2 FOR UPDATE")
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
    if let Err(message) = validate_items_tx(&mut tx, workspace, actor, &scope, &items).await {
        if message == "duplicate_relation" || message == "duplicate_schema" {
            return (
                StatusCode::CONFLICT,
                Json(json!({"error":"proposal_conflict","detail":message})),
            )
                .into_response();
        }
        return invalid(&message);
    }
    match sqlx::query("UPDATE proposals SET items=$3,revision=revision+1,status='pending',applied_revision=NULL,apply_result=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND revision=$4 RETURNING id,workspace_id,schema_version,revision,status,scope,items,applied_revision").bind(workspace).bind(id).bind(items).bind(expected_revision_i32).fetch_one(&mut *tx).await {
        Ok(row) => {
            if tx.commit().await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
            (StatusCode::OK, Json(response(&row))).into_response()
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
            let items: Value = row.get("items");
            if !matches!(member(&state.pool, workspace, actor).await, Ok(true))
                || !proposal_access_valid(&state.pool, workspace, actor, &scope, &items).await
            {
                return StatusCode::FORBIDDEN.into_response();
            }
            match validate_items(&state.pool, workspace, actor, &scope, &items).await {
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
    let items: Value = row.get("items");
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
    if status != "pending" {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"proposal_not_pending"})),
        )
            .into_response();
    }
    if let Err(error) = validate_items_tx(&mut tx, workspace, actor, &scope, &items).await {
        if error == "duplicate_relation" || error == "duplicate_schema" {
            return (
                StatusCode::CONFLICT,
                Json(json!({"error":"proposal_conflict","detail":error})),
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
            if sqlx::query("INSERT INTO task_operation_groups(id,command_id,workspace_id,actor_id) VALUES($1,$2,$3,$4)").bind(group).bind(Uuid::new_v4()).bind(workspace).bind(actor).execute(&mut *tx).await.is_err(){return StatusCode::INTERNAL_SERVER_ERROR.into_response()}
            group
        }
    };
    let mut created = Vec::new();
    let selected = items
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| i["selected"] == true)
        .collect::<Vec<_>>();
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
                let num:Option<i64>=sqlx::query_scalar("UPDATE workspaces SET next_task_number=next_task_number+1 WHERE id=$1 RETURNING next_task_number-1").bind(workspace).fetch_optional(&mut *tx).await.ok().flatten();
                let Some(number) = num else {
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                };
                if sqlx::query("INSERT INTO tasks(id,workspace_id,number,project_id,title,description,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(task).bind(workspace).bind(number).bind(project).bind(item["title"].as_str().unwrap_or("" )).bind(item["description"].as_str().unwrap_or("")).bind(actor).execute(&mut *tx).await.is_err(){return StatusCode::INTERNAL_SERVER_ERROR.into_response()}
                created.push(json!({"id":task,"number":number,"item_id":item["id"]}));
            }
            "relation" => {
                let source = resolve_task(&created, item["source_task_id"].as_str().unwrap_or(""));
                let target = resolve_task(&created, item["target_task_id"].as_str().unwrap_or(""));
                let (Some(mut source), Some(mut target)) = (source, target) else {
                    return (StatusCode::CONFLICT, Json(json!({"error":"proposal_invalid","detail":"relation endpoint missing"}))).into_response();
                };
                let kind = item["relation"].as_str().unwrap_or("related");
                if kind == "related" && target < source {
                    std::mem::swap(&mut source, &mut target);
                }
                if sqlx::query("INSERT INTO task_relations(workspace_id,source_task_id,target_task_id,kind) VALUES($1,$2,$3,$4)").bind(workspace).bind(source).bind(target).bind(kind).execute(&mut *tx).await.is_err(){return (StatusCode::CONFLICT, Json(json!({"error":"proposal_conflict","detail":"duplicate_relation"}))).into_response()}
                let source_version: i64 =
                    match sqlx::query_scalar("SELECT version FROM tasks WHERE id=$1")
                        .bind(source)
                        .fetch_one(&mut *tx)
                        .await
                    {
                        Ok(version) => version,
                        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                    };
                let target_version: i64 =
                    match sqlx::query_scalar("SELECT version FROM tasks WHERE id=$1")
                        .bind(target)
                        .fetch_one(&mut *tx)
                        .await
                    {
                        Ok(version) => version,
                        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                    };
                applied_relations.push(json!({"source":source,"target":target,"kind":kind,"source_version":source_version,"target_version":target_version}));
            }
            "skill" => {
                let skill = Uuid::parse_str(item["skill_id"].as_str().unwrap_or("")).unwrap();
                let before=match sqlx::query("SELECT name,description,body,enabled,version FROM skills WHERE workspace_id=$1 AND id=$2 FOR UPDATE").bind(workspace).bind(skill).fetch_one(&mut *tx).await{Ok(row)=>json!({"id":skill,"name":row.get::<String,_>("name"),"description":row.get::<String,_>("description"),"body":row.get::<String,_>("body"),"enabled":row.get::<bool,_>("enabled"),"version":row.get::<i64,_>("version")}),Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response()};
                if sqlx::query("UPDATE skills SET name=COALESCE($3,name),description=COALESCE($4,description),body=COALESCE($5,body),enabled=COALESCE($6,enabled),version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2").bind(workspace).bind(skill).bind(item["name"].as_str()).bind(item["description"].as_str()).bind(item["body"].as_str()).bind(item["enabled"].as_bool()).execute(&mut *tx).await.is_err(){return StatusCode::INTERNAL_SERVER_ERROR.into_response()}
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
        "SELECT initiator_id,status,scope,items FROM proposals WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
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
    if proposal.get::<String, _>("status") != "applied" {
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
        let version = sqlx::query_scalar::<_, i64>(
            "SELECT version FROM tasks WHERE id=$1 AND archived_at IS NULL",
        )
        .bind(task)
        .fetch_optional(&mut *tx)
        .await;
        if !matches!(version, Ok(Some(1))) {
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
            let exists=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM task_relations WHERE source_task_id=$1 AND target_task_id=$2 AND kind=$3)").bind(source).bind(target).bind(kind).fetch_one(&mut *tx).await;
            if !matches!(exists, Ok(true)) {
                conflicts.push(json!({"source_task_id":source,"target_task_id":target,"reason":"relation_changed_or_missing"}));
            }
            for (task, key) in [(source, "source_version"), (target, "target_version")] {
                let expected = relation[key].as_i64();
                let current = sqlx::query_scalar::<_, i64>(
                    "SELECT version FROM tasks WHERE id=$1 AND archived_at IS NULL",
                )
                .bind(task)
                .fetch_optional(&mut *tx)
                .await;
                if !matches!((expected, current), (Some(expected), Ok(Some(current))) if expected == current)
                {
                    conflicts
                        .push(json!({"task_id":task,"reason":"relation_task_changed_or_missing"}));
                }
            }
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
    for task in &tasks {
        if sqlx::query(
            "UPDATE tasks SET archived_at=now(),version=version+1,updated_at=now() WHERE id=$1 AND version=1 AND archived_at IS NULL",
        )
        .bind(task)
        .execute(&mut *tx)
        .await
        .is_err()
        {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    for relation in relations.as_array().into_iter().flatten() {
        let source = Uuid::parse_str(relation["source"].as_str().unwrap_or("")).unwrap();
        let target = Uuid::parse_str(relation["target"].as_str().unwrap_or("")).unwrap();
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
async fn validate_items(
    pool: &PgPool,
    workspace: Uuid,
    actor: Uuid,
    scope: &Value,
    items: &Value,
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
    items: &Value,
) -> Result<(), String> {
    let ids = scope["project_ids"]
        .as_array()
        .ok_or("scope project_ids missing")?
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<std::collections::HashSet<_>>();
    let items = items.as_array().ok_or("items must be array")?;
    let mut known = std::collections::HashSet::new();
    let mut proposal_relations = std::collections::HashSet::new();
    let mut proposal_schemas = std::collections::HashSet::new();
    for item in items {
        let id = item["id"].as_str().ok_or("item id required")?;
        if !known.insert(id) {
            return Err("duplicate item id".into());
        }
        if item["reason"].as_str().is_none_or(str::is_empty) || item["sources"].as_array().is_none()
        {
            return Err("each item needs a reason and sources".into());
        }
        if let Some(deps) = item["depends_on"].as_array() {
            for dep in deps {
                let dependency = items.iter().find(|other| other["id"] == *dep);
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
                if item["title"].as_str().is_none_or(str::is_empty) {
                    return Err("task title required".into());
                }
            }
            "relation" => {
                let kind = item["relation"].as_str().unwrap_or("related");
                if !["blocks", "related", "duplicate"].contains(&kind) {
                    return Err("invalid relation kind".into());
                }
                for key in ["source_task_id", "target_task_id"] {
                    let target = item[key].as_str().ok_or("relation endpoints required")?;
                    if let Ok(task) = Uuid::parse_str(target) {
                        let row=sqlx::query("SELECT t.project_id,t.version,t.workspace_id FROM tasks t WHERE t.id=$1 AND t.archived_at IS NULL FOR UPDATE").bind(task).fetch_optional(&mut **tx).await.map_err(|_|"task lookup failed")?.ok_or("relation task missing")?;
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
                        if !items
                            .iter()
                            .any(|i| i["id"] == target && i["kind"] == "task")
                        {
                            return Err("relation endpoint missing".into());
                        }
                        if items.iter().any(|i| {
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
                        return Err("duplicate_relation".into());
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
                        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM task_relations WHERE workspace_id=$1 AND kind=$2 AND source_task_id=$3 AND target_task_id=$4)")
                            .bind(workspace).bind(kind).bind(source_id).bind(target_id).fetch_one(&mut **tx).await.map_err(|_| "relation lookup failed")?;
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
                let row=sqlx::query("SELECT version FROM skills WHERE workspace_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE").bind(workspace).bind(id).fetch_optional(&mut **tx).await.map_err(|_|"skill lookup failed")?.ok_or("skill missing")?;
                if item["expected_version"].as_i64() != Some(row.get("version")) {
                    return Err("stale base version".into());
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
            }
            _ => return Err("unknown proposal item kind".into()),
        }
    }
    let mut graph = std::collections::HashMap::<String, Vec<String>>::new();
    for item in items
        .iter()
        .filter(|i| i["kind"] == "relation" && i["relation"] == "blocks")
    {
        let source = item["source_task_id"].as_str().unwrap_or("").to_owned();
        let target = item["target_task_id"].as_str().unwrap_or("").to_owned();
        graph.entry(source).or_default().push(target);
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
    for node in graph.keys() {
        if cycle(node, &graph, &mut visiting, &mut done) {
            return Err("relation cycle".into());
        }
    }
    let existing=sqlx::query("SELECT source_task_id,target_task_id FROM task_relations WHERE workspace_id=$1 AND kind='blocks'").bind(workspace).fetch_all(&mut **tx).await.map_err(|_|"relation lookup failed")?;
    for row in existing {
        graph
            .entry(row.get::<Uuid, _>("source_task_id").to_string())
            .or_default()
            .push(row.get::<Uuid, _>("target_task_id").to_string());
    }
    visiting.clear();
    done.clear();
    for node in graph.keys() {
        if cycle(node, &graph, &mut visiting, &mut done) {
            return Err("relation cycle".into());
        }
    }
    Ok(())
}
