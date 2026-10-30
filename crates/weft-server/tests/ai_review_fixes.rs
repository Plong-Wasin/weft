//! Authorization and consistency fixes found in review of AI planning: installation-scoped
//! connections, runner management rights, usage visibility, runner revoke and heartbeat state.

use sha2::{Digest, Sha256};
use std::{env, net::SocketAddr, time::Duration};
use uuid::Uuid;
use weft_server::{serve, ServerConfig};

struct Person {
    id: Uuid,
    cookie: String,
    csrf: String,
}

struct Fixture {
    origin: String,
    server: tokio::task::JoinHandle<()>,
    schema: String,
    admin: sqlx::PgPool,
    db: sqlx::PgPool,
    /// Workspace created first: its owner is the installation admin.
    first: Uuid,
    second: Uuid,
    installation_admin: Person,
    second_owner: Person,
}

async fn person(db: &sqlx::PgPool, id: Uuid) -> Person {
    let token = Uuid::new_v4().to_string();
    let csrf = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')")
        .bind(Uuid::new_v4()).bind(id).bind(format!("{:x}", Sha256::digest(token.as_bytes()))).bind(&csrf).execute(db).await.unwrap();
    Person {
        id,
        cookie: format!("weft_session={token}; weft_csrf={csrf}"),
        csrf,
    }
}

async fn add_user(db: &sqlx::PgPool, email: &str, workspace: Uuid, role: &str) -> Person {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'unused')")
        .bind(id)
        .bind(email)
        .execute(db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,$3)")
        .bind(workspace)
        .bind(id)
        .bind(role)
        .execute(db)
        .await
        .unwrap();
    person(db, id).await
}

async fn fixture() -> Fixture {
    env::set_var(
        "WEFT_AGENT_SIGNING_KEY",
        "runner-test-signing-key-012345678901234567890123456789",
    );
    env::set_var(
        "WEFT_AI_CREDENTIAL_KEY",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!("ai_review_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&admin)
        .await
        .unwrap();
    let scoped = format!("{base}?options=-csearch_path%3D{schema}");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address: SocketAddr = listener.local_addr().unwrap();
    let root = env::temp_dir().join(format!("weft-{schema}"));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("index.html"), "Weft").unwrap();
    let server_db = scoped.clone();
    let server = tokio::spawn(async move {
        let _ = serve(listener, ServerConfig::new(server_db, root)).await;
    });
    let origin = format!("http://{address}");
    let client = reqwest::Client::new();
    for _ in 0..3000 {
        if client
            .get(format!("{origin}/health/ready"))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let db = sqlx::PgPool::connect(&scoped).await.unwrap();
    weft_server::bootstrap_admin(&db, "owner@example.com", "secret", "First")
        .await
        .unwrap();
    let (first, owner_id): (Uuid, Uuid) =
        sqlx::query_as("SELECT m.workspace_id,m.user_id FROM workspace_memberships m")
            .fetch_one(&db)
            .await
            .unwrap();
    let second = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO workspaces(id,name,created_at) VALUES($1,'Second',now()+interval '1 minute')",
    )
    .bind(second)
    .execute(&db)
    .await
    .unwrap();
    let installation_admin = person(&db, owner_id).await;
    let second_owner = add_user(&db, "second@example.com", second, "owner").await;
    Fixture {
        origin,
        server,
        schema,
        admin,
        db,
        first,
        second,
        installation_admin,
        second_owner,
    }
}

async fn cleanup(f: Fixture) {
    f.server.abort();
    sqlx::query(&format!("DROP SCHEMA {} CASCADE", f.schema))
        .execute(&f.admin)
        .await
        .unwrap();
    f.admin.close().await;
}

fn call(f: &Fixture, who: &Person, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
    reqwest::Client::new()
        .request(method, format!("{}/api/v1{path}", f.origin))
        .header(reqwest::header::COOKIE, &who.cookie)
        .header("x-csrf-token", &who.csrf)
}

async fn connection(f: &Fixture, scope: &str, workspace: Option<Uuid>, created_by: Uuid) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO ai_connections(id,scope,workspace_id,provider,auth_mode,billing_mode,state,state_reason,created_by) VALUES($1,$2,$3,'scripted','provider_cli','api','ready','ready',$4)")
        .bind(id).bind(scope).bind(workspace).bind(created_by).execute(&f.db).await.unwrap();
    id
}

async fn runner(f: &Fixture, connection: Uuid, owner: Uuid) -> (Uuid, String) {
    let id = Uuid::new_v4();
    let token = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO ai_runners(id,connection_id,owner_id,name,version,supported_modes,token_hash) VALUES($1,$2,$3,'r','1','{scripted}',$4)")
        .bind(id).bind(connection).bind(owner).bind(format!("{:x}", Sha256::digest(token.as_bytes()))).execute(&f.db).await.unwrap();
    (id, token)
}

#[tokio::test(flavor = "multi_thread")]
async fn installation_connection_is_managed_only_by_the_installation_admin() {
    let f = fixture().await;
    let conn = connection(&f, "installation", None, f.installation_admin.id).await;
    let (runner_id, _) = runner(&f, conn, f.installation_admin.id).await;
    let intruder = &f.second_owner;
    for (method, path) in [
        (
            reqwest::Method::POST,
            format!("/ai/connections/{conn}/runners/pairing-codes"),
        ),
        (
            reqwest::Method::GET,
            format!("/ai/connections/{conn}/runners"),
        ),
        (
            reqwest::Method::GET,
            format!("/ai/connections/{conn}/runner-jobs"),
        ),
        (
            reqwest::Method::POST,
            format!("/ai/runners/{runner_id}/revoke"),
        ),
    ] {
        let response = call(&f, intruder, method.clone(), &path)
            .json(&serde_json::json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            reqwest::StatusCode::NOT_FOUND,
            "{method} {path}"
        );
    }
    let revoked: bool =
        sqlx::query_scalar("SELECT revoked_at IS NOT NULL FROM ai_runners WHERE id=$1")
            .bind(runner_id)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert!(!revoked);
    // A Workspace owner who is not the installation admin cannot create or default one either.
    let create = call(&f, intruder, reqwest::Method::POST, "/ai/connections")
        .json(&serde_json::json!({"scope":"installation","provider":"codex","auth_mode":"organization","billing_mode":"organization","model_default":"m","allowed_workspaces":[f.second],"capabilities":["generate"],"limits":{}}))
        .send().await.unwrap();
    assert_eq!(create.status(), reqwest::StatusCode::FORBIDDEN);
    let default = call(&f, intruder, reqwest::Method::PUT, "/ai/defaults")
        .json(&serde_json::json!({"scope":"installation","connection_id":conn}))
        .send()
        .await
        .unwrap();
    assert_eq!(default.status(), reqwest::StatusCode::FORBIDDEN);
    let rotate = call(
        &f,
        intruder,
        reqwest::Method::POST,
        &format!("/ai/connections/{conn}/revoke"),
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap();
    assert_eq!(rotate.status(), reqwest::StatusCode::FORBIDDEN);
    // The installation admin still can.
    let code = call(
        &f,
        &f.installation_admin,
        reqwest::Method::POST,
        &format!("/ai/connections/{conn}/runners/pairing-codes"),
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap();
    assert_eq!(code.status(), reqwest::StatusCode::OK);
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn demoted_creator_loses_runner_management_rights() {
    let f = fixture().await;
    let creator = add_user(&f.db, "creator@example.com", f.first, "admin").await;
    let conn = connection(&f, "workspace", Some(f.first), creator.id).await;
    let path = format!("/ai/connections/{conn}/runners/pairing-codes");
    let before = call(&f, &creator, reqwest::Method::POST, &path)
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(before.status(), reqwest::StatusCode::OK);
    sqlx::query("UPDATE workspace_memberships SET role='member' WHERE user_id=$1")
        .bind(creator.id)
        .execute(&f.db)
        .await
        .unwrap();
    let after = call(&f, &creator, reqwest::Method::POST, &path)
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(after.status(), reqwest::StatusCode::NOT_FOUND);
    sqlx::query("DELETE FROM workspace_memberships WHERE user_id=$1")
        .bind(creator.id)
        .execute(&f.db)
        .await
        .unwrap();
    let removed = call(
        &f,
        &creator,
        reqwest::Method::GET,
        &format!("/ai/connections/{conn}/runners"),
    )
    .send()
    .await
    .unwrap();
    assert_eq!(removed.status(), reqwest::StatusCode::NOT_FOUND);
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn usage_is_limited_to_admins_of_the_requested_workspace() {
    let f = fixture().await;
    let own = call(
        &f,
        &f.second_owner,
        reqwest::Method::GET,
        &format!("/ai/usage?workspace_id={}", f.second),
    )
    .send()
    .await
    .unwrap();
    assert_eq!(own.status(), reqwest::StatusCode::OK);
    // Owning another Workspace, even the first one, grants nothing here.
    for (who, workspace) in [
        (&f.second_owner, f.first),
        (&f.installation_admin, f.second),
    ] {
        let response = call(
            &f,
            who,
            reqwest::Method::GET,
            &format!("/ai/usage?workspace_id={workspace}"),
        )
        .send()
        .await
        .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
    }
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn revoking_a_runner_requeues_its_run() {
    let f = fixture().await;
    let conn = connection(&f, "workspace", Some(f.first), f.installation_admin.id).await;
    let (runner_id, _) = runner(&f, conn, f.installation_admin.id).await;
    let run = Uuid::new_v4();
    sqlx::query("INSERT INTO ai_runs(id,initiator_id,workspace_id,connection_id,capability,scope,run_limits,prompt,session_key,state,summary,deadline_at) VALUES($1,$2,$3,$4,'generate','{}','{}','plan','s','running','Provider is running',now()+interval '1 hour')")
        .bind(run).bind(f.installation_admin.id).bind(f.first).bind(conn).execute(&f.db).await.unwrap();
    sqlx::query("INSERT INTO ai_runner_jobs(id,connection_id,provider_mode,payload,signature,status,runner_id,lease_expires_at,run_id) VALUES($1,$2,'scripted','{}','sig','leased',$3,now()+interval '1 hour',$4)")
        .bind(Uuid::new_v4()).bind(conn).bind(runner_id).bind(run).execute(&f.db).await.unwrap();
    let response = call(
        &f,
        &f.installation_admin,
        reqwest::Method::POST,
        &format!("/ai/runners/{runner_id}/revoke"),
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let state: String = sqlx::query_scalar("SELECT state FROM ai_runs WHERE id=$1")
        .bind(run)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(state, "queued");
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn heartbeat_does_not_overwrite_needs_login() {
    let f = fixture().await;
    let conn = connection(&f, "workspace", Some(f.first), f.installation_admin.id).await;
    let (_, token) = runner(&f, conn, f.installation_admin.id).await;
    let beat = || async {
        reqwest::Client::new()
            .post(format!("{}/api/v1/ai/agent/heartbeat", f.origin))
            .bearer_auth(&token)
            .json(&serde_json::json!({}))
            .send()
            .await
            .unwrap()
            .status()
    };
    sqlx::query(
        "UPDATE ai_connections SET state='needs_login',state_reason='Login required' WHERE id=$1",
    )
    .bind(conn)
    .execute(&f.db)
    .await
    .unwrap();
    assert_eq!(beat().await, reqwest::StatusCode::OK);
    let state: String = sqlx::query_scalar("SELECT state FROM ai_connections WHERE id=$1")
        .bind(conn)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(state, "needs_login");
    sqlx::query("UPDATE ai_connections SET state='runner_offline' WHERE id=$1")
        .bind(conn)
        .execute(&f.db)
        .await
        .unwrap();
    assert_eq!(beat().await, reqwest::StatusCode::OK);
    let state: String = sqlx::query_scalar("SELECT state FROM ai_connections WHERE id=$1")
        .bind(conn)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(state, "ready");
    cleanup(f).await;
}
