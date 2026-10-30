use sha2::{Digest, Sha256};
use std::{env, net::SocketAddr, time::Duration};
use uuid::Uuid;
use weft_server::{serve, ServerConfig};

struct Fixture {
    origin: String,
    server: tokio::task::JoinHandle<()>,
    schema: String,
    admin: sqlx::PgPool,
    db: sqlx::PgPool,
    connection: Uuid,
    owner: String,
    csrf: String,
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
    let schema = format!("ai_runner_{}", Uuid::new_v4().simple());
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
    weft_server::bootstrap_admin(&db, "owner@example.com", "secret", "Workspace")
        .await
        .unwrap();
    let (owner_id, workspace): (Uuid, Uuid) =
        sqlx::query_as("SELECT m.user_id,m.workspace_id FROM workspace_memberships m")
            .fetch_one(&db)
            .await
            .unwrap();
    let connection = Uuid::new_v4();
    sqlx::query("INSERT INTO ai_connections(id,scope,workspace_id,provider,auth_mode,billing_mode,state,state_reason,created_by) VALUES($1,'workspace',$2,'scripted','provider_cli','api','ready','ready',$3)")
        .bind(connection).bind(workspace).bind(owner_id).execute(&db).await.unwrap();
    let token = Uuid::new_v4().to_string();
    let csrf = Uuid::new_v4().to_string();
    let token_hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')")
        .bind(Uuid::new_v4()).bind(owner_id).bind(token_hash).bind(&csrf).execute(&db).await.unwrap();
    Fixture {
        origin,
        server,
        schema,
        admin,
        db,
        connection,
        owner: format!("weft_session={token}; weft_csrf={csrf}"),
        csrf,
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

fn owner(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: String,
    f: &Fixture,
) -> reqwest::RequestBuilder {
    client
        .request(method, url)
        .header(reqwest::header::COOKIE, &f.owner)
        .header("x-csrf-token", &f.csrf)
}

#[tokio::test(flavor = "multi_thread")]
async fn real_agent_protocol_pairs_leases_and_rejects_revoked_runner() {
    let f = fixture().await;
    let client = reqwest::Client::new();
    let root = format!("{}/api/v1/ai", f.origin);
    let pairing: serde_json::Value = owner(
        &client,
        reqwest::Method::POST,
        format!("{root}/connections/{}/runners/pairing-codes", f.connection),
        &f,
    )
    .json(&serde_json::json!({"expires_in_seconds":300}))
    .send()
    .await
    .unwrap()
    .error_for_status()
    .unwrap()
    .json()
    .await
    .unwrap();
    let code = pairing["code"].as_str().unwrap();
    let pair = client.post(format!("{root}/agent/pair")).json(&serde_json::json!({"code":code,"name":"test-runner","version":"0.1.0","supported_modes":["scripted"]})).send().await.unwrap();
    assert_eq!(pair.status(), reqwest::StatusCode::OK);
    let paired: serde_json::Value = pair.json().await.unwrap();
    let runner = paired["runner_id"].as_str().unwrap();
    let bearer = paired["token"].as_str().unwrap();
    let heartbeat = client
        .post(format!("{root}/agent/heartbeat"))
        .bearer_auth(bearer)
        .json(&serde_json::json!({"version":"0.1.1"}))
        .send()
        .await
        .unwrap();
    assert_eq!(heartbeat.status(), reqwest::StatusCode::OK);
    let replay = client.post(format!("{root}/agent/pair")).json(&serde_json::json!({"code":code,"name":"replay","version":"0.1.0","supported_modes":["scripted"]})).send().await.unwrap();
    assert_eq!(replay.status(), reqwest::StatusCode::UNAUTHORIZED);
    let expiring: serde_json::Value = owner(
        &client,
        reqwest::Method::POST,
        format!("{root}/connections/{}/runners/pairing-codes", f.connection),
        &f,
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap()
    .error_for_status()
    .unwrap()
    .json()
    .await
    .unwrap();
    sqlx::query(
        "UPDATE ai_runner_pairing_codes SET expires_at=now()-interval '1 second' WHERE id=$1",
    )
    .bind(expiring["id"].as_str().unwrap().parse::<Uuid>().unwrap())
    .execute(&f.db)
    .await
    .unwrap();
    let expired = client.post(format!("{root}/agent/pair")).json(&serde_json::json!({"code":expiring["code"],"name":"expired","version":"1","supported_modes":["scripted"]})).send().await.unwrap();
    assert_eq!(expired.status(), reqwest::StatusCode::UNAUTHORIZED);

    let payload = serde_json::json!({"type":"provider_job","schema_version":1,"provider_mode":"scripted","arguments":["draft"]});
    let job = weft_server::enqueue_agent_job(&f.db, f.connection, "scripted", payload)
        .await
        .unwrap();
    let lease = client
        .post(format!("{root}/agent/jobs/lease"))
        .bearer_auth(bearer)
        .json(&serde_json::json!({"lease_seconds":1}))
        .send()
        .await
        .unwrap();
    assert_eq!(lease.status(), reqwest::StatusCode::OK);
    let leased: serde_json::Value = lease.json().await.unwrap();
    assert_eq!(leased["job"]["id"], job.to_string());
    assert_eq!(leased["job"]["payload"]["arguments"][0], "draft");
    assert!(leased["job"]["signature"].as_str().is_some());
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let again: serde_json::Value = client
        .post(format!("{root}/agent/jobs/lease"))
        .bearer_auth(bearer)
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(again["job"]["id"], job.to_string());
    assert_eq!(again["job"]["signature"], leased["job"]["signature"]);
    let result = client
        .post(format!("{root}/agent/jobs/{job}/result"))
        .bearer_auth(bearer)
        .json(&serde_json::json!({"result":{"provider":"scripted","draft":[]}}))
        .send()
        .await
        .unwrap();
    assert_eq!(result.status(), reqwest::StatusCode::OK);

    owner(
        &client,
        reqwest::Method::POST,
        format!("{root}/runners/{runner}/revoke"),
        &f,
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap()
    .error_for_status()
    .unwrap();
    let rejected = client
        .post(format!("{root}/agent/jobs/lease"))
        .bearer_auth(bearer)
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(rejected.status(), reqwest::StatusCode::UNAUTHORIZED);
    let listed: serde_json::Value = owner(
        &client,
        reqwest::Method::GET,
        format!("{root}/connections/{}/runners", f.connection),
        &f,
    )
    .send()
    .await
    .unwrap()
    .error_for_status()
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(listed["runners"][0]["version"], "0.1.1");
    assert!(listed["runners"][0]["last_contact_at"].as_str().is_some());
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn unsupported_modes_are_reported_and_never_leased() {
    let f = fixture().await;
    let client = reqwest::Client::new();
    let root = format!("{}/api/v1/ai", f.origin);
    let pairing: serde_json::Value = owner(
        &client,
        reqwest::Method::POST,
        format!("{root}/connections/{}/runners/pairing-codes", f.connection),
        &f,
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap()
    .error_for_status()
    .unwrap()
    .json()
    .await
    .unwrap();
    let paired: serde_json::Value = client.post(format!("{root}/agent/pair")).json(&serde_json::json!({"code":pairing["code"],"name":"limited-runner","version":"1","supported_modes":["codex_subscription"]})).send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    assert_eq!(paired["unsupported_modes"][0], "codex_subscription");
    let payload = serde_json::json!({"type":"provider_job","schema_version":1,"provider_mode":"codex_subscription","arguments":[]});
    let job = weft_server::enqueue_agent_job(&f.db, f.connection, "codex_subscription", payload)
        .await
        .unwrap();
    let response: serde_json::Value = client
        .post(format!("{root}/agent/jobs/lease"))
        .bearer_auth(paired["token"].as_str().unwrap())
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(response["job"].is_null());
    let visible: serde_json::Value = owner(
        &client,
        reqwest::Method::GET,
        format!("{root}/connections/{}/runner-jobs", f.connection),
        &f,
    )
    .send()
    .await
    .unwrap()
    .error_for_status()
    .unwrap()
    .json()
    .await
    .unwrap();
    let visible_job = visible["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|j| j["id"] == job.to_string())
        .unwrap();
    assert_eq!(visible_job["status"], "queued");
    assert!(visible_job["reason"].as_str().unwrap().contains("runner"));
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn runnerless_connection_keeps_jobs_queued_without_blocking_core_requests() {
    let f = fixture().await;
    let client = reqwest::Client::new();
    let root = format!("{}/api/v1/ai", f.origin);
    let payload =
        serde_json::json!({"type":"provider_job","schema_version":1,"arguments":["draft"]});
    let job = weft_server::enqueue_agent_job(&f.db, f.connection, "scripted", payload)
        .await
        .unwrap();
    let visible: serde_json::Value = owner(
        &client,
        reqwest::Method::GET,
        format!("{root}/connections/{}/runner-jobs", f.connection),
        &f,
    )
    .send()
    .await
    .unwrap()
    .error_for_status()
    .unwrap()
    .json()
    .await
    .unwrap();
    let queued = visible["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|candidate| candidate["id"] == job.to_string())
        .unwrap();
    assert_eq!(queued["status"], "queued");
    assert!(queued["reason"].as_str().unwrap().contains("runner"));
    let core = client
        .get(format!("{}/api/v1", f.origin))
        .send()
        .await
        .unwrap();
    assert_eq!(core.status(), reqwest::StatusCode::OK);
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn runner_bearer_is_never_a_task_vault_or_proposal_user_session() {
    let f = fixture().await;
    let client = reqwest::Client::new();
    let root = format!("{}/api/v1/ai", f.origin);
    let pairing: serde_json::Value = owner(
        &client,
        reqwest::Method::POST,
        format!("{root}/connections/{}/runners/pairing-codes", f.connection),
        &f,
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap()
    .error_for_status()
    .unwrap()
    .json()
    .await
    .unwrap();
    let paired: serde_json::Value = client.post(format!("{root}/agent/pair"))
        .json(&serde_json::json!({"code":pairing["code"],"name":"acl-runner","version":"0.1.0","supported_modes":["scripted"]}))
        .send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    let bearer = paired["token"].as_str().unwrap();
    let workspace: Uuid =
        sqlx::query_scalar("SELECT workspace_id FROM workspace_memberships LIMIT 1")
            .fetch_one(&f.db)
            .await
            .unwrap();
    let session = owner(
        &client,
        reqwest::Method::GET,
        format!("{}/api/v1/auth/me", f.origin),
        &f,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(session.status(), reqwest::StatusCode::OK);
    let task = client
        .get(format!(
            "{}/api/v1/workspaces/{workspace}/tasks/1",
            f.origin
        ))
        .bearer_auth(bearer)
        .send()
        .await
        .unwrap();
    let vault = client
        .get(format!(
            "{}/api/v1/vaults/{}/contents",
            f.origin,
            Uuid::new_v4()
        ))
        .bearer_auth(bearer)
        .send()
        .await
        .unwrap();
    let proposal = client
        .post(format!(
            "{}/api/v1/workspaces/{workspace}/proposals/{}/approve",
            f.origin,
            Uuid::new_v4()
        ))
        .bearer_auth(bearer)
        .json(&serde_json::json!({"revision":1}))
        .send()
        .await
        .unwrap();
    assert_eq!(task.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert_eq!(vault.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert_eq!(proposal.status(), reqwest::StatusCode::UNAUTHORIZED);
    cleanup(f).await;
}
