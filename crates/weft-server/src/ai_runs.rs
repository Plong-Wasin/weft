//! Persistent lifecycle for AI runs. Provider work is always delegated to the typed runner
//! bridge; HTTP handlers only validate, enqueue, inspect, and cancel bounded jobs.

use std::collections::HashSet;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{
    ai_runner::{enqueue_agent_job, AgentJobError},
    ai_tools::{AiReadTools, ReadToolCall, RunToolState, TrustedRunContext},
    auth::{require_session, AuthState},
    projects::{self, Role},
};

const MAX_SCOPE_ITEMS: usize = 50;
const MAX_PROMPT_BYTES: usize = 16_000;
const QUEUE_LIMIT_DEFAULT: i64 = 100;
const GLOBAL_CONCURRENCY_DEFAULT: i64 = 8;
const USER_CONCURRENCY_DEFAULT: i64 = 2;
const MAX_TIMEOUT_SECONDS: i64 = 3_600;
const ADVISORY_LOCK: i64 = 0x574546540029;

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route("/ai/usage", get(workspace_usage))
        .route("/ai/runs/preview", post(preview_run))
        .route("/ai/runs", post(create_run))
        .route("/ai/runs/:run_id", get(get_run))
        .route("/ai/runs/:run_id/events", get(list_events))
        .route("/ai/runs/:run_id/cancel", post(cancel_run))
        .route("/ai/runs/:run_id/tools", post(call_tool))
}

#[derive(Deserialize)]
struct UsageQuery {
    workspace_id: Uuid,
}

async fn workspace_usage(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Query(query): Query<UsageQuery>,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let permitted = sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND role IN ('owner','admin'))")
        .bind(query.workspace_id)
        .bind(actor)
        .fetch_one(&state.pool)
        .await;
    if !matches!(permitted, Ok(true)) {
        return StatusCode::NOT_FOUND.into_response();
    }

    let policy_rows = sqlx::query("SELECT DISTINCT c.id,c.provider,c.billing_mode,c.limits FROM ai_connections c WHERE c.workspace_id=$1 OR EXISTS(SELECT 1 FROM ai_connection_grants g WHERE g.connection_id=c.id AND g.workspace_id=$1)")
        .bind(query.workspace_id)
        .fetch_all(&state.pool)
        .await;
    let Ok(policy_rows) = policy_rows else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let policies: Vec<Value> = policy_rows
        .into_iter()
        .map(|row| {
            let limits: Value = row.get("limits");
            json!({
                "connection_id":row.get::<Uuid,_>("id"),
                "provider":row.get::<String,_>("provider"),
                "billing_mode":row.get::<String,_>("billing_mode"),
                "global_concurrency":bounded_limit(&limits,"global_concurrency",GLOBAL_CONCURRENCY_DEFAULT,1,128),
                "per_user_concurrency":bounded_limit(&limits,"per_user_concurrency",USER_CONCURRENCY_DEFAULT,1,32),
                "daily_run_budget":bounded_limit(&limits,"daily_run_budget",100,1,10_000),
                "daily_token_budget":bounded_limit(&limits,"daily_token_budget",0,0,100_000_000)
            })
        })
        .collect();
    let rows = sqlx::query("SELECT r.initiator_id,u.email,r.state,r.usage FROM ai_runs r JOIN users u ON u.id=r.initiator_id WHERE r.workspace_id=$1 AND r.created_at>=now()-interval '30 days'")
        .bind(query.workspace_id)
        .fetch_all(&state.pool)
        .await;
    let Ok(rows) = rows else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let mut users: std::collections::BTreeMap<Uuid, (String, i64, i64, UsageTotals)> =
        std::collections::BTreeMap::new();
    for row in rows {
        let user_id: Uuid = row.get("initiator_id");
        let email: String = row.get("email");
        let state: String = row.get("state");
        let usage: Option<Value> = row.get("usage");
        let entry = users
            .entry(user_id)
            .or_insert_with(|| (email, 0, 0, UsageTotals::default()));
        entry.1 += 1;
        if matches!(state.as_str(), "failed" | "needs_login" | "rate_limited") {
            entry.2 += 1;
        }
        if let Some(usage) = usage {
            entry.3.add(&usage);
        }
    }
    let mut totals = UsageTotals::default();
    for (_, _, _, usage) in users.values() {
        totals.merge(usage);
    }
    let user_rows: Vec<Value> = users
        .into_iter()
        .map(|(user_id, (email, runs, limited_runs, usage))| {
            json!({"user_id":user_id,"email":email,"runs":runs,"limited_runs":limited_runs,"usage":usage.json()})
        })
        .collect();
    let mut totals_json = totals.json();
    totals_json["runs"] = json!(user_rows
        .iter()
        .map(|r| r["runs"].as_i64().unwrap_or(0))
        .sum::<i64>());
    totals_json["limited_runs"] = json!(user_rows
        .iter()
        .map(|r| r["limited_runs"].as_i64().unwrap_or(0))
        .sum::<i64>());
    Json(json!({
        "workspace_id":query.workspace_id,
        "period_days":30,
        "policies":policies,
        "totals":totals_json,
        "users":user_rows
    }))
    .into_response()
}

#[derive(Default)]
struct UsageTotals {
    input_tokens: i64,
    output_tokens: i64,
    total_tokens: i64,
    cost_usd: f64,
    reports: i64,
}

impl UsageTotals {
    fn add(&mut self, value: &Value) {
        let mut reported = false;
        for (key, slot) in [
            ("input_tokens", &mut self.input_tokens),
            ("output_tokens", &mut self.output_tokens),
            ("total_tokens", &mut self.total_tokens),
        ] {
            if let Some(number) = value.get(key).and_then(Value::as_i64).filter(|n| *n >= 0) {
                *slot = slot.saturating_add(number);
                reported = true;
            }
        }
        if let Some(cost) = value
            .get("cost_usd")
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite() && *n >= 0.0)
        {
            self.cost_usd = (self.cost_usd + cost).min(1_000_000_000_000_000.0);
            reported = true;
        }
        if reported {
            self.reports += 1;
        }
    }

    fn merge(&mut self, other: &Self) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.total_tokens = self.total_tokens.saturating_add(other.total_tokens);
        self.cost_usd = (self.cost_usd + other.cost_usd).min(1_000_000_000_000_000.0);
        self.reports = self.reports.saturating_add(other.reports);
    }

    fn json(&self) -> Value {
        json!({"input_tokens":self.input_tokens,"output_tokens":self.output_tokens,"total_tokens":self.total_tokens,"cost_usd":self.cost_usd,"reports":self.reports,"unknown":self.reports==0})
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct RunScope {
    #[serde(default)]
    projects: Vec<Uuid>,
    #[serde(default)]
    tasks: Vec<Uuid>,
    #[serde(default)]
    vaults: Vec<Uuid>,
}

#[derive(Deserialize)]
struct PreviewInput {
    workspace_id: Uuid,
    connection_id: Uuid,
    #[serde(default)]
    scope: RunScope,
}

#[derive(Deserialize)]
struct CreateInput {
    workspace_id: Uuid,
    connection_id: Uuid,
    #[serde(default)]
    capability: Option<String>,
    #[serde(default)]
    scope: RunScope,
    prompt: String,
}

#[derive(Deserialize)]
pub(crate) struct ToolInput {
    pub(crate) call: ReadToolCall,
}

#[derive(Deserialize)]
pub(crate) struct AgentToolInput {
    pub(crate) call: Value,
}

async fn preview_run(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Json(input): Json<PreviewInput>,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    match preview(
        &state.pool,
        actor,
        input.workspace_id,
        input.connection_id,
        &input.scope,
    )
    .await
    {
        Ok(value) => Json(value).into_response(),
        Err(status) => status.into_response(),
    }
}

async fn preview(
    pool: &PgPool,
    actor: Uuid,
    workspace: Uuid,
    connection: Uuid,
    scope: &RunScope,
) -> Result<Value, StatusCode> {
    validate_scope_shape(scope)?;
    if !is_workspace_member(pool, workspace, actor).await? {
        return Err(StatusCode::NOT_FOUND);
    }
    let connection_row = connection_for_run(pool, connection, workspace, actor).await?;
    let mut sources = Vec::new();
    let projects = readable_scope_projects(pool, workspace, actor, scope).await?;
    for project in &projects {
        let row = sqlx::query("SELECT id,name FROM projects WHERE id=$1 AND workspace_id=$2")
            .bind(project)
            .bind(workspace)
            .fetch_one(pool)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        sources.push(json!({"kind":"project","id":project,"label":row.get::<String,_>("name")}));
    }
    let mut visible_task_ids: HashSet<Uuid> = scope.tasks.iter().copied().collect();
    for task in &scope.tasks {
        let row = sqlx::query("SELECT id,number,title,project_id FROM tasks WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL")
            .bind(task).bind(workspace).fetch_optional(pool).await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let Some(row) = row else {
            return Err(StatusCode::FORBIDDEN);
        };
        let project: Uuid = row.get("project_id");
        if !projects.contains(&project) {
            return Err(StatusCode::FORBIDDEN);
        }
        sources.push(json!({"kind":"task","id":task,"label":format!("#{} {}",row.get::<i64,_>("number"),row.get::<String,_>("title"))}));
        let comment_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM task_comments WHERE task_id=$1 AND deleted_at IS NULL",
        )
        .bind(task)
        .fetch_one(pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        sources.push(json!({"kind":"task_chat","id":task,"task_id":task,"label":format!("Chat for #{} {} ({} comments)",row.get::<i64,_>("number"),row.get::<String,_>("title"),comment_count)}));
        let related_rows = sqlx::query("SELECT t.id,t.number,t.title,t.project_id FROM task_relations r JOIN tasks t ON t.id=CASE WHEN r.source_task_id=$1 THEN r.target_task_id ELSE r.source_task_id END WHERE (r.source_task_id=$1 OR r.target_task_id=$1) AND r.kind='related' AND t.workspace_id=$2 AND t.archived_at IS NULL ORDER BY t.number")
            .bind(task).bind(workspace).fetch_all(pool).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        for related in related_rows {
            let related_id: Uuid = related.get("id");
            let related_project: Uuid = related.get("project_id");
            if visible_task_ids.insert(related_id)
                && projects.contains(&related_project)
                && matches!(projects::evaluate_access(pool, related_project, actor).await, Ok(Some(access)) if access.workspace_id == workspace && access.role >= Role::Viewer)
            {
                sources.push(json!({"kind":"related_task","id":related_id,"label":format!("#{} {}",related.get::<i64,_>("number"),related.get::<String,_>("title"))}));
            }
        }
    }
    for vault in &scope.vaults {
        let readable = matches!(
            crate::vaults::evaluate_access(pool, *vault, actor).await,
            Ok(Some(access)) if access.workspace_id == workspace && access.role >= Role::Viewer
        );
        if !readable {
            return Err(StatusCode::FORBIDDEN);
        }
        let name = sqlx::query_scalar::<_, String>("SELECT name FROM vaults WHERE id=$1")
            .bind(vault)
            .fetch_one(pool)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        sources.push(json!({"kind":"vault","id":vault,"label":name}));
    }
    Ok(json!({
        "workspace_id":workspace,
        "connection_id":connection,
        "provider":connection_row.get::<String,_>("provider"),
        "model":connection_row.get::<Option<String>,_>("model_default"),
        "billing_mode":connection_row.get::<String,_>("billing_mode"),
        "state":"ready",
        "state_reason":connection_row.get::<String,_>("state_reason"),
        "scope":{"projects":scope.projects,"tasks":scope.tasks,"vaults":scope.vaults},
        "sources":sources
    }))
}

async fn create_run(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Json(input): Json<CreateInput>,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, true).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let mut input = input;
    let capability = input.capability.as_deref().unwrap_or("generate");
    if !matches!(
        capability,
        "generate"
            | "split"
            | "link"
            | "knowledge"
            | "summarize"
            | "review"
            | "plan"
            | "progress_review"
    ) || input.prompt.trim().is_empty()
        || input.prompt.len() > MAX_PROMPT_BYTES
    {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_run");
    }
    let mut fallback_from: Option<Uuid> = None;
    if connection_for_run(&state.pool, input.connection_id, input.workspace_id, actor)
        .await
        .is_err()
    {
        // Fallback happens only when an admin pre-approved it on the chosen connection.
        let fallback: Option<Uuid> = sqlx::query_scalar("SELECT fallback_connection_id FROM ai_connections c WHERE id=$1 AND fallback_connection_id IS NOT NULL AND (owner_id=$2 OR EXISTS(SELECT 1 FROM ai_connection_grants g WHERE g.connection_id=c.id AND (g.user_id=$2 OR g.workspace_id=$3)))")
            .bind(input.connection_id)
            .bind(actor)
            .bind(input.workspace_id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten();
        if let Some(fallback) = fallback {
            if connection_for_run(&state.pool, fallback, input.workspace_id, actor)
                .await
                .is_ok()
            {
                fallback_from = Some(input.connection_id);
                input.connection_id = fallback;
            }
        }
    }
    let preview = match preview(
        &state.pool,
        actor,
        input.workspace_id,
        input.connection_id,
        &input.scope,
    )
    .await
    {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let limits: Value = match sqlx::query_scalar("SELECT limits FROM ai_connections WHERE id=$1")
        .bind(input.connection_id)
        .fetch_one(&state.pool)
        .await
    {
        Ok(value) => value,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let timeout = bounded_limit(&limits, "timeout_seconds", 120, 1, MAX_TIMEOUT_SECONDS);
    let global_limit = bounded_limit(
        &limits,
        "global_concurrency",
        GLOBAL_CONCURRENCY_DEFAULT,
        1,
        128,
    );
    let user_limit = bounded_limit(
        &limits,
        "per_user_concurrency",
        USER_CONCURRENCY_DEFAULT,
        1,
        32,
    );
    let queue_limit = bounded_limit(&limits, "queue_size", QUEUE_LIMIT_DEFAULT, 1, 10_000);
    let daily_run_budget = bounded_limit(&limits, "daily_run_budget", 100, 1, 10_000);
    let daily_token_budget = bounded_limit(&limits, "daily_token_budget", 0, 0, 100_000_000);
    let retry_budget = bounded_limit(&limits, "retry_budget", 2, 0, 5);
    let context_limit = bounded_limit(&limits, "context_characters", 200_000, 1_000, 2_000_000);
    let prompt_characters = input.prompt.chars().count();
    if prompt_characters as i64 > context_limit {
        return error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "run_context_budget_exceeded",
        );
    }
    let id = Uuid::new_v4();
    let session_key = format!("{actor}:{}:{id}", input.workspace_id);
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(ADVISORY_LOCK)
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let queued: i64 =
        sqlx::query_scalar("SELECT count(*) FROM ai_runs WHERE state IN ('queued','rate_limited')")
            .fetch_one(&mut *tx)
            .await
            .unwrap_or(queue_limit);
    if queued >= queue_limit {
        return error(StatusCode::TOO_MANY_REQUESTS, "run_queue_full");
    }
    let daily_runs: i64 = match sqlx::query_scalar("SELECT count(*) FROM ai_runs WHERE initiator_id=$1 AND connection_id=$2 AND created_at>=now()-interval '24 hours'")
        .bind(actor)
        .bind(input.connection_id)
        .fetch_one(&mut *tx)
        .await
    {
        Ok(count) => count,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if daily_runs >= daily_run_budget {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({"error":"user_daily_run_budget_exceeded","state":"rate_limited","summary":"Your daily AI run budget for this connection is exhausted"})),
        )
            .into_response();
    }
    if daily_token_budget > 0 {
        let usage_rows = match sqlx::query_scalar::<_, Option<Value>>("SELECT usage FROM ai_runs WHERE initiator_id=$1 AND connection_id=$2 AND created_at>=now()-interval '24 hours'")
            .bind(actor)
            .bind(input.connection_id)
            .fetch_all(&mut *tx)
            .await
        {
            Ok(rows) => rows,
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        };
        let used_tokens =
            usage_rows
                .iter()
                .filter_map(Option::as_ref)
                .fold(0i64, |total, usage| {
                    let total_tokens = usage
                        .get("total_tokens")
                        .and_then(Value::as_i64)
                        .filter(|n| *n >= 0);
                    let tokens = total_tokens.unwrap_or_else(|| {
                        usage
                            .get("input_tokens")
                            .and_then(Value::as_i64)
                            .unwrap_or(0)
                            .max(0)
                            .saturating_add(
                                usage
                                    .get("output_tokens")
                                    .and_then(Value::as_i64)
                                    .unwrap_or(0)
                                    .max(0),
                            )
                    });
                    total.saturating_add(tokens)
                });
        if used_tokens >= daily_token_budget {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({"error":"user_daily_token_budget_exceeded","state":"rate_limited","summary":"Your daily AI usage budget for this connection is exhausted"})),
            )
                .into_response();
        }
    }
    let active_global: i64 =
        match sqlx::query_scalar("SELECT count(*) FROM ai_runs WHERE state='running'")
            .fetch_one(&mut *tx)
            .await
        {
            Ok(count) => count,
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        };
    let active_user: i64 = match sqlx::query_scalar(
        "SELECT count(*) FROM ai_runs WHERE initiator_id=$1 AND state='running'",
    )
    .bind(actor)
    .fetch_one(&mut *tx)
    .await
    {
        Ok(count) => count,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let queue_reason = if active_user >= user_limit {
        Some("Queued: your concurrent AI run limit is reached")
    } else if active_global >= global_limit {
        Some("Queued: the shared AI connection is at its concurrency limit")
    } else {
        None
    };
    let queue_summary = match (fallback_from, queue_reason) {
        (Some(_), _) => "Fallback connection in use: the chosen connection is unavailable",
        (None, Some(reason)) => reason,
        (None, None) => "Waiting for an available runner",
    };
    let scope = serde_json::to_value(&input.scope).unwrap_or_else(|_| json!({}));
    let run_limits = json!({"timeout_seconds":timeout,"global_concurrency":global_limit,"per_user_concurrency":user_limit,"daily_run_budget":daily_run_budget,"daily_token_budget":daily_token_budget,"queue_size":queue_limit,"retry_budget":retry_budget,"context_characters":context_limit,"tool_calls":bounded_limit(&limits,"tool_calls",40,1,500)});
    if sqlx::query("INSERT INTO ai_runs(id,initiator_id,workspace_id,connection_id,capability,scope,run_limits,prompt,session_key,state,summary,deadline_at,context_characters,fallback_from) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10,now()+make_interval(secs=>$11),$12,$13)")
        .bind(id).bind(actor).bind(input.workspace_id).bind(input.connection_id).bind(capability).bind(scope).bind(run_limits).bind(input.prompt.trim()).bind(&session_key).bind(queue_summary).bind(timeout as f64).bind(prompt_characters as i32).bind(fallback_from).execute(&mut *tx).await.is_err()
        || insert_event(&mut tx, id, "state", queue_summary, json!({"provider":preview["provider"],"capability":capability,"queue_reason":queue_reason,"fallback_from":fallback_from})).await.is_err()
        || tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let payload = json!({
        "type":"provider_job","schema_version":1,
        "arguments":[input.prompt.trim()],
        "run_id":id,"initiator_id":actor,"workspace_id":input.workspace_id,
        "capability":capability,"scope":input.scope,
        "context_character_limit":context_limit,"retry_budget":retry_budget,
        "session_key":session_key
    });
    let provider = preview["provider"].as_str().unwrap_or("unknown");
    let billing = preview["billing_mode"].as_str().unwrap_or("unknown");
    let provider_mode = if provider == "scripted" {
        "scripted".to_owned()
    } else {
        format!("{provider}_{billing}")
    };
    match enqueue_agent_job(&state.pool, input.connection_id, &provider_mode, payload).await {
        Ok(job) => {
            if sqlx::query("UPDATE ai_runner_jobs SET run_id=$2,visible_reason=COALESCE($3,visible_reason) WHERE id=$1")
                .bind(job)
                .bind(id)
                .bind(queue_reason)
                .execute(&state.pool)
                .await
                .is_err()
            {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
            (StatusCode::ACCEPTED, Json(json!({"id":id,"state":"queued","summary":queue_summary,"provider":preview["provider"],"job_id":job,"connection_id":input.connection_id,"fallback_from":fallback_from}))).into_response()
        }
        Err(AgentJobError::SigningKeyUnavailable) => {
            fail_run(&state.pool, id, "Runner signing is unavailable").await;
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "runner_signing_key_unavailable",
            )
        }
        Err(_) => {
            fail_run(&state.pool, id, "Could not queue provider job").await;
            StatusCode::SERVICE_UNAVAILABLE.into_response()
        }
    }
}

async fn get_run(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Path(run): Path<Uuid>,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    expire_run(&state.pool, run).await;
    match visible_run(&state.pool, run, actor).await {
        Ok(Some(row)) => Json(run_json(&row)).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

pub(crate) async fn call_runner_tool(
    pool: &PgPool,
    job: Uuid,
    runner: Uuid,
    call: Value,
) -> Result<Value, StatusCode> {
    let run: Option<Uuid> = sqlx::query_scalar("SELECT j.run_id FROM ai_runner_jobs j JOIN ai_runs r ON r.id=j.run_id JOIN ai_connections c ON c.id=j.connection_id WHERE j.id=$1 AND j.runner_id=$2 AND j.status='leased' AND j.lease_expires_at>now() AND c.enabled AND c.revoked_at IS NULL AND r.state='running' AND r.deadline_at>now()")
        .bind(job).bind(runner).fetch_optional(pool).await.map_err(|_|StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(run) = run else {
        return Err(StatusCode::NOT_FOUND);
    };
    let tool_name = call
        .get("tool")
        .and_then(Value::as_str)
        .ok_or(StatusCode::UNPROCESSABLE_ENTITY)?;
    if matches!(
        tool_name,
        "propose_tasks"
            | "propose_split"
            | "propose_links"
            | "propose_plan"
            | "propose_note_edit"
            | "propose_file_add"
            | "validate_proposal"
    ) {
        return call_proposal_tool(pool, run, tool_name, &call).await;
    }
    let read_call: ReadToolCall =
        serde_json::from_value(call).map_err(|_| StatusCode::UNPROCESSABLE_ENTITY)?;
    let tools = AiReadTools::new(pool.clone(), RunState { pool: pool.clone() });
    match tools.call(run, read_call).await {
        Ok(reply) => Ok(serde_json::to_value(reply).unwrap_or_else(|_| json!({}))),
        Err(crate::ai_tools::ToolError::BudgetExceeded) => {
            fail_run(pool, run, "Run exceeded its context or tool budget").await;
            Err(StatusCode::UNPROCESSABLE_ENTITY)
        }
        Err(crate::ai_tools::ToolError::Unavailable) => Err(StatusCode::SERVICE_UNAVAILABLE),
    }
}

pub(crate) async fn call_proposal_tool(
    pool: &PgPool,
    run: Uuid,
    name: &str,
    call: &Value,
) -> Result<Value, StatusCode> {
    let capability: String =
        sqlx::query_scalar("SELECT capability FROM ai_runs WHERE id=$1 AND state='running'")
            .bind(run)
            .fetch_optional(pool)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .ok_or(StatusCode::NOT_FOUND)?;
    let expected_capability = match name {
        "propose_tasks" => "generate",
        "propose_split" => "split",
        "propose_links" => "link",
        "propose_plan" => "plan",
        "propose_note_edit" | "propose_file_add" => "knowledge",
        "validate_proposal" => {
            return validate_ai_proposal_tool(pool, run, &call["proposal"]).await
        }
        _ => return Err(StatusCode::UNPROCESSABLE_ENTITY),
    };
    // A quality review proposes follow-up subtasks and links, never loose Tasks or notes.
    let review_may_call = capability == "review"
        && matches!(name, "propose_split" | "propose_links")
        || capability == "progress_review"
            && matches!(name, "propose_plan" | "propose_split" | "propose_links");
    if capability != expected_capability && !review_may_call {
        return Err(StatusCode::FORBIDDEN);
    }
    let mut items = call["items"]
        .as_array()
        .cloned()
        .ok_or(StatusCode::UNPROCESSABLE_ENTITY)?;
    if items.is_empty() || items.len() > 100 {
        return Err(StatusCode::UNPROCESSABLE_ENTITY);
    }
    if name == "propose_note_edit" {
        for item in &mut items {
            item["kind"] = json!("note_edit");
        }
    }
    if name == "propose_file_add" {
        for item in &mut items {
            item["kind"] = json!("file_add");
        }
    }
    if name == "propose_tasks" && items.iter().any(|item| item["kind"] != "task")
        || name == "propose_split"
            && items
                .iter()
                .any(|item| !["task", "relation"].contains(&item["kind"].as_str().unwrap_or("")))
        || name == "propose_links" && items.iter().any(|item| item["kind"] != "relation")
        || name == "propose_plan"
            && items.iter().any(|item| {
                !["task", "relation"].contains(&item["kind"].as_str().unwrap_or(""))
                    && !crate::proposal_milestones::is_kind(item["kind"].as_str().unwrap_or(""))
            })
        || name == "propose_note_edit" && items.iter().any(|item| item["kind"] != "note_edit")
        || name == "propose_file_add" && items.iter().any(|item| item["kind"] != "file_add")
    {
        return Err(StatusCode::UNPROCESSABLE_ENTITY);
    }
    for item in &items {
        if item["id"]
            .as_str()
            .is_none_or(|id| !id.starts_with("tmp-") || id.len() > 80)
        {
            return Err(StatusCode::UNPROCESSABLE_ENTITY);
        }
    }
    let items = if matches!(name, "propose_note_edit" | "propose_file_add") {
        crate::ai_knowledge_proposals::prepare_tool_items(pool, run, name, &items)
            .await
            .map_err(|_| StatusCode::UNPROCESSABLE_ENTITY)?
    } else {
        items
    };
    Ok(json!({"accepted":true,"item_count":items.len(),"items":items,"requires_validation":true}))
}

async fn validate_ai_proposal_tool(
    pool: &PgPool,
    run: Uuid,
    proposal: &Value,
) -> Result<Value, StatusCode> {
    match crate::proposals::validate_ai_proposal(pool, run, proposal).await {
        Ok(()) => Ok(json!({"valid":true})),
        Err(reason) => {
            Ok(json!({"valid":false,"error":{"code":"invalid_proposal","detail":reason}}))
        }
    }
}

async fn list_events(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Path(run): Path<Uuid>,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    if !matches!(visible_run(&state.pool, run, actor).await, Ok(Some(_))) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match sqlx::query("SELECT id,kind,summary,details,created_at::text AS created_at FROM ai_run_events WHERE run_id=$1 ORDER BY id")
        .bind(run).fetch_all(&state.pool).await {
        Ok(rows) => Json(json!({"events":rows.into_iter().map(|r|json!({"id":r.get::<i64,_>("id"),"kind":r.get::<String,_>("kind"),"summary":r.get::<String,_>("summary"),"details":r.get::<Value,_>("details"),"created_at":r.get::<String,_>("created_at")})).collect::<Vec<_>>()})).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn cancel_run(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Path(run): Path<Uuid>,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let changed = sqlx::query("UPDATE ai_runs SET state='canceled',summary='Canceled by the initiator',updated_at=now() WHERE id=$1 AND initiator_id=$2 AND state IN ('queued','running','rate_limited') RETURNING id")
        .bind(run).bind(actor).fetch_optional(&mut *tx).await;
    match changed {
        Ok(Some(_)) => {
            let _ = sqlx::query("UPDATE ai_runner_jobs SET status='paused',visible_reason='Run canceled by initiator',updated_at=now() WHERE run_id=$1 AND status IN ('queued','leased')").bind(run).execute(&mut *tx).await;
            let _ = insert_event(&mut tx, run, "state", "Run canceled", json!({})).await;
            if tx.commit().await.is_err() {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
            Json(json!({"id":run,"state":"canceled","summary":"Canceled by the initiator"}))
                .into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn call_tool(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Path(run): Path<Uuid>,
    Json(input): Json<ToolInput>,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    if !matches!(visible_run(&state.pool, run, actor).await, Ok(Some(_))) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let tools = AiReadTools::new(
        state.pool.clone(),
        RunState {
            pool: state.pool.clone(),
        },
    );
    match tools.call(run, input.call).await {
        Ok(result) => {
            Json(serde_json::to_value(result).unwrap_or_else(|_| json!({}))).into_response()
        }
        Err(crate::ai_tools::ToolError::BudgetExceeded) => {
            fail_run(&state.pool, run, "Run exceeded its context or tool budget").await;
            error(StatusCode::UNPROCESSABLE_ENTITY, "run_budget_exceeded")
        }
        Err(crate::ai_tools::ToolError::Unavailable) => {
            StatusCode::SERVICE_UNAVAILABLE.into_response()
        }
    }
}

/// Called only after the runner's current lease has been validated.
pub(crate) async fn accept_runner_result(
    pool: &PgPool,
    run: Uuid,
    mut result: Value,
    failed: bool,
) {
    let outcome = result["outcome"]
        .as_str()
        .unwrap_or(if failed { "failed" } else { "completed" })
        .to_owned();
    if outcome == "waiting_for_approval" {
        let Some(proposal) = result.get("proposal") else {
            fail_run(pool, run, "Provider completed without a valid Proposal").await;
            return;
        };
        match crate::proposals::create_ai_proposal(pool, run, proposal).await {
            Ok(proposal_id) => {
                if let Some(object) = result.as_object_mut() {
                    object.insert("proposal_id".into(), json!(proposal_id));
                    object.remove("proposal");
                }
            }
            Err(reason) => {
                let summary = format!("Provider Proposal was rejected: {reason}");
                fail_run(pool, run, &summary).await;
                return;
            }
        }
    }
    let retry_budget: i64 = sqlx::query_scalar(
        "SELECT COALESCE((run_limits->>'retry_budget')::bigint,2) FROM ai_runs WHERE id=$1",
    )
    .bind(run)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
    .unwrap_or(2)
    .clamp(0, 5);
    let retries: i32 = sqlx::query_scalar("SELECT retry_count FROM ai_runs WHERE id=$1")
        .bind(run)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .unwrap_or(0);
    let progress_access = progress_review_access_is_current(pool, run).await;
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return,
    };
    let (state, mut summary) = match outcome.as_str() {
        "rate_limited" if i64::from(retries) < retry_budget => {
            let delay = result["retry_after_seconds"]
                .as_i64()
                .unwrap_or(30)
                .clamp(1, 300);
            let _ = sqlx::query("UPDATE ai_runner_jobs SET status='queued',runner_id=NULL,lease_expires_at=NULL,available_at=now()+make_interval(secs=>$2),visible_reason='Provider rate limit; bounded retry scheduled',updated_at=now() WHERE run_id=$1 AND status IN ('leased','completed')")
                .bind(run).bind(delay as f64).execute(&mut *tx).await;
            let _ = sqlx::query("UPDATE ai_runs SET state='rate_limited',retry_count=retry_count+1,retry_at=now()+make_interval(secs=>$2),summary='Provider rate limited this run; a bounded retry is scheduled',updated_at=now() WHERE id=$1")
                .bind(run).bind(delay as f64).execute(&mut *tx).await;
            (
                "rate_limited",
                "Provider rate limited this run; a bounded retry is scheduled".to_owned(),
            )
        }
        "rate_limited" => ("failed", "Provider retry budget was exhausted".to_owned()),
        "needs_login" => (
            "needs_login",
            "Provider sign-in expired; reconnect the provider".to_owned(),
        ),
        "waiting_for_approval" => (
            "waiting_for_approval",
            summary_from(&result, "Proposal is ready for review"),
        ),
        "completed" => ("completed", summary_from(&result, "Run completed")),
        _ if failed || outcome == "failed" => {
            ("failed", summary_from(&result, "Provider job failed"))
        }
        _ => (
            "failed",
            "Provider returned an unsupported run outcome".to_owned(),
        ),
    };
    let shared_connection: bool = sqlx::query_scalar("SELECT c.scope<>'personal' FROM ai_runs r JOIN ai_connections c ON c.id=r.connection_id WHERE r.id=$1")
        .bind(run)
        .fetch_optional(&mut *tx)
        .await
        .ok()
        .flatten()
        .unwrap_or(false);
    if shared_connection && matches!(state, "rate_limited" | "needs_login" | "failed") {
        summary = format!("Shared AI connection is affected: {summary}");
    }
    if state == "rate_limited" {
        let _ = sqlx::query(
            "UPDATE ai_runs SET summary=$2,updated_at=now() WHERE id=$1 AND state='rate_limited'",
        )
        .bind(run)
        .bind(&summary)
        .execute(&mut *tx)
        .await;
    }
    if state == "needs_login" {
        let _ = sqlx::query("UPDATE ai_connections SET state='needs_login',state_reason='Provider sign-in expired',updated_at=now() WHERE id=(SELECT connection_id FROM ai_runs WHERE id=$1)")
            .bind(run).execute(&mut *tx).await;
    }
    if state != "rate_limited" {
        let mut visible = sanitized_result(&result);
        let capability: String = sqlx::query_scalar("SELECT capability FROM ai_runs WHERE id=$1")
            .bind(run)
            .fetch_optional(&mut *tx)
            .await
            .ok()
            .flatten()
            .unwrap_or_default();
        if capability == "progress_review" && !progress_access {
            // Access was lost while the run was working: nothing the model wrote is shown, since
            // it may name Tasks the initiator can no longer read.
            summary = "Access to a reviewed Project was lost; the report is withheld".to_owned();
            visible = json!({"summary":summary,"withheld":"access_revoked"});
            let _ = sqlx::query("DELETE FROM ai_run_sources WHERE run_id=$1")
                .bind(run)
                .execute(&mut *tx)
                .await;
        }
        if capability == "review" || capability == "progress_review" && progress_access {
            let read: HashSet<(String, String)> =
                sqlx::query("SELECT source_kind,source_id FROM ai_run_sources WHERE run_id=$1")
                    .bind(run)
                    .fetch_all(&mut *tx)
                    .await
                    .unwrap_or_default()
                    .iter()
                    .map(|row| (row.get("source_kind"), row.get("source_id")))
                    .collect();
            let categories: &[&str] = if capability == "review" {
                &REVIEW_CATEGORIES
            } else {
                &crate::ai_progress::CATEGORIES
            };
            visible["findings"] = Value::Array(review_findings(&result, &read, categories));
            if capability == "progress_review" {
                visible["fix_scope"] = json!(crate::ai_progress::FIX_SCOPE);
            }
        }
        let usage = result.get("usage").map(sanitize_usage);
        let _ = sqlx::query("UPDATE ai_runs SET state=$2,summary=$3,result=$4,usage=$5,updated_at=now() WHERE id=$1 AND state IN ('running','queued')")
            .bind(run).bind(state).bind(&summary).bind(visible).bind(usage).execute(&mut *tx).await;
        let _ = insert_event(&mut tx, run, "state", &summary, json!({"state":state})).await;
    } else {
        let _ = insert_event(
            &mut tx,
            run,
            "state",
            &summary,
            json!({"state":state,"retry_count":retries+1}),
        )
        .await;
    }
    let _ = tx.commit().await;
}

fn sanitize_usage(value: &Value) -> Value {
    let mut usage = serde_json::Map::new();
    for key in ["input_tokens", "output_tokens", "total_tokens"] {
        if let Some(number) = value.get(key).and_then(Value::as_i64).filter(|n| *n >= 0) {
            usage.insert(key.to_owned(), json!(number));
        }
    }
    if let Some(cost) = value
        .get("cost_usd")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.0)
    {
        usage.insert("cost_usd".to_owned(), json!(cost));
    }
    usage.insert("reported".to_owned(), json!(!usage.is_empty()));
    Value::Object(usage)
}

async fn insert_event(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    run: Uuid,
    kind: &str,
    summary: &str,
    details: Value,
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO ai_run_events(run_id,kind,summary,details) VALUES($1,$2,$3,$4)")
        .bind(run)
        .bind(kind)
        .bind(summary)
        .bind(details)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub(crate) async fn fail_run(pool: &PgPool, run: Uuid, reason: &str) {
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return,
    };
    let _ = sqlx::query("UPDATE ai_runs SET state='failed',summary=$2,updated_at=now() WHERE id=$1 AND state IN ('queued','running','rate_limited')")
        .bind(run).bind(reason).execute(&mut *tx).await;
    let _ = insert_event(&mut tx, run, "state", reason, json!({})).await;
    let _ = sqlx::query("UPDATE ai_runner_jobs SET status='paused',visible_reason=$2,updated_at=now() WHERE run_id=$1 AND status IN ('queued','leased')")
        .bind(run).bind(reason).execute(&mut *tx).await;
    let _ = tx.commit().await;
}

async fn visible_run(
    pool: &PgPool,
    run: Uuid,
    actor: Uuid,
) -> Result<Option<sqlx::postgres::PgRow>, sqlx::Error> {
    sqlx::query("SELECT r.id,r.initiator_id,r.workspace_id,r.connection_id,r.fallback_from,r.capability,r.state,r.summary,r.result,r.usage,r.retry_count,r.created_at::text AS created_at,r.updated_at::text AS updated_at,(SELECT COALESCE(jsonb_agg(jsonb_build_object('kind',s.source_kind,'id',s.source_id,'label',s.source_label,'task_number',CASE WHEN s.source_kind IN ('task','task_chat','related_task') THEN (SELECT t.number FROM tasks t WHERE t.id=s.source_id::uuid) ELSE NULL END) ORDER BY s.read_at),'[]'::jsonb) FROM ai_run_sources s WHERE s.run_id=r.id) AS sources_read,(SELECT COALESCE(jsonb_agg(e.details ORDER BY e.id),'[]'::jsonb) FROM ai_run_events e WHERE e.run_id=r.id AND e.kind='tool') AS tool_activity,EXISTS(SELECT 1 FROM ai_run_events e WHERE e.run_id=r.id AND e.kind='tool' AND e.details->>'truncated'='true') AS context_truncated,(SELECT visible_reason FROM ai_runner_jobs j WHERE j.run_id=r.id ORDER BY j.created_at DESC LIMIT 1) AS pause_reason FROM ai_runs r WHERE r.id=$1 AND r.initiator_id=$2")
        .bind(run).bind(actor).fetch_optional(pool).await
}

fn run_json(row: &sqlx::postgres::PgRow) -> Value {
    json!({"id":row.get::<Uuid,_>("id"),"initiator_id":row.get::<Uuid,_>("initiator_id"),"workspace_id":row.get::<Uuid,_>("workspace_id"),"connection_id":row.get::<Option<Uuid>,_>("connection_id"),"fallback_from":row.get::<Option<Uuid>,_>("fallback_from"),"capability":row.get::<String,_>("capability"),"state":row.get::<String,_>("state"),"summary":row.get::<String,_>("summary"),"pause_reason":row.get::<Option<String>,_>("pause_reason"),"result":row.get::<Option<Value>,_>("result"),"usage":row.get::<Option<Value>,_>("usage"),"sources_read":row.get::<Value,_>("sources_read"),"tool_activity":row.get::<Value,_>("tool_activity"),"context_truncated":row.get::<bool,_>("context_truncated"),"retry_count":row.get::<i32,_>("retry_count"),"created_at":row.get::<String,_>("created_at"),"updated_at":row.get::<String,_>("updated_at")})
}

fn sanitized_result(result: &Value) -> Value {
    let mut visible = serde_json::Map::new();
    for key in [
        "summary",
        "proposal_id",
        "tool_activity",
        "sources_read",
        "assumptions",
        "open_questions",
    ] {
        if let Some(value) = result.get(key) {
            visible.insert(key.to_owned(), value.clone());
        }
    }
    Value::Object(visible)
}

const REVIEW_CATEGORIES: [&str; 4] = [
    "missing_detail",
    "vague_criteria",
    "untestable_criteria",
    "missing_dependency",
];
const MAX_REVIEW_FINDINGS: usize = 25;
const MAX_FINDING_REASON_CHARACTERS: usize = 1_000;

/// Keep only well-formed review findings. A Source counts only when the run actually read it, so
/// model output can never cite something the requester has not been shown.
fn review_findings(
    result: &Value,
    read: &HashSet<(String, String)>,
    categories: &[&str],
) -> Vec<Value> {
    result
        .get("findings")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|finding| {
            let category = finding.get("category")?.as_str()?;
            let reason = finding.get("reason")?.as_str()?.trim();
            if !categories.contains(&category) || reason.is_empty() {
                return None;
            }
            let sources: Vec<Value> = finding
                .get("sources")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|source| {
                    let kind = source.get("kind")?.as_str()?;
                    let id = source.get("id")?.as_str()?;
                    read.contains(&(kind.to_owned(), id.to_owned()))
                        .then(|| json!({"kind":kind,"id":id}))
                })
                .collect();
            Some(json!({
                "category":category,
                "reason":reason.chars().take(MAX_FINDING_REASON_CHARACTERS).collect::<String>(),
                "sources":sources
            }))
        })
        .take(MAX_REVIEW_FINDINGS)
        .collect()
}

/// A progress review only reports what the initiator can still read when the result arrives.
async fn progress_review_access_is_current(pool: &PgPool, run: Uuid) -> bool {
    let Ok(Some(row)) = sqlx::query("SELECT initiator_id,workspace_id,scope FROM ai_runs WHERE id=$1 AND capability='progress_review'")
        .bind(run)
        .fetch_optional(pool)
        .await
    else {
        return true;
    };
    let initiator: Uuid = row.get("initiator_id");
    let workspace: Uuid = row.get("workspace_id");
    let scope: Value = row.get("scope");
    for project in scope["projects"].as_array().into_iter().flatten() {
        let Some(project) = project.as_str().and_then(|id| Uuid::parse_str(id).ok()) else {
            continue;
        };
        match crate::projects::evaluate_access(pool, project, initiator).await {
            Ok(Some(access))
                if access.workspace_id == workspace
                    && access.role >= crate::projects::Role::Viewer => {}
            _ => return false,
        }
    }
    true
}

fn summary_from(result: &Value, fallback: &str) -> String {
    result
        .get("summary")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(500).collect())
        .unwrap_or_else(|| fallback.to_owned())
}

fn bounded_limit(limits: &Value, key: &str, fallback: i64, min: i64, max: i64) -> i64 {
    limits
        .get(key)
        .and_then(Value::as_i64)
        .unwrap_or(fallback)
        .clamp(min, max)
}

fn validate_scope_shape(scope: &RunScope) -> Result<(), StatusCode> {
    if scope.projects.len() > MAX_SCOPE_ITEMS
        || scope.tasks.len() > MAX_SCOPE_ITEMS
        || scope.vaults.len() > MAX_SCOPE_ITEMS
    {
        return Err(StatusCode::UNPROCESSABLE_ENTITY);
    }
    let unique: HashSet<Uuid> = scope
        .projects
        .iter()
        .chain(scope.tasks.iter())
        .chain(scope.vaults.iter())
        .copied()
        .collect();
    if unique.len() != scope.projects.len() + scope.tasks.len() + scope.vaults.len() {
        return Err(StatusCode::UNPROCESSABLE_ENTITY);
    }
    Ok(())
}

async fn is_workspace_member(
    pool: &PgPool,
    workspace: Uuid,
    actor: Uuid,
) -> Result<bool, StatusCode> {
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2)",
    )
    .bind(workspace)
    .bind(actor)
    .fetch_one(pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) async fn expire_run(pool: &PgPool, run: Uuid) {
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return,
    };
    let _ = sqlx::query("WITH expired AS (UPDATE ai_runs SET state='failed',summary='Run exceeded its time limit',updated_at=now() WHERE id=$1 AND state IN ('queued','running','rate_limited') AND deadline_at<=now() RETURNING id,summary) INSERT INTO ai_run_events(run_id,kind,summary,details) SELECT id,'state',summary,jsonb_build_object('state','failed') FROM expired")
        .bind(run).execute(&mut *tx).await;
    let _ = sqlx::query("UPDATE ai_runner_jobs SET status='paused',visible_reason='Run exceeded its time limit',updated_at=now() WHERE run_id=$1 AND status IN ('queued','leased') AND EXISTS(SELECT 1 FROM ai_runs r WHERE r.id=$1 AND r.state='failed' AND r.summary='Run exceeded its time limit')")
        .bind(run).execute(&mut *tx).await;
    let _ = tx.commit().await;
}

async fn connection_for_run(
    pool: &PgPool,
    connection: Uuid,
    workspace: Uuid,
    actor: Uuid,
) -> Result<sqlx::postgres::PgRow, StatusCode> {
    let row=sqlx::query("SELECT id,provider,billing_mode,model_default,state,state_reason,limits,scope,workspace_id,owner_id FROM ai_connections c WHERE id=$1 AND enabled AND revoked_at IS NULL AND state='ready' AND (owner_id=$2 OR EXISTS(SELECT 1 FROM ai_connection_grants g WHERE g.connection_id=c.id AND (g.user_id=$2 OR g.workspace_id=$3)))")
        .bind(connection).bind(actor).bind(workspace).fetch_optional(pool).await.map_err(|_|StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(row) = row else {
        return Err(StatusCode::NOT_FOUND);
    };
    if row
        .get::<Option<Uuid>, _>("workspace_id")
        .is_some_and(|w| w != workspace)
        || row.get::<String, _>("state") != "ready"
    {
        return Err(StatusCode::CONFLICT);
    }
    Ok(row)
}

async fn readable_scope_projects(
    pool: &PgPool,
    workspace: Uuid,
    actor: Uuid,
    scope: &RunScope,
) -> Result<HashSet<Uuid>, StatusCode> {
    let mut selected: HashSet<Uuid> = scope.projects.iter().copied().collect();
    if !scope.tasks.is_empty() {
        let rows=sqlx::query("SELECT id,project_id FROM tasks WHERE id=ANY($1) AND workspace_id=$2 AND archived_at IS NULL")
            .bind(&scope.tasks).bind(workspace).fetch_all(pool).await.map_err(|_|StatusCode::INTERNAL_SERVER_ERROR)?;
        if rows.len() != scope.tasks.len() {
            return Err(StatusCode::FORBIDDEN);
        }
        selected.extend(rows.into_iter().map(|r| r.get::<Uuid, _>("project_id")));
    }
    for project in &selected {
        if !matches!(projects::evaluate_access(pool,*project,actor).await,Ok(Some(access)) if access.workspace_id==workspace && access.role>=Role::Viewer)
        {
            return Err(StatusCode::FORBIDDEN);
        }
    }
    Ok(selected)
}

struct RunState {
    pool: PgPool,
}

impl RunToolState for RunState {
    async fn load_current(&self, run_id: Uuid) -> Result<Option<TrustedRunContext>, sqlx::Error> {
        let row=sqlx::query("SELECT r.initiator_id,r.workspace_id,r.connection_id,r.scope,r.run_limits,r.state,r.context_characters,r.tool_calls,c.enabled,(c.revoked_at IS NULL) AS not_revoked,(c.owner_id=r.initiator_id OR EXISTS(SELECT 1 FROM ai_connection_grants g WHERE g.connection_id=c.id AND (g.user_id=r.initiator_id OR g.workspace_id=r.workspace_id))) AS connection_granted,EXISTS(SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=r.workspace_id AND m.user_id=r.initiator_id) AS workspace_member FROM ai_runs r JOIN ai_connections c ON c.id=r.connection_id WHERE r.id=$1")
            .bind(run_id).fetch_optional(&self.pool).await?;
        let Some(row) = row else { return Ok(None) };
        let scope: Value = row.get("scope");
        let selected_projects = uuid_set(scope.get("projects"));
        let selected_tasks = uuid_set(scope.get("tasks"));
        let selected_vaults = uuid_set(scope.get("vaults"));
        let initiator: Uuid = row.get("initiator_id");
        let workspace: Uuid = row.get("workspace_id");
        let mut granted_projects = selected_projects.clone();
        if !selected_tasks.is_empty() {
            let task_projects=sqlx::query_scalar::<_,Uuid>("SELECT DISTINCT project_id FROM tasks WHERE id=ANY($1) AND workspace_id=$2 AND archived_at IS NULL")
                .bind(selected_tasks.iter().copied().collect::<Vec<_>>()).bind(workspace).fetch_all(&self.pool).await?;
            granted_projects.extend(task_projects);
        }
        let connection: Uuid = row.get("connection_id");
        let has_workspace_grant=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM ai_connection_grants WHERE connection_id=$1 AND workspace_id=$2)")
            .bind(connection).bind(workspace).fetch_one(&self.pool).await?;
        if !has_workspace_grant {
            // The explicit connection owner/creator case is valid only while their own ACLs remain valid.
        }
        let granted_vaults = selected_vaults.clone();
        Ok(Some(TrustedRunContext {
            run_id,
            initiator_id: initiator,
            workspace_id: workspace,
            connection_enabled: row.get::<bool, _>("enabled")
                && row.get::<bool, _>("not_revoked")
                && row.get::<bool, _>("connection_granted")
                && row.get::<bool, _>("workspace_member")
                && matches!(
                    row.get::<String, _>("state").as_str(),
                    "queued" | "running" | "rate_limited"
                ),
            selected_projects,
            selected_tasks,
            selected_vaults,
            granted_projects,
            granted_vaults,
            max_tool_calls: bounded_limit(
                &row.get::<Value, _>("run_limits"),
                "tool_calls",
                40,
                1,
                500,
            ) as u32,
            max_characters: bounded_limit(
                &row.get::<Value, _>("run_limits"),
                "context_characters",
                200_000,
                1_000,
                2_000_000,
            ) as u64,
            tool_calls: row.get::<i32, _>("tool_calls").max(0) as u32,
            characters_read: row.get::<i32, _>("context_characters").max(0) as u64,
        }))
    }
    async fn record_revocation(
        &self,
        run_id: Uuid,
        reason: &'static str,
    ) -> Result<(), sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE ai_runs SET state='failed',summary=$2,updated_at=now() WHERE id=$1 AND state IN ('queued','running','rate_limited')")
            .bind(run_id).bind(reason).execute(&mut *tx).await?;
        sqlx::query("UPDATE ai_runner_jobs SET status='paused',visible_reason=$2,updated_at=now() WHERE run_id=$1 AND status IN ('queued','leased')")
            .bind(run_id).bind(reason).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM ai_run_sources WHERE run_id=$1")
            .bind(run_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
    async fn reserve_budget(&self, run_id: Uuid, characters: u64) -> Result<bool, sqlx::Error> {
        let limits: Option<Value> = sqlx::query_scalar(
            "SELECT run_limits FROM ai_runs WHERE id=$1 AND state IN ('queued','running')",
        )
        .bind(run_id)
        .fetch_optional(&self.pool)
        .await?;
        let Some(limits) = limits else {
            return Ok(false);
        };
        let max_calls = bounded_limit(&limits, "tool_calls", 40, 1, 500);
        let max_characters =
            bounded_limit(&limits, "context_characters", 200_000, 1_000, 2_000_000);
        let updated=sqlx::query("UPDATE ai_runs SET context_characters=context_characters+$2,tool_calls=tool_calls+1,updated_at=now() WHERE id=$1 AND state IN ('queued','running') AND tool_calls<$3 AND context_characters+$2<=$4 RETURNING id")
            .bind(run_id).bind(characters.min(i64::MAX as u64) as i64).bind(max_calls).bind(max_characters).fetch_optional(&self.pool).await?;
        Ok(updated.is_some())
    }
    async fn record_sources(
        &self,
        run_id: Uuid,
        sources: Vec<(String, String)>,
        truncated: bool,
    ) -> Result<(), sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        let count = sources.len() as i32;
        let workspace: Uuid = sqlx::query_scalar("SELECT workspace_id FROM ai_runs WHERE id=$1")
            .bind(run_id)
            .fetch_one(&mut *tx)
            .await?;
        for (kind, id) in sources {
            let label = if matches!(kind.as_str(), "task" | "task_chat" | "related_task") {
                if let Ok(task_id) = Uuid::parse_str(&id) {
                    sqlx::query_scalar::<_, String>("SELECT concat('#',number,' ',title) FROM tasks WHERE id=$1 AND workspace_id=$2")
                        .bind(task_id).bind(workspace).fetch_optional(&mut *tx).await?
                        .map(|task| if kind == "task_chat" { format!("Task chat: {task}") } else { task })
                        .unwrap_or_else(|| kind.clone())
                } else {
                    kind.clone()
                }
            } else if kind == "milestone" {
                match Uuid::parse_str(&id) {
                    Ok(milestone) => sqlx::query_scalar::<_, String>("SELECT concat('Milestone ',name) FROM milestones WHERE id=$1 AND workspace_id=$2")
                        .bind(milestone).bind(workspace).fetch_optional(&mut *tx).await?
                        .unwrap_or_else(|| kind.clone()),
                    Err(_) => kind.clone(),
                }
            } else {
                kind.clone()
            };
            sqlx::query("INSERT INTO ai_run_sources(run_id,source_kind,source_id,source_label) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING")
                .bind(run_id).bind(kind).bind(id).bind(label).execute(&mut *tx).await?;
        }
        sqlx::query("INSERT INTO ai_run_events(run_id,kind,summary,details) VALUES($1,'tool','Read tool completed',jsonb_build_object('source_count',$2,'truncated',$3))")
            .bind(run_id).bind(count).bind(truncated).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }
}

fn uuid_set(value: Option<&Value>) -> HashSet<Uuid> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str()?.parse().ok())
        .collect()
}

fn error(status: StatusCode, code: &'static str) -> Response {
    (status, Json(json!({"error":code}))).into_response()
}
