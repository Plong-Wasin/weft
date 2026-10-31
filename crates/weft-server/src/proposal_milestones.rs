//! Milestone items of a Proposal: create a Milestone, edit one and assign Tasks to one.
//!
//! The Proposal engine (`proposals`) owns the Proposal lifecycle; this module owns what a
//! Milestone item means: how it is validated against the initiator's access, how it is applied
//! and how it is undone. Items apply in the same transaction and operation group as Task and link
//! items, so a plan applies and undoes as one group.
use std::collections::HashSet;

use serde_json::{json, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::{
    milestones::{self, DESCRIPTION_LIMIT, NAME_LIMIT, STATES},
    projects::{self, Role},
};

pub(crate) type Tx<'a> = sqlx::Transaction<'a, sqlx::Postgres>;

pub(crate) fn is_kind(kind: &str) -> bool {
    matches!(kind, "milestone" | "milestone_update" | "milestone_assign")
}

fn uuid(value: &Value) -> Option<Uuid> {
    value.as_str().and_then(|id| Uuid::parse_str(id).ok())
}

fn is_tmp(value: &Value) -> bool {
    value.as_str().is_some_and(|id| id.starts_with("tmp-"))
}

/// Dates go through Postgres so every calendar form is accepted or refused the same way.
async fn normalise_date(conn: &mut PgConnection, value: &str) -> Result<String, String> {
    sqlx::query_scalar::<_, String>("SELECT $1::date::text")
        .bind(value)
        .fetch_one(conn)
        .await
        .map_err(|_| "invalid target_date".to_owned())
}

/// Checks the fields a Milestone item may carry. A person confirms delivery, so a Proposal never
/// completes a Milestone.
async fn validate_fields(conn: &mut PgConnection, item: &mut Value) -> Result<(), String> {
    if let Some(name) = item.get("name").filter(|value| !value.is_null()) {
        let name = name.as_str().ok_or("invalid name")?.trim().to_owned();
        if name.is_empty() || name.chars().count() > NAME_LIMIT {
            return Err("invalid name".into());
        }
        item["name"] = Value::String(name);
    }
    if let Some(description) = item.get("description").filter(|value| !value.is_null()) {
        if description
            .as_str()
            .is_none_or(|text| text.chars().count() > DESCRIPTION_LIMIT)
        {
            return Err("invalid description".into());
        }
    }
    if let Some(state) = item.get("state").filter(|value| !value.is_null()) {
        let state = state.as_str().unwrap_or("");
        if !STATES.contains(&state) {
            return Err("invalid milestone state".into());
        }
        if state == "completed" {
            return Err("milestone_completion_is_manual".into());
        }
    }
    if let Some(date) = item.get("target_date").and_then(Value::as_str) {
        item["target_date"] = Value::String(normalise_date(conn, date).await?);
    }
    Ok(())
}

async fn manager_of(conn: &mut PgConnection, project: Uuid, actor: Uuid, workspace: Uuid) -> bool {
    matches!(projects::evaluate_access(&mut *conn, project, actor).await, Ok(Some(access)) if access.workspace_id == workspace && access.role >= Role::Manager)
}

async fn contributor_of(
    conn: &mut PgConnection,
    project: Uuid,
    actor: Uuid,
    workspace: Uuid,
) -> bool {
    matches!(projects::evaluate_access(&mut *conn, project, actor).await, Ok(Some(access)) if access.workspace_id == workspace && access.role >= Role::Contributor)
}

/// Validates one selected Milestone item. `ids` are the Project ids of the Proposal scope and
/// `all` every item of the Proposal (the temporary ids a link or assignment may point at).
pub(crate) async fn validate_item(
    tx: &mut Tx<'_>,
    workspace: Uuid,
    actor: Uuid,
    ids: &HashSet<String>,
    item: &mut Value,
    all: &[Value],
) -> Result<(), String> {
    match item["kind"].as_str().unwrap_or("") {
        "milestone" => {
            let project = item["project_id"]
                .as_str()
                .ok_or("milestone project_id required")?;
            if !ids.contains(project) {
                return Err("item outside scope".into());
            }
            let project = Uuid::parse_str(project).map_err(|_| "invalid project id")?;
            if !manager_of(tx, project, actor, workspace).await {
                return Err("initiator cannot manage Milestones of the Project".into());
            }
            if item["name"]
                .as_str()
                .is_none_or(|name| name.trim().is_empty())
            {
                return Err("milestone name required".into());
            }
            validate_fields(tx, item).await?;
        }
        "milestone_update" => {
            let milestone = uuid(&item["milestone_id"]).ok_or("milestone_id required")?;
            let row = sqlx::query("SELECT project_id,workspace_id,version,archived_at IS NOT NULL AS archived FROM milestones WHERE id=$1")
                .bind(milestone)
                .fetch_optional(&mut **tx)
                .await
                .map_err(|_| "milestone lookup failed")?
                .ok_or("milestone missing")?;
            let project: Uuid = row.get("project_id");
            if row.get::<Uuid, _>("workspace_id") != workspace
                || !ids.contains(&project.to_string())
                || !manager_of(tx, project, actor, workspace).await
            {
                return Err("milestone outside scope or access".into());
            }
            if row.get::<bool, _>("archived") {
                return Err("milestone archived".into());
            }
            if item["expected_version"].as_i64().is_none() {
                return Err("expected_version required".into());
            }
            if item["expected_version"].as_i64() != Some(row.get::<i64, _>("version")) {
                return Err("stale base version".into());
            }
            if !["name", "description", "target_date", "state"]
                .iter()
                .any(|field| item.get(*field).is_some())
            {
                return Err("milestone update changes nothing".into());
            }
            // One row per Milestone: a second update would fail at Apply on the first one's version.
            if all.iter().any(|other| {
                other["kind"] == "milestone_update"
                    && other["selected"] == true
                    && other["id"] != item["id"]
                    && other["milestone_id"] == item["milestone_id"]
            }) {
                return Err("duplicate_milestone_update".into());
            }
            validate_fields(tx, item).await?;
        }
        "milestone_assign" => {
            let task_ref = &item["task_id"];
            let milestone_ref = &item["milestone_id"];
            let project = if is_tmp(task_ref) {
                let draft = all
                    .iter()
                    .find(|other| other["id"] == *task_ref && other["kind"] == "task")
                    .ok_or("assignment task missing")?;
                if draft["selected"] != true {
                    return Err("assignment endpoint is unselected".into());
                }
                uuid(&draft["project_id"]).ok_or("task project_id required")?
            } else {
                let task = uuid(task_ref).ok_or("task_id required")?;
                let row = sqlx::query("SELECT project_id,workspace_id,version FROM tasks WHERE id=$1 AND archived_at IS NULL")
                    .bind(task)
                    .fetch_optional(&mut **tx)
                    .await
                    .map_err(|_| "task lookup failed")?
                    .ok_or("assignment task missing")?;
                let project: Uuid = row.get("project_id");
                if row.get::<Uuid, _>("workspace_id") != workspace
                    || !ids.contains(&project.to_string())
                {
                    return Err("assignment outside scope".into());
                }
                if item["expected_version"].as_i64().is_none() {
                    return Err("expected_version required".into());
                }
                if item["expected_version"].as_i64() != Some(row.get::<i64, _>("version")) {
                    return Err("stale base version".into());
                }
                project
            };
            if !contributor_of(tx, project, actor, workspace).await {
                return Err("initiator cannot write assignment task".into());
            }
            if is_tmp(milestone_ref) {
                let draft = all
                    .iter()
                    .find(|other| other["id"] == *milestone_ref && other["kind"] == "milestone")
                    .ok_or("assignment milestone missing")?;
                if draft["selected"] != true {
                    return Err("assignment endpoint is unselected".into());
                }
                if uuid(&draft["project_id"]) != Some(project) {
                    return Err("milestone_in_another_project".into());
                }
            } else {
                let milestone = uuid(milestone_ref).ok_or("milestone_id required")?;
                if !milestones::assignable(tx, project, milestone)
                    .await
                    .map_err(|_| "milestone lookup failed")?
                {
                    return Err("milestone_unavailable".into());
                }
            }
            let duplicate = all.iter().any(|other| {
                other["kind"] == "milestone_assign"
                    && other["selected"] == true
                    && other["id"] != item["id"]
                    && other["task_id"] == *task_ref
            });
            if duplicate {
                return Err("duplicate_assignment".into());
            }
        }
        _ => return Err("unknown proposal item kind".into()),
    }
    Ok(())
}

/// Access the initiator must still hold on every Project a selected Milestone item touches.
/// Used before Edit, Apply and Undo, so revoked access refuses all of them.
pub(crate) async fn access_valid(
    tx: &mut Tx<'_>,
    workspace: Uuid,
    actor: Uuid,
    item: &Value,
    selected: &[&Value],
) -> Result<(), String> {
    match item["kind"].as_str().unwrap_or("") {
        "milestone" => {
            let project = uuid(&item["project_id"]).ok_or("milestone project missing")?;
            if !manager_of(tx, project, actor, workspace).await {
                return Err("current manager access to every affected Project is required".into());
            }
        }
        "milestone_update" => {
            let milestone = uuid(&item["milestone_id"]).ok_or("milestone missing")?;
            let project: Uuid = sqlx::query_scalar(
                "SELECT project_id FROM milestones WHERE workspace_id=$1 AND id=$2",
            )
            .bind(workspace)
            .bind(milestone)
            .fetch_optional(&mut **tx)
            .await
            .map_err(|_| "milestone lookup failed")?
            .ok_or("milestone missing")?;
            if !manager_of(tx, project, actor, workspace).await {
                return Err("current manager access to every affected Project is required".into());
            }
        }
        "milestone_assign" => {
            let task_ref = &item["task_id"];
            let project = if is_tmp(task_ref) {
                let draft = selected
                    .iter()
                    .find(|other| other["id"] == *task_ref && other["kind"] == "task")
                    .ok_or("assignment task missing")?;
                uuid(&draft["project_id"]).ok_or("task project missing")?
            } else {
                let task = uuid(task_ref).ok_or("assignment task missing")?;
                sqlx::query_scalar("SELECT project_id FROM tasks WHERE workspace_id=$1 AND id=$2 AND archived_at IS NULL")
                    .bind(workspace)
                    .bind(task)
                    .fetch_optional(&mut **tx)
                    .await
                    .map_err(|_| "task lookup failed")?
                    .ok_or("assignment task missing")?
            };
            if !contributor_of(tx, project, actor, workspace).await {
                return Err("current write access to every affected Project is required".into());
            }
        }
        _ => return Err("unknown proposal item kind".into()),
    }
    Ok(())
}

/// Existing Tasks and Milestones an item touches, so Apply can lock them in a fixed order
/// (Milestone rows first, then Task rows) like the Task update and the Milestone archive.
pub(crate) fn locks(items: &[Value]) -> (Vec<Uuid>, Vec<Uuid>, Vec<Uuid>) {
    let (mut shared, mut exclusive, mut tasks) = (Vec::new(), Vec::new(), Vec::new());
    for item in items {
        match item["kind"].as_str().unwrap_or("") {
            "milestone_update" => exclusive.extend(uuid(&item["milestone_id"])),
            "milestone_assign" => {
                shared.extend(uuid(&item["milestone_id"]));
                tasks.extend(uuid(&item["task_id"]));
            }
            _ => {}
        }
    }
    for list in [&mut shared, &mut exclusive, &mut tasks] {
        list.sort_unstable();
        list.dedup();
    }
    (shared, exclusive, tasks)
}

/// Locks the existing Milestones of the selected items in one pass: one id-sorted, deduplicated
/// list with the strongest mode per id (exclusive when edited, shared when only assigned to), so
/// two Applies cannot lock in opposite orders or upgrade a lock. Returns false when one no
/// longer exists.
pub(crate) async fn lock_milestones(tx: &mut Tx<'_>, items: &[Value]) -> Result<bool, String> {
    let (shared, exclusive, _) = locks(items);
    let mut all: Vec<(Uuid, bool)> = exclusive.iter().map(|id| (*id, true)).collect();
    all.extend(
        shared
            .into_iter()
            .filter(|id| !exclusive.contains(id))
            .map(|id| (id, false)),
    );
    all.sort_unstable_by_key(|(id, _)| *id);
    for (id, write) in all {
        let query = if write {
            "SELECT id FROM milestones WHERE id=$1 AND archived_at IS NULL FOR UPDATE"
        } else {
            "SELECT id FROM milestones WHERE id=$1 AND archived_at IS NULL FOR SHARE"
        };
        let found = sqlx::query_scalar::<_, Uuid>(query)
            .bind(id)
            .fetch_optional(&mut **tx)
            .await
            .map_err(|_| "milestone lock failed")?;
        if found.is_none() {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Creates a Milestone the way a Manager creates one by hand, with its own History entry.
pub(crate) async fn create(
    tx: &mut Tx<'_>,
    workspace: Uuid,
    actor: Uuid,
    item: &Value,
) -> Result<Uuid, String> {
    let id = Uuid::new_v4();
    let project = uuid(&item["project_id"]).ok_or("milestone project missing")?;
    let row = sqlx::query(&format!("INSERT INTO milestones(id,workspace_id,project_id,name,description,target_date,state,created_by) VALUES($1,$2,$3,$4,$5,$6::date,$7,$8) RETURNING {}", milestones::COLUMNS))
        .bind(id)
        .bind(workspace)
        .bind(project)
        .bind(item["name"].as_str().unwrap_or(""))
        .bind(item["description"].as_str().unwrap_or(""))
        .bind(item["target_date"].as_str())
        .bind(item["state"].as_str().unwrap_or("planned"))
        .bind(actor)
        .fetch_one(&mut **tx)
        .await
        .map_err(|_| "milestone insert failed")?;
    milestones::record_event(
        tx,
        id,
        project,
        actor,
        "created",
        Value::Null,
        milestones::milestone_json(&row),
    )
    .await
    .map_err(|_| "milestone history failed")?;
    Ok(id)
}

/// Applies a Milestone edit and returns the undo record: the values before and the version after.
pub(crate) async fn update(tx: &mut Tx<'_>, actor: Uuid, item: &Value) -> Result<Value, String> {
    let milestone = uuid(&item["milestone_id"]).ok_or("milestone missing")?;
    let before = sqlx::query(&format!(
        "SELECT {} FROM milestones WHERE id=$1 AND archived_at IS NULL",
        milestones::COLUMNS
    ))
    .bind(milestone)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| "milestone lookup failed")?
    .ok_or("milestone missing")?;
    if item["expected_version"].as_i64() != Some(before.get::<i64, _>("version")) {
        return Err("stale base version".into());
    }
    let project: Uuid = before.get("project_id");
    let clears_date = item.get("target_date").is_some_and(Value::is_null);
    let changes_date = clears_date || item["target_date"].is_string();
    let after = sqlx::query(&format!("UPDATE milestones SET name=COALESCE($2,name),description=COALESCE($3,description),target_date=CASE WHEN $4 THEN $5::date ELSE target_date END,state=COALESCE($6,state),version=version+1,updated_at=now() WHERE id=$1 RETURNING {}", milestones::COLUMNS))
        .bind(milestone)
        .bind(item["name"].as_str())
        .bind(item["description"].as_str())
        .bind(changes_date)
        .bind(item["target_date"].as_str())
        .bind(item["state"].as_str())
        .fetch_one(&mut **tx)
        .await
        .map_err(|_| "milestone update failed")?;
    let before_json = milestones::milestone_json(&before);
    let after_json = milestones::milestone_json(&after);
    milestones::record_event(
        tx,
        milestone,
        project,
        actor,
        "updated",
        before_json.clone(),
        after_json.clone(),
    )
    .await
    .map_err(|_| "milestone history failed")?;
    Ok(json!({
        "kind":"updated","id":milestone,
        "before":{"name":before_json["name"],"description":before_json["description"],"target_date":before_json["target_date"],"state":before_json["state"]},
        "after_version":after_json["version"],
    }))
}

/// Assigns a Task to a Milestone. An existing Task changes through the operation ledger (one
/// History entry in the Proposal's group); a Task created by the same Proposal gets its Milestone
/// without a version bump, because Undo archives it as a whole. `created_tasks` and
/// `created_milestones` map temporary ids to the rows this Apply created.
pub(crate) async fn assign(
    tx: &mut Tx<'_>,
    group: Uuid,
    item: &Value,
    created_tasks: &[(String, Uuid)],
    created_milestones: &[(String, Uuid)],
) -> Result<Option<Value>, String> {
    let lookup = |list: &[(String, Uuid)], reference: &Value| {
        list.iter()
            .find(|(tmp, _)| reference.as_str() == Some(tmp.as_str()))
            .map(|(_, id)| *id)
    };
    let milestone = lookup(created_milestones, &item["milestone_id"])
        .or_else(|| uuid(&item["milestone_id"]))
        .ok_or("assignment milestone missing")?;
    if let Some(task) = lookup(created_tasks, &item["task_id"]) {
        sqlx::query("UPDATE tasks SET milestone_id=$2 WHERE id=$1")
            .bind(task)
            .bind(milestone)
            .execute(&mut **tx)
            .await
            .map_err(|_| "assignment failed")?;
        return Ok(None);
    }
    let task = uuid(&item["task_id"]).ok_or("assignment task missing")?;
    let row = sqlx::query(
        "SELECT project_id,version,milestone_id FROM tasks WHERE id=$1 AND archived_at IS NULL",
    )
    .bind(task)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| "task lookup failed")?
    .ok_or("assignment task missing")?;
    if item["expected_version"].as_i64() != Some(row.get::<i64, _>("version")) {
        return Err("stale base version".into());
    }
    if !milestones::assignable(tx, row.get("project_id"), milestone)
        .await
        .map_err(|_| "milestone lookup failed")?
    {
        return Err("milestone_unavailable".into());
    }
    let before: Option<Uuid> = row.get("milestone_id");
    if before == Some(milestone) {
        return Ok(None);
    }
    let version: i64 = sqlx::query_scalar("UPDATE tasks SET milestone_id=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING version")
        .bind(task)
        .bind(milestone)
        .fetch_one(&mut **tx)
        .await
        .map_err(|_| "assignment failed")?;
    sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,'milestone_id',$4,$5,$6)")
        .bind(Uuid::new_v4())
        .bind(group)
        .bind(task)
        .bind(json!(before))
        .bind(json!(milestone))
        .bind(version)
        .execute(&mut **tx)
        .await
        .map_err(|_| "assignment history failed")?;
    Ok(Some(json!({
        "kind":"assigned","task":task,"before":before,"after":milestone,"task_version":version,
    })))
}

/// Conflicts that stop Undo: a Milestone or Task changed since Apply, or a Milestone the plan
/// created now holds other work. `generated` are the Tasks the same Proposal created (Undo
/// archives them), so they do not count as other work. A Task the plan also linked is version
/// checked by the link, whose recorded version is the final one.
pub(crate) async fn undo_conflicts(
    tx: &mut Tx<'_>,
    changes: &Value,
    generated: &[Uuid],
    linked: &HashSet<Uuid>,
) -> Result<Vec<Value>, String> {
    let mut conflicts = Vec::new();
    let assigned: Vec<Uuid> = changes
        .as_array()
        .into_iter()
        .flatten()
        .filter(|change| change["kind"] == "assigned")
        .filter_map(|change| uuid(&change["task"]))
        .collect();
    for change in changes.as_array().into_iter().flatten() {
        match change["kind"].as_str().unwrap_or("") {
            "created" => {
                let Some(id) = uuid(&change["id"]) else {
                    continue;
                };
                let row = sqlx::query(
                    "SELECT version FROM milestones WHERE id=$1 AND archived_at IS NULL FOR UPDATE",
                )
                .bind(id)
                .fetch_optional(&mut **tx)
                .await
                .map_err(|_| "milestone lookup failed")?;
                if !matches!(row, Some(ref row) if Some(row.get::<i64, _>("version")) == change["version"].as_i64())
                {
                    conflicts
                        .push(json!({"milestone_id":id,"reason":"milestone_changed_or_missing"}));
                    continue;
                }
                let others: i64 = sqlx::query_scalar("SELECT count(*) FROM tasks WHERE milestone_id=$1 AND archived_at IS NULL AND NOT (id=ANY($2)) AND NOT (id=ANY($3))")
                    .bind(id)
                    .bind(generated)
                    .bind(&assigned)
                    .fetch_one(&mut **tx)
                    .await
                    .map_err(|_| "milestone lookup failed")?;
                if others > 0 {
                    conflicts.push(json!({"milestone_id":id,"reason":"milestone_has_other_tasks"}));
                }
            }
            "updated" => {
                let Some(id) = uuid(&change["id"]) else {
                    continue;
                };
                let version: Option<i64> = sqlx::query_scalar(
                    "SELECT version FROM milestones WHERE id=$1 AND archived_at IS NULL FOR UPDATE",
                )
                .bind(id)
                .fetch_optional(&mut **tx)
                .await
                .map_err(|_| "milestone lookup failed")?;
                if version != change["after_version"].as_i64() {
                    conflicts
                        .push(json!({"milestone_id":id,"reason":"milestone_changed_or_missing"}));
                }
            }
            "assigned" => {
                let Some(task) = uuid(&change["task"]) else {
                    continue;
                };
                let row = sqlx::query("SELECT version,milestone_id,project_id FROM tasks WHERE id=$1 AND archived_at IS NULL")
                    .bind(task)
                    .fetch_optional(&mut **tx)
                    .await
                    .map_err(|_| "task lookup failed")?;
                let ok = matches!(row, Some(ref row) if (linked.contains(&task) || Some(row.get::<i64, _>("version")) == change["task_version"].as_i64()) && row.get::<Option<Uuid>, _>("milestone_id") == uuid(&change["after"]));
                if !ok {
                    conflicts.push(json!({"task_id":task,"reason":"task_changed_or_missing"}));
                    continue;
                }
                if let (Some(before), Some(row)) = (uuid(&change["before"]), row) {
                    let usable: Option<i32> = sqlx::query_scalar("SELECT 1 FROM milestones WHERE id=$1 AND project_id=$2 AND archived_at IS NULL")
                        .bind(before)
                        .bind(row.get::<Uuid, _>("project_id"))
                        .fetch_optional(&mut **tx)
                        .await
                        .map_err(|_| "milestone lookup failed")?;
                    if usable.is_none() {
                        conflicts.push(
                            json!({"task_id":task,"reason":"previous_milestone_unavailable"}),
                        );
                    }
                }
            }
            _ => conflicts.push(json!({"reason":"invalid_milestone_record"})),
        }
    }
    Ok(conflicts)
}

/// Locks every Milestone an undo touches, ordered by id, before the undo locks any Task: the
/// global order is Milestone then Task. Created and updated Milestones take the exclusive lock,
/// the before and after Milestones of an assignment the shared one.
pub(crate) async fn lock_for_undo(tx: &mut Tx<'_>, changes: &Value) -> Result<(), sqlx::Error> {
    let mut wanted = std::collections::BTreeMap::<Uuid, bool>::new();
    for change in changes.as_array().into_iter().flatten() {
        match change["kind"].as_str().unwrap_or("") {
            "created" | "updated" => {
                if let Some(id) = uuid(&change["id"]) {
                    wanted.insert(id, true);
                }
            }
            "assigned" => {
                for key in ["before", "after"] {
                    if let Some(id) = uuid(&change[key]) {
                        wanted.entry(id).or_insert(false);
                    }
                }
            }
            _ => {}
        }
    }
    for (id, exclusive) in wanted {
        let sql = if exclusive {
            "SELECT id FROM milestones WHERE id=$1 FOR UPDATE"
        } else {
            "SELECT id FROM milestones WHERE id=$1 FOR SHARE"
        };
        sqlx::query(sql).bind(id).fetch_optional(&mut **tx).await?;
    }
    Ok(())
}

/// Reverts the recorded Milestone changes: assignments first (one ledger row per Task in the undo
/// group), then edits, then the archive of Milestones the plan created.
pub(crate) async fn undo_apply(
    tx: &mut Tx<'_>,
    group: Option<Uuid>,
    actor: Uuid,
    changes: &Value,
) -> Result<(), String> {
    let list = changes.as_array().cloned().unwrap_or_default();
    for change in list.iter().filter(|change| change["kind"] == "assigned") {
        let task = uuid(&change["task"]).ok_or("invalid milestone record")?;
        let before = uuid(&change["before"]);
        let version: i64 = sqlx::query_scalar("UPDATE tasks SET milestone_id=$2,version=version+1,updated_at=now() WHERE id=$1 AND archived_at IS NULL RETURNING version")
            .bind(task)
            .bind(before)
            .fetch_one(&mut **tx)
            .await
            .map_err(|_| "task changed")?;
        if let Some(group) = group {
            sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,'milestone_id',$4,$5,$6)")
                .bind(Uuid::new_v4())
                .bind(group)
                .bind(task)
                .bind(&change["after"])
                .bind(json!(before))
                .bind(version)
                .execute(&mut **tx)
                .await
                .map_err(|_| "history failed")?;
        }
    }
    for change in list
        .iter()
        .rev()
        .filter(|change| change["kind"] == "updated")
    {
        let id = uuid(&change["id"]).ok_or("invalid milestone record")?;
        let before = &change["before"];
        let row = sqlx::query(&format!("UPDATE milestones SET name=$2,description=$3,target_date=$4::date,state=$5,version=version+1,updated_at=now() WHERE id=$1 RETURNING {}", milestones::COLUMNS))
            .bind(id)
            .bind(before["name"].as_str().unwrap_or(""))
            .bind(before["description"].as_str().unwrap_or(""))
            .bind(before["target_date"].as_str())
            .bind(before["state"].as_str().unwrap_or("planned"))
            .fetch_one(&mut **tx)
            .await
            .map_err(|_| "milestone changed")?;
        let project: Uuid = row.get("project_id");
        milestones::record_event(
            tx,
            id,
            project,
            actor,
            "updated",
            Value::Null,
            milestones::milestone_json(&row),
        )
        .await
        .map_err(|_| "history failed")?;
    }
    for change in list.iter().filter(|change| change["kind"] == "created") {
        let id = uuid(&change["id"]).ok_or("invalid milestone record")?;
        let row = sqlx::query(&format!("UPDATE milestones SET archived_at=now(),version=version+1,updated_at=now() WHERE id=$1 AND archived_at IS NULL RETURNING {}", milestones::COLUMNS))
            .bind(id)
            .fetch_one(&mut **tx)
            .await
            .map_err(|_| "milestone changed")?;
        let project: Uuid = row.get("project_id");
        milestones::record_event(
            tx,
            id,
            project,
            actor,
            "archived",
            Value::Null,
            milestones::milestone_json(&row),
        )
        .await
        .map_err(|_| "history failed")?;
    }
    Ok(())
}

/// Adds readable labels (`#12 Title`, Milestone name) so review never shows a bare id, and the
/// dependency edges that let one Milestone item stand and fall with the items it needs.
pub(crate) async fn annotate(conn: &mut PgConnection, items: &mut Value) -> Result<(), String> {
    for item in items.as_array_mut().into_iter().flatten() {
        match item["kind"].as_str().unwrap_or("") {
            "milestone_update" => {
                if let Some(milestone) = uuid(&item["milestone_id"]) {
                    let name: Option<String> =
                        sqlx::query_scalar("SELECT name FROM milestones WHERE id=$1")
                            .bind(milestone)
                            .fetch_optional(&mut *conn)
                            .await
                            .map_err(|_| "label_lookup_failed")?;
                    if let Some(name) = name {
                        item["milestone_label"] = json!(name);
                    }
                }
            }
            "milestone_assign" => {
                if let Some(task) = uuid(&item["task_id"]) {
                    let row = sqlx::query("SELECT number,title FROM tasks WHERE id=$1")
                        .bind(task)
                        .fetch_optional(&mut *conn)
                        .await
                        .map_err(|_| "label_lookup_failed")?;
                    if let Some(row) = row {
                        item["task_label"] = json!(format!(
                            "#{} {}",
                            row.get::<i64, _>("number"),
                            row.get::<String, _>("title")
                        ));
                    }
                }
                if let Some(milestone) = uuid(&item["milestone_id"]) {
                    let name: Option<String> =
                        sqlx::query_scalar("SELECT name FROM milestones WHERE id=$1")
                            .bind(milestone)
                            .fetch_optional(&mut *conn)
                            .await
                            .map_err(|_| "label_lookup_failed")?;
                    if let Some(name) = name {
                        item["milestone_label"] = json!(name);
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// An assignment to a Task or Milestone created in the same Proposal depends on that draft, so
/// unticking the draft unticks the assignment.
pub(crate) fn link_dependencies(items: &mut [Value]) {
    for item in items
        .iter_mut()
        .filter(|item| item["kind"] == "milestone_assign")
    {
        let mut deps: Vec<Value> = item["depends_on"].as_array().cloned().unwrap_or_default();
        for key in ["task_id", "milestone_id"] {
            if is_tmp(&item[key]) && !deps.contains(&item[key]) {
                deps.push(item[key].clone());
            }
        }
        if !deps.is_empty() {
            item["depends_on"] = Value::Array(deps);
        }
    }
}
