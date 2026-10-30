use sha2::{Digest, Sha256};
use std::{env, net::SocketAddr, time::Duration};
use uuid::Uuid;
use weft_server::{serve, ServerConfig};

struct Session {
    cookie: String,
    csrf: String,
}

struct Fixture {
    origin: String,
    server: tokio::task::JoinHandle<()>,
    schema: String,
    admin: sqlx::PgPool,
    db: sqlx::PgPool,
    workspace: Uuid,
    owner: Session,
    owner_id: Uuid,
    viewer: Session,
    viewer_id: Uuid,
}

async fn fixture() -> Fixture {
    env::set_var(
        "WEFT_AI_CREDENTIAL_KEY",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!("ai_connections_{}", Uuid::new_v4().simple());
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
            .is_ok_and(|response| response.status().is_success())
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let db = sqlx::PgPool::connect(&scoped).await.unwrap();
    weft_server::bootstrap_admin(&db, "owner@example.com", "secret", "Workspace")
        .await
        .unwrap();
    let (workspace, owner_id): (Uuid, Uuid) = sqlx::query_as(
        "SELECT w.id,m.user_id FROM workspaces w JOIN workspace_memberships m ON m.workspace_id=w.id WHERE m.role='owner'",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    let viewer_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users(id,email,password_hash) VALUES($1,'viewer@example.com','unused')",
    )
    .bind(viewer_id)
    .execute(&db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'viewer')",
    )
    .bind(workspace)
    .bind(viewer_id)
    .execute(&db)
    .await
    .unwrap();
    let owner = session(&db, owner_id).await;
    let viewer = session(&db, viewer_id).await;
    Fixture {
        origin,
        server,
        schema,
        admin,
        db,
        workspace,
        owner,
        owner_id,
        viewer,
        viewer_id,
    }
}

async fn session(db: &sqlx::PgPool, user: Uuid) -> Session {
    let token = Uuid::new_v4().to_string();
    let csrf = Uuid::new_v4().to_string();
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')")
        .bind(Uuid::new_v4())
        .bind(user)
        .bind(hash)
        .bind(&csrf)
        .execute(db)
        .await
        .unwrap();
    Session {
        cookie: format!("weft_session={token}; weft_csrf={csrf}"),
        csrf,
    }
}

fn req(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: String,
    session: &Session,
) -> reqwest::RequestBuilder {
    client
        .request(method, url)
        .header(reqwest::header::COOKIE, &session.cookie)
        .header("x-csrf-token", &session.csrf)
}

async fn cleanup(fixture: Fixture) {
    fixture.server.abort();
    sqlx::query(&format!("DROP SCHEMA {} CASCADE", fixture.schema))
        .execute(&fixture.admin)
        .await
        .unwrap();
    fixture.admin.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn connection_management_enforces_scope_and_never_returns_credentials() {
    let fixture = fixture().await;
    let client = reqwest::Client::new();
    let connections = format!("{}/api/v1/ai/connections", fixture.origin);

    let shared_subscription = req(
        &client,
        reqwest::Method::POST,
        connections.clone(),
        &fixture.owner,
    )
    .json(&serde_json::json!({
        "scope":"workspace",
        "workspace_id":fixture.workspace,
        "provider":"claude_code",
        "auth_mode":"provider_cli",
        "billing_mode":"subscription",
        "model_default":"sonnet",
        "runner_reference":"runner-one",
        "capabilities":["generate","split","link"],
        "limits":{"runs_per_hour":20}
    }))
    .send()
    .await
    .unwrap();
    assert_eq!(
        shared_subscription.status(),
        reqwest::StatusCode::UNPROCESSABLE_ENTITY
    );
    let body: serde_json::Value = shared_subscription.json().await.unwrap();
    assert_eq!(body["error"], "unsupported_shared_mode");
    assert_eq!(body["state"], "unsupported_shared_mode");
    assert!(body["state_reason"].as_str().is_some());

    let needs_login = req(
        &client,
        reqwest::Method::POST,
        connections.clone(),
        &fixture.owner,
    )
    .json(&serde_json::json!({
        "scope":"personal",
        "provider":"codex",
        "auth_mode":"api_key",
        "billing_mode":"api",
        "capabilities":["generate"],
        "limits":{}
    }))
    .send()
    .await
    .unwrap();
    assert_eq!(needs_login.status(), reqwest::StatusCode::CREATED);
    let needs_login: serde_json::Value = needs_login.json().await.unwrap();
    assert_eq!(needs_login["state"], "needs_login");
    assert!(needs_login["state_reason"].as_str().is_some());

    let created = req(
        &client,
        reqwest::Method::POST,
        connections.clone(),
        &fixture.owner,
    )
    .json(&serde_json::json!({
        "scope":"workspace",
        "workspace_id":fixture.workspace,
        "provider":"codex",
        "auth_mode":"api_key",
        "billing_mode":"api",
        "credential_secret":"sk-test-sensitive-value",
        "model_default":"gpt-test",
        "runner_reference":"runner-one",
        "capabilities":["generate","split","link"],
        "limits":{"runs_per_hour":20}
    }))
    .send()
    .await
    .unwrap();
    assert_eq!(created.status(), reqwest::StatusCode::CREATED);
    let response: serde_json::Value = created.json().await.unwrap();
    assert_eq!(response["provider"], "codex");
    assert_eq!(response["billing_mode"], "api");
    assert_eq!(response["state"], "runner_offline");
    assert!(response["state_reason"].as_str().is_some());
    assert!(response["credential_secret"].is_null());
    assert_eq!(response["runner_reference"], "runner-one");
    assert_eq!(response["capabilities"][0], "generate");
    assert_eq!(response["limits"]["runs_per_hour"], 20);
    assert!(response
        .to_string()
        .find("sk-test-sensitive-value")
        .is_none());
    let exported = req(
        &client,
        reqwest::Method::GET,
        format!(
            "{}/api/v1/workspaces/{}/export",
            fixture.origin, fixture.workspace
        ),
        &fixture.owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(exported.status(), reqwest::StatusCode::OK);
    let exported = exported.text().await.unwrap();
    assert!(!exported.contains("sk-test-sensitive-value"));
    let plaintext_stored: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM ai_connection_credentials WHERE position(convert_to('sk-test-sensitive-value','UTF8') in ciphertext)>0)",
    )
    .fetch_one(&fixture.db)
    .await
    .unwrap();
    assert!(!plaintext_stored);

    let id = response["id"].as_str().unwrap();
    let grant = req(
        &client,
        reqwest::Method::POST,
        format!("{connections}/{id}/grants"),
        &fixture.owner,
    )
    .json(&serde_json::json!({"user_id":fixture.viewer_id}))
    .send()
    .await
    .unwrap();
    assert_eq!(grant.status(), reqwest::StatusCode::CREATED);
    let visible = req(
        &client,
        reqwest::Method::GET,
        connections.clone(),
        &fixture.viewer,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(visible.status(), reqwest::StatusCode::OK);
    let visible: serde_json::Value = visible.json().await.unwrap();
    assert_eq!(visible["connections"][0]["id"], id);
    assert!(visible
        .to_string()
        .find("sk-test-sensitive-value")
        .is_none());
    let revoke_user_grant = req(
        &client,
        reqwest::Method::DELETE,
        format!("{connections}/{id}/grants/{}", fixture.viewer_id),
        &fixture.owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(revoke_user_grant.status(), reqwest::StatusCode::NO_CONTENT);
    let changed = req(
        &client,
        reqwest::Method::PATCH,
        format!("{connections}/{id}"),
        &fixture.owner,
    )
    .json(&serde_json::json!({"model_default":"gpt-next"}))
    .send()
    .await
    .unwrap();
    assert_eq!(changed.status(), reqwest::StatusCode::OK);
    let changed: serde_json::Value = changed.json().await.unwrap();
    assert_eq!(changed["model_default"], "gpt-next");

    let installation = req(
        &client,
        reqwest::Method::POST,
        connections.clone(),
        &fixture.owner,
    )
    .json(&serde_json::json!({
        "scope":"installation",
        "provider":"codex",
        "auth_mode":"organization",
        "billing_mode":"organization",
        "model_default":"org-default",
        "allowed_workspaces":[fixture.workspace],
        "capabilities":["generate"],
        "limits":{}
    }))
    .send()
    .await
    .unwrap();
    assert_eq!(installation.status(), reqwest::StatusCode::CREATED);
    let installation: serde_json::Value = installation.json().await.unwrap();
    let installation_id = installation["id"].as_str().unwrap();
    let allowed_grant: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM ai_connection_grants WHERE connection_id=$1 AND workspace_id=$2)")
        .bind(Uuid::parse_str(installation_id).unwrap())
        .bind(fixture.workspace)
        .fetch_one(&fixture.db)
        .await
        .unwrap();
    assert!(allowed_grant);
    let viewer_member: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2)",
    )
    .bind(fixture.workspace)
    .bind(fixture.viewer_id)
    .fetch_one(&fixture.db)
    .await
    .unwrap();
    assert!(viewer_member);
    let set_installation_default = req(
        &client,
        reqwest::Method::PUT,
        format!("{}/api/v1/ai/defaults", fixture.origin),
        &fixture.owner,
    )
    .json(&serde_json::json!({
        "scope":"installation",
        "connection_id":installation_id
    }))
    .send()
    .await
    .unwrap();
    assert_eq!(set_installation_default.status(), reqwest::StatusCode::OK);
    let fallback = req(
        &client,
        reqwest::Method::GET,
        format!(
            "{}/api/v1/ai/defaults?workspace_id={}",
            fixture.origin, fixture.workspace
        ),
        &fixture.viewer,
    )
    .send()
    .await
    .unwrap();
    let fallback_status = fallback.status();
    let fallback_text = fallback.text().await.unwrap();
    assert_eq!(fallback_status, reqwest::StatusCode::OK, "{fallback_text}");
    let fallback: serde_json::Value = serde_json::from_str(&fallback_text).unwrap();
    assert_eq!(fallback["source"], "installation_default");
    assert_eq!(fallback["connection"]["id"], installation_id);
    assert!(fallback["run_notice"]
        .as_str()
        .unwrap()
        .contains("organization billing"));

    let set_workspace_default = req(
        &client,
        reqwest::Method::PUT,
        format!("{}/api/v1/ai/defaults", fixture.origin),
        &fixture.owner,
    )
    .json(&serde_json::json!({
        "scope":"workspace",
        "workspace_id":fixture.workspace,
        "connection_id":id
    }))
    .send()
    .await
    .unwrap();
    assert_eq!(set_workspace_default.status(), reqwest::StatusCode::OK);
    let workspace_default = req(
        &client,
        reqwest::Method::GET,
        format!(
            "{}/api/v1/ai/defaults?workspace_id={}",
            fixture.origin, fixture.workspace
        ),
        &fixture.viewer,
    )
    .send()
    .await
    .unwrap();
    let workspace_default: serde_json::Value = workspace_default.json().await.unwrap();
    assert_eq!(workspace_default["source"], "workspace_default");
    assert_eq!(workspace_default["connection"]["id"], id);
    assert!(workspace_default["run_notice"]
        .as_str()
        .unwrap()
        .contains("codex · api billing"));

    let rotate = req(
        &client,
        reqwest::Method::POST,
        format!("{connections}/{id}/rotate"),
        &fixture.owner,
    )
    .json(&serde_json::json!({"credential_secret":"sk-replacement-sensitive-value"}))
    .send()
    .await
    .unwrap();
    assert_eq!(rotate.status(), reqwest::StatusCode::OK);
    let rotated: serde_json::Value = rotate.json().await.unwrap();
    assert!(rotated["credential_secret"].is_null());
    assert!(!rotated
        .to_string()
        .contains("sk-replacement-sensitive-value"));
    let audit_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM security_audit_events WHERE subject_id=$1 AND event LIKE 'ai.connection.%'",
    )
    .bind(Uuid::parse_str(id).unwrap())
    .fetch_one(&fixture.db)
    .await
    .unwrap();
    assert!(audit_count >= 5);

    let disable = req(
        &client,
        reqwest::Method::POST,
        format!("{connections}/{id}/disable"),
        &fixture.owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(disable.status(), reqwest::StatusCode::OK);
    let metadata: serde_json::Value = disable.json().await.unwrap();
    assert_eq!(metadata["state"], "disabled");
    assert!(metadata["state_reason"].as_str().is_some());
    let after_disable = req(
        &client,
        reqwest::Method::GET,
        format!(
            "{}/api/v1/ai/defaults?workspace_id={}",
            fixture.origin, fixture.workspace
        ),
        &fixture.viewer,
    )
    .send()
    .await
    .unwrap();
    let after_disable: serde_json::Value = after_disable.json().await.unwrap();
    assert_eq!(after_disable["source"], "workspace_default");
    assert_eq!(after_disable["connection"]["id"], id);
    assert_eq!(after_disable["connection"]["state"], "disabled");

    let personal = req(
        &client,
        reqwest::Method::POST,
        connections.clone(),
        &fixture.viewer,
    )
    .json(&serde_json::json!({
        "scope":"personal",
        "provider":"scripted",
        "auth_mode":"provider_cli",
        "billing_mode":"subscription",
        "model_default":"scripted-v1",
        "capabilities":["generate"],
        "limits":{}
    }))
    .send()
    .await
    .unwrap();
    assert_eq!(personal.status(), reqwest::StatusCode::CREATED);
    let personal: serde_json::Value = personal.json().await.unwrap();
    assert_eq!(personal["scope"], "personal");
    assert_eq!(personal["owner_id"], fixture.viewer_id.to_string());
    let personal_default = req(
        &client,
        reqwest::Method::PUT,
        format!("{}/api/v1/ai/defaults", fixture.origin),
        &fixture.viewer,
    )
    .json(&serde_json::json!({
        "scope":"personal",
        "connection_id":personal["id"]
    }))
    .send()
    .await
    .unwrap();
    assert_eq!(personal_default.status(), reqwest::StatusCode::OK);
    let chosen = req(
        &client,
        reqwest::Method::GET,
        format!(
            "{}/api/v1/ai/defaults?workspace_id={}",
            fixture.origin, fixture.workspace
        ),
        &fixture.viewer,
    )
    .send()
    .await
    .unwrap();
    let chosen: serde_json::Value = chosen.json().await.unwrap();
    assert_eq!(chosen["source"], "personal_default");
    assert_eq!(chosen["connection"]["id"], personal["id"]);
    let hidden = req(
        &client,
        reqwest::Method::GET,
        connections.clone(),
        &fixture.owner,
    )
    .send()
    .await
    .unwrap();
    let hidden: serde_json::Value = hidden.json().await.unwrap();
    assert!(hidden["connections"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["id"] != personal["id"]));

    let project = Uuid::new_v4();
    sqlx::query("INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES($1,$2,'Restricted connection test','restricted',$3)")
        .bind(project)
        .bind(fixture.workspace)
        .bind(fixture.owner_id)
        .execute(&fixture.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2,$3,'manager')")
        .bind(fixture.workspace)
        .bind(project)
        .bind(fixture.owner_id)
        .execute(&fixture.db)
        .await
        .unwrap();
    let task = req(
        &client,
        reqwest::Method::POST,
        format!(
            "{}/api/v1/workspaces/{}/tasks",
            fixture.origin, fixture.workspace
        ),
        &fixture.owner,
    )
    .json(&serde_json::json!({"project_id":project,"title":"Private task content"}))
    .send()
    .await
    .unwrap();
    assert_eq!(task.status(), reqwest::StatusCode::CREATED);
    let task: serde_json::Value = task.json().await.unwrap();
    let rename = req(
        &client,
        reqwest::Method::PATCH,
        format!(
            "{}/api/v1/workspaces/{}/tasks/{}",
            fixture.origin, fixture.workspace, task["number"]
        ),
        &fixture.owner,
    )
    .json(&serde_json::json!({"expected_version":task["version"],"title":"Changed before undo"}))
    .send()
    .await
    .unwrap();
    assert_eq!(rename.status(), reqwest::StatusCode::OK);
    let visible_tasks = req(
        &client,
        reqwest::Method::GET,
        format!(
            "{}/api/v1/workspaces/{}/tasks?project_id={}",
            fixture.origin, fixture.workspace, project
        ),
        &fixture.viewer,
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap();
    assert_eq!(visible_tasks.status(), reqwest::StatusCode::OK);
    let visible_tasks: serde_json::Value = visible_tasks.json().await.unwrap();
    assert!(visible_tasks["tasks"].as_array().unwrap().is_empty());
    let undo = req(
        &client,
        reqwest::Method::POST,
        format!(
            "{}/api/v1/workspaces/{}/history/undo",
            fixture.origin, fixture.workspace
        ),
        &fixture.owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(undo.status(), reqwest::StatusCode::OK);
    let surviving_audit: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM security_audit_events WHERE subject_id=$1 AND event LIKE 'ai.connection.%'",
    )
    .bind(Uuid::parse_str(id).unwrap())
    .fetch_one(&fixture.db)
    .await
    .unwrap();
    assert!(surviving_audit >= 7);

    let revoked = req(
        &client,
        reqwest::Method::POST,
        format!("{connections}/{id}/revoke"),
        &fixture.owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(revoked.status(), reqwest::StatusCode::OK);
    let revoked: serde_json::Value = revoked.json().await.unwrap();
    assert_eq!(revoked["state"], "disabled");
    assert_eq!(revoked["state_reason"], "Connection is revoked");
    let remaining_credentials: i64 =
        sqlx::query_scalar("SELECT count(*) FROM ai_connection_credentials WHERE connection_id=$1")
            .bind(Uuid::parse_str(id).unwrap())
            .fetch_one(&fixture.db)
            .await
            .unwrap();
    assert_eq!(remaining_credentials, 0);
    let audit: reqwest::Response = req(
        &client,
        reqwest::Method::GET,
        format!("{connections}/{id}/audit"),
        &fixture.owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(audit.status(), reqwest::StatusCode::OK);
    let audit: serde_json::Value = audit.json().await.unwrap();
    assert!(audit["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|event| event["event"] == "ai.connection.revoked"));

    cleanup(fixture).await;
}
