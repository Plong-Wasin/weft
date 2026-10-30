use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post},
    Json, Router,
};
use rand::rngs::OsRng;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct AuthState {
    pub pool: PgPool,
    pub vault_root: std::path::PathBuf,
}

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route("/auth/sign-in", post(sign_in))
        .route("/auth/me", get(me))
        .route("/auth/audit-events", get(audit_events))
        .route("/auth/sign-out", post(sign_out))
        .route("/auth/sessions", get(list_sessions))
        .route("/auth/sessions/:id", delete(revoke_session))
        .route("/auth/invites", post(create_invite).get(list_invites))
        .route("/auth/invites/:id", delete(revoke_invite))
        .route("/auth/invites/accept", post(accept_invite))
        .route(
            "/workspaces/:workspace_id/members/:user_id",
            patch(change_role).delete(remove_member),
        )
}

async fn me(State(state): State<AuthState>, headers: HeaderMap) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let rows=sqlx::query("SELECT m.workspace_id,w.name,m.role FROM workspace_memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=$1 ORDER BY w.name")
        .bind(user).fetch_all(&state.pool).await;
    match rows{Ok(rows)=>Json(json!({"user_id":user,"workspaces":rows.into_iter().map(|r|json!({"id":r.get::<Uuid,_>("workspace_id"),"name":r.get::<String,_>("name"),"role":r.get::<String,_>("role")})).collect::<Vec<_>>()})).into_response(),Err(_)=>StatusCode::INTERNAL_SERVER_ERROR.into_response()}
}

async fn audit_events(State(state): State<AuthState>, headers: HeaderMap) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let membership = sqlx::query(
        "SELECT workspace_id,role FROM workspace_memberships WHERE user_id=$1 ORDER BY workspace_id LIMIT 1",
    )
    .bind(user)
    .fetch_optional(&state.pool).await;
    let Ok(Some(membership)) = membership else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let workspace: Uuid = membership.get("workspace_id");
    let role: String = membership.get("role");
    if role != "owner" && role != "admin" {
        return StatusCode::FORBIDDEN.into_response();
    }
    let rows=sqlx::query("SELECT event,actor_id,subject_id,created_at::text AS created_at FROM security_audit_events WHERE workspace_id=$1 ORDER BY id").bind(workspace).fetch_all(&state.pool).await;
    match rows{Ok(rows)=>Json(json!({"events":rows.into_iter().map(|r|json!({"event":r.get::<String,_>("event"),"actor_id":r.get::<Option<Uuid>,_>("actor_id"),"subject_id":r.get::<Option<Uuid>,_>("subject_id"),"created_at":r.get::<String,_>("created_at")})).collect::<Vec<Value>>()})).into_response(),Err(_)=>StatusCode::INTERNAL_SERVER_ERROR.into_response()}
}

pub async fn bootstrap_admin(
    pool: &PgPool,
    email: &str,
    password: &str,
    workspace_name: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut tx = pool.begin().await?;
    sqlx::query("LOCK TABLE users IN EXCLUSIVE MODE")
        .execute(&mut *tx)
        .await?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&mut *tx)
        .await?;
    if count != 0 {
        return Err("bootstrap admin already exists".into());
    }
    let user_id = Uuid::new_v4();
    let workspace_id = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, email, password_hash) VALUES ($1, lower($2), $3)")
        .bind(user_id)
        .bind(email.trim())
        .bind(hash_password(password)?)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO workspaces (id, name) VALUES ($1, $2)")
        .bind(workspace_id)
        .bind(workspace_name.trim())
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
    )
    .bind(workspace_id)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO security_audit_events (actor_id, workspace_id, event, subject_id) VALUES ($1, $2, 'bootstrap.completed', $1)")
        .bind(user_id)
        .bind(workspace_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn reset_password(
    pool: &PgPool,
    email: &str,
    password: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut tx = pool.begin().await?;
    let Some(user_id) =
        sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE email=lower($1) FOR UPDATE")
            .bind(email.trim())
            .fetch_optional(&mut *tx)
            .await?
    else {
        return Err("user not found".into());
    };
    sqlx::query("UPDATE users SET password_hash = $2 WHERE id = $1")
        .bind(user_id)
        .bind(hash_password(password)?)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO security_audit_events (workspace_id,event,subject_id) SELECT workspace_id,'password.reset',$1 FROM workspace_memberships WHERE user_id=$1")
        .bind(user_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

fn hash_password(password: &str) -> Result<String, std::io::Error> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| std::io::Error::other("password hashing failed"))
}

fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn random_token() -> String {
    Uuid::new_v4().simple().to_string() + &Uuid::new_v4().simple().to_string()
}

#[derive(Deserialize)]
struct Credentials {
    email: String,
    password: String,
}

// Reserves one login attempt under a short per-email lock. The lock is released before the
// password hash runs, so slow hashing never pins pool connections.
async fn reserve_login_attempt(pool: &PgPool, email: &str) -> Result<bool, sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(email)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM login_attempts WHERE attempted_at < now() - interval '15 minutes'")
        .execute(&mut *tx)
        .await?;
    let attempts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM login_attempts WHERE email = $1 AND attempted_at > now() - interval '15 minutes'",
    )
    .bind(email)
    .fetch_one(&mut *tx)
    .await?;
    if attempts >= 10 {
        tx.rollback().await?;
        return Ok(false);
    }
    sqlx::query("INSERT INTO login_attempts (email) VALUES ($1)")
        .bind(email)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(true)
}

fn invalid_credentials() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({"error":"invalid_credentials"})),
    )
        .into_response()
}

async fn sign_in(State(state): State<AuthState>, Json(credentials): Json<Credentials>) -> Response {
    let email = credentials.email.trim().to_lowercase();
    match reserve_login_attempt(&state.pool, &email).await {
        Ok(true) => {}
        Ok(false) => {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({"error":"too_many_attempts"})),
            )
                .into_response();
        }
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    let row = match sqlx::query("SELECT id, password_hash FROM users WHERE email = $1")
        .bind(&email)
        .fetch_optional(&state.pool)
        .await
    {
        Ok(Some(row)) => row,
        Ok(None) => return invalid_credentials(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let user_id: Uuid = row.get("id");
    let password_hash: String = row.get("password_hash");
    let password = credentials.password;
    let verified = tokio::task::spawn_blocking(move || {
        PasswordHash::new(&password_hash).ok().is_some_and(|hash| {
            Argon2::default()
                .verify_password(password.as_bytes(), &hash)
                .is_ok()
        })
    })
    .await
    .unwrap_or(false);
    if !verified {
        return invalid_credentials();
    }
    let token = random_token();
    let csrf = random_token();
    let session_id = Uuid::new_v4();
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if sqlx::query("DELETE FROM login_attempts WHERE email=$1")
        .bind(&email)
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if sqlx::query("INSERT INTO sessions (id, user_id, token_hash, csrf_token, expires_at) VALUES ($1,$2,$3,$4,now()+interval '30 days')")
        .bind(session_id).bind(user_id).bind(digest(&token)).bind(&csrf).execute(&mut *tx).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if sqlx::query("INSERT INTO security_audit_events (actor_id,workspace_id,event,subject_id) SELECT $1,workspace_id,'sign_in',$1 FROM workspace_memberships WHERE user_id=$1 LIMIT 1")
        .bind(user_id).execute(&mut *tx).await.is_err() || tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let mut response = Json(json!({"id":session_id,"user_id":user_id})).into_response();
    set_cookie(&mut response, "weft_session", &token, true);
    set_cookie(&mut response, "weft_csrf", &csrf, false);
    response
}

fn set_cookie(response: &mut Response, name: &str, value: &str, http_only: bool) {
    let mut cookie = format!("{name}={value}; Path=/; SameSite=Strict");
    if http_only {
        cookie.push_str("; HttpOnly");
    }
    if std::env::var("WEFT_COOKIE_SECURE").as_deref() == Ok("1") {
        cookie.push_str("; Secure");
    }
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        response.headers_mut().append(header::SET_COOKIE, value);
    }
}

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|pair| {
            let (key, value) = pair.trim().split_once('=')?;
            (key == name).then(|| value.to_owned())
        })
}

async fn authenticated(pool: &PgPool, headers: &HeaderMap) -> Option<(Uuid, Uuid, String)> {
    let token = cookie(headers, "weft_session")?;
    let row = sqlx::query("SELECT id,user_id,csrf_token FROM sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()")
        .bind(digest(&token)).fetch_optional(pool).await.ok()??;
    Some((row.get("id"), row.get("user_id"), row.get("csrf_token")))
}

pub(crate) async fn require_session(
    pool: &PgPool,
    headers: &HeaderMap,
    write: bool,
) -> Result<(Uuid, Uuid), StatusCode> {
    let Some((session_id, user_id, csrf_db)) = authenticated(pool, headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    if write {
        let csrf_cookie = cookie(headers, "weft_csrf");
        let csrf_header = headers
            .get("x-csrf-token")
            .and_then(|value| value.to_str().ok());
        if csrf_cookie.as_deref() != Some(&csrf_db) || csrf_header != Some(&csrf_db) {
            return Err(StatusCode::FORBIDDEN);
        }
    }
    Ok((session_id, user_id))
}

async fn sign_out(State(state): State<AuthState>, headers: HeaderMap) -> Response {
    let (session, user) = match require_session(&state.pool, &headers, true).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if sqlx::query("UPDATE sessions SET revoked_at=now() WHERE id=$1")
        .bind(session)
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if sqlx::query("INSERT INTO security_audit_events (actor_id,workspace_id,event,subject_id) SELECT $1,workspace_id,'session.revoke',$2 FROM workspace_memberships WHERE user_id=$1 LIMIT 1").bind(user).bind(session).execute(&mut *tx).await.is_err() || tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    for name in ["weft_session", "weft_csrf"] {
        response.headers_mut().append(
            header::SET_COOKIE,
            HeaderValue::from_str(&format!("{name}=; Path=/; Max-Age=0; SameSite=Strict")).unwrap(),
        );
    }
    response
}

async fn list_sessions(State(state): State<AuthState>, headers: HeaderMap) -> Response {
    let (current, user) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let rows = sqlx::query("SELECT id,created_at::text AS created_at,expires_at::text AS expires_at FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC")
        .bind(user).fetch_all(&state.pool).await;
    match rows { Ok(rows) => Json(json!({"sessions":rows.into_iter().map(|r| json!({"id":r.get::<Uuid,_>("id"),"created_at":r.get::<String,_>("created_at"),"expires_at":r.get::<String,_>("expires_at"),"current":r.get::<Uuid,_>("id")==current})).collect::<Vec<_>>()})).into_response(), Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response() }
}

async fn revoke_session(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let result = sqlx::query(
        "UPDATE sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL",
    )
    .bind(id)
    .bind(user)
    .execute(&mut *tx)
    .await;
    match result {
        Ok(result) if result.rows_affected() == 1 => {
            if sqlx::query("INSERT INTO security_audit_events (actor_id,workspace_id,event,subject_id) SELECT $1,workspace_id,'session.revoke',$2 FROM workspace_memberships WHERE user_id=$1 LIMIT 1").bind(user).bind(id).execute(&mut *tx).await.is_err() || tx.commit().await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(_) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn workspace_role(
    pool: &mut sqlx::PgConnection,
    workspace: Uuid,
    user: Uuid,
) -> Option<String> {
    sqlx::query_scalar(
        "SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2",
    )
    .bind(workspace)
    .bind(user)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
}

#[derive(Deserialize)]
struct NewInvite {
    role: String,
    expires_in_hours: Option<i64>,
    expires_in_seconds: Option<i64>,
}

async fn create_invite(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Json(input): Json<NewInvite>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    if !["admin", "member", "viewer"].contains(&input.role.as_str()) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_role"})),
        )
            .into_response();
    }
    let workspace = sqlx::query("SELECT workspace_id,role FROM workspace_memberships WHERE user_id=$1 ORDER BY workspace_id LIMIT 1").bind(user).fetch_optional(&state.pool).await;
    let Ok(Some(workspace)) = workspace else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let workspace_id: Uuid = workspace.get("workspace_id");
    let role: String = workspace.get("role");
    if role != "owner" && role != "admin" {
        return StatusCode::FORBIDDEN.into_response();
    }
    let token = random_token();
    let id = Uuid::new_v4();
    let seconds = input
        .expires_in_seconds
        .unwrap_or_else(|| input.expires_in_hours.unwrap_or(168).saturating_mul(3600))
        .clamp(1, 2_592_000);
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let result = sqlx::query("INSERT INTO invitations (id,workspace_id,created_by,token_hash,role,expires_at) VALUES ($1,$2,$3,$4,$5,now()+($6::text||' seconds')::interval) RETURNING expires_at::text")
        .bind(id).bind(workspace_id).bind(user).bind(digest(&token)).bind(&input.role).bind(seconds).fetch_one(&mut *tx).await;
    match result {
        Ok(row) => {
            if sqlx::query("INSERT INTO security_audit_events (actor_id,workspace_id,event,subject_id) VALUES ($1,$2,'invite.create',$3)").bind(user).bind(workspace_id).bind(id).execute(&mut *tx).await.is_err() || tx.commit().await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
            (StatusCode::CREATED,Json(json!({"id":id,"token":token,"role":input.role,"expires_at":row.get::<String,_>("expires_at")}))).into_response()
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn list_invites(State(state): State<AuthState>, headers: HeaderMap) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, false).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let row = sqlx::query("SELECT workspace_id,role FROM workspace_memberships WHERE user_id=$1 ORDER BY workspace_id LIMIT 1").bind(user).fetch_optional(&state.pool).await;
    let Ok(Some(row)) = row else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let workspace: Uuid = row.get("workspace_id");
    let role: String = row.get("role");
    if role != "owner" && role != "admin" {
        return StatusCode::FORBIDDEN.into_response();
    }
    let invites=sqlx::query("SELECT id,role,expires_at::text AS expires_at,revoked_at IS NOT NULL AS revoked,accepted_at IS NOT NULL AS accepted FROM invitations WHERE workspace_id=$1 ORDER BY created_at DESC")
        .bind(workspace).fetch_all(&state.pool).await;
    match invites { Ok(rows)=>Json(json!({"invites":rows.into_iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"role":r.get::<String,_>("role"),"expires_at":r.get::<String,_>("expires_at"),"revoked":r.get::<bool,_>("revoked"),"accepted":r.get::<bool,_>("accepted")})).collect::<Vec<Value>>()})).into_response(),Err(_)=>StatusCode::INTERNAL_SERVER_ERROR.into_response() }
}

async fn revoke_invite(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let result=sqlx::query("UPDATE invitations i SET revoked_at=now() FROM workspace_memberships m WHERE i.id=$1 AND i.workspace_id=m.workspace_id AND m.user_id=$2 AND m.role IN ('owner','admin') AND i.revoked_at IS NULL AND i.accepted_at IS NULL RETURNING i.workspace_id")
        .bind(id).bind(user).fetch_optional(&mut *tx).await;
    match result {
        Ok(Some(row)) => {
            if sqlx::query("INSERT INTO security_audit_events (actor_id,workspace_id,event,subject_id) VALUES ($1,$2,'invite.revoke',$3)").bind(user).bind(row.get::<Uuid, _>("workspace_id")).bind(id).execute(&mut *tx).await.is_err() || tx.commit().await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(_) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Deserialize)]
struct AcceptInvite {
    token: String,
    email: String,
    password: String,
}

async fn accept_invite(
    State(state): State<AuthState>,
    Json(input): Json<AcceptInvite>,
) -> Response {
    let Some(invite)=sqlx::query("SELECT id,workspace_id,role FROM invitations i WHERE token_hash=$1 AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at>now() AND EXISTS (SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=i.workspace_id AND m.user_id=i.created_by AND m.role IN ('owner','admin'))")
        .bind(digest(&input.token)).fetch_optional(&state.pool).await.ok().flatten() else{return StatusCode::GONE.into_response()};
    let id: Uuid = invite.get("id");
    let workspace: Uuid = invite.get("workspace_id");
    let role: String = invite.get("role");
    let user = Uuid::new_v4();
    let password = input.password.clone();
    let password_hash = match tokio::task::spawn_blocking(move || hash_password(&password)).await {
        Ok(Ok(hash)) => hash,
        _ => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let insert = sqlx::query("INSERT INTO users (id,email,password_hash) VALUES ($1,lower($2),$3)")
        .bind(user)
        .bind(input.email.trim())
        .bind(password_hash)
        .execute(&mut *tx)
        .await;
    if insert.is_err() {
        return StatusCode::CONFLICT.into_response();
    }
    if sqlx::query(
        "INSERT INTO workspace_memberships (workspace_id,user_id,role) VALUES ($1,$2,$3)",
    )
    .bind(workspace)
    .bind(user)
    .bind(&role)
    .execute(&mut *tx)
    .await
    .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if sqlx::query("UPDATE invitations SET accepted_at=now() WHERE id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()").bind(id).execute(&mut *tx).await.map(|r|r.rows_affected()!=1).unwrap_or(true){return StatusCode::GONE.into_response()}
    if sqlx::query("INSERT INTO security_audit_events (actor_id,workspace_id,event,subject_id) VALUES ($1,$2,'invite.accept',$3),($1,$2,'membership.role_change',$3)").bind(user).bind(workspace).bind(user).execute(&mut *tx).await.is_err() { return StatusCode::INTERNAL_SERVER_ERROR.into_response(); }
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    StatusCode::CREATED.into_response()
}

#[derive(Deserialize)]
struct RoleChange {
    role: String,
}

async fn change_role(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Path((workspace, target)): Path<(Uuid, Uuid)>,
    Json(input): Json<RoleChange>,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, true).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    if !["owner", "admin", "member", "viewer"].contains(&input.role.as_str()) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if sqlx::query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE")
        .bind(workspace)
        .fetch_optional(&mut *tx)
        .await
        .ok()
        .flatten()
        .is_none()
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(actor_role) = workspace_role(&mut tx, workspace, actor).await else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let old = workspace_role(&mut tx, workspace, target).await;
    if actor_role != "owner"
        && (actor_role != "admin" || input.role == "owner" || old.as_deref() == Some("owner"))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if input.role == "owner" && actor_role != "owner" {
        return StatusCode::FORBIDDEN.into_response();
    }
    if old.as_deref() == Some("owner") && input.role != "owner" {
        let owners: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM workspace_memberships WHERE workspace_id=$1 AND role='owner'",
        )
        .bind(workspace)
        .fetch_one(&mut *tx)
        .await
        .unwrap_or(0);
        if owners <= 1 {
            return (StatusCode::CONFLICT, Json(json!({"error":"last_owner"}))).into_response();
        }
    }
    let result = sqlx::query(
        "UPDATE workspace_memberships SET role=$3 WHERE workspace_id=$1 AND user_id=$2",
    )
    .bind(workspace)
    .bind(target)
    .bind(&input.role)
    .execute(&mut *tx)
    .await;
    match result {
        Ok(r) if r.rows_affected() == 1 => {
            let audit=sqlx::query("INSERT INTO security_audit_events (actor_id,workspace_id,event,subject_id) VALUES ($1,$2,'membership.role_change',$3)").bind(actor).bind(workspace).bind(target).execute(&mut *tx).await;
            if audit.is_err() || tx.commit().await.is_err() {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(_) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn remove_member(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Path((workspace, target)): Path<(Uuid, Uuid)>,
) -> Response {
    let (_, actor) = match require_session(&state.pool, &headers, true).await {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if sqlx::query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE")
        .bind(workspace)
        .fetch_optional(&mut *tx)
        .await
        .ok()
        .flatten()
        .is_none()
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(actor_role) = workspace_role(&mut tx, workspace, actor).await else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let target_role = workspace_role(&mut tx, workspace, target).await;
    if actor_role != "owner" && (actor_role != "admin" || target_role.as_deref() == Some("owner")) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if target_role.as_deref() == Some("owner") {
        let owners: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM workspace_memberships WHERE workspace_id=$1 AND role='owner'",
        )
        .bind(workspace)
        .fetch_one(&mut *tx)
        .await
        .unwrap_or(0);
        if owners <= 1 {
            return (StatusCode::CONFLICT, Json(json!({"error":"last_owner"}))).into_response();
        }
    }
    if sqlx::query("DELETE FROM project_memberships WHERE workspace_id=$1 AND user_id=$2")
        .bind(workspace)
        .bind(target)
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let result =
        sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2")
            .bind(workspace)
            .bind(target)
            .execute(&mut *tx)
            .await;
    match result {
        Ok(r) if r.rows_affected() == 1 => {
            let audit=sqlx::query("INSERT INTO security_audit_events (actor_id,workspace_id,event,subject_id) VALUES ($1,$2,'membership.remove',$3)").bind(actor).bind(workspace).bind(target).execute(&mut *tx).await;
            if audit.is_err() || tx.commit().await.is_err() {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(_) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
