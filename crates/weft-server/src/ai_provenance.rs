//! Provenance and audit for changes created from an approved AI Proposal.
//!
//! The approving human stays the actor of every ledger group. The AI run, provider and Proposal
//! are recorded as the group source, and an approval audit row is written that no data undo can
//! remove. Only the retention window ends its life.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

use crate::auth::{require_session, AuthState};

const DEFAULT_RETENTION_DAYS: i64 = 365;

pub(crate) fn routes() -> Router<AuthState> {
    Router::new().route("/workspaces/:workspace_id/ai/audit", get(list_audit))
}

/// Days that AI runs, Proposals and approval audit are kept. `WEFT_AI_RETENTION_DAYS` overrides.
pub fn retention_days() -> i64 {
    std::env::var("WEFT_AI_RETENTION_DAYS")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|days| *days > 0)
        .unwrap_or(DEFAULT_RETENTION_DAYS)
}

/// Marks the apply group with its AI source and writes the approval audit row. A Proposal that
/// no AI run produced (a mock or hand-made plan) is left alone.
pub(crate) async fn record_approval(
    tx: &mut Transaction<'_, Postgres>,
    proposal: Uuid,
    group: Uuid,
    approver: Uuid,
    revision: i32,
    created_tasks: i64,
    relations: i64,
) -> Result<(), sqlx::Error> {
    let Some(run) =
        sqlx::query_scalar::<_, Option<Uuid>>("SELECT ai_run_id FROM proposals WHERE id=$1")
            .bind(proposal)
            .fetch_one(&mut **tx)
            .await?
    else {
        return Ok(());
    };
    sqlx::query("UPDATE task_operation_groups g SET source_run_id=$2,source_proposal_id=$3,source_provider=p.provider FROM proposals p WHERE g.id=$1 AND p.id=$3")
        .bind(group)
        .bind(run)
        .bind(proposal)
        .execute(&mut **tx)
        .await?;
    sqlx::query(
        "INSERT INTO ai_approval_audit(id,workspace_id,run_id,proposal_id,proposal_revision,operation_group_id,connection_id,provider,capability,initiator_id,approved_by,run_summary,run_scope,sources,created_task_count,relation_count,expires_at) \
         SELECT $1,p.workspace_id,r.id,p.id,$4,$2,r.connection_id,COALESCE(p.provider,c.provider),r.capability,r.initiator_id,$3,r.summary,r.scope,\
         (SELECT COALESCE(jsonb_agg(jsonb_build_object('kind',s.source_kind,'id',s.source_id,'label',s.source_label) ORDER BY s.read_at,s.source_kind,s.source_id),'[]'::jsonb) FROM ai_run_sources s WHERE s.run_id=r.id),\
         $5,$6,now()+make_interval(days=>$7::int) \
         FROM proposals p JOIN ai_runs r ON r.id=p.ai_run_id LEFT JOIN ai_connections c ON c.id=r.connection_id WHERE p.id=$8 \
         ON CONFLICT(proposal_id) DO UPDATE SET proposal_revision=EXCLUDED.proposal_revision,approved_by=EXCLUDED.approved_by,approved_at=now(),sources=EXCLUDED.sources,created_task_count=ai_approval_audit.created_task_count+EXCLUDED.created_task_count,relation_count=ai_approval_audit.relation_count+EXCLUDED.relation_count,expires_at=EXCLUDED.expires_at",
    )
    .bind(Uuid::new_v4())
    .bind(group)
    .bind(approver)
    .bind(revision)
    .bind(created_tasks as i32)
    .bind(relations as i32)
    .bind(retention_days() as i32)
    .bind(proposal)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Attributes the undo group to the same AI source and notes the undo on the audit row.
pub(crate) async fn record_undo(
    tx: &mut Transaction<'_, Postgres>,
    proposal: Uuid,
    undo_group: Option<Uuid>,
    actor: Uuid,
) -> Result<(), sqlx::Error> {
    if let Some(group) = undo_group {
        sqlx::query("UPDATE task_operation_groups g SET source_run_id=p.ai_run_id,source_proposal_id=p.id,source_provider=p.provider FROM proposals p WHERE g.id=$1 AND p.id=$2 AND p.ai_run_id IS NOT NULL")
            .bind(group)
            .bind(proposal)
            .execute(&mut **tx)
            .await?;
    }
    sqlx::query("UPDATE ai_approval_audit SET undone_at=now(),undone_by=$2 WHERE proposal_id=$1 AND undone_at IS NULL")
        .bind(proposal)
        .bind(actor)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Removes AI records past the retention window: expired approval audit, then unreferenced
/// Proposals and finished runs older than the window. Returns the number of rows removed.
pub async fn prune_ai_records(pool: &PgPool, days: i64) -> Result<u64, sqlx::Error> {
    let mut removed = 0;
    removed += sqlx::query("DELETE FROM ai_approval_audit WHERE expires_at<=now()")
        .execute(pool)
        .await?
        .rows_affected();
    removed += sqlx::query("DELETE FROM proposals WHERE ai_run_id IS NOT NULL AND updated_at<now()-make_interval(days=>$1::int)")
        .bind(days as i32)
        .execute(pool)
        .await?
        .rows_affected();
    removed += sqlx::query("DELETE FROM ai_runs r WHERE r.state IN ('completed','failed','canceled','waiting_for_approval') AND r.updated_at<now()-make_interval(days=>$1::int) AND NOT EXISTS(SELECT 1 FROM proposals p WHERE p.ai_run_id=r.id)")
        .bind(days as i32)
        .execute(pool)
        .await?
        .rows_affected();
    Ok(removed)
}

async fn list_audit(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let user = match require_session(&state.pool, &headers, false).await {
        Ok((_, user)) => user,
        Err(status) => return status.into_response(),
    };
    let role = match sqlx::query_scalar::<_, String>(
        "SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2",
    )
    .bind(workspace)
    .bind(user)
    .fetch_optional(&state.pool)
    .await
    {
        Ok(Some(role)) => role,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let admin = matches!(role.as_str(), "owner" | "admin");
    let rows = match sqlx::query(
        "SELECT id,run_id,proposal_id,proposal_revision,operation_group_id,connection_id,provider,capability,initiator_id,approved_by,run_summary,run_scope,sources,created_task_count,relation_count,approved_at::text AS approved_at,undone_at::text AS undone_at,undone_by,expires_at::text AS expires_at \
         FROM ai_approval_audit WHERE workspace_id=$1 AND expires_at>now() AND (initiator_id=$2 OR $3) ORDER BY approved_at DESC,id LIMIT 200",
    )
    .bind(workspace)
    .bind(user)
    .bind(admin)
    .fetch_all(&state.pool)
    .await
    {
        Ok(rows) => rows,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let records = rows
        .into_iter()
        .map(|row| {
            let initiator: Uuid = row.get("initiator_id");
            let sources: Value = row.get("sources");
            let mut record = json!({
                "id":row.get::<Uuid,_>("id"),
                "run_id":row.get::<Uuid,_>("run_id"),
                "proposal_id":row.get::<Uuid,_>("proposal_id"),
                "proposal_revision":row.get::<i32,_>("proposal_revision"),
                "connection_id":row.get::<Option<Uuid>,_>("connection_id"),
                "provider":row.get::<String,_>("provider"),
                "capability":row.get::<String,_>("capability"),
                "initiator_id":initiator,
                "approved_by":row.get::<Uuid,_>("approved_by"),
                "created_task_count":row.get::<i32,_>("created_task_count"),
                "relation_count":row.get::<i32,_>("relation_count"),
                "approved_at":row.get::<String,_>("approved_at"),
                "undone_at":row.get::<Option<String>,_>("undone_at"),
                "undone_by":row.get::<Option<Uuid>,_>("undone_by"),
                "expires_at":row.get::<String,_>("expires_at"),
            });
            if initiator == user {
                record["run_summary"] = json!(row.get::<String, _>("run_summary"));
                record["run_scope"] = row.get::<Value, _>("run_scope");
                record["sources"] = sources;
            } else {
                // A Workspace admin sees that and when an AI plan was approved, never what it read.
                record["source_count"] = json!(sources.as_array().map_or(0, Vec::len));
            }
            record
        })
        .collect::<Vec<_>>();
    Json(json!({"records":records})).into_response()
}
