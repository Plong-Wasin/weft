//! Milestones: delivery points of one Project.
//!
//! Reads follow Project access. Only Project Managers create, edit, change the state of, archive
//! and restore a Milestone. A Task's Milestone is an ordinary Task field written by
//! `tasks::update_task` through the operation ledger; this module owns the Milestone rows, the
//! same-Project rule (`assignable`) and the archive that detaches Tasks.
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{
    auth::{require_session, AuthState},
    projects::{evaluate_access, Role},
};

pub(crate) const STATES: [&str; 4] = ["planned", "active", "completed", "canceled"];
pub(crate) const NAME_LIMIT: usize = 200;
pub(crate) const DESCRIPTION_LIMIT: usize = 20_000;
pub(crate) const COLUMNS: &str = "id,workspace_id,project_id,name,description,target_date::text AS target_date,state,version,created_at::text AS created_at,updated_at::text AS updated_at,archived_at::text AS archived_at";

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route(
            "/projects/:project_id/milestones",
            get(list_milestones).post(create_milestone),
        )
        .route(
            "/milestones/:milestone_id",
            get(read_milestone).patch(update_milestone),
        )
        .route("/milestones/:milestone_id/history", get(milestone_history))
        .route(
            "/milestones/:milestone_id/confirm-delivery",
            post(confirm_delivery),
        )
        .route(
            "/milestones/:milestone_id/undo-delivery",
            post(undo_delivery),
        )
        .route(
            "/milestones/:milestone_id/archive-preview",
            get(archive_preview),
        )
        .route("/milestones/:milestone_id/archive", post(archive_milestone))
        .route("/milestones/:milestone_id/restore", post(restore_milestone))
}

/// Takes the shared row lock on the Milestones of the given Tasks. A Task write that can spawn
/// a next occurrence calls this before it touches the Task row, so every path locks the
/// Milestone first and the Task second, the order confirm delivery uses.
pub(crate) async fn lock_for_tasks(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    tasks: &[Uuid],
) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT id FROM milestones WHERE id IN (SELECT milestone_id FROM tasks WHERE id=ANY($1) AND milestone_id IS NOT NULL) ORDER BY id FOR SHARE")
        .bind(tasks)
        .fetch_all(&mut **tx)
        .await?;
    Ok(())
}

/// True when `milestone` is an active Milestone of `project`. Takes a shared row lock that pairs
/// with the exclusive lock the archive holds, so a Task cannot land on a Milestone being archived.
/// The caller answers `false` with one refusal whether the Milestone is missing, archived, in
/// another Project or in a Project the caller cannot read.
pub(crate) async fn assignable(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    project: Uuid,
    milestone: Uuid,
) -> Result<bool, sqlx::Error> {
    Ok(sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM milestones WHERE id=$1 AND project_id=$2 AND archived_at IS NULL AND state<>'completed' FOR SHARE",
    )
    .bind(milestone)
    .bind(project)
    .fetch_optional(&mut **tx)
    .await?
    .is_some())
}

/// True when `milestone` of `project` is Completed. A Completed Milestone takes no new Tasks until
/// its delivery is undone or its state is changed.
pub(crate) async fn is_completed(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    project: Uuid,
    milestone: Uuid,
) -> Result<bool, sqlx::Error> {
    Ok(sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM milestones WHERE id=$1 AND project_id=$2 AND archived_at IS NULL AND state='completed'",
    )
    .bind(milestone)
    .bind(project)
    .fetch_optional(&mut **tx)
    .await?
    .is_some())
}

/// Progress of one Milestone over its eligible leaf Tasks.
///
/// Eligible: not Archived and not in the `canceled` Status category. A Task with any live (not
/// Archived) direct subtask is a parent and is not counted, wherever the subtasks sit, so work
/// is never counted twice.
/// Task access follows Project access, and a Milestone lives in one Project the caller has already
/// been allowed to read, so every counted Task is readable by the caller. `manager` only decides
/// whether the "ready to confirm delivery" hint is shown.
pub(crate) async fn progress(
    executor: impl sqlx::PgExecutor<'_>,
    milestone: Uuid,
    state: &str,
    manager: bool,
) -> Result<Value, sqlx::Error> {
    let row = sqlx::query("WITH eligible AS (SELECT t.id,t.parent_task_id,s.category FROM tasks t JOIN workspace_statuses s ON s.workspace_id=t.workspace_id AND s.status_key=t.status WHERE t.milestone_id=$1 AND t.archived_at IS NULL AND s.category<>'canceled') SELECT count(*) AS total,count(*) FILTER (WHERE category='completed') AS completed FROM eligible e WHERE NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id=e.id AND c.archived_at IS NULL)")
        .bind(milestone)
        .fetch_one(executor)
        .await?;
    let total: i64 = row.get("total");
    let completed: i64 = row.get("completed");
    let all_done = total > 0 && completed == total;
    Ok(json!({
        "completed":completed,
        "total":total,
        "percent":if total == 0 { Value::Null } else { json!(completed * 100 / total) },
        "status":if total == 0 { "no_work_yet" } else if all_done { "all_completed" } else { "in_progress" },
        "ready_to_confirm":manager && all_done && matches!(state, "planned" | "active"),
    }))
}

/// The Milestone summary shown on a Task. The Milestone lives in the Task's own Project, which the
/// caller has already been allowed to read.
pub(crate) async fn task_summary(pool: &PgPool, task: Uuid) -> Result<Value, sqlx::Error> {
    Ok(sqlx::query("SELECT m.id,m.name,m.state,m.target_date::text AS target_date FROM tasks t JOIN milestones m ON m.id=t.milestone_id WHERE t.id=$1")
        .bind(task)
        .fetch_optional(pool)
        .await?
        .map(|row| json!({"id":row.get::<Uuid,_>("id"),"name":row.get::<String,_>("name"),"state":row.get::<String,_>("state"),"target_date":row.get::<Option<String>,_>("target_date")}))
        .unwrap_or(Value::Null))
}

/// What moving the Task (and its subtasks) to another Project does to Milestones.
pub(crate) async fn move_effect(pool: &PgPool, task: Uuid) -> Result<Value, sqlx::Error> {
    let cleared: i64 = sqlx::query_scalar("WITH RECURSIVE subtree(id) AS (SELECT id FROM tasks WHERE id=$1 UNION ALL SELECT t.id FROM tasks t JOIN subtree s ON t.parent_task_id=s.id) SELECT count(*) FROM tasks WHERE id IN (SELECT id FROM subtree) AND milestone_id IS NOT NULL")
        .bind(task)
        .fetch_one(pool)
        .await?;
    Ok(
        json!({"clears":cleared > 0,"tasks_cleared":cleared,"milestone":task_summary(pool,task).await?}),
    )
}

enum Gate {
    Hidden,
    Forbidden,
    Allowed(crate::projects::ProjectAccess),
}

async fn gate(
    pool: &PgPool,
    project: Uuid,
    user: Uuid,
    manager: bool,
) -> Result<Gate, sqlx::Error> {
    Ok(match evaluate_access(pool, project, user).await? {
        Some(access) if access.role >= Role::Viewer => {
            if manager && access.role != Role::Manager {
                Gate::Forbidden
            } else {
                Gate::Allowed(access)
            }
        }
        _ => Gate::Hidden,
    })
}

fn failed(status: StatusCode) -> Response {
    status.into_response()
}

pub(crate) fn milestone_json(row: &sqlx::postgres::PgRow) -> Value {
    json!({"id":row.get::<Uuid,_>("id"),"workspace_id":row.get::<Uuid,_>("workspace_id"),"project_id":row.get::<Uuid,_>("project_id"),"name":row.get::<String,_>("name"),"description":row.get::<String,_>("description"),"target_date":row.get::<Option<String>,_>("target_date"),"state":row.get::<String,_>("state"),"version":row.get::<i64,_>("version"),"created_at":row.get::<String,_>("created_at"),"updated_at":row.get::<String,_>("updated_at"),"archived":row.get::<Option<String>,_>("archived_at").is_some(),"archived_at":row.get::<Option<String>,_>("archived_at")})
}

/// Dates go through Postgres so every calendar form is accepted or refused the same way.
async fn normalise_date(pool: &PgPool, value: &str) -> Result<Option<String>, sqlx::Error> {
    match sqlx::query_scalar::<_, String>("SELECT $1::date::text")
        .bind(value)
        .fetch_one(pool)
        .await
    {
        Ok(date) => Ok(Some(date)),
        Err(error)
            if error
                .as_database_error()
                .and_then(|e| e.code())
                .is_some_and(|code| code.starts_with("22")) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

pub(crate) async fn record_event(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    milestone: Uuid,
    project: Uuid,
    actor: Uuid,
    kind: &str,
    before: Value,
    after: Value,
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO milestone_events(id,milestone_id,project_id,actor_id,kind,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6,$7)")
        .bind(Uuid::new_v4())
        .bind(milestone)
        .bind(project)
        .bind(actor)
        .bind(kind)
        .bind(before)
        .bind(after)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

#[derive(Deserialize)]
struct ListQuery {
    include_archived: Option<bool>,
}

async fn list_milestones(
    State(state): State<AuthState>,
    Path(project): Path<Uuid>,
    Query(query): Query<ListQuery>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let manager = match gate(&state.pool, project, user, false).await {
        Ok(Gate::Allowed(access)) => access.role == Role::Manager,
        Ok(_) => return failed(StatusCode::NOT_FOUND),
        Err(_) => return failed(StatusCode::INTERNAL_SERVER_ERROR),
    };
    let rows = sqlx::query(&format!("SELECT {COLUMNS},(SELECT count(*) FROM tasks t WHERE t.milestone_id=milestones.id AND t.archived_at IS NULL) AS task_count,(SELECT e.kind FROM milestone_events e WHERE e.milestone_id=milestones.id ORDER BY e.created_at DESC,e.id DESC LIMIT 1) AS last_event FROM milestones WHERE project_id=$1 AND ($2 OR archived_at IS NULL) ORDER BY target_date NULLS LAST,created_at,id"))
        .bind(project)
        .bind(query.include_archived.unwrap_or(false))
        .fetch_all(&state.pool)
        .await;
    let Ok(rows) = rows else {
        return failed(StatusCode::INTERNAL_SERVER_ERROR);
    };
    let mut milestones = Vec::new();
    for row in &rows {
        let mut value = milestone_json(row);
        value["task_count"] = json!(row.get::<i64, _>("task_count"));
        value["can_undo_delivery"] = json!(
            row.get::<String, _>("state") == "completed"
                && row.get::<Option<String>, _>("last_event").as_deref()
                    == Some("delivery_confirmed")
        );
        match progress(
            &state.pool,
            row.get("id"),
            row.get::<String, _>("state").as_str(),
            manager,
        )
        .await
        {
            Ok(progress) => value["progress"] = progress,
            Err(_) => return failed(StatusCode::INTERNAL_SERVER_ERROR),
        }
        milestones.push(value);
    }
    Json(json!({"milestones":milestones})).into_response()
}

#[derive(Deserialize)]
struct NewMilestone {
    name: String,
    description: Option<String>,
    target_date: Option<String>,
    state: Option<String>,
}

pub(crate) struct Seed<'a> {
    pub name: &'a str,
    pub description: &'a str,
    pub target_date: Option<&'a str>,
    pub state: &'a str,
    pub group: Option<Uuid>,
}

/// Inserts a Milestone and its `created` event inside the caller's transaction. `group` marks a
/// Milestone made by an operation group (a Project template) so that group's Undo can find it.
pub(crate) async fn create_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace: Uuid,
    project: Uuid,
    user: Uuid,
    seed: &Seed<'_>,
) -> Result<Value, sqlx::Error> {
    let id = Uuid::new_v4();
    let row = sqlx::query(&format!("INSERT INTO milestones(id,workspace_id,project_id,name,description,target_date,state,created_by) VALUES($1,$2,$3,$4,$5,$6::date,$7,$8) RETURNING {COLUMNS}"))
        .bind(id)
        .bind(workspace)
        .bind(project)
        .bind(seed.name)
        .bind(seed.description)
        .bind(seed.target_date)
        .bind(seed.state)
        .bind(user)
        .fetch_one(&mut **tx)
        .await?;
    let value = milestone_json(&row);
    let mut after = value.clone();
    if let Some(group) = seed.group {
        after["group_id"] = json!(group);
    }
    record_event(tx, id, project, user, "created", Value::Null, after).await?;
    Ok(value)
}

/// Archives or restores the Milestones a template group created, with the Project they live in.
pub(crate) async fn set_group_archived(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    group: Uuid,
    user: Uuid,
    archive: bool,
) -> Result<(), sqlx::Error> {
    let rows = sqlx::query("SELECT e.milestone_id,e.project_id FROM milestone_events e WHERE e.kind='created' AND e.after_value->>'group_id'=$1 ORDER BY e.created_at,e.id")
        .bind(group.to_string())
        .fetch_all(&mut **tx)
        .await?;
    for row in rows {
        let (milestone, project): (Uuid, Uuid) = (row.get("milestone_id"), row.get("project_id"));
        let sql = if archive {
            "UPDATE milestones SET archived_at=now(),version=version+1,updated_at=now() WHERE id=$1 AND archived_at IS NULL RETURNING id"
        } else {
            "UPDATE milestones SET archived_at=NULL,version=version+1,updated_at=now() WHERE id=$1 AND archived_at IS NOT NULL RETURNING id"
        };
        let changed = sqlx::query(sql)
            .bind(milestone)
            .fetch_optional(&mut **tx)
            .await?;
        if changed.is_some() {
            record_event(
                tx,
                milestone,
                project,
                user,
                if archive { "archived" } else { "restored" },
                json!({"group_id":group}),
                Value::Null,
            )
            .await?;
        }
    }
    Ok(())
}

/// Open Milestones of the Project that the group did not create.
pub(crate) async fn foreign_open_count(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    project: Uuid,
    group: Uuid,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT count(*) FROM milestones m WHERE m.project_id=$1 AND m.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM milestone_events e WHERE e.milestone_id=m.id AND e.kind='created' AND e.after_value->>'group_id'=$2)")
        .bind(project)
        .bind(group.to_string())
        .fetch_one(&mut **tx)
        .await
}

async fn create_milestone(
    State(state): State<AuthState>,
    Path(project): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<NewMilestone>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let access = match gate(&state.pool, project, user, true).await {
        Ok(Gate::Allowed(access)) => access,
        Ok(Gate::Forbidden) => return failed(StatusCode::FORBIDDEN),
        Ok(Gate::Hidden) => return failed(StatusCode::NOT_FOUND),
        Err(_) => return failed(StatusCode::INTERNAL_SERVER_ERROR),
    };
    let name = input.name.trim().to_owned();
    let description = input.description.unwrap_or_default();
    let milestone_state = input.state.unwrap_or_else(|| "planned".into());
    if name.is_empty()
        || name.chars().count() > NAME_LIMIT
        || description.chars().count() > DESCRIPTION_LIMIT
        || !STATES.contains(&milestone_state.as_str())
    {
        return failed(StatusCode::UNPROCESSABLE_ENTITY);
    }
    let date = match input.target_date.as_deref() {
        Some(value) => match normalise_date(&state.pool, value).await {
            Ok(Some(date)) => Some(date),
            Ok(None) => return failed(StatusCode::UNPROCESSABLE_ENTITY),
            Err(_) => return failed(StatusCode::INTERNAL_SERVER_ERROR),
        },
        None => None,
    };
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return failed(StatusCode::INTERNAL_SERVER_ERROR),
    };
    let seed = Seed {
        name: &name,
        description: &description,
        target_date: date.as_deref(),
        state: &milestone_state,
        group: None,
    };
    let Ok(value) = create_in_tx(&mut tx, access.workspace_id, project, user, &seed).await else {
        return failed(StatusCode::INTERNAL_SERVER_ERROR);
    };
    if tx.commit().await.is_err() {
        return failed(StatusCode::INTERNAL_SERVER_ERROR);
    }
    (StatusCode::CREATED, Json(value)).into_response()
}

/// Loads a Milestone and the caller's gate in one step; unreadable and missing look the same.
async fn load(
    pool: &PgPool,
    milestone: Uuid,
    user: Uuid,
    manager: bool,
) -> Result<Result<(sqlx::postgres::PgRow, Uuid), Response>, sqlx::Error> {
    let Some(row) = sqlx::query(&format!("SELECT {COLUMNS} FROM milestones WHERE id=$1"))
        .bind(milestone)
        .fetch_optional(pool)
        .await?
    else {
        return Ok(Err(failed(StatusCode::NOT_FOUND)));
    };
    let project: Uuid = row.get("project_id");
    Ok(match gate(pool, project, user, manager).await? {
        Gate::Allowed(_) => Ok((row, project)),
        Gate::Forbidden => Err(failed(StatusCode::FORBIDDEN)),
        Gate::Hidden => Err(failed(StatusCode::NOT_FOUND)),
    })
}

async fn read_milestone(
    State(state): State<AuthState>,
    Path(milestone): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    match load(&state.pool, milestone, user, false).await {
        Ok(Ok((row, project))) => {
            let manager = is_manager(&state.pool, project, user).await;
            let mut value = milestone_json(&row);
            match progress(
                &state.pool,
                milestone,
                row.get::<String, _>("state").as_str(),
                manager,
            )
            .await
            {
                Ok(progress) => value["progress"] = progress,
                Err(_) => return failed(StatusCode::INTERNAL_SERVER_ERROR),
            }
            Json(value).into_response()
        }
        Ok(Err(response)) => response,
        Err(_) => failed(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

async fn is_manager(pool: &PgPool, project: Uuid, user: Uuid) -> bool {
    matches!(gate(pool, project, user, true).await, Ok(Gate::Allowed(_)))
}

#[derive(Deserialize)]
struct DeliveryInput {
    expected_version: i64,
}

/// Why a delivery change is refused, or the locked row to change.
enum Delivery {
    Conflict(&'static str),
    Locked,
}

/// Locks the Milestone and checks version, archived state and the `required` state rule.
async fn lock_delivery(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    milestone: Uuid,
    version: i64,
    undo: bool,
) -> Result<Delivery, sqlx::Error> {
    let row = sqlx::query("SELECT version,state,archived_at IS NOT NULL AS archived FROM milestones WHERE id=$1 FOR UPDATE")
        .bind(milestone)
        .fetch_one(&mut **tx)
        .await?;
    if row.get::<bool, _>("archived") {
        return Ok(Delivery::Conflict("milestone_archived"));
    }
    if row.get::<i64, _>("version") != version {
        return Ok(Delivery::Conflict("version_conflict"));
    }
    let state: String = row.get("state");
    if undo {
        if state != "completed" {
            return Ok(Delivery::Conflict("not_confirmed"));
        }
        let confirmed: bool = sqlx::query_scalar("SELECT (SELECT kind FROM milestone_events WHERE milestone_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1)='delivery_confirmed'")
            .bind(milestone)
            .fetch_one(&mut **tx)
            .await?;
        if !confirmed {
            return Ok(Delivery::Conflict("not_confirmed"));
        }
    } else if !matches!(state.as_str(), "planned" | "active") {
        return Ok(Delivery::Conflict("not_ready"));
    }
    Ok(Delivery::Locked)
}

async fn confirm_delivery(
    state: State<AuthState>,
    path: Path<Uuid>,
    headers: HeaderMap,
    input: Json<DeliveryInput>,
) -> Response {
    change_delivery(state, path, headers, input, false).await
}

async fn undo_delivery(
    state: State<AuthState>,
    path: Path<Uuid>,
    headers: HeaderMap,
    input: Json<DeliveryInput>,
) -> Response {
    change_delivery(state, path, headers, input, true).await
}

/// A Manager moves a Milestone to Completed once every eligible Task is completed, or moves it
/// back to the state it had. Both write a Milestone event and bump the version.
async fn change_delivery(
    State(state): State<AuthState>,
    Path(milestone): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<DeliveryInput>,
    undo: bool,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let (_, project) = match load(&state.pool, milestone, user, true).await {
        Ok(Ok(found)) => found,
        Ok(Err(response)) => return response,
        Err(_) => return failed(StatusCode::INTERNAL_SERVER_ERROR),
    };
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return failed(StatusCode::INTERNAL_SERVER_ERROR),
    };
    match lock_delivery(&mut tx, milestone, input.expected_version, undo).await {
        Ok(Delivery::Locked) => {}
        Ok(Delivery::Conflict(error)) => {
            return (StatusCode::CONFLICT, Json(json!({"error":error}))).into_response()
        }
        Err(_) => return failed(StatusCode::INTERNAL_SERVER_ERROR),
    }
    let outcome = async {
        if !undo {
            // Pairs with Task writes so a status change in flight cannot slip past the count.
            sqlx::query("SELECT id FROM tasks WHERE milestone_id=$1 AND archived_at IS NULL ORDER BY id FOR SHARE")
                .bind(milestone)
                .fetch_all(&mut *tx)
                .await?;
        }
        let before = milestone_json(
            &sqlx::query(&format!("SELECT {COLUMNS} FROM milestones WHERE id=$1"))
                .bind(milestone)
                .fetch_one(&mut *tx)
                .await?,
        );
        let next = if undo {
            // The state a delivery confirmation replaced, recorded in the event it wrote.
            sqlx::query_scalar::<_, String>("SELECT before_value->>'state' FROM milestone_events WHERE milestone_id=$1 AND kind='delivery_confirmed' ORDER BY created_at DESC,id DESC LIMIT 1")
                .bind(milestone)
                .fetch_one(&mut *tx)
                .await?
        } else {
            let status = progress(&mut *tx, milestone, "", false).await?;
            if status["status"] != "all_completed" {
                return Ok(None);
            }
            "completed".to_owned()
        };
        let row = sqlx::query(&format!("UPDATE milestones SET state=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING {COLUMNS}"))
            .bind(milestone)
            .bind(&next)
            .fetch_one(&mut *tx)
            .await?;
        let after = milestone_json(&row);
        let kind = if undo { "delivery_undone" } else { "delivery_confirmed" };
        record_event(&mut tx, milestone, project, user, kind, before, after.clone()).await?;
        Ok::<Option<Value>, sqlx::Error>(Some(after))
    }
    .await;
    match outcome {
        Ok(Some(mut value)) => {
            value["progress"] = match progress_for(&mut tx, milestone, &value).await {
                Ok(v) => v,
                Err(_) => return failed(StatusCode::INTERNAL_SERVER_ERROR),
            };
            if tx.commit().await.is_err() {
                return failed(StatusCode::INTERNAL_SERVER_ERROR);
            }
            Json(value).into_response()
        }
        Ok(None) => (StatusCode::CONFLICT, Json(json!({"error":"not_ready"}))).into_response(),
        Err(_) => failed(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

async fn progress_for(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    milestone: Uuid,
    value: &Value,
) -> Result<Value, sqlx::Error> {
    progress(
        &mut **tx,
        milestone,
        value["state"].as_str().unwrap_or(""),
        true,
    )
    .await
}

fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
struct MilestoneUpdate {
    expected_version: i64,
    name: Option<String>,
    description: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    target_date: Option<Option<String>>,
    state: Option<String>,
}

async fn update_milestone(
    State(state): State<AuthState>,
    Path(milestone): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<MilestoneUpdate>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let (existing, project) = match load(&state.pool, milestone, user, true).await {
        Ok(Ok(found)) => found,
        Ok(Err(response)) => return response,
        Err(_) => return failed(StatusCode::INTERNAL_SERVER_ERROR),
    };
    let name = input.name.as_ref().map(|v| v.trim().to_owned());
    if name
        .as_deref()
        .is_some_and(|v| v.is_empty() || v.chars().count() > NAME_LIMIT)
        || input
            .description
            .as_ref()
            .is_some_and(|v| v.chars().count() > DESCRIPTION_LIMIT)
        || input.state.as_deref().is_some_and(|v| !STATES.contains(&v))
        || (name.is_none()
            && input.description.is_none()
            && input.target_date.is_none()
            && input.state.is_none())
    {
        return failed(StatusCode::UNPROCESSABLE_ENTITY);
    }
    let date = match input.target_date.as_ref() {
        Some(Some(value)) => match normalise_date(&state.pool, value).await {
            Ok(Some(date)) => Some(Some(date)),
            Ok(None) => return failed(StatusCode::UNPROCESSABLE_ENTITY),
            Err(_) => return failed(StatusCode::INTERNAL_SERVER_ERROR),
        },
        Some(None) => Some(None),
        None => None,
    };
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return failed(StatusCode::INTERNAL_SERVER_ERROR),
    };
    let locked = sqlx::query(
        "SELECT version,archived_at IS NOT NULL AS archived FROM milestones WHERE id=$1 FOR UPDATE",
    )
    .bind(milestone)
    .fetch_one(&mut *tx)
    .await;
    let Ok(locked) = locked else {
        return failed(StatusCode::INTERNAL_SERVER_ERROR);
    };
    if locked.get::<i64, _>("version") != input.expected_version
        || locked.get::<bool, _>("archived")
    {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error": if locked.get::<bool,_>("archived") {"milestone_archived"} else {"version_conflict"},"current":milestone_json(&existing)})),
        )
            .into_response();
    }
    let before = milestone_json(&existing);
    let updated = sqlx::query(&format!("UPDATE milestones SET name=COALESCE($2,name),description=COALESCE($3,description),target_date=CASE WHEN $4 THEN $5::date ELSE target_date END,state=COALESCE($6,state),version=version+1,updated_at=now() WHERE id=$1 RETURNING {COLUMNS}"))
        .bind(milestone)
        .bind(name)
        .bind(input.description)
        .bind(date.is_some())
        .bind(date.flatten())
        .bind(input.state)
        .fetch_one(&mut *tx)
        .await;
    let Ok(row) = updated else {
        return failed(StatusCode::INTERNAL_SERVER_ERROR);
    };
    let after = milestone_json(&row);
    let kind = if before["state"] != after["state"]
        && before["name"] == after["name"]
        && before["description"] == after["description"]
        && before["target_date"] == after["target_date"]
    {
        "state_changed"
    } else {
        "updated"
    };
    if record_event(
        &mut tx,
        milestone,
        project,
        user,
        kind,
        before,
        after.clone(),
    )
    .await
    .is_err()
        || tx.commit().await.is_err()
    {
        return failed(StatusCode::INTERNAL_SERVER_ERROR);
    }
    Json(after).into_response()
}

async fn milestone_history(
    State(state): State<AuthState>,
    Path(milestone): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    if let Err(response) = match load(&state.pool, milestone, user, false).await {
        Ok(found) => found.map(|_| ()),
        Err(_) => return failed(StatusCode::INTERNAL_SERVER_ERROR),
    } {
        return response;
    }
    match sqlx::query("SELECT id,actor_id,kind,before_value,after_value,created_at::text AS created_at FROM milestone_events WHERE milestone_id=$1 ORDER BY created_at,id")
        .bind(milestone)
        .fetch_all(&state.pool)
        .await
    {
        Ok(rows) => Json(json!({"events":rows.into_iter().map(|row| json!({"id":row.get::<Uuid,_>("id"),"actor_id":row.get::<Option<Uuid>,_>("actor_id"),"kind":row.get::<String,_>("kind"),"before":row.get::<Value,_>("before_value"),"after":row.get::<Value,_>("after_value"),"created_at":row.get::<String,_>("created_at")})).collect::<Vec<_>>()})).into_response(),
        Err(_) => failed(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

async fn archive_preview(
    State(state): State<AuthState>,
    Path(milestone): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    if let Err(response) = match load(&state.pool, milestone, user, true).await {
        Ok(found) => found.map(|_| ()),
        Err(_) => return failed(StatusCode::INTERNAL_SERVER_ERROR),
    } {
        return response;
    }
    match sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM tasks WHERE milestone_id=$1 AND archived_at IS NULL",
    )
    .bind(milestone)
    .fetch_one(&state.pool)
    .await
    {
        Ok(count) => Json(json!({"milestone_id":milestone,"task_count":count})).into_response(),
        Err(_) => failed(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

#[derive(Deserialize)]
struct ArchiveInput {
    detach_tasks: Option<bool>,
}

/// Moves each listed Task to `target` as one 'recorded' group: visible in Task History, never the
/// actor's undo target (the same shape as a Status replacement).
async fn restate_milestone(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace: Uuid,
    user: Uuid,
    tasks: &[Uuid],
    from: Option<Uuid>,
    to: Option<Uuid>,
) -> Result<(), sqlx::Error> {
    if tasks.is_empty() {
        return Ok(());
    }
    let group = Uuid::new_v4();
    sqlx::query("INSERT INTO task_operation_groups(id,command_id,workspace_id,actor_id,state) VALUES($1,$2,$3,$4,'recorded')")
        .bind(group)
        .bind(Uuid::new_v4())
        .bind(workspace)
        .bind(user)
        .execute(&mut **tx)
        .await?;
    for task in tasks {
        let version: i64 = sqlx::query_scalar("UPDATE tasks SET milestone_id=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING version")
            .bind(task)
            .bind(to)
            .fetch_one(&mut **tx)
            .await?;
        sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,'milestone_id',$4,$5,$6)")
            .bind(Uuid::new_v4())
            .bind(group)
            .bind(task)
            .bind(json!(from))
            .bind(json!(to))
            .bind(version)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

async fn archive_milestone(
    State(state): State<AuthState>,
    Path(milestone): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<ArchiveInput>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let (existing, project) = match load(&state.pool, milestone, user, true).await {
        Ok(Ok(found)) => found,
        Ok(Err(response)) => return response,
        Err(_) => return failed(StatusCode::INTERNAL_SERVER_ERROR),
    };
    let workspace: Uuid = existing.get("workspace_id");
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return failed(StatusCode::INTERNAL_SERVER_ERROR),
    };
    // Same order as a Task write: Milestone row first, then Task rows.
    let archived: bool = match sqlx::query_scalar(
        "SELECT archived_at IS NOT NULL FROM milestones WHERE id=$1 FOR UPDATE",
    )
    .bind(milestone)
    .fetch_one(&mut *tx)
    .await
    {
        Ok(v) => v,
        Err(_) => return failed(StatusCode::INTERNAL_SERVER_ERROR),
    };
    if archived {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"milestone_archived"})),
        )
            .into_response();
    }
    let tasks: Vec<Uuid> = match sqlx::query_scalar(
        "SELECT id FROM tasks WHERE milestone_id=$1 AND archived_at IS NULL ORDER BY id FOR UPDATE",
    )
    .bind(milestone)
    .fetch_all(&mut *tx)
    .await
    {
        Ok(v) => v,
        Err(_) => return failed(StatusCode::INTERNAL_SERVER_ERROR),
    };
    if !tasks.is_empty() && input.detach_tasks != Some(true) {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({"error":"detach_required","task_count":tasks.len()})),
        )
            .into_response();
    }
    let outcome = async {
        restate_milestone(&mut tx, workspace, user, &tasks, Some(milestone), None).await?;
        sqlx::query("INSERT INTO milestone_archive_detached(milestone_id,task_id) SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING")
            .bind(milestone)
            .bind(&tasks)
            .execute(&mut *tx)
            .await?;
        let row = sqlx::query(&format!("UPDATE milestones SET archived_at=now(),version=version+1,updated_at=now() WHERE id=$1 RETURNING {COLUMNS}"))
            .bind(milestone)
            .fetch_one(&mut *tx)
            .await?;
        let after = milestone_json(&row);
        record_event(&mut tx, milestone, project, user, "archived", json!({"task_count":tasks.len()}), after.clone()).await?;
        Ok::<Value, sqlx::Error>(after)
    }
    .await;
    match outcome {
        Ok(mut value) => {
            if tx.commit().await.is_err() {
                return failed(StatusCode::INTERNAL_SERVER_ERROR);
            }
            value["detached_tasks"] = json!(tasks.len());
            Json(value).into_response()
        }
        Err(_) => failed(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

#[derive(Deserialize)]
struct RestoreInput {
    reattach_tasks: Option<bool>,
}

async fn restore_milestone(
    State(state): State<AuthState>,
    Path(milestone): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<RestoreInput>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let (existing, project) = match load(&state.pool, milestone, user, true).await {
        Ok(Ok(found)) => found,
        Ok(Err(response)) => return response,
        Err(_) => return failed(StatusCode::INTERNAL_SERVER_ERROR),
    };
    let workspace: Uuid = existing.get("workspace_id");
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return failed(StatusCode::INTERNAL_SERVER_ERROR),
    };
    let archived: bool = match sqlx::query_scalar(
        "SELECT archived_at IS NOT NULL FROM milestones WHERE id=$1 FOR UPDATE",
    )
    .bind(milestone)
    .fetch_one(&mut *tx)
    .await
    {
        Ok(v) => v,
        Err(_) => return failed(StatusCode::INTERNAL_SERVER_ERROR),
    };
    if !archived {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"milestone_not_archived"})),
        )
            .into_response();
    }
    let outcome = async {
        let tasks: Vec<Uuid> = if input.reattach_tasks == Some(true) {
            sqlx::query_scalar("SELECT t.id FROM milestone_archive_detached d JOIN tasks t ON t.id=d.task_id WHERE d.milestone_id=$1 AND t.project_id=$2 AND t.archived_at IS NULL AND t.milestone_id IS NULL ORDER BY t.id FOR UPDATE OF t")
                .bind(milestone)
                .bind(project)
                .fetch_all(&mut *tx)
                .await?
        } else {
            Vec::new()
        };
        restate_milestone(&mut tx, workspace, user, &tasks, None, Some(milestone)).await?;
        sqlx::query("DELETE FROM milestone_archive_detached WHERE milestone_id=$1")
            .bind(milestone)
            .execute(&mut *tx)
            .await?;
        let row = sqlx::query(&format!("UPDATE milestones SET archived_at=NULL,version=version+1,updated_at=now() WHERE id=$1 RETURNING {COLUMNS}"))
            .bind(milestone)
            .fetch_one(&mut *tx)
            .await?;
        let after = milestone_json(&row);
        record_event(&mut tx, milestone, project, user, "restored", json!({"reattached_tasks":tasks.len()}), after.clone()).await?;
        Ok::<(Value, usize), sqlx::Error>((after, tasks.len()))
    }
    .await;
    match outcome {
        Ok((mut value, count)) => {
            if tx.commit().await.is_err() {
                return failed(StatusCode::INTERNAL_SERVER_ERROR);
            }
            value["reattached_tasks"] = json!(count);
            Json(value).into_response()
        }
        Err(_) => failed(StatusCode::INTERNAL_SERVER_ERROR),
    }
}
