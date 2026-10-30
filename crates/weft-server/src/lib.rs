use std::{
    future::{poll_fn, IntoFuture},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use axum::{
    body::{Body, HttpBody},
    extract::State,
    http::Request,
    http::{header, StatusCode},
    middleware::{self, Next},
    response::Response as AxumResponse,
    response::{IntoResponse, Response},
    routing::{any, get},
    Json, Router,
};
use serde_json::{json, Value};
use sqlx::{postgres::PgPoolOptions, Connection, PgConnection, PgPool};
use tokio::net::TcpListener;
use tower_http::services::{ServeDir, ServeFile};
use tracing::{error, info};
use uuid::Uuid;

mod ai_connections;
mod ai_knowledge_proposals;
mod ai_mcp;
mod ai_provenance;
mod ai_runner;
mod ai_runs;
pub mod ai_tools;
mod auth;
mod collaboration;
mod comment_attachments;
mod csv_export;
mod customization;
mod dependencies;
mod email_notifications;
mod email_smtp;
mod inbox;
pub mod knowledge;
mod lists;
mod milestones;
mod note_reference_text;
mod project_overview;
mod projects;
mod proposal_milestones;
mod proposals;
mod realtime;
pub mod recurrence;
mod skills;
mod smart_query;
mod task_import;
mod task_reference_text;
mod tasks;
mod teams;
mod templates;
mod vault_export;
mod vault_import;
mod vaults;
mod workspace_settings;
pub use ai_provenance::{prune_ai_records, retention_days as ai_retention_days};
pub use ai_runner::{enqueue_agent_job, sign_agent_job, AgentJobError};
pub use auth::{bootstrap_admin, reset_password};
pub use vault_import::{git_command, git_readonly_command};

static MIGRATION_LOCK_ID: i64 = 0x574546540001;
static MAINTENANCE_LOCK_ID: i64 = 0x574546540002;
static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!();

#[derive(Clone)]
pub struct ServerConfig {
    pub database_url: String,
    pub web_root: PathBuf,
    pub vault_root: PathBuf,
}

impl ServerConfig {
    pub fn new(database_url: impl Into<String>, web_root: impl Into<PathBuf>) -> Self {
        Self {
            database_url: database_url.into(),
            web_root: web_root.into(),
            vault_root: std::env::var_os("WEFT_VAULT_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/var/lib/weft/vaults")),
        }
    }

    pub fn with_vault_root(mut self, root: impl Into<PathBuf>) -> Self {
        self.vault_root = root.into();
        self
    }
}

#[derive(Clone)]
struct AppState {
    pool: PgPool,
    ready: Arc<AtomicBool>,
}

pub async fn connect(database_url: &str) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect(database_url)
        .await
}

pub async fn migrate(database_url: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    migrate_database(database_url, false).await
}

async fn migrate_for_serve(
    database_url: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    migrate_database(database_url, true).await
}

async fn migrate_database(
    database_url: &str,
    recover_interrupted_imports: bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut connection = PgConnection::connect(database_url).await?;
    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(MIGRATION_LOCK_ID)
        .execute(&mut connection)
        .await?;

    let migration_result = MIGRATOR.run_direct(&mut connection).await;
    let recovery_result = if migration_result.is_ok() && recover_interrupted_imports {
        sweep_interrupted_imports(&mut connection).await
    } else {
        Ok(())
    };
    let unlock_result = sqlx::query("SELECT pg_advisory_unlock($1)")
        .bind(MIGRATION_LOCK_ID)
        .execute(&mut connection)
        .await;

    migration_result?;
    recovery_result?;
    unlock_result?;
    Ok(())
}

async fn sweep_interrupted_imports(connection: &mut PgConnection) -> Result<(), sqlx::Error> {
    let interrupted: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "WITH active AS MATERIALIZED (SELECT id,vault_id,status FROM vault_import_jobs WHERE status IN ('queued','importing','reindexing')), failed AS (UPDATE vault_import_jobs j SET status='failed',reindex_status=CASE WHEN j.reindex_status IN ('queued','running') THEN 'failed' ELSE j.reindex_status END,error='Import interrupted by server restart',updated_at=now() FROM active WHERE j.id=active.id RETURNING j.id,j.vault_id,active.status AS previous_status), stale AS (UPDATE vault_search_states s SET status='failed',updated_at=now() FROM failed WHERE failed.previous_status='reindexing' AND s.vault_id=failed.vault_id RETURNING s.vault_id) SELECT failed.id,failed.vault_id FROM failed",
    )
    .fetch_all(&mut *connection)
    .await?;
    for (job, vault) in interrupted {
        if let Some(repository) =
            sqlx::query_scalar::<_, String>("SELECT repository_path FROM vaults WHERE id=$1")
                .bind(vault)
                .fetch_optional(&mut *connection)
                .await?
        {
            let repository = PathBuf::from(repository);
            let old = repository.with_extension("old");
            if old.exists() {
                if repository.exists() {
                    let _ = std::fs::remove_dir_all(old);
                } else {
                    let _ = std::fs::rename(old, &repository);
                }
            }
            for suffix in ["archive", "new", "work", "import", "seed"] {
                let _ = std::fs::remove_dir_all(repository.with_extension(suffix));
            }
        }
        let _ =
            std::fs::remove_dir_all(std::env::temp_dir().join(format!("weft-vault-import-{job}")));
    }
    Ok(())
}

pub async fn serve(
    listener: TcpListener,
    config: ServerConfig,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let pool = connect(&config.database_url).await?;
    // The Apply lock of every Vault with a group to recover is taken here, without waiting, before the
    // first request is served: a new Apply cannot move `main` under a half-finished one, it gets
    // `vault_busy`. Recovery itself (and the wait of up to 60 s for a Vault another session holds) runs
    // beside the listener instead of delaying startup.
    let recovery_hold = knowledge::apply::hold_vaults_awaiting_recovery(&pool).await;
    tokio::spawn({
        let pool = pool.clone();
        async move { knowledge::apply::recover(&pool, recovery_hold).await }
    });
    email_notifications::spawn_worker(pool.clone());
    let maintenance_pool = connect(&config.database_url).await?;
    let health_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect(&config.database_url)
        .await?;
    let ready = Arc::new(AtomicBool::new(false));
    let state = AppState {
        pool: health_pool,
        ready: ready.clone(),
    };
    let router = Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(readiness))
        .route("/health/maintenance", get(maintenance_status))
        .route("/api/v1", get(api_root))
        .nest(
            "/api/v1",
            auth::routes()
                .merge(ai_connections::routes())
                .merge(ai_mcp::routes())
                .merge(ai_runner::routes())
                .merge(ai_runs::routes())
                .merge(projects::routes())
                .merge(project_overview::routes())
                .merge(realtime::routes())
                .merge(proposals::routes())
                .merge(ai_provenance::routes())
                .merge(vaults::routes())
                .merge(knowledge::reader::routes())
                .merge(knowledge::search::routes())
                .merge(vault_import::routes())
                .merge(vault_export::routes())
                .merge(teams::routes())
                .merge(skills::routes())
                .merge(tasks::routes())
                .merge(workspace_settings::routes())
                .merge(csv_export::routes())
                .merge(task_import::routes())
                .merge(collaboration::routes())
                .merge(inbox::routes())
                .merge(email_notifications::routes())
                .merge(comment_attachments::routes())
                .merge(customization::routes())
                .merge(lists::routes())
                .merge(milestones::routes())
                .merge(dependencies::routes())
                .merge(templates::routes())
                .with_state(auth::AuthState {
                    pool: pool.clone(),
                    vault_root: config.vault_root.clone(),
                })
                .route_layer(middleware::from_fn_with_state(
                    maintenance_pool,
                    reject_writes_in_maintenance,
                )),
        )
        .merge(
            knowledge::reader::page_routes().with_state(auth::AuthState {
                pool: pool.clone(),
                vault_root: config.vault_root.clone(),
            }),
        )
        // Unknown API and health paths must stay real 404s; every other path gets the shell so
        // deep links such as /w/<workspace>/tasks/<n> survive a reload.
        .route("/api/*rest", any(|| async { StatusCode::NOT_FOUND }))
        .route("/health/*rest", any(|| async { StatusCode::NOT_FOUND }))
        .fallback_service(
            ServeDir::new(&config.web_root)
                .append_index_html_on_directories(true)
                .fallback(ServeFile::new(config.web_root.join("index.html"))),
        )
        .with_state(state);

    let http = axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .into_future();
    let migration = migrate_for_serve(&config.database_url);
    tokio::pin!(http);
    tokio::pin!(migration);
    tokio::select! {
        result = &mut http => {
            result?;
            Ok(())
        }
        result = &mut migration => {
            match result {
                Ok(()) => {
                    ready.store(true, Ordering::Release);
                    info!("database migrations complete; readiness enabled");
                    http.await?;
                    Ok(())
                }
                Err(error) => {
                    error!(%error, "database migrations failed");
                    Err(error)
                }
            }
        }
    }
}

async fn live() -> StatusCode {
    StatusCode::OK
}

async fn maintenance_status(State(state): State<AppState>) -> Response {
    match sqlx::query_scalar::<_, bool>("SELECT maintenance_mode FROM weft_installation WHERE id=1")
        .fetch_one(&state.pool)
        .await
    {
        Ok(enabled) => (StatusCode::OK, Json(json!({"maintenance":enabled}))).into_response(),
        Err(_) => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}

async fn reject_writes_in_maintenance(
    State(pool): State<PgPool>,
    request: Request<Body>,
    next: Next,
) -> AxumResponse {
    if request.method() != axum::http::Method::GET
        && request.method() != axum::http::Method::HEAD
        && request.method() != axum::http::Method::OPTIONS
    {
        // Consume each write body before borrowing a maintenance connection so slow clients
        // cannot reserve the pool. Route-specific caps preserve the archive and attachment
        // upload limits while keeping ordinary unauthenticated requests small.
        let (parts, body) = request.into_parts();
        let cap = request_body_limit(&parts.uri);
        if parts
            .headers
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<usize>().ok())
            .is_some_and(|length| length > cap)
        {
            return StatusCode::PAYLOAD_TOO_LARGE.into_response();
        }
        let body = match tokio::time::timeout(
            std::time::Duration::from_secs(600),
            collect_write_body(body, cap),
        )
        .await
        {
            Ok(Ok(body)) => body,
            Ok(Err(BodyReadError::TooLarge)) => {
                return StatusCode::PAYLOAD_TOO_LARGE.into_response()
            }
            Ok(Err(BodyReadError::Read)) => return StatusCode::BAD_REQUEST.into_response(),
            Ok(Err(BodyReadError::IdleTimeout)) => {
                return StatusCode::REQUEST_TIMEOUT.into_response()
            }
            Err(_) => return StatusCode::REQUEST_TIMEOUT.into_response(),
        };
        let request = Request::from_parts(parts, Body::from(body));
        let mut transaction = match pool.begin().await {
            Ok(transaction) => transaction,
            Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
        };
        if sqlx::query("SET LOCAL lock_timeout = '5s'")
            .execute(&mut *transaction)
            .await
            .is_err()
        {
            let _ = transaction.rollback().await;
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
        if sqlx::query("SELECT pg_advisory_xact_lock_shared($1)")
            .bind(MAINTENANCE_LOCK_ID)
            .execute(&mut *transaction)
            .await
            .is_err()
        {
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
        let maintenance = sqlx::query_scalar::<_, bool>(
            "SELECT maintenance_mode FROM weft_installation WHERE id=1",
        )
        .fetch_one(&mut *transaction)
        .await;
        match maintenance {
            Ok(true) => {
                let _ = transaction.rollback().await;
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"error":"maintenance_mode","message":"Writes are paused for a maintenance operation"})),
                ).into_response();
            }
            Err(_) => {
                let _ = transaction.rollback().await;
                return StatusCode::SERVICE_UNAVAILABLE.into_response();
            }
            Ok(false) => {}
        }
        let response = match tokio::time::timeout(
            std::time::Duration::from_secs(120),
            next.run(request),
        )
        .await
        {
            Ok(response) => response,
            Err(_) => {
                let _ = transaction.rollback().await;
                return StatusCode::GATEWAY_TIMEOUT.into_response();
            }
        };
        let _ = transaction.commit().await;
        return response;
    }
    next.run(request).await
}

enum BodyReadError {
    TooLarge,
    Read,
    IdleTimeout,
}

async fn collect_write_body(
    mut body: Body,
    limit: usize,
) -> Result<axum::body::Bytes, BodyReadError> {
    let mut bytes = Vec::new();
    loop {
        let frame = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            poll_fn(|context| std::pin::Pin::new(&mut body).poll_frame(context)),
        )
        .await
        .map_err(|_| BodyReadError::IdleTimeout)?;
        let Some(frame) = frame else { break };
        let frame = frame.map_err(|_| BodyReadError::Read)?;
        if let Ok(data) = frame.into_data() {
            if bytes.len().saturating_add(data.len()) > limit {
                return Err(BodyReadError::TooLarge);
            }
            bytes.extend_from_slice(&data);
        }
    }
    Ok(axum::body::Bytes::from(bytes))
}

fn request_body_limit(uri: &axum::http::Uri) -> usize {
    let path = uri.path();
    if path.ends_with("/imports/archive") {
        50 * 1024 * 1024
    } else if path.ends_with("/attachments") {
        21 * 1024 * 1024
    } else {
        2 * 1024 * 1024
    }
}

pub(crate) async fn maintenance_write_guard(
    pool: &PgPool,
) -> Result<Option<sqlx::Transaction<'static, sqlx::Postgres>>, sqlx::Error> {
    let mut transaction = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock_shared($1)")
        .bind(MAINTENANCE_LOCK_ID)
        .execute(&mut *transaction)
        .await?;
    let enabled =
        sqlx::query_scalar::<_, bool>("SELECT maintenance_mode FROM weft_installation WHERE id=1")
            .fetch_one(&mut *transaction)
            .await?;
    if enabled {
        transaction.rollback().await?;
        Ok(None)
    } else {
        Ok(Some(transaction))
    }
}

pub async fn set_maintenance_mode(database_url: &str, enabled: bool) -> Result<(), sqlx::Error> {
    let pool = connect(database_url).await?;
    let mut connection = pool.acquire().await?;
    sqlx::query("SET lock_timeout = '30s'")
        .execute(&mut *connection)
        .await?;
    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(MAINTENANCE_LOCK_ID)
        .execute(&mut *connection)
        .await?;
    let update = sqlx::query("UPDATE weft_installation SET maintenance_mode=$1, maintenance_started_at=CASE WHEN $1 THEN now() ELSE NULL END WHERE id=1")
        .bind(enabled)
        .execute(&mut *connection)
        .await;
    let unlock = sqlx::query("SELECT pg_advisory_unlock($1)")
        .bind(MAINTENANCE_LOCK_ID)
        .execute(&mut *connection)
        .await;
    update?;
    unlock?;
    drop(connection);
    pool.close().await;
    Ok(())
}

async fn readiness(State(state): State<AppState>) -> Response {
    let database_available = sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.pool)
        .await
        .is_ok();
    if state.ready.load(Ordering::Acquire) && database_available {
        StatusCode::OK.into_response()
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            [(header::RETRY_AFTER, "1")],
        )
            .into_response()
    }
}

async fn api_root() -> Json<Value> {
    Json(json!({"service": "weft", "api_version": "v1"}))
}

async fn shutdown_signal() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        error!(%error, "failed to listen for shutdown signal");
    }
    info!("shutdown signal received");
}

#[cfg(test)]
mod maintenance_tests {
    use super::request_body_limit;

    #[test]
    fn request_body_limit_is_small_except_for_upload_routes() {
        assert_eq!(
            request_body_limit(&"/api/v1/auth/sign-in".parse().unwrap()),
            2 * 1024 * 1024
        );
        assert_eq!(
            request_body_limit(&"/api/v1/vaults/id/imports/archive".parse().unwrap()),
            50 * 1024 * 1024
        );
        assert_eq!(
            request_body_limit(&"/api/v1/tasks/id/attachments".parse().unwrap()),
            21 * 1024 * 1024
        );
    }

    #[tokio::test]
    async fn body_buffering_enforces_the_selected_cap() {
        let result = super::collect_write_body(axum::body::Body::from(vec![0; 8]), 7).await;
        assert!(matches!(result, Err(super::BodyReadError::TooLarge)));
    }
}
