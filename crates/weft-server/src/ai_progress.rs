//! Delivery risks for the `progress_review` AI capability.
//!
//! The risks are computed on the server from Tasks, Milestones and dependencies of Projects the
//! run selected and the initiator can read right now. AI gets facts with ids, never a
//! conclusion, and a Source is only recorded for what is actually returned here.

use std::collections::BTreeMap;

use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::milestones;

/// Fixes the Proposal engine cannot express stay manual; the report says so plainly.
pub(crate) const FIX_SCOPE: &str = "AI can only propose Milestone updates, subtasks and links. Due dates, assignees, statuses and other edits are not available to AI and stay manual.";

pub(crate) const CATEGORIES: [&str; 5] = [
    "overdue",
    "blocked_chain",
    "no_assignee",
    "empty_milestone",
    "behind_schedule",
];

pub(crate) struct Risks {
    /// One entry per risky Task or Milestone, each carrying its own Source id and kind.
    pub entries: Vec<(&'static str, Uuid, Value)>,
    pub truncated: bool,
    pub size: u64,
}

/// Risks across `projects`, which the caller has already limited to readable Projects.
pub(crate) async fn collect(
    pool: &PgPool,
    workspace: Uuid,
    projects: &[Uuid],
    limit: usize,
) -> Result<Risks, sqlx::Error> {
    let today: String = sqlx::query_scalar(
        "SELECT (now() AT TIME ZONE time_zone)::date::text FROM workspaces WHERE id=$1",
    )
    .bind(workspace)
    .fetch_one(pool)
    .await?;
    let rows = sqlx::query(
        "WITH open_tasks AS (SELECT t.id,t.project_id,t.number,t.title,t.due_date,t.milestone_id FROM tasks t JOIN workspace_statuses s ON s.workspace_id=t.workspace_id AND s.status_key=t.status WHERE t.workspace_id=$1 AND t.project_id=ANY($2) AND t.archived_at IS NULL AND s.category NOT IN ('completed','canceled')) \
         SELECT o.id,o.project_id,o.number,o.title,o.due_date::text AS due_date,o.milestone_id,\
         COALESCE(o.due_date < $3::date,false) AS overdue,\
         NOT EXISTS(SELECT 1 FROM task_assignees a WHERE a.task_id=o.id) AS unassigned,\
         COALESCE((SELECT jsonb_agg(jsonb_build_object('id',b.id,'number',b.number) ORDER BY b.number) FROM task_relations r JOIN open_tasks b ON b.id=r.source_task_id WHERE r.kind='blocks' AND r.target_task_id=o.id),'[]'::jsonb) AS blockers \
         FROM open_tasks o WHERE o.due_date < $3::date OR NOT EXISTS(SELECT 1 FROM task_assignees a WHERE a.task_id=o.id) OR EXISTS(SELECT 1 FROM task_relations r JOIN open_tasks b ON b.id=r.source_task_id WHERE r.kind='blocks' AND r.target_task_id=o.id) \
         ORDER BY o.due_date NULLS LAST,o.number LIMIT $4",
    )
    .bind(workspace)
    .bind(projects)
    .bind(&today)
    .bind(limit as i64 + 1)
    .fetch_all(pool)
    .await?;
    let mut truncated = rows.len() > limit;
    let mut entries: Vec<(&'static str, Uuid, Value)> = Vec::new();
    for row in rows.into_iter().take(limit) {
        let id: Uuid = row.get("id");
        let blockers: Value = row.get("blockers");
        let mut reasons = Vec::new();
        if row.get::<bool, _>("overdue") {
            reasons.push("overdue");
        }
        if blockers.as_array().is_some_and(|list| !list.is_empty()) {
            reasons.push("blocked_chain");
        }
        if row.get::<bool, _>("unassigned") {
            reasons.push("no_assignee");
        }
        entries.push((
            "task",
            id,
            json!({"id":id,"project_id":row.get::<Uuid,_>("project_id"),"number":row.get::<i64,_>("number"),"title":row.get::<String,_>("title"),"due_date":row.get::<Option<String>,_>("due_date"),"milestone_id":row.get::<Option<Uuid>,_>("milestone_id"),"risks":reasons,"blocked_by_open_tasks":blockers,"untrusted_content":true}),
        ));
    }
    let milestone_rows = sqlx::query("SELECT id,project_id,name,state,target_date::text AS target_date,(target_date < $3::date) AS past_target FROM milestones WHERE workspace_id=$1 AND project_id=ANY($2) AND archived_at IS NULL AND state IN ('planned','active') ORDER BY target_date NULLS LAST,created_at,id LIMIT $4")
        .bind(workspace)
        .bind(projects)
        .bind(&today)
        .bind(limit as i64 + 1)
        .fetch_all(pool)
        .await?;
    truncated |= milestone_rows.len() > limit;
    let mut by_milestone: BTreeMap<Uuid, Value> = BTreeMap::new();
    for row in milestone_rows.into_iter().take(limit) {
        let id: Uuid = row.get("id");
        let state: String = row.get("state");
        let progress = milestones::progress(pool, id, &state, false).await?;
        let total = progress["total"].as_i64().unwrap_or(0);
        let completed = progress["completed"].as_i64().unwrap_or(0);
        let mut reasons = Vec::new();
        if total == 0 {
            reasons.push("empty_milestone");
        } else if row.get::<Option<bool>, _>("past_target").unwrap_or(false) && completed < total {
            reasons.push("behind_schedule");
        }
        if reasons.is_empty() {
            continue;
        }
        by_milestone.insert(
            id,
            json!({"id":id,"project_id":row.get::<Uuid,_>("project_id"),"name":row.get::<String,_>("name"),"state":state,"target_date":row.get::<Option<String>,_>("target_date"),"progress":progress,"risks":reasons,"untrusted_content":true}),
        );
    }
    for (id, data) in by_milestone {
        entries.push(("milestone", id, data));
    }
    if entries.len() > limit {
        entries.truncate(limit);
        truncated = true;
    }
    let size = entries
        .iter()
        .map(|(_, _, data)| data.to_string().chars().count() as u64)
        .sum();
    Ok(Risks {
        entries,
        truncated,
        size,
    })
}
