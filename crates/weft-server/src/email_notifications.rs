//! Optional email for Inbox notifications. A Workspace admin configures SMTP (off by default);
//! a background worker turns notification entries into emails, debouncing attribute changes,
//! re-checking access at send time and retrying failures a bounded number of times.

use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use ring::aead::{self, Aad, LessSafeKey, Nonce, UnboundKey};
use ring::rand::{SecureRandom, SystemRandom};
use serde::Deserialize;
use serde_json::json;
use sqlx::{PgPool, Row};
use tracing::warn;
use uuid::Uuid;

use crate::{
    ai_connections::credential_key,
    auth::{require_session, AuthState},
    email_smtp::{self, Message, Security, SmtpConfig},
    inbox::readable_project,
};

const MAX_ATTEMPTS: i32 = 3;
const TICK: Duration = Duration::from_millis(500);
const DATE_SQL: &str = "to_char(now() AT TIME ZONE 'UTC', 'Dy, DD Mon YYYY HH24:MI:SS \"+0000\"')";

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route(
            "/workspaces/:workspace_id/email",
            get(get_settings).put(put_settings),
        )
        .route("/workspaces/:workspace_id/email/test", post(test_send))
        .route(
            "/workspaces/:workspace_id/email/deliveries",
            get(list_deliveries),
        )
}

fn seal(workspace: Uuid, secret: &str) -> Result<Vec<u8>, ()> {
    let key = LessSafeKey::new(
        UnboundKey::new(&aead::CHACHA20_POLY1305, &credential_key()?).map_err(|_| ())?,
    );
    let mut nonce_bytes = [0u8; 12];
    SystemRandom::new().fill(&mut nonce_bytes).map_err(|_| ())?;
    let mut data = secret.as_bytes().to_vec();
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce_bytes),
        Aad::from(workspace.as_bytes()),
        &mut data,
    )
    .map_err(|_| ())?;
    let mut out = nonce_bytes.to_vec();
    out.extend_from_slice(&data);
    Ok(out)
}

fn open(workspace: Uuid, sealed: &[u8]) -> Result<String, ()> {
    if sealed.len() < 12 {
        return Err(());
    }
    let key = LessSafeKey::new(
        UnboundKey::new(&aead::CHACHA20_POLY1305, &credential_key()?).map_err(|_| ())?,
    );
    let nonce = Nonce::try_assume_unique_for_key(&sealed[..12]).map_err(|_| ())?;
    let mut data = sealed[12..].to_vec();
    let plain = key
        .open_in_place(nonce, Aad::from(workspace.as_bytes()), &mut data)
        .map_err(|_| ())?;
    String::from_utf8(plain.to_vec()).map_err(|_| ())
}

enum Admin {
    Yes,
    No,
    NotMember,
}

async fn admin_role(pool: &PgPool, workspace: Uuid, user: Uuid) -> Result<Admin, sqlx::Error> {
    let role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2",
    )
    .bind(workspace)
    .bind(user)
    .fetch_optional(pool)
    .await?;
    Ok(match role.as_deref() {
        Some("owner" | "admin") => Admin::Yes,
        Some(_) => Admin::No,
        None => Admin::NotMember,
    })
}

/// Resolves the caller as a Workspace admin or returns the status to answer with.
async fn require_admin(
    pool: &PgPool,
    headers: &HeaderMap,
    workspace: Uuid,
    write: bool,
) -> Result<Uuid, StatusCode> {
    let (_, user) = require_session(pool, headers, write).await?;
    match admin_role(pool, workspace, user).await {
        Ok(Admin::Yes) => Ok(user),
        Ok(Admin::No) => Err(StatusCode::FORBIDDEN),
        Ok(Admin::NotMember) => Err(StatusCode::NOT_FOUND),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

struct Settings {
    enabled: bool,
    host: String,
    port: i32,
    security: String,
    username: String,
    ciphertext: Option<Vec<u8>>,
    from_address: String,
    debounce_seconds: i32,
    retry_seconds: i32,
}

impl Settings {
    fn default_off() -> Self {
        Self {
            enabled: false,
            host: String::new(),
            port: 587,
            security: "starttls".into(),
            username: String::new(),
            ciphertext: None,
            from_address: String::new(),
            debounce_seconds: 300,
            retry_seconds: 300,
        }
    }

    fn view(&self) -> serde_json::Value {
        json!({
            "enabled": self.enabled,
            "host": self.host,
            "port": self.port,
            "security": self.security,
            "username": self.username,
            "from_address": self.from_address,
            "password_set": self.ciphertext.is_some(),
            "debounce_seconds": self.debounce_seconds,
            "retry_seconds": self.retry_seconds,
        })
    }

    fn smtp(&self, workspace: Uuid) -> Result<SmtpConfig, String> {
        if self.host.is_empty() || self.from_address.is_empty() {
            return Err("SMTP host and from address are required".into());
        }
        let password = match &self.ciphertext {
            Some(sealed) => Some(
                open(workspace, sealed)
                    .map_err(|_| "the stored SMTP password cannot be decrypted".to_owned())?,
            ),
            None => None,
        };
        Ok(SmtpConfig {
            host: self.host.clone(),
            port: self.port as u16,
            security: Security::parse(&self.security).unwrap_or(Security::StartTls),
            username: self.username.clone(),
            password,
            from: self.from_address.clone(),
        })
    }
}

async fn load_settings(pool: &PgPool, workspace: Uuid) -> Result<Settings, sqlx::Error> {
    let row = sqlx::query("SELECT enabled,host,port,security,username,password_ciphertext,from_address,debounce_seconds,retry_seconds FROM workspace_email_settings WHERE workspace_id=$1")
        .bind(workspace)
        .fetch_optional(pool)
        .await?;
    Ok(match row {
        Some(row) => Settings {
            enabled: row.get("enabled"),
            host: row.get("host"),
            port: row.get("port"),
            security: row.get("security"),
            username: row.get("username"),
            ciphertext: row.get("password_ciphertext"),
            from_address: row.get("from_address"),
            debounce_seconds: row.get("debounce_seconds"),
            retry_seconds: row.get("retry_seconds"),
        },
        None => Settings::default_off(),
    })
}

async fn get_settings(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    if let Err(status) = require_admin(&state.pool, &headers, workspace, false).await {
        return status.into_response();
    }
    match load_settings(&state.pool, workspace).await {
        Ok(settings) => Json(settings.view()).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Deserialize)]
struct SettingsInput {
    enabled: bool,
    host: String,
    port: i64,
    security: String,
    #[serde(default)]
    username: String,
    /// Absent keeps the stored secret, an empty string clears it.
    password: Option<String>,
    from_address: String,
    debounce_seconds: Option<i64>,
    retry_seconds: Option<i64>,
}

fn plain_token(value: &str, max: usize) -> bool {
    value.len() <= max && !value.chars().any(|c| c.is_control() || c.is_whitespace())
}

fn valid_address(value: &str) -> bool {
    plain_token(value, 254)
        && !value.contains(['<', '>', ','])
        && value.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty() && domain.contains('.') && !domain.contains('@')
        })
}

async fn put_settings(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<SettingsInput>,
) -> Response {
    if let Err(status) = require_admin(&state.pool, &headers, workspace, true).await {
        return status.into_response();
    }
    let current = match load_settings(&state.pool, workspace).await {
        Ok(settings) => settings,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let host = input.host.trim().to_owned();
    let from_address = input.from_address.trim().to_owned();
    let debounce = input
        .debounce_seconds
        .unwrap_or(current.debounce_seconds as i64);
    let retry = input.retry_seconds.unwrap_or(current.retry_seconds as i64);
    let bad = !(1..=65535).contains(&input.port)
        || Security::parse(&input.security).is_none()
        || !(host.is_empty() || plain_token(&host, 253))
        || !(input.username.len() <= 255 && !input.username.chars().any(char::is_control))
        || !(from_address.is_empty() || valid_address(&from_address))
        || (input.enabled && (host.is_empty() || from_address.is_empty()))
        || !(0..=86400).contains(&debounce)
        || !(0..=86400).contains(&retry)
        || input
            .password
            .as_ref()
            .is_some_and(|p| p.len() > 1024 || p.chars().any(char::is_control));
    if bad {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    let ciphertext = match input.password.as_deref() {
        None => current.ciphertext,
        Some("") => None,
        Some(secret) => match seal(workspace, secret) {
            Ok(sealed) => Some(sealed),
            Err(()) => {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"error":"credential_encryption_unavailable"})),
                )
                    .into_response()
            }
        },
    };
    let saved = sqlx::query(
        "INSERT INTO workspace_email_settings(workspace_id,enabled,enabled_at,host,port,security,username,password_ciphertext,from_address,debounce_seconds,retry_seconds) \
         VALUES($1,$2,CASE WHEN $2 THEN now() END,$3,$4,$5,$6,$7,$8,$9,$10) \
         ON CONFLICT(workspace_id) DO UPDATE SET \
           enabled_at=CASE WHEN EXCLUDED.enabled AND NOT workspace_email_settings.enabled THEN now() WHEN EXCLUDED.enabled THEN workspace_email_settings.enabled_at END,\
           enabled=EXCLUDED.enabled,host=EXCLUDED.host,port=EXCLUDED.port,security=EXCLUDED.security,username=EXCLUDED.username,\
           password_ciphertext=EXCLUDED.password_ciphertext,from_address=EXCLUDED.from_address,\
           debounce_seconds=EXCLUDED.debounce_seconds,retry_seconds=EXCLUDED.retry_seconds,updated_at=now()",
    )
    .bind(workspace)
    .bind(input.enabled)
    .bind(&host)
    .bind(input.port as i32)
    .bind(&input.security)
    .bind(&input.username)
    .bind(&ciphertext)
    .bind(&from_address)
    .bind(debounce as i32)
    .bind(retry as i32)
    .execute(&state.pool)
    .await;
    if saved.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    match load_settings(&state.pool, workspace).await {
        Ok(settings) => Json(settings.view()).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn mail_date(pool: &PgPool) -> String {
    sqlx::query_scalar(&format!("SELECT {DATE_SQL}"))
        .fetch_one(pool)
        .await
        .unwrap_or_default()
}

/// Sends a test message to the calling admin's own address (never to an arbitrary recipient).
async fn test_send(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let user = match require_admin(&state.pool, &headers, workspace, true).await {
        Ok(user) => user,
        Err(status) => return status.into_response(),
    };
    let settings = match load_settings(&state.pool, workspace).await {
        Ok(settings) => settings,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let to: Option<String> = sqlx::query_scalar("SELECT email FROM users WHERE id=$1")
        .bind(user)
        .fetch_optional(&state.pool)
        .await
        .unwrap_or(None);
    let Some(to) = to else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let result = match settings.smtp(workspace) {
        Ok(config) => {
            let date = mail_date(&state.pool).await;
            let id = format!("{}@weft.invalid", Uuid::new_v4());
            email_smtp::send(
                &config,
                &Message {
                    to: &to,
                    subject: "[Weft] SMTP test",
                    body: "This is a test message from Weft. Email notifications are configured correctly.",
                    date: &date,
                    message_id: &id,
                },
            )
            .await
        }
        Err(error) => Err(error),
    };
    match result {
        Ok(()) => Json(json!({"ok":true,"to":to})).into_response(),
        Err(error) => Json(json!({"ok":false,"error":error})).into_response(),
    }
}

async fn list_deliveries(
    State(state): State<AuthState>,
    Path(workspace): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    if let Err(status) = require_admin(&state.pool, &headers, workspace, false).await {
        return status.into_response();
    }
    let rows = sqlx::query(
        "SELECT e.id,e.status,e.attempts,e.last_error,e.skip_reason,e.created_at::text AS created_at,e.sent_at::text AS sent_at,u.email,t.number \
         FROM notification_emails e JOIN users u ON u.id=e.recipient_id JOIN tasks t ON t.id=e.task_id \
         WHERE e.workspace_id=$1 ORDER BY e.created_at DESC,e.id LIMIT 100",
    )
    .bind(workspace)
    .fetch_all(&state.pool)
    .await;
    match rows {
        Ok(rows) => Json(json!({"deliveries": rows.iter().map(|row| json!({
            "id": row.get::<Uuid,_>("id"),
            "status": row.get::<String,_>("status"),
            "attempts": row.get::<i32,_>("attempts"),
            "last_error": row.get::<Option<String>,_>("last_error"),
            "skip_reason": row.get::<Option<String>,_>("skip_reason"),
            "recipient": row.get::<String,_>("email"),
            "task_number": row.get::<i64,_>("number"),
            "created_at": row.get::<String,_>("created_at"),
            "sent_at": row.get::<Option<String>,_>("sent_at"),
        })).collect::<Vec<_>>()}))
        .into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

pub(crate) fn spawn_worker(pool: PgPool) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(TICK).await;
            if let Err(error) = enqueue(&pool).await {
                warn!(%error, "email enqueue failed");
            }
            if let Err(error) = deliver(&pool).await {
                warn!(%error, "email delivery pass failed");
            }
        }
    });
}

/// Groups unsent notification entries per recipient and Task. A group with a direct reason
/// (assigned, mentioned, replied) is emailed at once; a group of only watched changes waits until
/// no new entry arrived for the debounce window, so a burst of edits becomes one email. Entries
/// created before email was enabled are never replayed.
async fn enqueue(pool: &PgPool) -> Result<(), sqlx::Error> {
    let groups = sqlx::query(
        "SELECT n.workspace_id,n.recipient_id,n.task_id,array_agg(n.id) AS ids \
         FROM notification_intents n \
         JOIN workspace_email_settings s ON s.workspace_id=n.workspace_id AND s.enabled AND n.created_at>=s.enabled_at \
         WHERE n.email_id IS NULL AND n.retracted_at IS NULL \
         GROUP BY n.workspace_id,n.recipient_id,n.task_id,s.debounce_seconds \
         HAVING bool_or(n.reason<>'watched') OR max(n.created_at)<=now()-make_interval(secs=>s.debounce_seconds::double precision)",
    )
    .fetch_all(pool)
    .await?;
    for group in groups {
        let ids: Vec<Uuid> = group.get("ids");
        let email = Uuid::new_v4();
        let mut tx = pool.begin().await?;
        sqlx::query("INSERT INTO notification_emails(id,workspace_id,task_id,recipient_id) VALUES($1,$2,$3,$4)")
            .bind(email)
            .bind(group.get::<Uuid, _>("workspace_id"))
            .bind(group.get::<Uuid, _>("task_id"))
            .bind(group.get::<Uuid, _>("recipient_id"))
            .execute(&mut *tx)
            .await?;
        let claimed = sqlx::query("UPDATE notification_intents SET email_id=$1 WHERE id=ANY($2) AND email_id IS NULL AND retracted_at IS NULL")
            .bind(email)
            .bind(&ids)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        if claimed == 0 {
            tx.rollback().await?;
        } else {
            tx.commit().await?;
        }
    }
    Ok(())
}

async fn deliver(pool: &PgPool) -> Result<(), sqlx::Error> {
    // Leasing the row keeps a second server (or a crash mid-send) from sending it twice at once.
    let due = sqlx::query(
        "UPDATE notification_emails SET next_attempt_at=now()+interval '2 minutes' WHERE id IN \
         (SELECT id FROM notification_emails WHERE status='queued' AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT 10 FOR UPDATE SKIP LOCKED) \
         RETURNING id,workspace_id,task_id,recipient_id,attempts",
    )
    .fetch_all(pool)
    .await?;
    for row in due {
        deliver_one(
            pool,
            row.get("id"),
            row.get("workspace_id"),
            row.get("task_id"),
            row.get("recipient_id"),
            row.get("attempts"),
        )
        .await?;
    }
    Ok(())
}

async fn skip(pool: &PgPool, email: Uuid, reason: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE notification_emails SET status='skipped',skip_reason=$2 WHERE id=$1")
        .bind(email)
        .bind(reason)
        .execute(pool)
        .await?;
    Ok(())
}

fn reason_line(reason: &str) -> &'static str {
    match reason {
        "assigned" => "You were assigned to this task.",
        "mentioned" => "You were mentioned on this task.",
        "replied" => "Someone replied to your comment on this task.",
        _ => "A task you watch changed.",
    }
}

async fn deliver_one(
    pool: &PgPool,
    email: Uuid,
    workspace: Uuid,
    task: Uuid,
    recipient: Uuid,
    attempts: i32,
) -> Result<(), sqlx::Error> {
    let settings = load_settings(pool, workspace).await?;
    if !settings.enabled {
        return skip(pool, email, "email_disabled").await;
    }
    let member: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2)",
    )
    .bind(workspace)
    .bind(recipient)
    .fetch_one(pool)
    .await?;
    // Access is judged now, not when the entry was created: nothing about a Task the recipient
    // can no longer read may leave the server.
    if !member || readable_project(pool, task, recipient).await?.is_none() {
        return skip(pool, email, "no_access").await;
    }
    let muted: bool = sqlx::query_scalar(
        "SELECT COALESCE((SELECT muted FROM task_notification_preferences WHERE task_id=$1 AND user_id=$2),false)",
    )
    .bind(task)
    .bind(recipient)
    .fetch_one(pool)
    .await?;
    if muted {
        return skip(pool, email, "muted").await;
    }
    let reasons: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT n.reason FROM notification_intents n WHERE n.email_id=$1 AND n.retracted_at IS NULL \
         AND (n.operation_group_id IS NULL OR NOT EXISTS(SELECT 1 FROM task_operation_groups g WHERE g.id=n.operation_group_id AND g.state='undone')) ORDER BY 1",
    )
    .bind(email)
    .fetch_all(pool)
    .await?;
    if reasons.is_empty() {
        return skip(pool, email, "retracted").await;
    }
    let task_row = sqlx::query("SELECT number,title,status FROM tasks WHERE id=$1")
        .bind(task)
        .fetch_one(pool)
        .await?;
    let address: String = sqlx::query_scalar("SELECT email FROM users WHERE id=$1")
        .bind(recipient)
        .fetch_one(pool)
        .await?;
    let number: i64 = task_row.get("number");
    let title: String = task_row.get("title");
    let status: String = task_row.get("status");
    let subject = format!(
        "[Weft] #{number} {}",
        title.chars().take(150).collect::<String>()
    );
    let mut body = String::new();
    for reason in &reasons {
        body.push_str(reason_line(reason));
        body.push('\n');
    }
    body.push_str(&format!(
        "\n#{number} {title}\nStatus: {status}\n\nOpen it in Weft: /w/{workspace}/tasks/{number}\n"
    ));

    let result = match settings.smtp(workspace) {
        Ok(config) => {
            let date = mail_date(pool).await;
            let id = format!("{email}@weft.invalid");
            email_smtp::send(
                &config,
                &Message {
                    to: &address,
                    subject: &subject,
                    body: &body,
                    date: &date,
                    message_id: &id,
                },
            )
            .await
        }
        Err(error) => Err(error),
    };
    match result {
        Ok(()) => {
            sqlx::query("UPDATE notification_emails SET status='sent',attempts=$2,sent_at=now(),last_error=NULL WHERE id=$1")
                .bind(email)
                .bind(attempts + 1)
                .execute(pool)
                .await?;
        }
        Err(error) => {
            let attempts = attempts + 1;
            let status = if attempts >= MAX_ATTEMPTS {
                "failed"
            } else {
                "queued"
            };
            sqlx::query("UPDATE notification_emails SET status=$2,attempts=$3,last_error=$4,next_attempt_at=now()+make_interval(secs=>$5::double precision) WHERE id=$1")
                .bind(email)
                .bind(status)
                .bind(attempts)
                .bind(&error)
                .bind(settings.retry_seconds)
                .execute(pool)
                .await?;
        }
    }
    Ok(())
}
