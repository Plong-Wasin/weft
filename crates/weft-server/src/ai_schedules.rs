//! Opt-in scheduled reviews. A Schedule is off until a Workspace Admin enables it. Each run is a
//! normal `progress_review` AI run started by the system as the Schedule's execution principal,
//! through that principal's own access and Connection grants. The only thing a run can produce is
//! a Proposal in the approval queue, labelled with its origin. A Schedule stops with a visible
//! reason when its principal or Connection goes away or a limit is hit, and never resumes by itself.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgConnection, PgPool, Row};
use tracing::warn;
use uuid::Uuid;

use crate::{
    ai_runs::{self, CreateInput, RunScope, ScheduleOrigin, BUDGET_EXCEEDED_SUMMARY},
    auth::{require_session, AuthState},
    projects::{self, Role},
    proposals, vaults,
};

const MAX_SCOPE_ITEMS: usize = 50;
const TICK: std::time::Duration = std::time::Duration::from_secs(60);
/// The prompt is fixed on the server: nothing a person or a note types becomes an instruction.
const REVIEW_PROMPT: &str = "Review delivery risks across the selected Projects. Report overdue work, blocked chains, missing assignees and Milestones that are empty or behind. Propose only fixes the Proposal engine can express.";
const QUEUE_LIMIT: i64 = 100;

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route(
            "/workspaces/:workspace_id/ai/service-principals",
            post(create_principal).get(list_principals),
        )
        .route(
            "/workspaces/:workspace_id/ai/service-principals/:principal_id/revoke",
            post(revoke_principal),
        )
        .route(
            "/workspaces/:workspace_id/ai/schedules",
            post(create_schedule).get(list_schedules),
        )
        .route(
            "/workspaces/:workspace_id/ai/schedules/:schedule_id",
            get(read_schedule),
        )
        .route(
            "/workspaces/:workspace_id/ai/schedules/:schedule_id/enable",
            post(enable_schedule),
        )
        .route(
            "/workspaces/:workspace_id/ai/schedules/:schedule_id/disable",
            post(disable_schedule),
        )
        .route(
            "/workspaces/:workspace_id/ai/schedules/:schedule_id/runs",
            get(list_schedule_runs),
        )
        .route(
            "/workspaces/:workspace_id/ai/schedules/:schedule_id/audit",
            get(schedule_audit),
        )
        .route(
            "/workspaces/:workspace_id/proposal-queue",
            get(proposal_queue),
        )
}

fn error(status: StatusCode, code: &'static str) -> Response {
    (status, Json(json!({"error":code}))).into_response()
}

fn internal() -> Response {
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}

/// Why a Schedule cannot run right now.
struct Stop {
    reason: &'static str,
    detail: String,
}

fn stop(reason: &'static str, detail: &str) -> Stop {
    Stop {
        reason,
        detail: detail.to_owned(),
    }
}

#[derive(Clone)]
struct Frequency {
    kind: String,
    time: String,
    weekday: i32,
    minute: i32,
}

impl Frequency {
    fn parse(value: &Value) -> Option<Frequency> {
        let kind = value.get("kind")?.as_str()?;
        let clock = |value: &Value| -> Option<String> {
            let text = value.get("time")?.as_str()?;
            let (hour, minute) = text.split_once(':')?;
            let valid = hour.len() == 2
                && minute.len() == 2
                && hour.parse::<u32>().ok()? < 24
                && minute.parse::<u32>().ok()? < 60;
            valid.then(|| text.to_owned())
        };
        match kind {
            "hourly" => {
                let minute = value.get("minute")?.as_i64()?;
                (0..60).contains(&minute).then(|| Frequency {
                    kind: kind.into(),
                    time: "00:00".into(),
                    weekday: 0,
                    minute: minute as i32,
                })
            }
            "daily" => Some(Frequency {
                kind: kind.into(),
                time: clock(value)?,
                weekday: 0,
                minute: 0,
            }),
            "weekly" => {
                let weekday = value.get("weekday")?.as_i64()?;
                (0..=6)
                    .contains(&weekday)
                    .then(|| Frequency {
                        kind: kind.into(),
                        time: clock(value).unwrap_or_default(),
                        weekday: weekday as i32,
                        minute: 0,
                    })
                    .filter(|frequency| !frequency.time.is_empty())
            }
            _ => None,
        }
    }

    fn to_json(&self) -> Value {
        match self.kind.as_str() {
            "hourly" => json!({"kind":"hourly","minute":self.minute}),
            "daily" => json!({"kind":"daily","time":self.time}),
            _ => json!({"kind":"weekly","weekday":self.weekday,"time":self.time}),
        }
    }
}

/// The first run time strictly after `after` (an RFC 3339 instant) for `frequency`, evaluated on
/// the wall clock of `zone`. Postgres resolves daylight-saving gaps and repeats, so a 09:00
/// Schedule stays at 09:00 local across a clock change.
async fn next_after(
    pool: &PgPool,
    after: &str,
    zone: &str,
    frequency: &Frequency,
) -> Result<String, sqlx::Error> {
    let mut from = after.to_owned();
    loop {
        let next: String = sqlx::query_scalar(
            "WITH l AS (SELECT ($1::timestamptz AT TIME ZONE $2) AS n), \
             c AS (SELECT n, CASE $3 \
               WHEN 'hourly' THEN date_trunc('hour',n)+make_interval(mins=>$5) \
               WHEN 'daily' THEN date_trunc('day',n)+$4::time \
               ELSE date_trunc('day',n)+make_interval(days=>(($6-extract(dow FROM n)::int+7)%7))+$4::time END AS cand, \
               CASE $3 WHEN 'hourly' THEN interval '1 hour' WHEN 'daily' THEN interval '1 day' ELSE interval '7 days' END AS step FROM l) \
             SELECT ((CASE WHEN cand>n THEN cand ELSE cand+step END) AT TIME ZONE $2)::text FROM c",
        )
        .bind(&from)
        .bind(zone)
        .bind(&frequency.kind)
        .bind(&frequency.time)
        .bind(frequency.minute)
        .bind(frequency.weekday)
        .fetch_one(pool)
        .await?;
        let later: bool = sqlx::query_scalar("SELECT $1::timestamptz > $2::timestamptz")
            .bind(&next)
            .bind(after)
            .fetch_one(pool)
            .await?;
        if later {
            return Ok(next);
        }
        // A repeated wall-clock hour can map a candidate back before `after`; step past it.
        from = sqlx::query_scalar("SELECT ($1::timestamptz+interval '1 hour')::text")
            .bind(&next)
            .fetch_one(pool)
            .await?;
    }
}

/// Public for time-passing tests: the next run time after `after` in `zone`.
pub async fn next_schedule_run(
    pool: &PgPool,
    after: &str,
    zone: &str,
    frequency: &Value,
) -> Result<Option<String>, sqlx::Error> {
    match Frequency::parse(frequency) {
        Some(frequency) => next_after(pool, after, zone, &frequency).await.map(Some),
        None => Ok(None),
    }
}

async fn workspace_zone(pool: &PgPool, workspace: Uuid) -> Result<String, sqlx::Error> {
    sqlx::query_scalar("SELECT time_zone FROM workspaces WHERE id=$1")
        .bind(workspace)
        .fetch_one(pool)
        .await
}

enum Caller {
    Admin(Uuid),
    Response(Response),
}

async fn admin(state: &AuthState, headers: &HeaderMap, workspace: Uuid, write: bool) -> Caller {
    let actor = match require_session(&state.pool, headers, write).await {
        Ok((_, actor)) => actor,
        Err(status) => return Caller::Response(status.into_response()),
    };
    let role: Result<Option<String>, _> = sqlx::query_scalar(
        "SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2",
    )
    .bind(workspace)
    .bind(actor)
    .fetch_optional(&state.pool)
    .await;
    match role {
        Ok(Some(role)) if matches!(role.as_str(), "owner" | "admin") => Caller::Admin(actor),
        Ok(Some(_)) => Caller::Response(StatusCode::FORBIDDEN.into_response()),
        Ok(None) => Caller::Response(StatusCode::NOT_FOUND.into_response()),
        Err(_) => Caller::Response(internal()),
    }
}

macro_rules! admin_or_return {
    ($state:expr, $headers:expr, $workspace:expr, $write:expr) => {
        match admin(&$state, &$headers, $workspace, $write).await {
            Caller::Admin(actor) => actor,
            Caller::Response(response) => return response,
        }
    };
}

async fn audit(
    conn: &mut PgConnection,
    actor: Option<Uuid>,
    workspace: Uuid,
    event: &str,
    subject: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO security_audit_events(actor_id,workspace_id,event,subject_id) VALUES($1,$2,$3,$4)")
        .bind(actor)
        .bind(workspace)
        .bind(event)
        .bind(subject)
        .execute(conn)
        .await?;
    Ok(())
}

// ---- service principals ------------------------------------------------------------------

#[derive(Deserialize)]
struct PrincipalInput {
    name: String,
}

async fn create_principal(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<PrincipalInput>,
) -> Response {
    let actor = admin_or_return!(state, headers, workspace, true);
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 120 {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_name");
    }
    let id = Uuid::new_v4();
    let Ok(mut tx) = state.pool.begin().await else {
        return internal();
    };
    // The hash is not a valid password hash, so nobody can ever sign in as this user. Workspace
    // role `member` is what lets a Project grant above Viewer count; the Project grant itself
    // stays the ceiling.
    let created = sqlx::query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'!')")
        .bind(id)
        .bind(format!("service-{id}@service.invalid"))
        .execute(&mut *tx)
        .await
        .is_ok()
        && sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'member')")
            .bind(workspace)
            .bind(id)
            .execute(&mut *tx)
            .await
            .is_ok()
        && sqlx::query("INSERT INTO ai_service_principals(user_id,workspace_id,name,created_by) VALUES($1,$2,$3,$4)")
            .bind(id)
            .bind(workspace)
            .bind(name)
            .bind(actor)
            .execute(&mut *tx)
            .await
            .is_ok()
        && audit(&mut tx, Some(actor), workspace, "ai.service_principal.created", id)
            .await
            .is_ok();
    if !created || tx.commit().await.is_err() {
        return internal();
    }
    (
        StatusCode::CREATED,
        Json(json!({"id":id,"name":name,"revoked":false})),
    )
        .into_response()
}

async fn list_principals(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    admin_or_return!(state, headers, workspace, false);
    match sqlx::query("SELECT user_id,name,revoked_at IS NOT NULL AS revoked FROM ai_service_principals WHERE workspace_id=$1 ORDER BY created_at,user_id")
        .bind(workspace)
        .fetch_all(&state.pool)
        .await
    {
        Ok(rows) => Json(json!({"principals":rows.iter().map(|row| json!({"id":row.get::<Uuid,_>("user_id"),"name":row.get::<String,_>("name"),"revoked":row.get::<bool,_>("revoked")})).collect::<Vec<_>>()})).into_response(),
        Err(_) => internal(),
    }
}

async fn revoke_principal(
    State(state): State<AuthState>,
    Path((workspace, principal)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let actor = admin_or_return!(state, headers, workspace, true);
    let Ok(mut tx) = state.pool.begin().await else {
        return internal();
    };
    let revoked = sqlx::query("UPDATE ai_service_principals SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1 AND workspace_id=$2")
        .bind(principal)
        .bind(workspace)
        .execute(&mut *tx)
        .await;
    match revoked {
        Ok(result) if result.rows_affected() == 1 => {}
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return internal(),
    }
    // Work the principal already queued must not keep running, and its Schedules stop now.
    let stopped = stop_runs(
        &mut tx,
        "principal_id",
        principal,
        "Execution principal was revoked",
    )
    .await;
    if stopped.is_err()
        || stop_schedules(
            &mut tx,
            "principal_id",
            principal,
            "principal_revoked",
            "The execution principal was revoked",
        )
        .await
        .is_err()
        || audit(
            &mut tx,
            Some(actor),
            workspace,
            "ai.service_principal.revoked",
            principal,
        )
        .await
        .is_err()
        || tx.commit().await.is_err()
    {
        return internal();
    }
    Json(json!({"id":principal,"revoked":true})).into_response()
}

/// Cancels queued and running scheduled runs. `by` is `schedule_id` or `principal_id`.
async fn stop_runs(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    by: &str,
    id: Uuid,
    reason: &str,
) -> Result<(), sqlx::Error> {
    let filter = match by {
        "schedule_id" => "schedule_id=$1",
        _ => "schedule_id IS NOT NULL AND initiator_id=$1",
    };
    sqlx::query(&format!("UPDATE ai_runner_jobs SET status='paused',visible_reason=$2,updated_at=now() WHERE status IN ('queued','leased') AND run_id IN (SELECT id FROM ai_runs WHERE {filter})"))
        .bind(id)
        .bind(reason)
        .execute(&mut **tx)
        .await?;
    sqlx::query(&format!("WITH stopped AS (UPDATE ai_runs SET state='canceled',summary=$2,updated_at=now() WHERE {filter} AND state IN ('queued','running','rate_limited') RETURNING id,summary) INSERT INTO ai_run_events(run_id,kind,summary,details) SELECT id,'state',summary,jsonb_build_object('state','canceled','reason','schedule_stopped') FROM stopped"))
        .bind(id)
        .bind(reason)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Stops every active Schedule that depends on a principal or Connection that just went away,
/// in the caller's transaction, so none stays active until the next tick. `by` is `principal_id`
/// or `connection_id`.
pub(crate) async fn stop_schedules(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    by: &str,
    id: Uuid,
    reason: &str,
    detail: &str,
) -> Result<(), sqlx::Error> {
    let filter = match by {
        "principal_id" => "principal_id=$1",
        _ => "connection_id=$1",
    };
    sqlx::query(&format!("WITH stopped AS (UPDATE ai_schedules SET state='stopped',stop_reason=$2,stop_detail=$3,next_run_at=NULL,updated_at=now() WHERE {filter} AND state='active' RETURNING id,workspace_id) INSERT INTO security_audit_events(actor_id,workspace_id,event,subject_id) SELECT NULL,workspace_id,'ai.schedule.stopped.'||$2,id FROM stopped"))
        .bind(id)
        .bind(reason)
        .bind(detail)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

// ---- readiness ---------------------------------------------------------------------------

/// Re-checks, right now, everything a run depends on: the principal, the Connection the
/// principal may use, and that the principal can still read every Project and Vault in scope.
/// The principal's grants are the ceiling: nothing here widens them.
async fn check_ready(
    pool: &PgPool,
    workspace: Uuid,
    principal: Uuid,
    connection: Uuid,
    scope: &RunScope,
) -> Result<(), Stop> {
    let unavailable = |_| stop("connection_unavailable", "Connection could not be checked");
    let revoked_principal: Option<bool> = sqlx::query_scalar(
        "SELECT revoked_at IS NOT NULL FROM ai_service_principals WHERE user_id=$1",
    )
    .bind(principal)
    .fetch_optional(pool)
    .await
    .map_err(|_| stop("principal_revoked", "Principal could not be checked"))?;
    let member: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2)",
    )
    .bind(workspace)
    .bind(principal)
    .fetch_one(pool)
    .await
    .map_err(|_| stop("principal_revoked", "Principal could not be checked"))?;
    if revoked_principal == Some(true) || !member {
        return Err(stop(
            "principal_revoked",
            "The execution principal was revoked or is no longer a member of the Workspace",
        ));
    }
    let row = sqlx::query(
        "SELECT enabled,revoked_at IS NOT NULL AS revoked FROM ai_connections WHERE id=$1",
    )
    .bind(connection)
    .fetch_optional(pool)
    .await
    .map_err(unavailable)?;
    let Some(row) = row else {
        return Err(stop(
            "connection_revoked",
            "The Connection no longer exists",
        ));
    };
    if row.get::<bool, _>("revoked") {
        return Err(stop("connection_revoked", "The Connection was revoked"));
    }
    if !row.get::<bool, _>("enabled") {
        return Err(stop("connection_unavailable", "The Connection is disabled"));
    }
    if ai_runs::connection_for_run(pool, connection, workspace, principal)
        .await
        .is_err()
    {
        return Err(stop(
            "connection_unavailable",
            "The principal can no longer use the Connection, or it is not ready",
        ));
    }
    // A service principal holds only what it was explicitly granted: a Workspace-visible Project
    // or Vault, which every member reads, is not enough.
    let service = revoked_principal.is_some();
    for project in &scope.projects {
        let explicit: bool = !service
            || sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM project_memberships WHERE project_id=$1 AND user_id=$2) OR EXISTS(SELECT 1 FROM project_team_memberships pt JOIN team_memberships tm ON tm.team_id=pt.team_id WHERE pt.project_id=$1 AND tm.user_id=$2)")
                .bind(project)
                .bind(principal)
                .fetch_one(pool)
                .await
                .unwrap_or(false);
        if !explicit
            || !matches!(projects::evaluate_access(pool, *project, principal).await, Ok(Some(access)) if access.workspace_id == workspace && access.role >= Role::Viewer)
        {
            return Err(stop(
                "access_lost",
                "The principal can no longer read a Project in the scope",
            ));
        }
    }
    for vault in &scope.vaults {
        let explicit: bool = !service
            || sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM vault_user_memberships WHERE vault_id=$1 AND user_id=$2) OR EXISTS(SELECT 1 FROM vault_team_memberships vt JOIN team_memberships tm ON tm.team_id=vt.team_id WHERE vt.vault_id=$1 AND tm.user_id=$2)")
                .bind(vault)
                .bind(principal)
                .fetch_one(pool)
                .await
                .unwrap_or(false);
        if !explicit
            || !matches!(vaults::evaluate_access(pool, *vault, principal).await, Ok(Some(access)) if access.workspace_id == workspace && access.role >= Role::Viewer)
        {
            return Err(stop(
                "access_lost",
                "The principal can no longer read a Vault in the scope",
            ));
        }
    }
    Ok(())
}

/// What the person creating or enabling a Schedule must hold: the principal is a service
/// principal or themselves (never another member, whose personal Connection it could use), and
/// they can read everything in the scope, so a Schedule cannot reach what its author cannot.
async fn check_actor(
    pool: &PgPool,
    workspace: Uuid,
    actor: Uuid,
    principal: Uuid,
    scope: &RunScope,
) -> Result<(), Stop> {
    let service: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM ai_service_principals WHERE user_id=$1 AND workspace_id=$2)",
    )
    .bind(principal)
    .bind(workspace)
    .fetch_one(pool)
    .await
    .unwrap_or(false);
    if !service && principal != actor {
        return Err(stop(
            "principal_not_allowed",
            "The execution principal must be a service principal or the person acting",
        ));
    }
    let readable = json!({"project_ids":scope.projects,"vault_ids":scope.vaults});
    if !proposals::scope_readable(pool, workspace, actor, &readable).await {
        return Err(stop(
            "scope_not_readable",
            "You cannot read every Project and Vault in the scope",
        ));
    }
    Ok(())
}

// ---- schedules ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ScheduleInput {
    name: String,
    principal_id: Uuid,
    connection_id: Uuid,
    #[serde(default)]
    scope: ScopeInput,
    frequency: Value,
    limits: Value,
}

#[derive(Deserialize, Default)]
struct ScopeInput {
    #[serde(default)]
    projects: Vec<Uuid>,
    #[serde(default)]
    vaults: Vec<Uuid>,
}

fn limit_value(limits: &Value, key: &str, min: i64, max: i64) -> Option<i64> {
    limits
        .get(key)?
        .as_i64()
        .filter(|value| (min..=max).contains(value))
}

fn scope_of(value: &Value) -> RunScope {
    let ids = |key: &str| -> Vec<Uuid> {
        value[key]
            .as_array()
            .map(|list| {
                list.iter()
                    .filter_map(|id| id.as_str().and_then(|text| Uuid::parse_str(text).ok()))
                    .collect()
            })
            .unwrap_or_default()
    };
    RunScope {
        projects: ids("projects"),
        tasks: Vec::new(),
        vaults: ids("vaults"),
    }
}

async fn create_schedule(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<ScheduleInput>,
) -> Response {
    let actor = admin_or_return!(state, headers, workspace, true);
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 120 {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_name");
    }
    let Some(frequency) = Frequency::parse(&input.frequency) else {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_frequency");
    };
    let (Some(runs), Some(characters), Some(calls)) = (
        limit_value(&input.limits, "runs_per_day", 1, 24),
        limit_value(&input.limits, "characters", 1_000, 2_000_000),
        limit_value(&input.limits, "tool_calls", 1, 500),
    ) else {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_limits");
    };
    let mut scope = RunScope {
        projects: input.scope.projects,
        tasks: Vec::new(),
        vaults: input.scope.vaults,
    };
    scope.projects.sort();
    scope.projects.dedup();
    scope.vaults.sort();
    scope.vaults.dedup();
    if scope.projects.len() + scope.vaults.len() == 0
        || scope.projects.len() + scope.vaults.len() > MAX_SCOPE_ITEMS
    {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_scope");
    }
    // Principal, Connection and scope are validated now and again at every run.
    if let Err(problem) = check_ready(
        &state.pool,
        workspace,
        input.principal_id,
        input.connection_id,
        &scope,
    )
    .await
    {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({"error":"schedule_not_runnable","reason":problem.reason})),
        )
            .into_response();
    }
    if let Err(problem) =
        check_actor(&state.pool, workspace, actor, input.principal_id, &scope).await
    {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({"error":"schedule_not_runnable","reason":problem.reason})),
        )
            .into_response();
    }
    let id = Uuid::new_v4();
    let Ok(mut tx) = state.pool.begin().await else {
        return internal();
    };
    let created = sqlx::query("INSERT INTO ai_schedules(id,workspace_id,name,principal_id,connection_id,scope,frequency,limits,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)")
        .bind(id)
        .bind(workspace)
        .bind(name)
        .bind(input.principal_id)
        .bind(input.connection_id)
        .bind(json!({"projects":scope.projects,"vaults":scope.vaults}))
        .bind(frequency.to_json())
        .bind(json!({"runs_per_day":runs,"characters":characters,"tool_calls":calls}))
        .bind(actor)
        .execute(&mut *tx)
        .await
        .is_ok()
        && audit(&mut tx, Some(actor), workspace, "ai.schedule.created", id)
            .await
            .is_ok();
    if !created || tx.commit().await.is_err() {
        return internal();
    }
    match load(&state.pool, workspace, id).await {
        Some(body) => (StatusCode::CREATED, Json(body)).into_response(),
        None => internal(),
    }
}

const SCHEDULE_COLUMNS: &str = "s.id,s.name,s.principal_id,COALESCE(p.name,u.email) AS principal_name,p.user_id IS NOT NULL AS service_principal,s.connection_id,s.capability,s.scope,s.frequency,s.limits,s.state,s.stop_reason,s.stop_detail,s.next_run_at::text AS next_run_at,s.last_run_at::text AS last_run_at";

fn schedule_json(row: &sqlx::postgres::PgRow) -> Value {
    json!({
        "id":row.get::<Uuid,_>("id"),
        "name":row.get::<String,_>("name"),
        "principal":{"id":row.get::<Uuid,_>("principal_id"),"name":row.get::<String,_>("principal_name"),"service":row.get::<bool,_>("service_principal")},
        "connection_id":row.get::<Uuid,_>("connection_id"),
        "capability":row.get::<String,_>("capability"),
        "scope":row.get::<Value,_>("scope"),
        "frequency":row.get::<Value,_>("frequency"),
        "limits":row.get::<Value,_>("limits"),
        "state":row.get::<String,_>("state"),
        "stop_reason":row.get::<Option<String>,_>("stop_reason"),
        "stop_detail":row.get::<Option<String>,_>("stop_detail"),
        "next_run_at":row.get::<Option<String>,_>("next_run_at"),
        "last_run_at":row.get::<Option<String>,_>("last_run_at"),
    })
}

async fn load(pool: &PgPool, workspace: Uuid, id: Uuid) -> Option<Value> {
    sqlx::query(&format!("SELECT {SCHEDULE_COLUMNS} FROM ai_schedules s JOIN users u ON u.id=s.principal_id LEFT JOIN ai_service_principals p ON p.user_id=s.principal_id WHERE s.workspace_id=$1 AND s.id=$2"))
        .bind(workspace)
        .bind(id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .map(|row| schedule_json(&row))
}

async fn list_schedules(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    admin_or_return!(state, headers, workspace, false);
    match sqlx::query(&format!("SELECT {SCHEDULE_COLUMNS} FROM ai_schedules s JOIN users u ON u.id=s.principal_id LEFT JOIN ai_service_principals p ON p.user_id=s.principal_id WHERE s.workspace_id=$1 ORDER BY s.created_at,s.id"))
        .bind(workspace)
        .fetch_all(&state.pool)
        .await
    {
        Ok(rows) => Json(json!({"schedules":rows.iter().map(schedule_json).collect::<Vec<_>>()})).into_response(),
        Err(_) => internal(),
    }
}

async fn read_schedule(
    State(state): State<AuthState>,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    admin_or_return!(state, headers, workspace, false);
    match load(&state.pool, workspace, id).await {
        Some(body) => Json(body).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn enable_schedule(
    State(state): State<AuthState>,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let actor = admin_or_return!(state, headers, workspace, true);
    let row = sqlx::query("SELECT principal_id,connection_id,scope,frequency,state FROM ai_schedules WHERE workspace_id=$1 AND id=$2")
        .bind(workspace)
        .bind(id)
        .fetch_optional(&state.pool)
        .await;
    let row = match row {
        Ok(Some(row)) => row,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return internal(),
    };
    let Some(frequency) = Frequency::parse(&row.get::<Value, _>("frequency")) else {
        return internal();
    };
    // Enabling is a fresh explicit decision: everything is checked again first.
    let scope = scope_of(&row.get::<Value, _>("scope"));
    let principal: Uuid = row.get("principal_id");
    let ready = check_ready(
        &state.pool,
        workspace,
        principal,
        row.get("connection_id"),
        &scope,
    )
    .await;
    if let Err(problem) = match ready {
        Ok(()) => check_actor(&state.pool, workspace, actor, principal, &scope).await,
        Err(problem) => Err(problem),
    } {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"schedule_not_runnable","reason":problem.reason,"detail":problem.detail})),
        )
            .into_response();
    }
    let (Ok(zone), Ok(now)) = (
        workspace_zone(&state.pool, workspace).await,
        sqlx::query_scalar::<_, String>("SELECT now()::text")
            .fetch_one(&state.pool)
            .await,
    ) else {
        return internal();
    };
    let Ok(next) = next_after(&state.pool, &now, &zone, &frequency).await else {
        return internal();
    };
    let Ok(mut tx) = state.pool.begin().await else {
        return internal();
    };
    let updated = sqlx::query("UPDATE ai_schedules SET state='active',stop_reason=NULL,stop_detail=NULL,next_run_at=$3::timestamptz,updated_at=now() WHERE workspace_id=$1 AND id=$2")
        .bind(workspace)
        .bind(id)
        .bind(&next)
        .execute(&mut *tx)
        .await
        .is_ok()
        && audit(&mut tx, Some(actor), workspace, "ai.schedule.enabled", id)
            .await
            .is_ok();
    if !updated || tx.commit().await.is_err() {
        return internal();
    }
    match load(&state.pool, workspace, id).await {
        Some(body) => Json(body).into_response(),
        None => internal(),
    }
}

/// Emergency switch: blocks new runs at once, cancels queued runs and cancels running ones.
async fn disable_schedule(
    State(state): State<AuthState>,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let actor = admin_or_return!(state, headers, workspace, true);
    let Ok(mut tx) = state.pool.begin().await else {
        return internal();
    };
    let updated = sqlx::query("UPDATE ai_schedules SET state='stopped',stop_reason='disabled_by_admin',stop_detail='Disabled by a Workspace Admin',next_run_at=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2")
        .bind(workspace)
        .bind(id)
        .execute(&mut *tx)
        .await;
    match updated {
        Ok(result) if result.rows_affected() == 1 => {}
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return internal(),
    }
    if stop_runs(
        &mut tx,
        "schedule_id",
        id,
        "Schedule disabled by a Workspace Admin",
    )
    .await
    .is_err()
        || audit(&mut tx, Some(actor), workspace, "ai.schedule.disabled", id)
            .await
            .is_err()
        || tx.commit().await.is_err()
    {
        return internal();
    }
    match load(&state.pool, workspace, id).await {
        Some(body) => Json(body).into_response(),
        None => internal(),
    }
}

async fn list_schedule_runs(
    State(state): State<AuthState>,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    let actor = admin_or_return!(state, headers, workspace, false);
    let Some(schedule) = load(&state.pool, workspace, id).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // A run's summary may name Tasks of the scope; an admin outside that scope sees only states.
    let scope = scope_of(&schedule["scope"]);
    let readable = proposals::scope_readable(
        &state.pool,
        workspace,
        actor,
        &json!({"project_ids":scope.projects,"vault_ids":scope.vaults}),
    )
    .await;
    let rows = sqlx::query("SELECT sr.id,sr.scheduled_for::text AS scheduled_for,sr.state,sr.reason,sr.ai_run_id,r.state AS run_state,r.summary,r.usage,r.tool_calls,r.context_characters,(SELECT p.id FROM proposals p WHERE p.ai_run_id=r.id) AS proposal_id FROM ai_schedule_runs sr LEFT JOIN ai_runs r ON r.id=sr.ai_run_id WHERE sr.schedule_id=$1 ORDER BY sr.scheduled_for DESC,sr.id LIMIT 200")
        .bind(id)
        .fetch_all(&state.pool)
        .await;
    match rows {
        Ok(rows) => Json(json!({"runs":rows.iter().map(|row| json!({
            "id":row.get::<Uuid,_>("id"),
            "scheduled_for":row.get::<String,_>("scheduled_for"),
            "state":row.get::<String,_>("state"),
            "reason":row.get::<Option<String>,_>("reason"),
            "run_id":row.get::<Option<Uuid>,_>("ai_run_id"),
            "run_state":row.get::<Option<String>,_>("run_state"),
            "result":row.get::<Option<String>,_>("summary").filter(|_| readable),
            "proposal_id":row.get::<Option<Uuid>,_>("proposal_id"),
            "usage":{"tool_calls":row.get::<Option<i32>,_>("tool_calls"),"characters":row.get::<Option<i32>,_>("context_characters"),"provider":row.get::<Option<Value>,_>("usage")},
        })).collect::<Vec<_>>()})).into_response(),
        Err(_) => internal(),
    }
}

/// Who changed a Schedule and when, newest first.
async fn schedule_audit(
    State(state): State<AuthState>,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    admin_or_return!(state, headers, workspace, false);
    if load(&state.pool, workspace, id).await.is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let rows = sqlx::query("SELECT event,actor_id,created_at::text AS created_at FROM security_audit_events WHERE workspace_id=$1 AND subject_id=$2 AND event LIKE 'ai.schedule.%' ORDER BY id DESC LIMIT 200")
        .bind(workspace)
        .bind(id)
        .fetch_all(&state.pool)
        .await;
    match rows {
        Ok(rows) => Json(json!({"events":rows.iter().map(|row| json!({
            "event":row.get::<String,_>("event"),
            "actor_id":row.get::<Option<Uuid>,_>("actor_id"),
            "created_at":row.get::<String,_>("created_at"),
        })).collect::<Vec<_>>()}))
        .into_response(),
        Err(_) => internal(),
    }
}

// ---- approval queue ----------------------------------------------------------------------

/// Where a Proposal came from, for the label in the approval queue. `null` for a person's run.
pub(crate) async fn origin_of(conn: &mut PgConnection, run: Option<Uuid>) -> Value {
    let Some(run) = run else {
        return Value::Null;
    };
    sqlx::query("SELECT s.id,s.name FROM ai_runs r JOIN ai_schedules s ON s.id=r.schedule_id WHERE r.id=$1")
        .bind(run)
        .fetch_optional(conn)
        .await
        .ok()
        .flatten()
        .map(|row| json!({"kind":"schedule","schedule_id":row.get::<Uuid,_>("id"),"name":row.get::<String,_>("name")}))
        .unwrap_or(Value::Null)
}

/// Proposals waiting for a person, limited to those whose scope the caller can read right now.
async fn proposal_queue(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let actor = match require_session(&state.pool, &headers, false).await {
        Ok((_, actor)) => actor,
        Err(status) => return status.into_response(),
    };
    if !matches!(
        proposals::member(&state.pool, workspace, actor).await,
        Ok(true)
    ) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let rows = sqlx::query("SELECT id,status,scope,jsonb_array_length(items) AS item_count,ai_run_id,created_at::text AS created_at FROM proposals WHERE workspace_id=$1 AND status IN ('pending','ready') ORDER BY created_at DESC,id")
        .bind(workspace)
        .fetch_all(&state.pool)
        .await;
    let Ok(rows) = rows else {
        return internal();
    };
    let Ok(mut conn) = state.pool.acquire().await else {
        return internal();
    };
    let mut queue = Vec::new();
    for row in rows {
        let scope: Value = row.get("scope");
        if !proposals::scope_readable(&state.pool, workspace, actor, &scope).await {
            continue;
        }
        // The limit counts only what the caller can read, so hidden Proposals never crowd it.
        if queue.len() as i64 >= QUEUE_LIMIT {
            break;
        }
        queue.push(json!({
            "id":row.get::<Uuid,_>("id"),
            "status":row.get::<String,_>("status"),
            "items":row.get::<i32,_>("item_count"),
            "created_at":row.get::<String,_>("created_at"),
            "origin":origin_of(&mut conn, row.get("ai_run_id")).await,
        }));
    }
    Json(json!({"proposals":queue})).into_response()
}

// ---- execution ---------------------------------------------------------------------------

pub(crate) fn spawn_worker(pool: PgPool) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(TICK).await;
            let now: Result<String, _> = sqlx::query_scalar("SELECT now()::text")
                .fetch_one(&pool)
                .await;
            let Ok(now) = now else { continue };
            if let Err(error) = run_due_schedules(&pool, &now).await {
                warn!(%error, "scheduled review pass failed");
            }
        }
    });
}

/// Starts every active Schedule that is due at `now` (an RFC 3339 instant passed in, never read
/// from a clock here, so tests control time). Returns how many Schedules were handled. A Schedule
/// that is overdue by several periods runs once, then continues from `now`.
pub async fn run_due_schedules(pool: &PgPool, now: &str) -> Result<usize, sqlx::Error> {
    let due = sqlx::query("SELECT id,workspace_id,principal_id,connection_id,scope,frequency,limits,next_run_at::text AS next_run_at FROM ai_schedules WHERE state='active' AND next_run_at<=$1::timestamptz ORDER BY next_run_at,id")
        .bind(now)
        .fetch_all(pool)
        .await?;
    let mut handled = 0;
    for row in due {
        let id: Uuid = row.get("id");
        let workspace: Uuid = row.get("workspace_id");
        let due_at: String = row.get("next_run_at");
        let Some(frequency) = Frequency::parse(&row.get::<Value, _>("frequency")) else {
            continue;
        };
        let zone = workspace_zone(pool, workspace).await?;
        let next = next_after(pool, now, &zone, &frequency).await?;
        // Claiming moves next_run_at forward in one statement, so two workers never both run it.
        let claimed = sqlx::query("UPDATE ai_schedules SET next_run_at=$3::timestamptz,last_run_at=$4::timestamptz,updated_at=now() WHERE id=$1 AND state='active' AND next_run_at=$2::timestamptz")
            .bind(id)
            .bind(&due_at)
            .bind(&next)
            .bind(now)
            .execute(pool)
            .await?;
        if claimed.rows_affected() != 1 {
            continue;
        }
        handled += 1;
        let schedule_run = Uuid::new_v4();
        let inserted = sqlx::query("INSERT INTO ai_schedule_runs(id,schedule_id,workspace_id,scheduled_for,state) VALUES($1,$2,$3,$4::timestamptz,'started') ON CONFLICT (schedule_id,scheduled_for) DO NOTHING")
            .bind(schedule_run)
            .bind(id)
            .bind(workspace)
            .bind(&due_at)
            .execute(pool)
            .await?;
        if inserted.rows_affected() != 1 {
            continue;
        }
        match start(pool, &row, &zone, now).await {
            Ok(run) => {
                sqlx::query("UPDATE ai_schedule_runs SET ai_run_id=$2 WHERE id=$1")
                    .bind(schedule_run)
                    .bind(run)
                    .execute(pool)
                    .await?;
                // An emergency disable that landed after the claim must not leave a live run.
                let active: bool = sqlx::query_scalar(
                    "SELECT COALESCE((SELECT state='active' FROM ai_schedules WHERE id=$1),false)",
                )
                .bind(id)
                .fetch_one(pool)
                .await?;
                if !active {
                    let mut tx = pool.begin().await?;
                    stop_runs(
                        &mut tx,
                        "schedule_id",
                        id,
                        "Schedule disabled by a Workspace Admin",
                    )
                    .await?;
                    tx.commit().await?;
                }
            }
            Err(Outcome::Skipped(reason)) => {
                finish(pool, schedule_run, "skipped", reason).await?;
            }
            Err(Outcome::Failed(reason)) => {
                finish(pool, schedule_run, "failed", &reason).await?;
            }
            Err(Outcome::Stopped(problem)) => {
                finish(pool, schedule_run, "blocked", &problem.detail).await?;
                halt(pool, id, workspace, &problem).await?;
            }
        }
    }
    Ok(handled)
}

enum Outcome {
    Skipped(&'static str),
    Failed(String),
    Stopped(Stop),
}

async fn finish(
    pool: &PgPool,
    schedule_run: Uuid,
    state: &str,
    reason: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE ai_schedule_runs SET state=$2,reason=$3 WHERE id=$1")
        .bind(schedule_run)
        .bind(state)
        .bind(reason)
        .execute(pool)
        .await?;
    Ok(())
}

/// Stops a Schedule for a visible reason. It stays stopped until an admin enables it again.
async fn halt(pool: &PgPool, id: Uuid, workspace: Uuid, problem: &Stop) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE ai_schedules SET state='stopped',stop_reason=$2,stop_detail=$3,next_run_at=NULL,updated_at=now() WHERE id=$1")
        .bind(id)
        .bind(problem.reason)
        .bind(&problem.detail)
        .execute(&mut *tx)
        .await?;
    audit(
        &mut tx,
        None,
        workspace,
        &format!("ai.schedule.stopped.{}", problem.reason),
        id,
    )
    .await?;
    tx.commit().await
}

async fn start(
    pool: &PgPool,
    row: &sqlx::postgres::PgRow,
    zone: &str,
    now: &str,
) -> Result<Uuid, Outcome> {
    let id: Uuid = row.get("id");
    let workspace: Uuid = row.get("workspace_id");
    let principal: Uuid = row.get("principal_id");
    let connection: Uuid = row.get("connection_id");
    let scope = scope_of(&row.get::<Value, _>("scope"));
    let limits: Value = row.get("limits");
    let db = |_| Outcome::Failed("Schedule state could not be read".into());
    check_ready(pool, workspace, principal, connection, &scope)
        .await
        .map_err(Outcome::Stopped)?;
    let latest = sqlx::query("SELECT r.state,r.summary FROM ai_schedule_runs sr JOIN ai_runs r ON r.id=sr.ai_run_id WHERE sr.schedule_id=$1 ORDER BY sr.scheduled_for DESC LIMIT 1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(db)?;
    if let Some(latest) = latest {
        let state: String = latest.get("state");
        if state == "failed" && latest.get::<String, _>("summary") == BUDGET_EXCEEDED_SUMMARY {
            return Err(Outcome::Stopped(stop(
                "limit_reached",
                "The previous run exceeded its character or tool-call limit",
            )));
        }
        if matches!(state.as_str(), "queued" | "running" | "rate_limited") {
            return Err(Outcome::Skipped("previous_run_still_active"));
        }
    }
    let per_day = limits["runs_per_day"].as_i64().unwrap_or(1);
    let today: i64 = sqlx::query_scalar("SELECT count(*) FROM ai_schedule_runs WHERE schedule_id=$1 AND state='started' AND (scheduled_for AT TIME ZONE $2)::date=($3::timestamptz AT TIME ZONE $2)::date")
        .bind(id)
        .bind(zone)
        .bind(now)
        .fetch_one(pool)
        .await
        .map_err(db)?;
    // This pass's own row is already counted as started, so the limit applies at `>`.
    if today > per_day {
        return Err(Outcome::Stopped(stop(
            "limit_reached",
            "The Schedule reached its runs-per-day limit",
        )));
    }
    let input = CreateInput {
        workspace_id: workspace,
        connection_id: connection,
        capability: Some("progress_review".into()),
        scope,
        prompt: REVIEW_PROMPT.into(),
    };
    let origin = ScheduleOrigin {
        schedule_id: id,
        context_characters: limits["characters"].as_i64().unwrap_or(200_000),
        tool_calls: limits["tool_calls"].as_i64().unwrap_or(40),
    };
    let response = ai_runs::start_run(pool, principal, input, Some(origin)).await;
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap_or_default();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    match status {
        StatusCode::ACCEPTED => body["id"]
            .as_str()
            .and_then(|text| Uuid::parse_str(text).ok())
            .ok_or_else(|| Outcome::Failed("Run was queued without an id".into())),
        StatusCode::FORBIDDEN => Err(Outcome::Stopped(stop(
            "access_lost",
            "The principal may no longer start a review over this scope",
        ))),
        StatusCode::NOT_FOUND | StatusCode::CONFLICT => Err(Outcome::Stopped(stop(
            "connection_unavailable",
            "The Connection is not available to the principal",
        ))),
        StatusCode::TOO_MANY_REQUESTS => Err(Outcome::Stopped(stop(
            "limit_reached",
            "The Connection's own run or usage budget is exhausted",
        ))),
        other => Err(Outcome::Failed(format!(
            "Run could not be started ({})",
            other.as_u16()
        ))),
    }
}
