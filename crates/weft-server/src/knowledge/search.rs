use std::path::PathBuf;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::{
    auth::{require_session, AuthState},
    knowledge::index::{self, IndexedFile, PARSER_VERSION},
    projects::Role,
    vault_import,
    vaults::evaluate_access,
};

const MAX_SEARCH_TEXT_BYTES: usize = 256 * 1024;

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route(
            "/workspaces/:workspace_id/knowledge/search",
            get(search_notes),
        )
        .route(
            "/workspaces/:workspace_id/knowledge/names",
            get(search_note_names),
        )
        .route(
            "/workspaces/:workspace_id/knowledge/search-status",
            get(search_status),
        )
        .route(
            "/vaults/:vault_id/search-index",
            get(index_status).post(start_reindex),
        )
}

async fn search_status(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let vaults = sqlx::query("SELECT id FROM vaults WHERE workspace_id=$1")
        .bind(workspace)
        .fetch_all(&state.pool)
        .await;
    let Ok(vaults) = vaults else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let mut indexing = false;
    for row in vaults {
        let vault: Uuid = row.get("id");
        match evaluate_access(&state.pool, vault, user).await {
            Ok(Some(access)) if access.role >= Role::Viewer => {
                let state_row = sqlx::query(
                    "SELECT status,parser_version FROM vault_search_states WHERE vault_id=$1",
                )
                .bind(vault)
                .fetch_optional(&state.pool)
                .await;
                match state_row {
                    Ok(Some(state_row)) => {
                        indexing |= state_row.get::<String, _>("status") != "ready"
                            || state_row
                                .get::<Option<String>, _>("parser_version")
                                .as_deref()
                                != Some(PARSER_VERSION);
                    }
                    Ok(None) => match has_import_job(&state, vault).await {
                        Ok(has_import_job) => indexing |= has_import_job,
                        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                    },
                    Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                }
            }
            Ok(_) => {}
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    }
    Json(json!({"indexing":indexing})).into_response()
}

async fn search_note_names(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    Query(query): Query<SearchQuery>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let query_text = query.q.trim();
    if query_text.is_empty() || query_text.chars().count() > 100 {
        return Json(json!({"results":[]})).into_response();
    }
    let vault_rows = sqlx::query("SELECT id FROM vaults WHERE workspace_id=$1 ORDER BY id")
        .bind(workspace)
        .fetch_all(&state.pool)
        .await;
    let Ok(vault_rows) = vault_rows else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let mut readable = Vec::new();
    for row in vault_rows {
        let vault: Uuid = row.get("id");
        match evaluate_access(&state.pool, vault, user).await {
            Ok(Some(access)) if access.role >= Role::Viewer => readable.push(vault),
            Ok(_) => {}
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    }
    if readable.is_empty() {
        return Json(json!({"results":[]})).into_response();
    }
    let rows = sqlx::query(
        "SELECT f.vault_id,f.path,f.title,v.name AS vault_name FROM vault_indexed_files f
         JOIN vaults v ON v.id=f.vault_id JOIN vault_search_states s ON s.vault_id=f.vault_id
         WHERE f.vault_id=ANY($1) AND s.status='ready' AND s.parser_version=$3
         AND (f.path ILIKE ('%' || $2 || '%') OR f.title ILIKE ('%' || $2 || '%'))
         ORDER BY v.name,f.title,f.path LIMIT 10",
    )
    .bind(&readable)
    .bind(query_text)
    .bind(PARSER_VERSION)
    .fetch_all(&state.pool)
    .await;
    match rows {
        Ok(rows) => Json(json!({"results":rows.iter().map(|row|json!({
            "vault_id":row.get::<Uuid,_>("vault_id"),
            "vault_name":row.get::<String,_>("vault_name"),
            "path":row.get::<String,_>("path"),
            "title":row.get::<String,_>("title"),
        })).collect::<Vec<_>>()}))
        .into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
}

async fn search_notes(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    Query(query): Query<SearchQuery>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let query_text = query.q.trim();
    if query_text.is_empty() || query_text.chars().count() > 100 {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let workspace_member = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2)",
    )
    .bind(workspace)
    .bind(user)
    .fetch_one(&state.pool)
    .await;
    if !matches!(workspace_member, Ok(true)) {
        return if workspace_member.is_ok() {
            StatusCode::NOT_FOUND.into_response()
        } else {
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        };
    }
    let vault_rows = sqlx::query("SELECT id FROM vaults WHERE workspace_id=$1 ORDER BY id")
        .bind(workspace)
        .fetch_all(&state.pool)
        .await;
    let Ok(vault_rows) = vault_rows else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let mut readable = Vec::new();
    let mut pending = false;
    for row in vault_rows {
        let vault: Uuid = row.get("id");
        match evaluate_access(&state.pool, vault, user).await {
            Ok(Some(access)) if access.role >= Role::Viewer => {
                readable.push(vault);
                let state_row = sqlx::query(
                    "SELECT status,parser_version FROM vault_search_states WHERE vault_id=$1",
                )
                .bind(vault)
                .fetch_optional(&state.pool)
                .await;
                match state_row {
                    Ok(Some(state_row)) => {
                        let status: String = state_row.get("status");
                        let version: Option<String> = state_row.get("parser_version");
                        pending |= status != "ready" || version.as_deref() != Some(PARSER_VERSION);
                    }
                    Ok(None) => match has_import_job(&state, vault).await {
                        Ok(has_import_job) => pending |= has_import_job,
                        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                    },
                    Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                }
            }
            Ok(_) => {}
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    }
    if readable.is_empty() {
        return Json(json!({"results": [], "count": 0, "indexing": false})).into_response();
    }
    let count = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM vault_indexed_files f JOIN vault_search_states s ON s.vault_id=f.vault_id
         WHERE f.vault_id=ANY($1) AND s.status='ready' AND s.parser_version=$3
           AND (f.search_text ILIKE ('%' || $2 || '%')
                OR to_tsvector('simple',f.search_text) @@ plainto_tsquery('simple',$2)
                OR public.word_similarity($2,f.search_text) >= 0.3)",
    )
    .bind(&readable)
    .bind(query_text)
    .bind(PARSER_VERSION)
    .fetch_one(&state.pool)
    .await;
    let Ok(count) = count else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let rows = sqlx::query(
        "SELECT f.vault_id,f.path,f.title,f.search_text,v.name AS vault_name
         FROM vault_indexed_files f JOIN vault_search_states s ON s.vault_id=f.vault_id
         JOIN vaults v ON v.id=f.vault_id
         WHERE f.vault_id=ANY($1) AND s.status='ready' AND s.parser_version=$3
           AND (f.search_text ILIKE ('%' || $2 || '%')
                OR to_tsvector('simple',f.search_text) @@ plainto_tsquery('simple',$2)
                OR public.word_similarity($2,f.search_text) >= 0.3)
         ORDER BY v.name,f.title,f.path LIMIT 20",
    )
    .bind(&readable)
    .bind(query_text)
    .bind(PARSER_VERSION)
    .fetch_all(&state.pool)
    .await;
    let Ok(rows) = rows else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let results = rows
        .iter()
        .map(|row| {
            let search_text: String = row.get("search_text");
            json!({
                "vault_id":row.get::<Uuid,_>("vault_id"),
                "vault_name":row.get::<String,_>("vault_name"),
                "path":row.get::<String,_>("path"),
                "title":row.get::<String,_>("title"),
                "snippet":index::snippet(&search_text,query_text),
            })
        })
        .collect::<Vec<_>>();
    Json(json!({"results":results,"count":count,"indexing":pending})).into_response()
}

async fn index_status(
    State(state): State<AuthState>,
    Path(vault): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    match evaluate_access(&state.pool, vault, user).await {
        Ok(Some(access)) if access.role >= Role::Viewer => {}
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    match sqlx::query("SELECT status,parser_version FROM vault_search_states WHERE vault_id=$1")
        .bind(vault)
        .fetch_optional(&state.pool)
        .await
    {
        Ok(Some(row)) => Json(json!({
            "status":row.get::<String,_>("status"),
            "parser_version":row.get::<Option<String>,_>("parser_version"),
            "searchable":row.get::<String,_>("status")=="ready" && row.get::<Option<String>,_>("parser_version").as_deref()==Some(PARSER_VERSION),
        })).into_response(),
        Ok(None) => Json(json!({"status":"not_indexed","parser_version":null,"searchable":false})).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn has_import_job(state: &AuthState, vault: Uuid) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM vault_import_jobs WHERE vault_id=$1 AND status<>'failed')",
    )
    .bind(vault)
    .fetch_one(&state.pool)
    .await
}

async fn start_reindex(
    State(state): State<AuthState>,
    Path(vault): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let access = match evaluate_access(&state.pool, vault, user).await {
        Ok(Some(access)) if access.role == Role::Manager => access,
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let repository = sqlx::query_scalar::<_, String>(
        "SELECT repository_path FROM vaults WHERE id=$1 AND workspace_id=$2",
    )
    .bind(vault)
    .bind(access.workspace_id)
    .fetch_optional(&state.pool)
    .await;
    let Ok(Some(repository)) = repository else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if sqlx::query("INSERT INTO vault_search_states(vault_id,status,parser_version) VALUES($1,'running',NULL) ON CONFLICT(vault_id) DO UPDATE SET status='running',updated_at=now()")
        .bind(vault).execute(&state.pool).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let task_state = state.clone();
    tokio::spawn(async move { run_reindex(task_state, vault, PathBuf::from(repository)).await });
    (
        StatusCode::ACCEPTED,
        Json(json!({"status":"running","searchable":false})),
    )
        .into_response()
}

pub(crate) async fn reindex_import(
    state: &AuthState,
    vault: Uuid,
    files: Vec<(String, Option<String>)>,
) -> Result<(), sqlx::Error> {
    let indexed = tokio::task::spawn_blocking(move || {
        let mut indexed = index::build(files);
        for file in &mut indexed {
            if file.search_text.len() > MAX_SEARCH_TEXT_BYTES {
                let mut end = MAX_SEARCH_TEXT_BYTES;
                while !file.search_text.is_char_boundary(end) {
                    end -= 1;
                }
                file.search_text.truncate(end);
            }
        }
        indexed
    })
    .await
    .map_err(|error| sqlx::Error::Protocol(format!("vault index build failed: {error}")))?;
    let Some(mut tx) = crate::maintenance_write_guard(&state.pool).await? else {
        return Err(sqlx::Error::Protocol(
            "vault reindex paused for maintenance".into(),
        ));
    };
    replace_index(&mut tx, vault, &indexed).await?;
    sqlx::query("INSERT INTO vault_search_states(vault_id,status,parser_version) VALUES($1,'ready',$2) ON CONFLICT(vault_id) DO UPDATE SET status='ready',parser_version=EXCLUDED.parser_version,updated_at=now()")
        .bind(vault).bind(PARSER_VERSION).execute(&mut *tx).await?;
    tx.commit().await
}

async fn run_reindex(state: AuthState, vault: Uuid, repository: PathBuf) {
    let files = tokio::task::spawn_blocking(move || vault_import::index_files(&repository)).await;
    let result = match files {
        Ok(Ok(files)) => reindex_import(&state, vault, files).await,
        _ => Err(sqlx::Error::Protocol("vault reindex scan failed".into())),
    };
    if result.is_err() {
        if let Ok(Some(mut tx)) = crate::maintenance_write_guard(&state.pool).await {
            let _ = sqlx::query(
                "UPDATE vault_search_states SET status='failed',updated_at=now() WHERE vault_id=$1",
            )
            .bind(vault)
            .execute(&mut *tx)
            .await;
            let _ = tx.commit().await;
        }
    }
}

async fn replace_index(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    vault: Uuid,
    files: &[IndexedFile],
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM vault_indexed_files WHERE vault_id=$1")
        .bind(vault)
        .execute(&mut **tx)
        .await?;
    for file in files {
        sqlx::query("INSERT INTO vault_indexed_files(vault_id,path,text_content,title,search_text,properties,tags,outgoing_links,parser_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)")
            .bind(vault).bind(&file.path).bind(&file.text_content).bind(&file.title)
            .bind(&file.search_text).bind(&file.properties).bind(&file.tags)
            .bind(&file.outgoing_links).bind(PARSER_VERSION)
            .execute(&mut **tx).await?;
    }
    Ok(())
}
