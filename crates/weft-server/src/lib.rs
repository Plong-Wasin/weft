use std::{
    future::IntoFuture,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use axum::{
    extract::State,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{any, get},
    Json, Router,
};
use serde_json::{json, Value};
use sqlx::{postgres::PgPoolOptions, Connection, PgConnection, PgPool};
use tokio::net::TcpListener;
use tower_http::services::{ServeDir, ServeFile};
use tracing::{error, info};

mod auth;
mod projects;
mod skills;
mod tasks;
pub use auth::{bootstrap_admin, reset_password};

static MIGRATION_LOCK_ID: i64 = 0x574546540001;
static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!();

#[derive(Clone)]
pub struct ServerConfig {
    pub database_url: String,
    pub web_root: PathBuf,
}

impl ServerConfig {
    pub fn new(database_url: impl Into<String>, web_root: impl Into<PathBuf>) -> Self {
        Self {
            database_url: database_url.into(),
            web_root: web_root.into(),
        }
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
        .connect(database_url)
        .await
}

pub async fn migrate(database_url: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut connection = PgConnection::connect(database_url).await?;
    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(MIGRATION_LOCK_ID)
        .execute(&mut connection)
        .await?;

    let migration_result = MIGRATOR.run_direct(&mut connection).await;
    let unlock_result = sqlx::query("SELECT pg_advisory_unlock($1)")
        .bind(MIGRATION_LOCK_ID)
        .execute(&mut connection)
        .await;

    migration_result?;
    unlock_result?;
    Ok(())
}

pub async fn serve(
    listener: TcpListener,
    config: ServerConfig,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let pool = connect(&config.database_url).await?;
    let ready = Arc::new(AtomicBool::new(false));
    let state = AppState {
        pool: pool.clone(),
        ready: ready.clone(),
    };
    let router = Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(readiness))
        .route("/api/v1", get(api_root))
        .nest(
            "/api/v1",
            auth::routes()
                .merge(projects::routes())
                .merge(skills::routes())
                .merge(tasks::routes())
                .with_state(auth::AuthState { pool: pool.clone() }),
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
    let migration = migrate(&config.database_url);
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
