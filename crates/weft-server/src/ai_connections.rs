use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post, put},
    Json, Router,
};
use ring::aead::{self, Aad, LessSafeKey, Nonce, UnboundKey};
use ring::rand::{SecureRandom, SystemRandom};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::auth::{require_session, AuthState};

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route(
            "/ai/connections",
            get(list_connections).post(create_connection),
        )
        .route("/ai/connections/:id", patch(update_connection))
        .route("/ai/connections/:id/grants", post(create_grant))
        .route("/ai/connections/:id/grants/:grant_id", delete(delete_grant))
        .route("/ai/connections/:id/disable", post(disable_connection))
        .route("/ai/connections/:id/enable", post(enable_connection))
        .route("/ai/connections/:id/rotate", post(rotate_credential))
        .route("/ai/connections/:id/revoke", post(revoke_connection))
        .route("/ai/connections/:id/audit", get(connection_audit))
        .route("/ai/defaults", put(set_default).get(resolve_default))
}

#[derive(Deserialize)]
struct CreateConnection {
    scope: String,
    workspace_id: Option<Uuid>,
    provider: String,
    auth_mode: String,
    billing_mode: String,
    credential_reference: Option<String>,
    credential_secret: Option<String>,
    runner_reference: Option<String>,
    model_default: Option<String>,
    #[serde(default)]
    capabilities: Vec<String>,
    #[serde(default)]
    limits: Value,
    #[serde(default)]
    allowed_workspaces: Vec<Uuid>,
    #[serde(default)]
    allowed_users: Vec<Uuid>,
}

#[derive(Deserialize)]
struct UpdateConnection {
    model_default: Option<String>,
    runner_reference: Option<String>,
    capabilities: Option<Vec<String>>,
    limits: Option<Value>,
    fallback_connection_id: Option<Uuid>,
    #[serde(default)]
    clear_fallback: bool,
}

#[derive(Deserialize)]
struct GrantInput {
    workspace_id: Option<Uuid>,
    user_id: Option<Uuid>,
}

#[derive(Deserialize)]
struct DefaultInput {
    scope: String,
    workspace_id: Option<Uuid>,
    connection_id: Uuid,
}

#[derive(Deserialize)]
struct ResolveQuery {
    workspace_id: Option<Uuid>,
    connection_id: Option<Uuid>,
}

#[derive(Deserialize)]
struct RotateInput {
    credential_secret: String,
}

async fn create_connection(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Json(input): Json<CreateConnection>,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, true).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let Some(scope_workspace) = valid_scope(&input.scope, input.workspace_id) else {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_scope");
    };
    if !valid_provider(&input.provider)
        || !valid_auth_billing(&input.auth_mode, &input.billing_mode)
        || !valid_capabilities(&input.capabilities)
        || !input.limits.is_object()
        || input
            .model_default
            .as_deref()
            .is_some_and(|model| model.trim().is_empty() || model.len() > 200)
        || input
            .credential_reference
            .as_deref()
            .is_some_and(|reference| reference.trim().is_empty() || reference.len() > 512)
        || input
            .runner_reference
            .as_deref()
            .is_some_and(|reference| reference.trim().is_empty() || reference.len() > 512)
    {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_connection");
    }
    // No provider mode has passed the many-end-user capability check yet. In particular,
    // a personal subscription login cannot be promoted to a shared Workspace connection.
    if input.scope != "personal" && input.billing_mode == "subscription" {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({
                "error":"unsupported_shared_mode",
                "state":"unsupported_shared_mode",
                "state_reason":"This provider mode has not been verified for shared end users"
            })),
        )
            .into_response();
    }
    if let Some(secret) = input.credential_secret.as_deref() {
        if secret.is_empty() || secret.len() > 16_384 {
            return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_credential");
        }
        if credential_key().is_err() {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "credential_encryption_unavailable",
            );
        }
    }
    if !can_create(&state.pool, &input.scope, scope_workspace, actor).await {
        return StatusCode::FORBIDDEN.into_response();
    }
    let id = Uuid::new_v4();
    let owner = (input.scope == "personal").then_some(actor);
    let mut allowed_workspaces = input.allowed_workspaces.clone();
    if input.scope == "workspace" && allowed_workspaces.is_empty() {
        if let Some(workspace) = scope_workspace {
            allowed_workspaces.push(workspace);
        }
    }
    if (input.scope == "personal"
        && (!input.allowed_users.is_empty() || !allowed_workspaces.is_empty()))
        || (scope_workspace
            .is_some_and(|workspace| allowed_workspaces.iter().any(|id| *id != workspace)))
    {
        return error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_connection_grants",
        );
    }
    if let Some(workspace) = scope_workspace {
        for user in &input.allowed_users {
            let member = sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2)")
                .bind(workspace)
                .bind(user)
                .fetch_one(&state.pool)
                .await;
            if !matches!(member, Ok(true)) {
                return error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "invalid_connection_grants",
                );
            }
        }
    }
    let state_name = initial_state(&input);
    let state_reason = state_reason(&state_name);
    let encrypted = match input
        .credential_secret
        .as_deref()
        .map(|secret| encrypt_secret(id, secret))
        .transpose()
    {
        Ok(value) => value,
        Err(_) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "credential_encryption_unavailable",
            )
        }
    };
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let inserted = sqlx::query("INSERT INTO ai_connections(id,scope,workspace_id,owner_id,provider,auth_mode,billing_mode,credential_reference,runner_reference,model_default,capabilities,limits,state,state_reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)")
        .bind(id)
        .bind(&input.scope)
        .bind(scope_workspace)
        .bind(owner)
        .bind(&input.provider)
        .bind(&input.auth_mode)
        .bind(&input.billing_mode)
        .bind(input.credential_reference.as_deref())
        .bind(input.runner_reference.as_deref())
        .bind(input.model_default.as_deref().map(str::trim))
        .bind(json!(input.capabilities))
        .bind(input.limits)
        .bind(&state_name)
        .bind(&state_reason)
        .bind(actor)
        .execute(&mut *tx)
        .await;
    if inserted.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    for workspace in allowed_workspaces {
        if sqlx::query("INSERT INTO ai_connection_grants(connection_id,workspace_id) VALUES($1,$2)")
            .bind(id)
            .bind(workspace)
            .execute(&mut *tx)
            .await
            .is_err()
        {
            return error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_connection_grants",
            );
        }
    }
    for user in &input.allowed_users {
        if sqlx::query("INSERT INTO ai_connection_grants(connection_id,user_id) VALUES($1,$2)")
            .bind(id)
            .bind(user)
            .execute(&mut *tx)
            .await
            .is_err()
        {
            return error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_connection_grants",
            );
        }
    }
    if let Some(ciphertext) = encrypted {
        if sqlx::query(
            "INSERT INTO ai_connection_credentials(connection_id,ciphertext) VALUES($1,$2)",
        )
        .bind(id)
        .bind(ciphertext)
        .execute(&mut *tx)
        .await
        .is_err()
        {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    if insert_audit(&mut tx, actor, scope_workspace, "ai.connection.created", id)
        .await
        .is_err()
        || tx.commit().await.is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    match load_connection(&state.pool, id).await {
        Ok(Some(connection)) => (StatusCode::CREATED, Json(connection)).into_response(),
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn list_connections(State(state): State<AuthState>, headers: HeaderMap) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let rows = sqlx::query("SELECT c.id FROM ai_connections c WHERE (c.owner_id=$1 OR (c.scope='workspace' AND EXISTS(SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=c.workspace_id AND m.user_id=$1) AND (EXISTS(SELECT 1 FROM ai_connection_grants g WHERE g.connection_id=c.id AND g.workspace_id=c.workspace_id) OR EXISTS(SELECT 1 FROM ai_connection_grants g WHERE g.connection_id=c.id AND g.user_id=$1))) OR EXISTS(SELECT 1 FROM ai_connection_grants g JOIN workspace_memberships m ON m.workspace_id=g.workspace_id WHERE g.connection_id=c.id AND m.user_id=$1) OR (c.scope<>'workspace' AND EXISTS(SELECT 1 FROM ai_connection_grants g WHERE g.connection_id=c.id AND g.user_id=$1))) ORDER BY c.created_at,c.id")
        .bind(actor)
        .fetch_all(&state.pool)
        .await;
    let Ok(rows) = rows else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let mut connections = Vec::with_capacity(rows.len());
    for row in rows {
        let id: Uuid = row.get("id");
        match load_connection(&state.pool, id).await {
            Ok(Some(connection)) => connections.push(connection),
            _ => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    }
    Json(json!({"connections":connections})).into_response()
}

async fn update_connection(
    State(state): State<AuthState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<UpdateConnection>,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, true).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    if !connection_admin(&state.pool, id, actor).await {
        return StatusCode::FORBIDDEN.into_response();
    }
    if input
        .capabilities
        .as_ref()
        .is_some_and(|items| !valid_capabilities(items))
        || input
            .limits
            .as_ref()
            .is_some_and(|limits| !limits.is_object())
        || input
            .model_default
            .as_deref()
            .is_some_and(|model| model.trim().is_empty() || model.len() > 200)
        || input
            .runner_reference
            .as_deref()
            .is_some_and(|reference| reference.trim().is_empty() || reference.len() > 512)
    {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_connection");
    }
    if let Some(fallback) = input.fallback_connection_id {
        if fallback == id
            || input.clear_fallback
            || !connection_admin(&state.pool, fallback, actor).await
        {
            return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_fallback");
        }
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let changed = sqlx::query("UPDATE ai_connections SET model_default=COALESCE($2,model_default),runner_reference=COALESCE($3,runner_reference),capabilities=COALESCE($4,capabilities),limits=COALESCE($5,limits),state=CASE WHEN enabled THEN CASE WHEN COALESCE($3,runner_reference) IS NOT NULL THEN 'runner_offline' WHEN NOT EXISTS(SELECT 1 FROM ai_connection_credentials c WHERE c.connection_id=ai_connections.id AND c.revoked_at IS NULL) AND credential_reference IS NULL AND provider<>'scripted' THEN 'needs_login' ELSE 'ready' END ELSE 'disabled' END,state_reason=CASE WHEN NOT enabled THEN 'Connection is disabled' WHEN COALESCE($3,runner_reference) IS NOT NULL THEN 'Runner has not connected' WHEN NOT EXISTS(SELECT 1 FROM ai_connection_credentials c WHERE c.connection_id=ai_connections.id AND c.revoked_at IS NULL) AND credential_reference IS NULL AND provider<>'scripted' THEN 'Provider sign-in is required' ELSE 'Connection is ready' END,updated_at=now() WHERE id=$1 AND revoked_at IS NULL")
        .bind(id)
        .bind(input.model_default.as_deref().map(str::trim))
        .bind(input.runner_reference.as_deref())
        .bind(input.capabilities.map(|value| json!(value)))
        .bind(input.limits)
        .execute(&mut *tx)
        .await;
    if !changed.is_ok_and(|result| result.rows_affected() == 1) {
        return error(StatusCode::NOT_FOUND, "connection_not_found");
    }
    let change_fallback = input.clear_fallback || input.fallback_connection_id.is_some();
    if change_fallback
        && sqlx::query(
            "UPDATE ai_connections SET fallback_connection_id=$2,updated_at=now() WHERE id=$1",
        )
        .bind(id)
        .bind(input.fallback_connection_id)
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let workspace = connection_workspace(&mut tx, id).await.ok().flatten();
    if insert_audit(&mut tx, actor, workspace, "ai.connection.changed", id)
        .await
        .is_err()
        || tx.commit().await.is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    return_connection(&state.pool, id).await
}

async fn create_grant(
    State(state): State<AuthState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<GrantInput>,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, true).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    if input.workspace_id.is_some() == input.user_id.is_some() {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_grant");
    }
    if !connection_admin(&state.pool, id, actor).await {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !connection_active(&state.pool, id).await {
        return error(StatusCode::NOT_FOUND, "connection_not_found");
    }
    let connection = match load_connection_row(&state.pool, id).await {
        Ok(Some(row)) => row,
        Ok(None) => return error(StatusCode::NOT_FOUND, "connection_not_found"),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let scope: String = connection.get("scope");
    let scope_workspace: Option<Uuid> = connection.get("workspace_id");
    if scope == "personal"
        || scope_workspace
            .is_some_and(|workspace| input.workspace_id.is_some_and(|id| id != workspace))
    {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_grant");
    }
    if let Some(user) = input.user_id {
        let exists: bool = if scope == "workspace" {
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2)")
                .bind(scope_workspace)
                .bind(user)
                .fetch_one(&state.pool)
                .await
                .unwrap_or(false)
        } else {
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id=$1)")
                .bind(user)
                .fetch_one(&state.pool)
                .await
                .unwrap_or(false)
        };
        if !exists {
            return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_grant");
        }
    }
    if let Some(workspace) = input.workspace_id {
        if scope == "workspace" {
            let member: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2)")
                .bind(workspace)
                .bind(actor)
                .fetch_one(&state.pool)
                .await
                .unwrap_or(false);
            if !member {
                return StatusCode::FORBIDDEN.into_response();
            }
        }
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let inserted = sqlx::query("INSERT INTO ai_connection_grants(connection_id,workspace_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING connection_id")
        .bind(id)
        .bind(input.workspace_id)
        .bind(input.user_id)
        .fetch_optional(&mut *tx)
        .await;
    match inserted {
        Ok(Some(_)) => {}
        Ok(None) => return error(StatusCode::CONFLICT, "grant_exists"),
        Err(_) => return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_grant"),
    }
    let workspace = connection_workspace(&mut tx, id).await.ok().flatten();
    if insert_audit(&mut tx, actor, workspace, "ai.connection.grant_created", id)
        .await
        .is_err()
        || tx.commit().await.is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    (
        StatusCode::CREATED,
        Json(json!({"connection_id":id,"workspace_id":input.workspace_id,"user_id":input.user_id})),
    )
        .into_response()
}

async fn delete_grant(
    State(state): State<AuthState>,
    Path((id, grant_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, true).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    if !connection_admin(&state.pool, id, actor).await {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let removed = sqlx::query("DELETE FROM ai_connection_grants WHERE connection_id=$1 AND (user_id=$2 OR workspace_id=$2) RETURNING connection_id")
        .bind(id)
        .bind(grant_id)
        .fetch_optional(&mut *tx)
        .await;
    if !matches!(removed, Ok(Some(_))) {
        return error(StatusCode::NOT_FOUND, "grant_not_found");
    }
    let workspace = connection_workspace(&mut tx, id).await.ok().flatten();
    if insert_audit(&mut tx, actor, workspace, "ai.connection.grant_revoked", id)
        .await
        .is_err()
        || tx.commit().await.is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn disable_connection(
    State(state): State<AuthState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    change_enabled(&state, id, &headers, false).await
}

async fn enable_connection(
    State(state): State<AuthState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    change_enabled(&state, id, &headers, true).await
}

async fn change_enabled(
    state: &AuthState,
    id: Uuid,
    headers: &HeaderMap,
    enabled: bool,
) -> Response {
    let (_, actor) = match require_session(&state.pool, headers, true).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    if !connection_admin(&state.pool, id, actor).await {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let result = sqlx::query("UPDATE ai_connections SET enabled=$2,state=CASE WHEN NOT $2 THEN 'disabled' WHEN runner_reference IS NOT NULL THEN 'runner_offline' WHEN NOT EXISTS(SELECT 1 FROM ai_connection_credentials c WHERE c.connection_id=ai_connections.id AND c.revoked_at IS NULL) AND credential_reference IS NULL AND provider<>'scripted' THEN 'needs_login' ELSE 'ready' END,state_reason=CASE WHEN NOT $2 THEN 'Connection is disabled' WHEN runner_reference IS NOT NULL THEN 'Runner has not connected' WHEN NOT EXISTS(SELECT 1 FROM ai_connection_credentials c WHERE c.connection_id=ai_connections.id AND c.revoked_at IS NULL) AND credential_reference IS NULL AND provider<>'scripted' THEN 'Provider sign-in is required' ELSE 'Connection is ready' END,updated_at=now() WHERE id=$1 AND revoked_at IS NULL")
        .bind(id)
        .bind(enabled)
        .execute(&mut *tx)
        .await;
    if !result.is_ok_and(|result| result.rows_affected() == 1) {
        return error(StatusCode::NOT_FOUND, "connection_not_found");
    }
    let event = if enabled {
        "ai.connection.enabled"
    } else {
        "ai.connection.disabled"
    };
    let workspace = connection_workspace(&mut tx, id).await.ok().flatten();
    // Lock order everywhere: schedule rows, then run rows, then job rows.
    if !enabled
        && crate::ai_schedules::stop_schedules(
            &mut tx,
            "connection_id",
            id,
            "connection_unavailable",
            "The Connection is disabled",
        )
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if !enabled
        && stop_connection_runs(
            &mut tx,
            id,
            "AI connection disabled by an administrator; restart after it is enabled",
        )
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if insert_audit(&mut tx, actor, workspace, event, id)
        .await
        .is_err()
        || tx.commit().await.is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    return_connection(&state.pool, id).await
}

async fn rotate_credential(
    State(state): State<AuthState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<RotateInput>,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, true).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    if !connection_admin(&state.pool, id, actor).await {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !connection_active(&state.pool, id).await {
        return error(StatusCode::NOT_FOUND, "connection_not_found");
    }
    if input.credential_secret.is_empty() || input.credential_secret.len() > 16_384 {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_credential");
    }
    let ciphertext = match encrypt_secret(id, &input.credential_secret) {
        Ok(value) => value,
        Err(_) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "credential_encryption_unavailable",
            )
        }
    };
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if sqlx::query("INSERT INTO ai_connection_credentials(connection_id,ciphertext) VALUES($1,$2) ON CONFLICT(connection_id) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,rotated_at=now(),revoked_at=NULL")
        .bind(id)
        .bind(ciphertext)
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return error(StatusCode::NOT_FOUND, "connection_not_found");
    }
    if sqlx::query("UPDATE ai_connections SET state=CASE WHEN NOT enabled THEN 'disabled' WHEN runner_reference IS NOT NULL THEN 'runner_offline' ELSE 'ready' END,state_reason=CASE WHEN NOT enabled THEN 'Connection is disabled' WHEN runner_reference IS NOT NULL THEN 'Runner has not connected' ELSE 'Connection is ready' END,updated_at=now() WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let workspace = connection_workspace(&mut tx, id).await.ok().flatten();
    if stop_connection_runs(
        &mut tx,
        id,
        "AI connection credential rotated by an administrator; restart this run",
    )
    .await
    .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if insert_audit(&mut tx, actor, workspace, "ai.connection.rotated", id)
        .await
        .is_err()
        || tx.commit().await.is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    return_connection(&state.pool, id).await
}

async fn revoke_connection(
    State(state): State<AuthState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, true).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    if !connection_admin(&state.pool, id, actor).await {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let result = sqlx::query("UPDATE ai_connections SET enabled=false,revoked_at=now(),state='disabled',state_reason='Connection is revoked',updated_at=now() WHERE id=$1 AND revoked_at IS NULL")
        .bind(id)
        .execute(&mut *tx)
        .await;
    if !result.is_ok_and(|result| result.rows_affected() == 1) {
        return error(StatusCode::NOT_FOUND, "connection_not_found");
    }
    if sqlx::query("DELETE FROM ai_connection_credentials WHERE connection_id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let workspace = connection_workspace(&mut tx, id).await.ok().flatten();
    // Lock order everywhere: schedule rows, then run rows, then job rows.
    if crate::ai_schedules::stop_schedules(
        &mut tx,
        "connection_id",
        id,
        "connection_revoked",
        "The Connection was revoked",
    )
    .await
    .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if stop_connection_runs(&mut tx, id, "AI connection revoked by an administrator")
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if insert_audit(&mut tx, actor, workspace, "ai.connection.revoked", id)
        .await
        .is_err()
        || tx.commit().await.is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    return_connection(&state.pool, id).await
}

async fn stop_connection_runs(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    connection: Uuid,
    reason: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("WITH stopped AS (UPDATE ai_runs SET state='canceled',summary=$2,updated_at=now() WHERE connection_id=$1 AND state IN ('queued','running','rate_limited') RETURNING id,summary) INSERT INTO ai_run_events(run_id,kind,summary,details) SELECT id,'state',summary,jsonb_build_object('state','canceled','reason','connection_changed') FROM stopped")
        .bind(connection)
        .bind(reason)
        .execute(&mut **tx)
        .await?;
    // Schedules first (callers), then run rows, then jobs (the global lock order).
    sqlx::query("UPDATE ai_runner_jobs SET status='paused',visible_reason=$2,updated_at=now() WHERE connection_id=$1 AND status IN ('queued','leased')")
        .bind(connection)
        .bind(reason)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn set_default(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Json(input): Json<DefaultInput>,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, true).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let (policy_scope, workspace, user) = match input.scope.as_str() {
        "installation" if input.workspace_id.is_none() => ("installation", None, None),
        "workspace" if input.workspace_id.is_some() => ("workspace", input.workspace_id, None),
        "personal" if input.workspace_id.is_none() => ("user", None, Some(actor)),
        _ => return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_default_scope"),
    };
    if (policy_scope == "installation" && !is_installation_admin(&state.pool, actor).await)
        || (policy_scope == "workspace"
            && !workspace_admin(&state.pool, workspace.unwrap(), actor).await)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if (policy_scope != "installation"
        && !connection_allowed(&state.pool, input.connection_id, actor, workspace).await)
        || !connection_matches_policy(
            &state.pool,
            input.connection_id,
            policy_scope,
            workspace,
            user,
        )
        .await
    {
        return error(StatusCode::FORBIDDEN, "connection_not_allowed");
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if sqlx::query("DELETE FROM ai_default_policies WHERE scope=$1 AND workspace_id IS NOT DISTINCT FROM $2 AND user_id IS NOT DISTINCT FROM $3")
        .bind(policy_scope)
        .bind(workspace)
        .bind(user)
        .execute(&mut *tx)
        .await
        .is_err()
        || sqlx::query("INSERT INTO ai_default_policies(scope,workspace_id,user_id,connection_id,updated_by) VALUES($1,$2,$3,$4,$5)")
        .bind(policy_scope)
        .bind(workspace)
        .bind(user)
        .bind(input.connection_id)
        .bind(actor)
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_default");
    }
    if insert_audit(
        &mut tx,
        actor,
        workspace,
        "ai.connection.default_switched",
        input.connection_id,
    )
    .await
    .is_err()
        || tx.commit().await.is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    return_connection(&state.pool, input.connection_id).await
}

async fn resolve_default(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Query(query): Query<ResolveQuery>,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    resolve_for(&state.pool, actor, query).await
}

async fn resolve_for(pool: &PgPool, actor: Uuid, query: ResolveQuery) -> Response {
    if let Some(workspace) = query.workspace_id {
        let member = sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2)")
            .bind(workspace)
            .bind(actor)
            .fetch_one(pool)
            .await;
        if !matches!(member, Ok(true)) {
            return StatusCode::NOT_FOUND.into_response();
        }
    }
    let (selected, source) = if let Some(id) = query.connection_id {
        if !connection_allowed(pool, id, actor, query.workspace_id).await {
            return error(StatusCode::FORBIDDEN, "connection_not_allowed");
        }
        (Some(id), "explicit")
    } else {
        let personal = sqlx::query_scalar::<_, Uuid>(
            "SELECT connection_id FROM ai_default_policies WHERE scope='user' AND user_id=$1",
        )
        .bind(actor)
        .fetch_optional(pool)
        .await;
        let workspace = if let Some(workspace) = query.workspace_id {
            sqlx::query_scalar::<_, Uuid>("SELECT connection_id FROM ai_default_policies WHERE scope='workspace' AND workspace_id=$1")
                .bind(workspace)
                .fetch_optional(pool)
                .await
        } else {
            Ok(None)
        };
        let installation = sqlx::query_scalar::<_, Uuid>(
            "SELECT connection_id FROM ai_default_policies WHERE scope='installation'",
        )
        .fetch_optional(pool)
        .await;
        match (personal, workspace, installation) {
            (Ok(Some(id)), Ok(_), Ok(_)) => (Some(id), "personal_default"),
            (Ok(None), Ok(Some(id)), Ok(_)) => (Some(id), "workspace_default"),
            (Ok(None), Ok(None), Ok(installation)) => (installation, "installation_default"),
            _ => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    };
    let Some(id) = selected else {
        return Json(
            json!({"connection":null,"source":"none","message":"No AI connection is configured"}),
        )
        .into_response();
    };
    if !connection_allowed(pool, id, actor, query.workspace_id).await {
        return error(StatusCode::FORBIDDEN, "connection_not_allowed");
    }
    match load_connection(pool, id).await {
        Ok(Some(connection)) => {
            Json(json!({"connection":connection,"source":source,"run_notice":format!("{} · {} billing", connection["provider"].as_str().unwrap_or("provider"), connection["billing_mode"].as_str().unwrap_or("unknown"))})).into_response()
        }
        Ok(None) => error(StatusCode::NOT_FOUND, "connection_not_found"),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn connection_audit(
    State(state): State<AuthState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    if !connection_admin(&state.pool, id, actor).await {
        return StatusCode::FORBIDDEN.into_response();
    }
    match sqlx::query("SELECT event,actor_id,created_at::text AS created_at FROM security_audit_events WHERE subject_id=$1 AND event LIKE 'ai.connection.%' ORDER BY id")
        .bind(id)
        .fetch_all(&state.pool)
        .await
    {
        Ok(rows) => Json(json!({"events":rows.into_iter().map(|row| json!({"event":row.get::<String,_>("event"),"actor_id":row.get::<Option<Uuid>,_>("actor_id"),"created_at":row.get::<String,_>("created_at")})).collect::<Vec<Value>>()})).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

fn valid_scope(scope: &str, workspace: Option<Uuid>) -> Option<Option<Uuid>> {
    match (scope, workspace) {
        ("installation", None) | ("personal", None) => Some(None),
        ("workspace", Some(workspace)) => Some(Some(workspace)),
        _ => None,
    }
}

fn valid_provider(provider: &str) -> bool {
    matches!(provider, "codex" | "claude_code" | "scripted")
}

fn valid_auth_billing(auth: &str, billing: &str) -> bool {
    matches!(
        (auth, billing),
        ("api_key", "api") | ("provider_cli", "subscription") | ("organization", "organization")
    )
}

fn valid_capabilities(capabilities: &[String]) -> bool {
    capabilities.iter().all(|capability| {
        matches!(
            capability.as_str(),
            "generate" | "split" | "link" | "knowledge"
        )
    }) && capabilities
        .iter()
        .collect::<std::collections::HashSet<_>>()
        .len()
        == capabilities.len()
}

fn initial_state(input: &CreateConnection) -> String {
    if input.runner_reference.is_some() {
        "runner_offline".to_owned()
    } else if input.credential_secret.is_some()
        || input.credential_reference.is_some()
        || input.provider == "scripted"
    {
        "ready".to_owned()
    } else {
        "needs_login".to_owned()
    }
}

fn state_reason(state: &str) -> String {
    match state {
        "runner_offline" => "Runner has not connected".to_owned(),
        "ready" => "Connection is ready".to_owned(),
        "disabled" => "Connection is disabled".to_owned(),
        "unsupported_shared_mode" => "unsupported shared mode".to_owned(),
        _ => "Provider sign-in is required".to_owned(),
    }
}

pub(crate) fn credential_key() -> Result<[u8; 32], ()> {
    let value = std::env::var("WEFT_AI_CREDENTIAL_KEY").map_err(|_| ())?;
    let raw = value.as_bytes();
    if raw.len() == 64 {
        let mut key = [0u8; 32];
        for (index, byte) in key.iter_mut().enumerate() {
            let digit = |value: u8| match value {
                b'0'..=b'9' => Some(value - b'0'),
                b'a'..=b'f' => Some(value - b'a' + 10),
                b'A'..=b'F' => Some(value - b'A' + 10),
                _ => None,
            };
            *byte = (digit(raw[index * 2]).ok_or(())? << 4) | digit(raw[index * 2 + 1]).ok_or(())?;
        }
        Ok(key)
    } else if raw.len() == 32 {
        let mut key = [0u8; 32];
        key.copy_from_slice(raw);
        Ok(key)
    } else {
        Err(())
    }
}

fn encrypt_secret(connection: Uuid, secret: &str) -> Result<Vec<u8>, ()> {
    let key = UnboundKey::new(&aead::CHACHA20_POLY1305, &credential_key()?).map_err(|_| ())?;
    let key = LessSafeKey::new(key);
    let mut nonce_bytes = [0u8; 12];
    SystemRandom::new().fill(&mut nonce_bytes).map_err(|_| ())?;
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);
    let mut ciphertext = secret.as_bytes().to_vec();
    key.seal_in_place_append_tag(nonce, Aad::from(connection.as_bytes()), &mut ciphertext)
        .map_err(|_| ())?;
    let mut output = nonce_bytes.to_vec();
    output.extend_from_slice(&ciphertext);
    Ok(output)
}

async fn can_create(pool: &PgPool, scope: &str, workspace: Option<Uuid>, actor: Uuid) -> bool {
    match scope {
        "personal" => true,
        "workspace" => match workspace {
            Some(workspace) => workspace_admin(pool, workspace, actor).await,
            None => false,
        },
        "installation" => is_installation_admin(pool, actor).await,
        _ => false,
    }
}

async fn workspace_admin(pool: &PgPool, workspace: Uuid, actor: Uuid) -> bool {
    sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND role IN ('owner','admin'))")
        .bind(workspace)
        .bind(actor)
        .fetch_one(pool)
        .await
        .unwrap_or(false)
}

/// The installation admin is the owner of the first Workspace created on the installation (the
/// one `bootstrap-admin` creates). Owning or administering any later Workspace grants nothing at
/// installation level.
pub(crate) async fn is_installation_admin(pool: &PgPool, actor: Uuid) -> bool {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM workspace_memberships m WHERE m.user_id=$1 AND m.role='owner' AND m.workspace_id=(SELECT id FROM workspaces ORDER BY created_at,id LIMIT 1))",
    )
    .bind(actor)
    .fetch_one(pool)
    .await
    .unwrap_or(false)
}

pub(crate) async fn connection_admin(pool: &PgPool, id: Uuid, actor: Uuid) -> bool {
    match sqlx::query("SELECT scope,workspace_id,owner_id FROM ai_connections WHERE id=$1")
        .bind(id)
        .fetch_optional(pool)
        .await
    {
        Ok(Some(row)) => {
            let scope: String = row.get("scope");
            let workspace: Option<Uuid> = row.get("workspace_id");
            let owner: Option<Uuid> = row.get("owner_id");
            match scope.as_str() {
                "personal" => owner == Some(actor),
                "workspace" => match workspace {
                    Some(workspace) => workspace_admin(pool, workspace, actor).await,
                    None => false,
                },
                "installation" => is_installation_admin(pool, actor).await,
                _ => false,
            }
        }
        _ => false,
    }
}

async fn connection_active(pool: &PgPool, id: Uuid) -> bool {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM ai_connections WHERE id=$1 AND enabled AND revoked_at IS NULL)",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .unwrap_or(false)
}

async fn connection_allowed(pool: &PgPool, id: Uuid, actor: Uuid, workspace: Option<Uuid>) -> bool {
    sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM ai_connections c WHERE c.id=$1 AND (c.owner_id=$2 OR (c.scope='workspace' AND c.workspace_id=$3 AND EXISTS(SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=c.workspace_id AND m.user_id=$2) AND (EXISTS(SELECT 1 FROM ai_connection_grants g WHERE g.connection_id=c.id AND g.workspace_id=c.workspace_id) OR EXISTS(SELECT 1 FROM ai_connection_grants g WHERE g.connection_id=c.id AND g.user_id=$2))) OR EXISTS(SELECT 1 FROM ai_connection_grants g WHERE g.connection_id=c.id AND g.user_id=$2) OR (EXISTS(SELECT 1 FROM ai_connection_grants g WHERE g.connection_id=c.id AND g.workspace_id=$3) AND EXISTS(SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=$3 AND m.user_id=$2))))")
        .bind(id)
        .bind(actor)
        .bind(workspace)
        .fetch_one(pool)
        .await
        .unwrap_or(false)
}

async fn connection_matches_policy(
    pool: &PgPool,
    id: Uuid,
    scope: &str,
    workspace: Option<Uuid>,
    user: Option<Uuid>,
) -> bool {
    sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM ai_connections WHERE id=$1 AND revoked_at IS NULL AND enabled AND ((scope='installation' AND $2='installation') OR (scope='workspace' AND $2='workspace' AND workspace_id=$3) OR (scope='personal' AND $2='user' AND owner_id=$4)))")
        .bind(id)
        .bind(scope)
        .bind(workspace)
        .bind(user)
        .fetch_one(pool)
        .await
        .unwrap_or(false)
}

async fn connection_workspace(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar("SELECT workspace_id FROM ai_connections WHERE id=$1")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await
}

async fn insert_audit(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    actor: Uuid,
    workspace: Option<Uuid>,
    event: &str,
    subject: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO security_audit_events(actor_id,workspace_id,event,subject_id) VALUES($1,$2,$3,$4)")
        .bind(actor)
        .bind(workspace)
        .bind(event)
        .bind(subject)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn load_connection_row(
    pool: &PgPool,
    id: Uuid,
) -> Result<Option<sqlx::postgres::PgRow>, sqlx::Error> {
    sqlx::query("SELECT *,created_at::text AS created_at_text,updated_at::text AS updated_at_text FROM ai_connections WHERE id=$1")
        .bind(id)
        .fetch_optional(pool)
        .await
}

async fn load_connection(pool: &PgPool, id: Uuid) -> Result<Option<Value>, sqlx::Error> {
    let Some(row) = load_connection_row(pool, id).await? else {
        return Ok(None);
    };
    let has_credential: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM ai_connection_credentials WHERE connection_id=$1 AND revoked_at IS NULL AND octet_length(ciphertext)>0) OR EXISTS(SELECT 1 FROM ai_connections WHERE id=$1 AND credential_reference IS NOT NULL)")
        .bind(id)
        .fetch_one(pool)
        .await?;
    Ok(Some(json!({
        "id":row.get::<Uuid,_>("id"),
        "scope":row.get::<String,_>("scope"),
        "workspace_id":row.get::<Option<Uuid>,_>("workspace_id"),
        "owner_id":row.get::<Option<Uuid>,_>("owner_id"),
        "provider":row.get::<String,_>("provider"),
        "auth_mode":row.get::<String,_>("auth_mode"),
        "billing_mode":row.get::<String,_>("billing_mode"),
        "has_credential":has_credential,
        "runner_reference":row.get::<Option<String>,_>("runner_reference"),
        "model_default":row.get::<Option<String>,_>("model_default"),
        "capabilities":row.get::<Value,_>("capabilities"),
        "limits":row.get::<Value,_>("limits"),
        "state":row.get::<String,_>("state"),
        "state_reason":row.get::<String,_>("state_reason"),
        "enabled":row.get::<bool,_>("enabled"),
        "created_at":row.get::<String,_>("created_at_text"),
        "updated_at":row.get::<String,_>("updated_at_text")
    })))
}

async fn return_connection(pool: &PgPool, id: Uuid) -> Response {
    match load_connection(pool, id).await {
        Ok(Some(connection)) => Json(connection).into_response(),
        Ok(None) => error(StatusCode::NOT_FOUND, "connection_not_found"),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

fn error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({"error":code}))).into_response()
}
