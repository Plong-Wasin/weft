//! Outbound runner pairing and typed job lease protocol.
//!
//! Provider execution belongs to a runner process. The server only issues bounded JSON
//! jobs signed with an installation key and accepts results from the runner holding the
//! matching lease. Shell commands are not part of this protocol.
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use ring::{
    rand::{SecureRandom, SystemRandom},
    signature::{self, KeyPair},
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::auth::{require_session, AuthState};

const LEASE_SECONDS_DEFAULT: i64 = 60;
const LEASE_SECONDS_MAX: i64 = 300;
const RESULT_MAX_BYTES: usize = 256 * 1024;
const SUPPORTED_MODES: &[&str] = &["scripted"];
const RUN_ADMISSION_LOCK: i64 = 0x574546540028;

#[derive(Debug)]
pub enum AgentJobError {
    InvalidPayload,
    SigningKeyUnavailable,
    Storage,
}

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route(
            "/ai/connections/:connection_id/runners/pairing-codes",
            post(create_pairing_code),
        )
        .route("/ai/connections/:connection_id/runners", get(list_runners))
        .route("/ai/connections/:connection_id/runner-jobs", get(list_jobs))
        .route("/ai/runners/:runner_id/revoke", post(revoke_runner))
        .route("/ai/agent/pair", post(pair_runner))
        .route("/ai/agent/heartbeat", post(heartbeat))
        .route("/ai/agent/jobs/lease", post(lease_job))
        .route("/ai/agent/jobs/:job_id/status", get(job_status))
        .route("/ai/agent/jobs/:job_id/tools", post(job_tool))
        .route("/ai/agent/jobs/:job_id/result", post(report_result))
}

#[derive(Deserialize)]
struct PairCodeInput {
    expires_in_seconds: Option<i64>,
}
#[derive(Deserialize)]
struct PairInput {
    code: String,
    name: String,
    version: String,
    #[serde(default)]
    supported_modes: Vec<String>,
}
#[derive(Deserialize)]
struct HeartbeatInput {
    version: Option<String>,
}
#[derive(Deserialize)]
struct LeaseInput {
    lease_seconds: Option<i64>,
}
#[derive(Deserialize)]
struct ResultInput {
    result: Value,
    failed: Option<bool>,
}

async fn create_pairing_code(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Path(connection): Path<Uuid>,
    Json(input): Json<PairCodeInput>,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, true).await {
        Ok(x) => x,
        Err(s) => return s.into_response(),
    };
    let Some(_workspace) = authorized_connection(&state.pool, connection, actor).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if server_public_key().is_err() {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "runner_signing_key_unavailable",
        );
    }
    let expiry = input.expires_in_seconds.unwrap_or(300);
    if !(30..=900).contains(&expiry) {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_expiry");
    }
    let code = match random_secret() {
        Ok(x) => x,
        Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    };
    let id = Uuid::new_v4();
    if sqlx::query("INSERT INTO ai_runner_pairing_codes(id,connection_id,owner_id,code_hash,expires_at) VALUES($1,$2,$3,$4,now()+make_interval(secs=>$5))")
        .bind(id).bind(connection).bind(actor).bind(digest(&code)).bind(expiry as f64).execute(&state.pool).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    Json(json!({"id":id,"code":code,"expires_in_seconds":expiry})).into_response()
}

async fn list_runners(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Path(connection): Path<Uuid>,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, false).await {
        Ok(x) => x,
        Err(s) => return s.into_response(),
    };
    if authorized_connection(&state.pool, connection, actor)
        .await
        .is_none()
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    match sqlx::query("SELECT id,name,version,supported_modes,last_contact_at::text AS last_contact_at,revoked_at IS NOT NULL AS revoked FROM ai_runners WHERE connection_id=$1 ORDER BY created_at DESC")
        .bind(connection).fetch_all(&state.pool).await {
        Ok(rows) => Json(json!({"runners":rows.into_iter().map(|r| json!({"id":r.get::<Uuid,_>("id"),"name":r.get::<String,_>("name"),"version":r.get::<String,_>("version"),"supported_modes":r.get::<Vec<String>,_>("supported_modes"),"last_contact_at":r.get::<String,_>("last_contact_at"),"revoked":r.get::<bool,_>("revoked")})).collect::<Vec<_>>()})).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }
}

async fn list_jobs(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Path(connection): Path<Uuid>,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, false).await {
        Ok(x) => x,
        Err(s) => return s.into_response(),
    };
    if authorized_connection(&state.pool, connection, actor)
        .await
        .is_none()
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    match sqlx::query("SELECT id,provider_mode,status,visible_reason,lease_expires_at::text AS lease_expires_at,created_at::text AS created_at FROM ai_runner_jobs WHERE connection_id=$1 AND status IN ('queued','paused','leased') ORDER BY created_at")
        .bind(connection).fetch_all(&state.pool).await {
        Ok(rows) => Json(json!({"jobs":rows.into_iter().map(|r| json!({"id":r.get::<Uuid,_>("id"),"provider_mode":r.get::<String,_>("provider_mode"),"status":r.get::<String,_>("status"),"reason":r.get::<Option<String>,_>("visible_reason"),"lease_expires_at":r.get::<Option<String>,_>("lease_expires_at"),"created_at":r.get::<String,_>("created_at")})).collect::<Vec<_>>()})).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }
}

async fn revoke_runner(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Path(runner): Path<Uuid>,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, true).await {
        Ok(x) => x,
        Err(s) => return s.into_response(),
    };
    let connection: Option<Uuid> = sqlx::query_scalar(
        "SELECT connection_id FROM ai_runners WHERE id=$1 AND revoked_at IS NULL",
    )
    .bind(runner)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten();
    let Some(connection) = connection else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if authorized_connection(&state.pool, connection, actor)
        .await
        .is_none()
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    // Global lock order (see `ai_connections::lock_connection`): connection, schedule, runner,
    // run, job. The connection row is locked first and updated last.
    if !matches!(
        crate::ai_connections::lock_connection(&mut tx, connection).await,
        Ok(true)
    ) {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let runner_locked = sqlx::query(
        "SELECT id FROM ai_runners WHERE id=$1 AND revoked_at IS NULL FOR NO KEY UPDATE",
    )
    .bind(runner)
    .fetch_optional(&mut *tx)
    .await;
    match runner_locked {
        Ok(Some(_)) => {}
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    if sqlx::query("SELECT id FROM ai_runs WHERE id IN (SELECT run_id FROM ai_runner_jobs WHERE runner_id=$1 AND status='leased' AND run_id IS NOT NULL) ORDER BY id FOR NO KEY UPDATE").bind(runner).execute(&mut *tx).await.is_err()
        || sqlx::query("SELECT id FROM ai_runner_jobs WHERE runner_id=$1 AND status='leased' ORDER BY id FOR NO KEY UPDATE").bind(runner).execute(&mut *tx).await.is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if sqlx::query("WITH requeued AS (UPDATE ai_runs r SET state='queued',summary='Runner was revoked; run returned to queue',updated_at=now() FROM ai_runner_jobs j WHERE j.run_id=r.id AND j.runner_id=$1 AND j.status='leased' AND r.state='running' RETURNING r.id) INSERT INTO ai_run_events(run_id,kind,summary,details) SELECT id,'state','Runner was revoked; run returned to queue',jsonb_build_object('state','queued') FROM requeued").bind(runner).execute(&mut *tx).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if sqlx::query("UPDATE ai_runners SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL").bind(runner).execute(&mut *tx).await.is_err()
        || sqlx::query("UPDATE ai_runner_jobs SET status='queued',runner_id=NULL,lease_expires_at=NULL,visible_reason='Runner was revoked; job returned to queue',updated_at=now() WHERE runner_id=$1 AND status='leased'").bind(runner).execute(&mut *tx).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if sqlx::query("UPDATE ai_connections c SET runner_reference=(SELECT r.id::text FROM ai_runners r WHERE r.connection_id=c.id AND r.revoked_at IS NULL ORDER BY r.last_contact_at DESC LIMIT 1),state=CASE WHEN NOT c.enabled THEN 'disabled' WHEN EXISTS(SELECT 1 FROM ai_runners r WHERE r.connection_id=c.id AND r.revoked_at IS NULL AND r.last_contact_at>now()-interval '90 seconds') THEN 'ready' ELSE 'runner_offline' END,state_reason=CASE WHEN NOT c.enabled THEN 'Connection is disabled' WHEN EXISTS(SELECT 1 FROM ai_runners r WHERE r.connection_id=c.id AND r.revoked_at IS NULL AND r.last_contact_at>now()-interval '90 seconds') THEN 'Runner connected' ELSE 'Runner has not connected' END,updated_at=now() WHERE c.id=$1")
        .bind(connection).execute(&mut *tx).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    Json(json!({"id":runner,"revoked":true})).into_response()
}

async fn pair_runner(State(state): State<AuthState>, Json(input): Json<PairInput>) -> Response {
    if input.name.trim().is_empty()
        || input.name.len() > 120
        || input.version.trim().is_empty()
        || input.version.len() > 120
        || input.supported_modes.len() > 16
        || input.supported_modes.iter().any(|m| m.len() > 80)
    {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_runner");
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let code = sqlx::query("SELECT id,connection_id,owner_id FROM ai_runner_pairing_codes WHERE code_hash=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE")
        .bind(digest(input.code.trim())).fetch_optional(&mut *tx).await;
    let Ok(Some(code_row)) = code else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let code_id: Uuid = code_row.get("id");
    let connection: Uuid = code_row.get("connection_id");
    let owner: Uuid = code_row.get("owner_id");
    let token = match random_secret() {
        Ok(x) => x,
        Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    };
    let runner = Uuid::new_v4();
    let supported: Vec<String> = input
        .supported_modes
        .iter()
        .filter(|m| SUPPORTED_MODES.contains(&m.as_str()))
        .cloned()
        .collect();
    let unsupported: Vec<String> = input
        .supported_modes
        .iter()
        .filter(|m| !SUPPORTED_MODES.contains(&m.as_str()))
        .cloned()
        .collect();
    if sqlx::query("UPDATE ai_runner_pairing_codes SET used_at=now() WHERE id=$1").bind(code_id).execute(&mut *tx).await.is_err()
        || sqlx::query("INSERT INTO ai_runners(id,connection_id,owner_id,name,version,supported_modes,token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)")
            .bind(runner).bind(connection).bind(owner).bind(input.name.trim()).bind(input.version.trim()).bind(&supported).bind(digest(&token)).execute(&mut *tx).await.is_err()
        || sqlx::query("UPDATE ai_connections SET runner_reference=$2,state='runner_offline',state_reason='Runner paired; waiting for heartbeat',updated_at=now() WHERE id=$1 AND enabled AND revoked_at IS NULL").bind(connection).bind(runner.to_string()).execute(&mut *tx).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    Json(json!({"runner_id":runner,"token":token,"supported_modes":supported,"unsupported_modes":unsupported,"server_signing_key":server_public_key().unwrap_or_default()})).into_response()
}

async fn heartbeat(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Json(input): Json<HeartbeatInput>,
) -> Response {
    let Some(runner) = authenticate_runner(&state.pool, &headers).await else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if input
        .version
        .as_deref()
        .is_some_and(|v| v.trim().is_empty() || v.len() > 120)
    {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_version");
    }
    let updated = sqlx::query("UPDATE ai_runners SET last_contact_at=now(),version=COALESCE($2,version) WHERE id=$1 AND revoked_at IS NULL RETURNING connection_id")
        .bind(runner).bind(input.version.as_deref()).fetch_optional(&state.pool).await;
    let Ok(Some(row)) = updated else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let connection: Uuid = row.get("connection_id");
    let _ = sqlx::query("UPDATE ai_connections SET state='ready',state_reason='Runner connected',updated_at=now() WHERE id=$1 AND state='runner_offline' AND enabled AND revoked_at IS NULL").bind(connection).execute(&state.pool).await;
    Json(json!({"runner_id":runner,"status":"connected"})).into_response()
}

async fn lease_job(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Json(input): Json<LeaseInput>,
) -> Response {
    let Some(runner) = authenticate_runner(&state.pool, &headers).await else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let seconds = input.lease_seconds.unwrap_or(LEASE_SECONDS_DEFAULT);
    if !(1..=LEASE_SECONDS_MAX).contains(&seconds) {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_lease");
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let runner_row = sqlx::query("SELECT r.connection_id,r.supported_modes FROM ai_runners r JOIN ai_connections c ON c.id=r.connection_id WHERE r.id=$1 AND r.revoked_at IS NULL AND c.enabled AND c.revoked_at IS NULL FOR UPDATE OF r")
        .bind(runner).fetch_optional(&mut *tx).await;
    let Ok(Some(runner_row)) = runner_row else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let connection: Uuid = runner_row.get("connection_id");
    let modes: Vec<String> = runner_row.get("supported_modes");
    if sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(RUN_ADMISSION_LOCK)
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if sqlx::query("WITH expired AS (UPDATE ai_runs SET state='failed',summary='Run exceeded its time limit',updated_at=now() WHERE state IN ('queued','running','rate_limited') AND deadline_at<=now() RETURNING id,summary) INSERT INTO ai_run_events(run_id,kind,summary,details) SELECT id,'state',summary,jsonb_build_object('state','failed') FROM expired")
        .execute(&mut *tx).await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
    if sqlx::query("UPDATE ai_runner_jobs SET status='queued',runner_id=NULL,lease_expires_at=NULL,available_at=now(),visible_reason='Lease expired; returned to queue',updated_at=now() WHERE run_id IS NULL AND connection_id=$1 AND status='leased' AND lease_expires_at<=now()")
        .bind(connection).execute(&mut *tx).await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
    // Runner row (locked above), then run rows, then jobs (the global lock order).
    if sqlx::query("SELECT id FROM ai_runs WHERE id IN (SELECT run_id FROM ai_runner_jobs WHERE connection_id=$1 AND status='leased' AND lease_expires_at<=now()) ORDER BY id FOR UPDATE")
        .bind(connection).execute(&mut *tx).await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
    if sqlx::query("UPDATE ai_runner_jobs j SET status=CASE WHEN r.retry_count<COALESCE((r.run_limits->>'retry_budget')::int,2) THEN 'queued' ELSE 'failed' END,runner_id=NULL,lease_expires_at=NULL,available_at=now(),visible_reason='Lease expired; applying bounded retry',updated_at=now(),result=CASE WHEN r.retry_count<COALESCE((r.run_limits->>'retry_budget')::int,2) THEN j.result ELSE jsonb_build_object('outcome','failed','summary','Provider lease timed out') END FROM ai_runs r WHERE j.run_id=r.id AND j.connection_id=$1 AND j.status='leased' AND j.lease_expires_at<=now() AND r.deadline_at>now()")
        .bind(connection).execute(&mut *tx).await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
    if sqlx::query("WITH retried AS (UPDATE ai_runs r SET retry_count=r.retry_count+1,state=CASE WHEN r.retry_count<COALESCE((r.run_limits->>'retry_budget')::int,2) THEN 'queued' ELSE 'failed' END,summary=CASE WHEN r.retry_count<COALESCE((r.run_limits->>'retry_budget')::int,2) THEN 'Runner timed out; retrying within the run budget' ELSE 'Runner retry budget was exhausted' END,updated_at=now() FROM ai_runner_jobs j WHERE j.run_id=r.id AND j.connection_id=$1 AND j.status IN ('queued','failed') AND j.visible_reason='Lease expired; applying bounded retry' RETURNING r.id,r.state,r.summary,r.retry_count) INSERT INTO ai_run_events(run_id,kind,summary,details) SELECT id,'state',summary,jsonb_build_object('state',state,'retry_count',retry_count) FROM retried")
        .bind(connection).execute(&mut *tx).await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
    if sqlx::query("UPDATE ai_runner_jobs SET visible_reason=CASE WHEN status='failed' THEN 'Runner retry budget was exhausted' ELSE 'Runner timed out; retrying within the run budget' END WHERE connection_id=$1 AND visible_reason='Lease expired; applying bounded retry'")
        .bind(connection).execute(&mut *tx).await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
    if sqlx::query("UPDATE ai_runner_jobs SET visible_reason='No connected runner supports this restricted provider mode' WHERE connection_id=$1 AND status='queued' AND NOT (provider_mode=ANY($2))").bind(connection).bind(&modes).execute(&mut *tx).await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
    let job = sqlx::query("SELECT j.id,j.provider_mode,j.payload,j.signature,j.run_id FROM ai_runner_jobs j LEFT JOIN ai_runs r ON r.id=j.run_id WHERE j.connection_id=$1 AND j.status='queued' AND j.available_at<=now() AND j.provider_mode=ANY($2) AND (r.id IS NULL OR (r.state IN ('queued','rate_limited') AND r.deadline_at>now() AND (r.retry_at IS NULL OR r.retry_at<=now()) AND (SELECT count(*) FROM ai_runs active WHERE active.state='running')<COALESCE((r.run_limits->>'global_concurrency')::int,8) AND (SELECT count(*) FROM ai_runs active WHERE active.initiator_id=r.initiator_id AND active.state='running')<COALESCE((r.run_limits->>'per_user_concurrency')::int,2))) ORDER BY (SELECT count(*) FROM ai_runs active WHERE active.initiator_id=r.initiator_id AND active.state='running'),j.created_at,j.id LIMIT 1")
        .bind(connection).bind(&modes).fetch_optional(&mut *tx).await;
    let Ok(job) = job else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let Some(job) = job else {
        let _ = sqlx::query("UPDATE ai_runners SET last_contact_at=now() WHERE id=$1")
            .bind(runner)
            .execute(&mut *tx)
            .await;
        let _ = tx.commit().await;
        return Json(json!({"job":null,"reason":"No compatible queued job is available"}))
            .into_response();
    };
    let id: Uuid = job.get("id");
    // Lock order is runner row, run row, then its job row, the same as every run writer and both
    // emergency-stop helpers. A candidate that is locked by someone else or no longer queued
    // is skipped; the runner polls again.
    let candidate_run: Option<Uuid> = job.get("run_id");
    if let Some(run_id) = candidate_run {
        let locked = sqlx::query("SELECT id FROM ai_runs WHERE id=$1 AND state IN ('queued','rate_limited') FOR UPDATE SKIP LOCKED")
            .bind(run_id).fetch_optional(&mut *tx).await;
        if !matches!(locked, Ok(Some(_))) {
            let _ = tx.commit().await;
            return Json(json!({"job":null,"reason":"No compatible queued job is available"}))
                .into_response();
        }
    }
    let job = sqlx::query("SELECT j.id,j.provider_mode,j.payload,j.signature,j.run_id FROM ai_runner_jobs j WHERE j.id=$1 AND j.status='queued' FOR UPDATE SKIP LOCKED")
        .bind(id).fetch_optional(&mut *tx).await;
    let Ok(Some(job)) = job else {
        let _ = tx.commit().await;
        return Json(json!({"job":null,"reason":"No compatible queued job is available"}))
            .into_response();
    };
    let mode: String = job.get("provider_mode");
    let payload: Value = job.get("payload");
    let signature: String = job.get("signature");
    let run_id: Option<Uuid> = job.get("run_id");
    let valid_signature = verify_agent_job(id, connection, &mode, &payload, &signature);
    if !valid_signature {
        return error(StatusCode::SERVICE_UNAVAILABLE, "invalid_job_signature");
    }
    if sqlx::query("UPDATE ai_runner_jobs SET status='leased',runner_id=$2,lease_expires_at=now()+make_interval(secs=>$3),visible_reason=NULL,updated_at=now() WHERE id=$1")
        .bind(id).bind(runner).bind(seconds as f64).execute(&mut *tx).await.is_err()
        || (if let Some(run_id)=run_id { sqlx::query("UPDATE ai_runs SET state='running',retry_at=NULL,summary='Provider is running',updated_at=now() WHERE id=$1 AND state IN ('queued','rate_limited')").bind(run_id).execute(&mut *tx).await.is_err() } else { false })
        || (if let Some(run_id)=run_id { sqlx::query("INSERT INTO ai_run_events(run_id,kind,summary,details) VALUES($1,'state','Provider is running','{}')").bind(run_id).execute(&mut *tx).await.is_err() } else { false })
        || sqlx::query("UPDATE ai_runners SET last_contact_at=now() WHERE id=$1").bind(runner).execute(&mut *tx).await.is_err()
        || tx.commit().await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
    Json(json!({"job":{"id":id,"connection_id":connection,"provider_mode":mode,"payload":payload,"signature":signature,"lease_seconds":seconds,"server_signing_key":server_public_key().unwrap_or_default()}})).into_response()
}

async fn report_result(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Path(job): Path<Uuid>,
    Json(input): Json<ResultInput>,
) -> Response {
    let Some(runner) = authenticate_runner(&state.pool, &headers).await else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if let Some(run) = sqlx::query_scalar::<_, Uuid>(
        "SELECT run_id FROM ai_runner_jobs WHERE id=$1 AND runner_id=$2 AND status='leased'",
    )
    .bind(job)
    .bind(runner)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten()
    {
        crate::ai_runs::expire_run(&state.pool, run).await;
    }
    if !input.result.is_object()
        || serde_json::to_vec(&input.result).map_or(true, |bytes| bytes.len() > RESULT_MAX_BYTES)
    {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_result");
    }
    let status = if input.failed.unwrap_or(false) {
        "failed"
    } else {
        "completed"
    };
    let updated = sqlx::query("UPDATE ai_runner_jobs j SET result=$3,status=$4,lease_expires_at=NULL,visible_reason=NULL,updated_at=now() FROM ai_connections c WHERE j.id=$1 AND j.runner_id=$2 AND j.status='leased' AND j.lease_expires_at>now() AND c.id=j.connection_id AND c.enabled AND c.revoked_at IS NULL RETURNING j.id,j.run_id")
        .bind(job).bind(runner).bind(input.result.clone()).bind(status).fetch_optional(&state.pool).await;
    match updated {
        Ok(Some(row)) => {
            if let Some(run_id) = row.get::<Option<Uuid>, _>("run_id") {
                crate::ai_runs::accept_runner_result(
                    &state.pool,
                    run_id,
                    input.result,
                    input.failed.unwrap_or(false),
                )
                .await;
            }
            Json(json!({"job_id":job,"status":status})).into_response()
        }
        Ok(None) => StatusCode::CONFLICT.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn job_status(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Path(job): Path<Uuid>,
) -> Response {
    let Some(runner) = authenticate_runner(&state.pool, &headers).await else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if let Some(run) = sqlx::query_scalar::<_, Uuid>(
        "SELECT run_id FROM ai_runner_jobs WHERE id=$1 AND runner_id=$2 AND status='leased'",
    )
    .bind(job)
    .bind(runner)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten()
    {
        crate::ai_runs::expire_run(&state.pool, run).await;
    }
    match sqlx::query("SELECT j.status,j.visible_reason,r.state AS run_state FROM ai_runner_jobs j LEFT JOIN ai_runs r ON r.id=j.run_id WHERE j.id=$1 AND j.connection_id=(SELECT connection_id FROM ai_runners WHERE id=$2) AND (j.runner_id=$2 OR j.status IN ('queued','paused'))")
        .bind(job).bind(runner).fetch_optional(&state.pool).await {
        Ok(Some(row)) => Json(json!({"job_id":job,"status":row.get::<String,_>("status"),"run_state":row.get::<Option<String>,_>("run_state"),"reason":row.get::<Option<String>,_>("visible_reason")})).into_response(),
        Ok(None)=>StatusCode::NOT_FOUND.into_response(),
        Err(_)=>StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn job_tool(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Path(job): Path<Uuid>,
    Json(input): Json<crate::ai_runs::AgentToolInput>,
) -> Response {
    let Some(runner) = authenticate_runner(&state.pool, &headers).await else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    match crate::ai_runs::call_runner_tool(&state.pool, job, runner, input.call).await {
        Ok(value) => Json(value).into_response(),
        Err(status) => status.into_response(),
    }
}

/// Sign a server-created typed job. Run engines may enqueue only structured JSON; no shell
/// command string is part of the job schema.
pub fn sign_agent_job(
    job: Uuid,
    connection: Uuid,
    mode: &str,
    payload: &Value,
) -> Result<String, AgentJobError> {
    if mode.is_empty()
        || mode.len() > 80
        || payload["type"] != "provider_job"
        || payload["schema_version"] != 1
        || !payload["arguments"]
            .as_array()
            .is_some_and(|args| args.len() <= 128 && args.iter().all(Value::is_string))
        || payload.get("command").is_some()
        || payload.get("shell").is_some()
    {
        return Err(AgentJobError::InvalidPayload);
    }
    let key = signing_key()?;
    let body = signature_body(job, connection, mode, payload);
    Ok(hex(key.sign(&body).as_ref()))
}

/// Queue a validated, server-created provider job for an active connection. Unsupported
/// modes remain queued with a visible reason until a compatible runner is paired.
pub async fn enqueue_agent_job(
    pool: &PgPool,
    connection: Uuid,
    mode: &str,
    payload: Value,
) -> Result<Uuid, AgentJobError> {
    if mode.is_empty()
        || mode.len() > 80
        || payload["type"] != "provider_job"
        || payload["schema_version"] != 1
        || !payload["arguments"]
            .as_array()
            .is_some_and(|args| args.len() <= 128 && args.iter().all(Value::is_string))
        || payload.get("command").is_some()
        || payload.get("shell").is_some()
    {
        return Err(AgentJobError::InvalidPayload);
    }
    let id = Uuid::new_v4();
    let signature = sign_agent_job(id, connection, mode, &payload)?;
    let reason = if SUPPORTED_MODES.contains(&mode) {
        "No connected runner is available"
    } else {
        "No runner supports this restricted provider mode"
    };
    let inserted = sqlx::query("INSERT INTO ai_runner_jobs(id,connection_id,provider_mode,payload,signature,status,visible_reason) SELECT $1,$2,$3,$4,$5,'queued',$6 WHERE EXISTS(SELECT 1 FROM ai_connections WHERE id=$2 AND enabled AND revoked_at IS NULL)")
        .bind(id).bind(connection).bind(mode).bind(payload).bind(signature).bind(reason).execute(pool).await.map_err(|_| AgentJobError::Storage)?;
    if inserted.rows_affected() != 1 {
        return Err(AgentJobError::Storage);
    }
    Ok(id)
}

fn verify_agent_job(
    job: Uuid,
    connection: Uuid,
    mode: &str,
    payload: &Value,
    signature: &str,
) -> bool {
    let Ok(key) = server_public_key_bytes() else {
        return false;
    };
    let Ok(bytes) = decode_hex(signature) else {
        return false;
    };
    signature::UnparsedPublicKey::new(&signature::ED25519, key)
        .verify(&signature_body(job, connection, mode, payload), &bytes)
        .is_ok()
}

fn signature_body(job: Uuid, connection: Uuid, mode: &str, payload: &Value) -> Vec<u8> {
    format!("weft-agent-job-v1\n{job}\n{connection}\n{mode}\n{payload}").into_bytes()
}

fn signing_key() -> Result<signature::Ed25519KeyPair, AgentJobError> {
    let value = std::env::var("WEFT_AGENT_SIGNING_KEY")
        .map_err(|_| AgentJobError::SigningKeyUnavailable)?;
    if value.len() < 32 {
        return Err(AgentJobError::SigningKeyUnavailable);
    }
    signature::Ed25519KeyPair::from_seed_unchecked(&value.as_bytes()[..32])
        .map_err(|_| AgentJobError::SigningKeyUnavailable)
}

fn server_public_key_bytes() -> Result<Vec<u8>, AgentJobError> {
    Ok(signing_key()?.public_key().as_ref().to_vec())
}
fn server_public_key() -> Result<String, AgentJobError> {
    Ok(hex(&server_public_key_bytes()?))
}

async fn authenticate_runner(pool: &PgPool, headers: &HeaderMap) -> Option<Uuid> {
    let value = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    let token = value.strip_prefix("Bearer ")?;
    sqlx::query_scalar("SELECT id FROM ai_runners WHERE token_hash=$1 AND revoked_at IS NULL")
        .bind(digest(token))
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

async fn authorized_connection(
    pool: &PgPool,
    connection: Uuid,
    actor: Uuid,
) -> Option<Option<Uuid>> {
    let row = sqlx::query(
        "SELECT workspace_id FROM ai_connections WHERE id=$1 AND enabled AND revoked_at IS NULL",
    )
    .bind(connection)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()?;
    if crate::ai_connections::connection_admin(pool, connection, actor).await {
        Some(row.get("workspace_id"))
    } else {
        None
    }
}

fn random_secret() -> Result<String, ()> {
    let mut bytes = [0u8; 32];
    SystemRandom::new().fill(&mut bytes).map_err(|_| ())?;
    Ok(hex(&bytes))
}
fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn decode_hex(value: &str) -> Result<Vec<u8>, AgentJobError> {
    if !value.len().is_multiple_of(2) {
        return Err(AgentJobError::InvalidPayload);
    }
    value
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|chunk| {
            let hi = (chunk[0] as char)
                .to_digit(16)
                .ok_or(AgentJobError::InvalidPayload)?;
            let lo = (chunk[1] as char)
                .to_digit(16)
                .ok_or(AgentJobError::InvalidPayload)?;
            Ok(((hi << 4) | lo) as u8)
        })
        .collect()
}
fn error(status: StatusCode, name: &'static str) -> Response {
    (status, Json(json!({"error":name}))).into_response()
}
