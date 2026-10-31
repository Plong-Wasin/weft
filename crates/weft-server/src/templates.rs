//! Task and Project templates: Workspace Admins keep a library of recipes, and any member creates
//! Tasks (or a whole Project) from one inside their own access. A template never carries access: it
//! has no members, Teams or visibility, and a Project made from one gets its creator as the only
//! Manager. Creating runs as one operation group, so one Undo archives everything it made.
use std::collections::{HashMap, HashSet};

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{
    auth::{require_session, AuthState},
    projects::{evaluate_access, Role},
};

const MAX_ITEMS: usize = 50;
const MAX_CHECKLIST: usize = 100;
const MAX_TEXT: usize = 500;
const MAX_DESCRIPTION: usize = 20_000;
const MAX_OFFSET_DAYS: i32 = 3650;

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route(
            "/workspaces/:workspace_id/task-templates",
            get(list_task_templates).post(create_task_template),
        )
        .route(
            "/workspaces/:workspace_id/task-templates/:template_id",
            get(read_task_template)
                .patch(update_task_template)
                .delete(delete_task_template),
        )
        .route(
            "/workspaces/:workspace_id/task-templates/:template_id/instantiate",
            axum::routing::post(instantiate_task_template),
        )
        .route(
            "/workspaces/:workspace_id/project-templates",
            get(list_project_templates).post(create_project_template),
        )
        .route(
            "/workspaces/:workspace_id/project-templates/:template_id",
            get(read_project_template)
                .patch(update_project_template)
                .delete(delete_project_template),
        )
        .route(
            "/workspaces/:workspace_id/project-templates/:template_id/instantiate",
            axum::routing::post(instantiate_project_template),
        )
}

fn default_priority() -> String {
    "normal".into()
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SubtaskDoc {
    title_pattern: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    checklist: Vec<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct AttributeDoc {
    attribute_id: Uuid,
    value: Value,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct TaskTemplateDoc {
    name: String,
    title_pattern: String,
    #[serde(default)]
    description: String,
    #[serde(default = "default_priority")]
    priority: String,
    #[serde(default)]
    default_status: Option<String>,
    #[serde(default)]
    checklist: Vec<String>,
    #[serde(default)]
    subtasks: Vec<SubtaskDoc>,
    #[serde(default)]
    attributes: Vec<AttributeDoc>,
}

fn text_ok(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.chars().count() <= max
}

fn checklist_ok(items: &[String]) -> bool {
    items.len() <= MAX_CHECKLIST && items.iter().all(|item| text_ok(item, MAX_TEXT))
}

impl TaskTemplateDoc {
    fn valid(&self) -> bool {
        text_ok(&self.name, MAX_TEXT)
            && text_ok(&self.title_pattern, MAX_TEXT)
            && self.description.chars().count() <= MAX_DESCRIPTION
            && ["low", "normal", "high", "urgent"].contains(&self.priority.as_str())
            && self
                .default_status
                .as_deref()
                .is_none_or(|s| text_ok(s, MAX_TEXT))
            && checklist_ok(&self.checklist)
            && self.subtasks.len() <= MAX_ITEMS
            && self.subtasks.iter().all(|s| {
                text_ok(&s.title_pattern, MAX_TEXT)
                    && s.description.chars().count() <= MAX_DESCRIPTION
                    && s.status.as_deref().is_none_or(|v| text_ok(v, MAX_TEXT))
                    && checklist_ok(&s.checklist)
            })
            && self.attributes.len() <= MAX_ITEMS
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct MilestoneDoc {
    name: String,
    #[serde(default)]
    description: String,
    offset_days: i32,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ProjectTemplateDoc {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    statuses: Vec<String>,
    #[serde(default)]
    milestones: Vec<MilestoneDoc>,
    #[serde(default)]
    task_templates: Vec<Uuid>,
}

impl ProjectTemplateDoc {
    fn valid(&self) -> bool {
        text_ok(&self.name, MAX_TEXT)
            && self.description.chars().count() <= MAX_DESCRIPTION
            && self.statuses.len() <= MAX_ITEMS
            && self.statuses.iter().all(|s| text_ok(s, MAX_TEXT))
            && self.milestones.len() <= MAX_ITEMS
            && self.milestones.iter().all(|m| {
                text_ok(&m.name, MAX_TEXT)
                    && m.description.chars().count() <= MAX_DESCRIPTION
                    && (-MAX_OFFSET_DAYS..=MAX_OFFSET_DAYS).contains(&m.offset_days)
            })
            && self.task_templates.len() <= MAX_ITEMS
    }
}

fn internal() -> Response {
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}

fn unprocessable() -> Response {
    StatusCode::UNPROCESSABLE_ENTITY.into_response()
}

async fn workspace_role(
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

/// A member of the Workspace (any role) who may read the library.
async fn reader(
    state: &AuthState,
    headers: &HeaderMap,
    workspace: Uuid,
) -> Result<Uuid, StatusCode> {
    let (_, user) = require_session(&state.pool, headers, false).await?;
    match workspace_role(&state.pool, workspace, user).await {
        Ok(Some(_)) => Ok(user),
        Ok(None) => Err(StatusCode::NOT_FOUND),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

/// Only an owner or admin changes the library; checked on every request so a revoked Admin loses it at once.
async fn admin(
    state: &AuthState,
    headers: &HeaderMap,
    workspace: Uuid,
) -> Result<Uuid, StatusCode> {
    let (_, user) = require_session(&state.pool, headers, true).await?;
    match workspace_role(&state.pool, workspace, user).await {
        Ok(Some(role)) if role == "owner" || role == "admin" => Ok(user),
        Ok(_) => Err(StatusCode::FORBIDDEN),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

#[derive(Clone, Copy)]
enum Kind {
    Task,
    Project,
}

impl Kind {
    fn table(self) -> &'static str {
        match self {
            Kind::Task => "task_templates",
            Kind::Project => "project_templates",
        }
    }
    fn doc_columns(self) -> &'static str {
        match self {
            Kind::Task => "to_jsonb(t) - 'id' - 'workspace_id' - 'created_by' - 'created_at' - 'updated_at' - 'version'",
            Kind::Project => "to_jsonb(t) - 'id' - 'workspace_id' - 'created_by' - 'created_at' - 'updated_at' - 'version'",
        }
    }
}

async fn list(kind: Kind, state: AuthState, workspace: Uuid, headers: HeaderMap) -> Response {
    if let Err(status) = reader(&state, &headers, workspace).await {
        return status.into_response();
    }
    let sql = format!(
        "SELECT to_jsonb(t) - 'workspace_id' - 'created_by' FROM {} t WHERE workspace_id=$1 ORDER BY name,id",
        kind.table()
    );
    match sqlx::query_scalar::<_, Value>(&sql)
        .bind(workspace)
        .fetch_all(&state.pool)
        .await
    {
        Ok(templates) => Json(json!({"templates": templates})).into_response(),
        Err(_) => internal(),
    }
}

async fn read(
    kind: Kind,
    state: AuthState,
    workspace: Uuid,
    id: Uuid,
    headers: HeaderMap,
) -> Response {
    if let Err(status) = reader(&state, &headers, workspace).await {
        return status.into_response();
    }
    let sql = format!(
        "SELECT to_jsonb(t) - 'workspace_id' - 'created_by' FROM {} t WHERE workspace_id=$1 AND id=$2",
        kind.table()
    );
    match sqlx::query_scalar::<_, Value>(&sql)
        .bind(workspace)
        .bind(id)
        .fetch_optional(&state.pool)
        .await
    {
        Ok(Some(template)) => Json(template).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => internal(),
    }
}

async fn delete(
    kind: Kind,
    state: AuthState,
    workspace: Uuid,
    id: Uuid,
    headers: HeaderMap,
) -> Response {
    if let Err(status) = admin(&state, &headers, workspace).await {
        return status.into_response();
    }
    let sql = format!(
        "DELETE FROM {} WHERE workspace_id=$1 AND id=$2",
        kind.table()
    );
    match sqlx::query(&sql)
        .bind(workspace)
        .bind(id)
        .execute(&state.pool)
        .await
    {
        Ok(result) if result.rows_affected() == 1 => StatusCode::NO_CONTENT.into_response(),
        Ok(_) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => internal(),
    }
}

/// PATCH merges the provided fields over the stored document and validates the whole result, so a
/// partial edit can never store something a create would have refused.
async fn merged_patch(
    kind: Kind,
    state: &AuthState,
    workspace: Uuid,
    id: Uuid,
    mut patch: Value,
) -> Result<(Value, Option<i64>), StatusCode> {
    let Some(fields) = patch.as_object_mut() else {
        return Err(StatusCode::UNPROCESSABLE_ENTITY);
    };
    let expected = match fields.remove("expected_version") {
        None => None,
        Some(value) => Some(value.as_i64().ok_or(StatusCode::UNPROCESSABLE_ENTITY)?),
    };
    let sql = format!(
        "SELECT {} FROM {} t WHERE workspace_id=$1 AND id=$2",
        kind.doc_columns(),
        kind.table()
    );
    let mut current = match sqlx::query_scalar::<_, Value>(&sql)
        .bind(workspace)
        .bind(id)
        .fetch_optional(&state.pool)
        .await
    {
        Ok(Some(current)) => current,
        Ok(None) => return Err(StatusCode::NOT_FOUND),
        Err(_) => return Err(StatusCode::INTERNAL_SERVER_ERROR),
    };
    let target = current.as_object_mut().expect("document is an object");
    for (key, value) in std::mem::take(fields) {
        target.insert(key, value);
    }
    Ok((current, expected))
}

async fn create_task_template(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
    Json(doc): Json<TaskTemplateDoc>,
) -> Response {
    let user = match admin(&state, &headers, workspace).await {
        Ok(user) => user,
        Err(status) => return status.into_response(),
    };
    if !doc.valid() {
        return unprocessable();
    }
    let id = Uuid::new_v4();
    let result = sqlx::query("INSERT INTO task_templates(id,workspace_id,name,title_pattern,description,priority,default_status,checklist,subtasks,attributes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)")
        .bind(id).bind(workspace).bind(doc.name.trim()).bind(doc.title_pattern.trim()).bind(&doc.description).bind(&doc.priority).bind(&doc.default_status)
        .bind(json!(doc.checklist)).bind(json!(doc.subtasks)).bind(json!(doc.attributes)).bind(user)
        .execute(&state.pool).await;
    if result.is_err() {
        return internal();
    }
    read(Kind::Task, state, workspace, id, headers)
        .await
        .into_created()
}

async fn update_task_template(
    State(state): State<AuthState>,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(patch): Json<Value>,
) -> Response {
    if let Err(status) = admin(&state, &headers, workspace).await {
        return status.into_response();
    }
    let (merged, expected) = match merged_patch(Kind::Task, &state, workspace, id, patch).await {
        Ok(v) => v,
        Err(status) => return status.into_response(),
    };
    let Ok(doc) = serde_json::from_value::<TaskTemplateDoc>(merged) else {
        return unprocessable();
    };
    if !doc.valid() {
        return unprocessable();
    }
    let result = sqlx::query("UPDATE task_templates SET name=$3,title_pattern=$4,description=$5,priority=$6,default_status=$7,checklist=$8,subtasks=$9,attributes=$10,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND ($11::bigint IS NULL OR version=$11)")
        .bind(workspace).bind(id).bind(doc.name.trim()).bind(doc.title_pattern.trim()).bind(&doc.description).bind(&doc.priority).bind(&doc.default_status)
        .bind(json!(doc.checklist)).bind(json!(doc.subtasks)).bind(json!(doc.attributes)).bind(expected)
        .execute(&state.pool).await;
    match result {
        Ok(r) if r.rows_affected() == 1 => read(Kind::Task, state, workspace, id, headers).await,
        Ok(_) => StatusCode::CONFLICT.into_response(),
        Err(_) => internal(),
    }
}

async fn create_project_template(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
    Json(doc): Json<ProjectTemplateDoc>,
) -> Response {
    let user = match admin(&state, &headers, workspace).await {
        Ok(user) => user,
        Err(status) => return status.into_response(),
    };
    if !doc.valid() {
        return unprocessable();
    }
    let id = Uuid::new_v4();
    let result = sqlx::query("INSERT INTO project_templates(id,workspace_id,name,description,statuses,milestones,task_templates,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
        .bind(id).bind(workspace).bind(doc.name.trim()).bind(&doc.description)
        .bind(json!(doc.statuses)).bind(json!(doc.milestones)).bind(json!(doc.task_templates)).bind(user)
        .execute(&state.pool).await;
    if result.is_err() {
        return internal();
    }
    read(Kind::Project, state, workspace, id, headers)
        .await
        .into_created()
}

async fn update_project_template(
    State(state): State<AuthState>,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(patch): Json<Value>,
) -> Response {
    if let Err(status) = admin(&state, &headers, workspace).await {
        return status.into_response();
    }
    let (merged, expected) = match merged_patch(Kind::Project, &state, workspace, id, patch).await {
        Ok(v) => v,
        Err(status) => return status.into_response(),
    };
    let Ok(doc) = serde_json::from_value::<ProjectTemplateDoc>(merged) else {
        return unprocessable();
    };
    if !doc.valid() {
        return unprocessable();
    }
    let result = sqlx::query("UPDATE project_templates SET name=$3,description=$4,statuses=$5,milestones=$6,task_templates=$7,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND ($8::bigint IS NULL OR version=$8)")
        .bind(workspace).bind(id).bind(doc.name.trim()).bind(&doc.description)
        .bind(json!(doc.statuses)).bind(json!(doc.milestones)).bind(json!(doc.task_templates)).bind(expected)
        .execute(&state.pool).await;
    match result {
        Ok(r) if r.rows_affected() == 1 => read(Kind::Project, state, workspace, id, headers).await,
        Ok(_) => StatusCode::CONFLICT.into_response(),
        Err(_) => internal(),
    }
}

trait IntoCreated {
    fn into_created(self) -> Response;
}

impl IntoCreated for Response {
    fn into_created(self) -> Response {
        let (mut parts, body) = self.into_parts();
        if parts.status == StatusCode::OK {
            parts.status = StatusCode::CREATED;
        }
        Response::from_parts(parts, body)
    }
}

async fn list_task_templates(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    list(Kind::Task, state, workspace, headers).await
}
async fn read_task_template(
    State(state): State<AuthState>,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    read(Kind::Task, state, workspace, id, headers).await
}
async fn delete_task_template(
    State(state): State<AuthState>,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    delete(Kind::Task, state, workspace, id, headers).await
}
async fn list_project_templates(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    list(Kind::Project, state, workspace, headers).await
}
async fn read_project_template(
    State(state): State<AuthState>,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    read(Kind::Project, state, workspace, id, headers).await
}
async fn delete_project_template(
    State(state): State<AuthState>,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Response {
    delete(Kind::Project, state, workspace, id, headers).await
}

// ---- creating from a template -------------------------------------------------------------

/// What a template needs that the Workspace no longer offers. Reported whole, before any write.
#[derive(Default)]
struct Missing(Vec<Value>);

impl Missing {
    fn add(&mut self, kind: &str, key: impl ToString, reason: &str) {
        let entry = json!({"kind": kind, "key": key.to_string(), "reason": reason});
        if !self.0.contains(&entry) {
            self.0.push(entry);
        }
    }
    fn report(self) -> Response {
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({"error": "template_unresolved", "missing": self.0})),
        )
            .into_response()
    }
}

struct Catalog {
    /// Active Status keys with their category.
    statuses: HashMap<String, String>,
    /// Every Attribute of the Workspace: (value type, archived).
    attributes: HashMap<Uuid, (String, bool)>,
    /// Attributes already enabled on the target Project; `None` when the Project is still to be created
    /// and the template enables what it uses.
    project_attributes: Option<HashSet<Uuid>>,
}

async fn load_catalog(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace: Uuid,
    project: Option<Uuid>,
) -> Result<Catalog, sqlx::Error> {
    // FOR SHARE pairs with archive_status's FOR UPDATE so a Status cannot be archived mid-plan.
    let statuses = sqlx::query("SELECT status_key,category FROM workspace_statuses WHERE workspace_id=$1 AND archived_at IS NULL FOR SHARE")
        .bind(workspace)
        .fetch_all(&mut **tx)
        .await?
        .into_iter()
        .map(|row| (row.get::<String, _>("status_key"), row.get::<String, _>("category")))
        .collect();
    let attributes = sqlx::query("SELECT id,value_type,archived_at IS NOT NULL AS archived FROM attribute_schemas WHERE workspace_id=$1")
        .bind(workspace)
        .fetch_all(&mut **tx)
        .await?
        .into_iter()
        .map(|row| (row.get::<Uuid, _>("id"), (row.get::<String, _>("value_type"), row.get::<bool, _>("archived"))))
        .collect();
    let project_attributes = match project {
        Some(project) => Some(
            sqlx::query_scalar::<_, Uuid>(
                "SELECT attribute_id FROM project_attributes WHERE project_id=$1",
            )
            .bind(project)
            .fetch_all(&mut **tx)
            .await?
            .into_iter()
            .collect(),
        ),
        None => None,
    };
    Ok(Catalog {
        statuses,
        attributes,
        project_attributes,
    })
}

struct PlannedTask {
    title: String,
    description: String,
    status: String,
    completed: bool,
    priority: String,
    checklist: Vec<String>,
    attributes: Vec<(Uuid, Value)>,
    parent: Option<usize>,
}

/// Replaces `{{name}}` with the caller's variable. A name nobody supplied is reported, not guessed.
fn render(pattern: &str, variables: &HashMap<String, String>, missing: &mut Missing) -> String {
    let mut out = String::new();
    let mut rest = pattern;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else { break };
        let name = after[..end].trim();
        if !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
        {
            out.push_str(&rest[..start]);
            match variables.get(name) {
                Some(value) => out.push_str(value),
                None => missing.add("variable", name, "not_provided"),
            }
            rest = &after[end + 2..];
        } else {
            out.push_str(&rest[..start + 2]);
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

fn resolve_status(key: Option<&str>, catalog: &Catalog, missing: &mut Missing) -> (String, bool) {
    let key = key.unwrap_or("backlog");
    match catalog.statuses.get(key) {
        Some(category) => (key.to_owned(), category == "completed"),
        None => {
            missing.add("status", key, "archived_or_unknown");
            (key.to_owned(), false)
        }
    }
}

async fn plan_task_template(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace: Uuid,
    doc: &TaskTemplateDoc,
    variables: &HashMap<String, String>,
    catalog: &Catalog,
    missing: &mut Missing,
    plan: &mut Vec<PlannedTask>,
) -> Result<(), sqlx::Error> {
    let root = plan.len();
    let (status, completed) = resolve_status(doc.default_status.as_deref(), catalog, missing);
    let mut attributes = Vec::new();
    for attribute in &doc.attributes {
        let id = attribute.attribute_id;
        match catalog.attributes.get(&id) {
            None => missing.add("attribute", id, "not_found"),
            Some((_, true)) => missing.add("attribute", id, "archived"),
            Some((kind, false)) => {
                if catalog
                    .project_attributes
                    .as_ref()
                    .is_some_and(|set| !set.contains(&id))
                {
                    missing.add("attribute", id, "not_in_project");
                } else if crate::customization::validate_attribute(
                    tx,
                    workspace,
                    kind,
                    &attribute.value,
                    id,
                )
                .await
                .is_err()
                {
                    missing.add("attribute", id, "invalid_value");
                } else {
                    attributes.push((id, attribute.value.clone()));
                }
            }
        }
    }
    plan.push(PlannedTask {
        title: render(&doc.title_pattern, variables, missing)
            .trim()
            .to_owned(),
        description: render(&doc.description, variables, missing),
        status,
        completed,
        priority: doc.priority.clone(),
        checklist: doc
            .checklist
            .iter()
            .map(|item| render(item, variables, missing))
            .collect(),
        attributes,
        parent: None,
    });
    for subtask in &doc.subtasks {
        let (status, completed) = resolve_status(subtask.status.as_deref(), catalog, missing);
        plan.push(PlannedTask {
            title: render(&subtask.title_pattern, variables, missing)
                .trim()
                .to_owned(),
            description: render(&subtask.description, variables, missing),
            status,
            completed,
            priority: "normal".into(),
            checklist: subtask
                .checklist
                .iter()
                .map(|item| render(item, variables, missing))
                .collect(),
            attributes: Vec::new(),
            parent: Some(root),
        });
    }
    Ok(())
}

/// A Project template can fan out to many Tasks: cap the totals so one instantiation stays bounded.
const MAX_PLANNED_TASKS: usize = 200;
const MAX_PLANNED_CHECKLIST: usize = 1000;

/// Every rendered title, description and checklist item must be storable; a variable can render a
/// stored pattern empty or too long, which must be a 422 and never a database error.
fn plan_titles_valid(plan: &[PlannedTask]) -> bool {
    plan.len() <= MAX_PLANNED_TASKS
        && plan.iter().map(|task| task.checklist.len()).sum::<usize>() <= MAX_PLANNED_CHECKLIST
        && plan.iter().all(|task| {
            text_ok(&task.title, MAX_TEXT)
                && task.description.chars().count() <= MAX_DESCRIPTION
                && task.checklist.iter().all(|item| text_ok(item, MAX_TEXT))
        })
}

/// Plain `YYYY-MM-DD`: Postgres would also take 'infinity' or 'today' for a `::date` cast.
fn plain_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                *b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
}

/// Inserts the planned Tasks and records one `active` operation group with an `archived` operation per
/// Task, the same shape Duplicate and Proposal Apply use, so the ordinary Undo/Redo covers all of it.
async fn create_tasks(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace: Uuid,
    project: Uuid,
    user: Uuid,
    plan: &[PlannedTask],
    group: Uuid,
) -> Result<Vec<Value>, sqlx::Error> {
    let count = plan.len() as i64;
    let first: i64 = sqlx::query_scalar("UPDATE workspaces SET next_task_number=next_task_number+$2 WHERE id=$1 RETURNING next_task_number-$2")
        .bind(workspace)
        .bind(count)
        .fetch_one(&mut **tx)
        .await?;
    sqlx::query("INSERT INTO task_operation_groups(id,command_id,workspace_id,actor_id) VALUES($1,$2,$3,$4)")
        .bind(group)
        .bind(Uuid::new_v4())
        .bind(workspace)
        .bind(user)
        .execute(&mut **tx)
        .await?;
    sqlx::query("UPDATE task_operation_groups SET state='suppressed' WHERE workspace_id=$1 AND actor_id=$2 AND state='undone'")
        .bind(workspace)
        .bind(user)
        .execute(&mut **tx)
        .await?;
    let ids: Vec<Uuid> = plan.iter().map(|_| Uuid::new_v4()).collect();
    let mut created = Vec::new();
    for (index, task) in plan.iter().enumerate() {
        let number = first + index as i64;
        let parent = task.parent.map(|p| ids[p]);
        sqlx::query("INSERT INTO tasks(id,workspace_id,number,project_id,parent_task_id,title,description,status,priority,completed_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $10 THEN now() ELSE NULL END,$11)")
            .bind(ids[index]).bind(workspace).bind(number).bind(project).bind(parent).bind(&task.title).bind(&task.description)
            .bind(&task.status).bind(&task.priority).bind(task.completed).bind(user)
            .execute(&mut **tx)
            .await?;
        for (position, item) in task.checklist.iter().enumerate() {
            sqlx::query("INSERT INTO task_checklist_items(id,workspace_id,task_id,title,position) VALUES($1,$2,$3,$4,$5)")
                .bind(Uuid::new_v4()).bind(workspace).bind(ids[index]).bind(item.trim()).bind(position as i32)
                .execute(&mut **tx)
                .await?;
        }
        for (attribute, value) in &task.attributes {
            sqlx::query("INSERT INTO task_attribute_values(workspace_id,task_id,attribute_id,value) VALUES($1,$2,$3,$4)")
                .bind(workspace).bind(ids[index]).bind(attribute).bind(value)
                .execute(&mut **tx)
                .await?;
        }
        sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,'archived','true'::jsonb,'false'::jsonb,1)")
            .bind(Uuid::new_v4()).bind(group).bind(ids[index])
            .execute(&mut **tx)
            .await?;
        created.push(json!({
            "id": ids[index], "number": number, "title": task.title, "status": task.status,
            "priority": task.priority, "project_id": project, "parent_task_id": parent, "version": 1
        }));
    }
    Ok(created)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InstantiateTask {
    project_id: Uuid,
    #[serde(default)]
    variables: HashMap<String, String>,
}

async fn instantiate_task_template(
    State(state): State<AuthState>,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(input): Json<InstantiateTask>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(status) => return status.into_response(),
    };
    let Ok(mut tx) = state.pool.begin().await else {
        return internal();
    };
    // The Project check comes first and answers the same for a missing, archived or unreadable Project.
    let writable = match evaluate_access(&mut *tx, input.project_id, user).await {
        Ok(Some(access)) => access.workspace_id == workspace && access.role >= Role::Contributor,
        Ok(None) => false,
        Err(_) => return internal(),
    };
    if !writable {
        return StatusCode::NOT_FOUND.into_response();
    }
    let doc = match sqlx::query_scalar::<_, Value>("SELECT to_jsonb(t) - 'id' - 'workspace_id' - 'created_by' - 'created_at' - 'updated_at' - 'version' FROM task_templates t WHERE workspace_id=$1 AND id=$2")
        .bind(workspace).bind(id).fetch_optional(&mut *tx).await
    {
        Ok(Some(doc)) => doc,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return internal(),
    };
    let Ok(doc) = serde_json::from_value::<TaskTemplateDoc>(doc) else {
        return internal();
    };
    let catalog = match load_catalog(&mut tx, workspace, Some(input.project_id)).await {
        Ok(catalog) => catalog,
        Err(_) => return internal(),
    };
    let mut missing = Missing::default();
    let mut plan = Vec::new();
    if plan_task_template(
        &mut tx,
        workspace,
        &doc,
        &input.variables,
        &catalog,
        &mut missing,
        &mut plan,
    )
    .await
    .is_err()
    {
        return internal();
    }
    if !missing.0.is_empty() {
        return missing.report();
    }
    if !plan_titles_valid(&plan) {
        return unprocessable();
    }
    let group = Uuid::new_v4();
    let tasks = match create_tasks(&mut tx, workspace, input.project_id, user, &plan, group).await {
        Ok(tasks) => tasks,
        Err(_) => return internal(),
    };
    if tx.commit().await.is_err() {
        return internal();
    }
    (
        StatusCode::CREATED,
        Json(json!({"group_id": group, "tasks": tasks})),
    )
        .into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InstantiateProject {
    name: String,
    visibility: String,
    start_date: Option<String>,
    #[serde(default)]
    variables: HashMap<String, String>,
}

async fn instantiate_project_template(
    State(state): State<AuthState>,
    Path((workspace, id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(input): Json<InstantiateProject>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(status) => return status.into_response(),
    };
    match workspace_role(&state.pool, workspace, user).await {
        Ok(Some(role)) if role != "viewer" => {}
        Ok(Some(_)) => return StatusCode::FORBIDDEN.into_response(),
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return internal(),
    }
    let name = input.name.trim().to_owned();
    if !text_ok(&name, MAX_TEXT)
        || !["restricted", "workspace"].contains(&input.visibility.as_str())
    {
        return unprocessable();
    }
    let doc = match sqlx::query_scalar::<_, Value>("SELECT to_jsonb(t) - 'id' - 'workspace_id' - 'created_by' - 'created_at' - 'updated_at' - 'version' FROM project_templates t WHERE workspace_id=$1 AND id=$2")
        .bind(workspace).bind(id).fetch_optional(&state.pool).await
    {
        Ok(Some(doc)) => doc,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return internal(),
    };
    let Ok(doc) = serde_json::from_value::<ProjectTemplateDoc>(doc) else {
        return internal();
    };
    // Milestone dates are dates: computed by Postgres from the start date, never shifted by a time zone.
    let mut dates = Vec::new();
    if !doc.milestones.is_empty() {
        let Some(start) = input.start_date.as_deref().filter(|d| plain_date(d)) else {
            return unprocessable();
        };
        for milestone in &doc.milestones {
            let date = sqlx::query_scalar::<_, String>("SELECT ($1::date + $2::int)::text")
                .bind(start)
                .bind(milestone.offset_days)
                .fetch_one(&state.pool)
                .await;
            let Ok(date) = date else {
                return unprocessable();
            };
            dates.push(date);
        }
    }
    let Ok(mut tx) = state.pool.begin().await else {
        return internal();
    };
    let catalog = match load_catalog(&mut tx, workspace, None).await {
        Ok(catalog) => catalog,
        Err(_) => return internal(),
    };
    let mut missing = Missing::default();
    for status in &doc.statuses {
        if !catalog.statuses.contains_key(status) {
            missing.add("status", status, "archived_or_unknown");
        }
    }
    let mut plan = Vec::new();
    for template in &doc.task_templates {
        let stored = sqlx::query_scalar::<_, Value>("SELECT to_jsonb(t) - 'id' - 'workspace_id' - 'created_by' - 'created_at' - 'updated_at' - 'version' FROM task_templates t WHERE workspace_id=$1 AND id=$2")
            .bind(workspace).bind(template).fetch_optional(&mut *tx).await;
        match stored {
            Ok(Some(stored)) => {
                let Ok(task_doc) = serde_json::from_value::<TaskTemplateDoc>(stored) else {
                    return internal();
                };
                if plan_task_template(
                    &mut tx,
                    workspace,
                    &task_doc,
                    &input.variables,
                    &catalog,
                    &mut missing,
                    &mut plan,
                )
                .await
                .is_err()
                {
                    return internal();
                }
            }
            Ok(None) => missing.add("task_template", template, "deleted"),
            Err(_) => return internal(),
        }
    }
    if !missing.0.is_empty() {
        return missing.report();
    }
    if !plan_titles_valid(&plan) {
        return unprocessable();
    }
    let project = Uuid::new_v4();
    let group = Uuid::new_v4();
    let created = async {
        sqlx::query("INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES($1,$2,$3,$4,$5)")
            .bind(project).bind(workspace).bind(&name).bind(&input.visibility).bind(user)
            .execute(&mut *tx)
            .await?;
        // The creator is the only member: what a template could offer beyond that is not access.
        sqlx::query("INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2,$3,'manager')")
            .bind(workspace).bind(project).bind(user)
            .execute(&mut *tx)
            .await?;
        let used: HashSet<Uuid> = plan.iter().flat_map(|task| task.attributes.iter().map(|(id, _)| *id)).collect();
        for attribute in used {
            sqlx::query("INSERT INTO project_attributes(workspace_id,project_id,attribute_id) VALUES($1,$2,$3)")
                .bind(workspace).bind(project).bind(attribute)
                .execute(&mut *tx)
                .await?;
        }
        let tasks = create_tasks(&mut tx, workspace, project, user, &plan, group).await?;
        sqlx::query("INSERT INTO template_created_projects(group_id,workspace_id,project_id) VALUES($1,$2,$3)")
            .bind(group).bind(workspace).bind(project)
            .execute(&mut *tx)
            .await?;
        let mut milestones = Vec::new();
        for (milestone, date) in doc.milestones.iter().zip(&dates) {
            let seed = crate::milestones::Seed {
                name: &milestone.name,
                description: &milestone.description,
                target_date: Some(date),
                state: "planned",
                group: Some(group),
            };
            milestones.push(crate::milestones::create_in_tx(&mut tx, workspace, project, user, &seed).await?);
        }
        Ok::<_, sqlx::Error>((tasks, milestones))
    }
    .await;
    let Ok((tasks, milestones)) = created else {
        return internal();
    };
    if tx.commit().await.is_err() {
        return internal();
    }
    (
        StatusCode::CREATED,
        Json(json!({
            "project": {"id": project, "workspace_id": workspace, "name": name, "visibility": input.visibility, "role": "manager", "version": 1},
            "group_id": group,
            "tasks": tasks,
            "milestones": milestones,
        })),
    )
        .into_response()
}

// ---- Undo and Redo of a group that created a Project ---------------------------------------

async fn group_project(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    group: Uuid,
) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar("SELECT project_id FROM template_created_projects WHERE group_id=$1")
        .bind(group)
        .fetch_optional(&mut **tx)
        .await
}

/// Runs before the Task checks of Undo/Redo. Redo gives the Project back first so the Tasks can be
/// access-checked in it; Undo refuses while the Project holds work the group did not make, and
/// while the actor is not its Manager. Returns a conflict entry when the group cannot move.
pub(crate) async fn project_precheck(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    group: Uuid,
    user: Uuid,
    redo: bool,
) -> Result<Option<Value>, sqlx::Error> {
    let Some(project) = group_project(tx, group).await? else {
        return Ok(None);
    };
    if redo {
        sqlx::query("UPDATE projects SET archived_at=NULL,version=version+1,updated_at=now() WHERE id=$1 AND archived_at IS NOT NULL")
            .bind(project)
            .execute(&mut **tx)
            .await?;
        crate::milestones::set_group_archived(tx, group, user, false).await?;
        return Ok(None);
    }
    let manager = matches!(evaluate_access(&mut **tx, project, user).await?, Some(access) if access.role == Role::Manager);
    if !manager {
        return Ok(Some(
            json!({"project_id": project, "cause": "only a Manager can undo the creation of the Project"}),
        ));
    }
    let others: i64 = sqlx::query_scalar("SELECT count(*) FROM tasks WHERE project_id=$1 AND archived_at IS NULL AND id NOT IN (SELECT task_id FROM task_operations WHERE group_id=$2)")
        .bind(project)
        .bind(group)
        .fetch_one(&mut **tx)
        .await?;
    if others > 0 {
        return Ok(Some(
            json!({"project_id": project, "cause": "the Project holds Tasks this group did not create"}),
        ));
    }
    if crate::milestones::foreign_open_count(tx, project, group).await? > 0 {
        return Ok(Some(
            json!({"project_id": project, "cause": "the Project holds Milestones this group did not create"}),
        ));
    }
    Ok(None)
}

/// Runs after the Task changes of an Undo: the Project leaves with its Tasks.
pub(crate) async fn project_finish(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    group: Uuid,
    user: Uuid,
    redo: bool,
) -> Result<(), sqlx::Error> {
    if redo {
        return Ok(());
    }
    if let Some(project) = group_project(tx, group).await? {
        crate::milestones::set_group_archived(tx, group, user, true).await?;
        sqlx::query("UPDATE projects SET archived_at=now(),version=version+1,updated_at=now() WHERE id=$1 AND archived_at IS NULL")
            .bind(project)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}
