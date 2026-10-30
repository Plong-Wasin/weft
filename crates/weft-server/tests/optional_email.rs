use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    env,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};
use uuid::Uuid;
use weft_server::{serve, ServerConfig};

const SECRET: &str = "smtp-pass-7f3a91c2";

struct Session {
    user: Uuid,
    cookie: String,
    csrf: String,
}

struct Env {
    origin: String,
    server: tokio::task::JoinHandle<()>,
    schema: String,
    admin: sqlx::PgPool,
    db: sqlx::PgPool,
    workspace: Uuid,
    owner: Session,
    member: Session,
    outsider: Session,
}

async fn setup() -> Env {
    env::set_var(
        "WEFT_AI_CREDENTIAL_KEY",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!("email_{}_{}", std::process::id(), Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&admin)
        .await
        .unwrap();
    let scoped = format!("{base}?options=-csearch_path%3D{schema}");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
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
    weft_server::bootstrap_admin(
        &db,
        "owner@example.com",
        "secret password",
        "Test Workspace",
    )
    .await
    .unwrap();
    let (workspace, owner): (Uuid, Uuid) = sqlx::query_as(
        "SELECT w.id,m.user_id FROM workspaces w JOIN workspace_memberships m ON m.workspace_id=w.id WHERE m.role='owner'",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    let member = add_user(&db, workspace, "member@example.com", "member").await;
    let outsider = add_user(&db, workspace, "outsider@example.com", "member").await;
    Env {
        origin,
        server,
        schema,
        admin,
        workspace,
        owner: session(&db, owner).await,
        member: session(&db, member).await,
        outsider: session(&db, outsider).await,
        db,
    }
}

async fn add_user(pool: &sqlx::PgPool, workspace: Uuid, email: &str, role: &str) -> Uuid {
    let user = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'unused')")
        .bind(user)
        .bind(email)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,$3)")
        .bind(workspace)
        .bind(user)
        .bind(role)
        .execute(pool)
        .await
        .unwrap();
    user
}

async fn session(pool: &sqlx::PgPool, user: Uuid) -> Session {
    let token = Uuid::new_v4().to_string();
    let csrf = Uuid::new_v4().to_string();
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')")
        .bind(Uuid::new_v4())
        .bind(user)
        .bind(hash)
        .bind(&csrf)
        .execute(pool)
        .await
        .unwrap();
    Session {
        user,
        cookie: format!("weft_session={token}; weft_csrf={csrf}"),
        csrf,
    }
}

fn req(method: reqwest::Method, url: String, who: &Session) -> reqwest::RequestBuilder {
    reqwest::Client::new()
        .request(method, url)
        .header(reqwest::header::COOKIE, &who.cookie)
        .header("x-csrf-token", &who.csrf)
}

async fn cleanup(env: Env) {
    env.server.abort();
    sqlx::query(&format!("DROP SCHEMA {} CASCADE", env.schema))
        .execute(&env.admin)
        .await
        .unwrap();
    env.admin.close().await;
}

#[derive(Default)]
struct FakeState {
    messages: Vec<Mail>,
    rcpt_failures: usize,
    reject_auth: bool,
    auth_lines: Vec<String>,
}

#[derive(Clone)]
struct Mail {
    from: String,
    to: String,
    data: String,
}

impl Mail {
    fn text(&self) -> String {
        let (head, body) = self.data.split_once("\r\n\r\n").unwrap_or((&self.data, ""));
        let joined: String = body.lines().collect();
        let decoded = STANDARD
            .decode(joined.trim())
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_else(|_| body.to_owned());
        format!("{head}\n\n{decoded}")
    }
}

type Fake = Arc<Mutex<FakeState>>;

/// Minimal plain-text SMTP server that records every accepted message.
async fn fake_smtp() -> (u16, Fake) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let state: Fake = Arc::default();
    let shared = state.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let state = shared.clone();
            tokio::spawn(async move {
                let (read, mut write) = stream.into_split();
                let mut lines = BufReader::new(read).lines();
                let _ = write.write_all(b"220 fake ESMTP\r\n").await;
                let (mut from, mut to) = (String::new(), String::new());
                while let Ok(Some(line)) = lines.next_line().await {
                    let upper = line.to_uppercase();
                    let reply: String = if upper.starts_with("EHLO") {
                        "250-fake\r\n250 AUTH PLAIN\r\n".into()
                    } else if upper.starts_with("AUTH PLAIN") {
                        let mut s = state.lock().unwrap();
                        s.auth_lines.push(line.clone());
                        if s.reject_auth {
                            "535 5.7.8 authentication failed\r\n".into()
                        } else {
                            "235 ok\r\n".into()
                        }
                    } else if upper.starts_with("MAIL FROM:") {
                        from = line[10..].trim().trim_matches(['<', '>']).to_owned();
                        "250 ok\r\n".into()
                    } else if upper.starts_with("RCPT TO:") {
                        let mut s = state.lock().unwrap();
                        if s.rcpt_failures > 0 {
                            s.rcpt_failures -= 1;
                            "451 4.3.0 try later\r\n".into()
                        } else {
                            to = line[8..].trim().trim_matches(['<', '>']).to_owned();
                            "250 ok\r\n".into()
                        }
                    } else if upper == "DATA" {
                        let _ = write.write_all(b"354 go\r\n").await;
                        let mut data = String::new();
                        while let Ok(Some(l)) = lines.next_line().await {
                            if l == "." {
                                break;
                            }
                            data.push_str(
                                l.strip_prefix('.')
                                    .filter(|_| l.starts_with(".."))
                                    .unwrap_or(&l),
                            );
                            data.push_str("\r\n");
                        }
                        state.lock().unwrap().messages.push(Mail {
                            from: from.clone(),
                            to: to.clone(),
                            data,
                        });
                        "250 queued\r\n".into()
                    } else if upper == "QUIT" {
                        let _ = write.write_all(b"221 bye\r\n").await;
                        return;
                    } else {
                        "250 ok\r\n".into()
                    };
                    if write.write_all(reply.as_bytes()).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    (port, state)
}

async fn configure(env: &Env, port: u16, enabled: bool, debounce: i64, retry: i64) -> Value {
    let response = req(
        reqwest::Method::PUT,
        format!("{}/api/v1/workspaces/{}/email", env.origin, env.workspace),
        &env.owner,
    )
    .json(&json!({
        "enabled": enabled, "host": "127.0.0.1", "port": port, "security": "none",
        "username": "weft", "password": SECRET, "from_address": "weft@example.com",
        "debounce_seconds": debounce, "retry_seconds": retry
    }))
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    response.json().await.unwrap()
}

async fn project_with_member(env: &Env) -> Uuid {
    let project: Value = req(
        reqwest::Method::POST,
        format!(
            "{}/api/v1/workspaces/{}/projects",
            env.origin, env.workspace
        ),
        &env.owner,
    )
    .json(&json!({"name":"Mail project","visibility":"restricted"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let project: Uuid = project["id"].as_str().unwrap().parse().unwrap();
    let added = req(
        reqwest::Method::POST,
        format!("{}/api/v1/projects/{project}/members", env.origin),
        &env.owner,
    )
    .json(&json!({"user_id":env.member.user,"role":"contributor"}))
    .send()
    .await
    .unwrap();
    assert!(added.status().is_success());
    project
}

async fn create_task(env: &Env, project: Uuid, title: &str, assignees: Value) -> Value {
    let response = req(
        reqwest::Method::POST,
        format!("{}/api/v1/workspaces/{}/tasks", env.origin, env.workspace),
        &env.owner,
    )
    .json(&json!({"project_id":project,"title":title,"assignees":assignees}))
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::CREATED);
    response.json().await.unwrap()
}

async fn watch_updates(env: &Env, task: &Value) {
    let response = req(
        reqwest::Method::PUT,
        format!(
            "{}/api/v1/tasks/{}/watch",
            env.origin,
            task["id"].as_str().unwrap()
        ),
        &env.member,
    )
    .json(&json!({"watching":true,"events":["updated"]}))
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
}

async fn rename(env: &Env, task: &Value, version: i64, title: &str) -> i64 {
    let response = req(
        reqwest::Method::PATCH,
        format!(
            "{}/api/v1/tasks/{}",
            env.origin,
            task["id"].as_str().unwrap()
        ),
        &env.owner,
    )
    .json(&json!({"expected_version":version,"title":title}))
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    body["version"].as_i64().unwrap()
}

async fn deliveries(env: &Env) -> Value {
    req(
        reqwest::Method::GET,
        format!(
            "{}/api/v1/workspaces/{}/email/deliveries",
            env.origin, env.workspace
        ),
        &env.owner,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap()
}

async fn wait_for<F: Fn() -> bool>(what: &str, check: F) {
    for _ in 0..200 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test(flavor = "multi_thread")]
async fn email_is_off_by_default_and_the_smtp_secret_never_leaves_the_server() {
    let env = setup().await;
    let url = format!("{}/api/v1/workspaces/{}/email", env.origin, env.workspace);
    let initial: Value = req(reqwest::Method::GET, url.clone(), &env.owner)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(initial["enabled"], false);
    assert_eq!(initial["password_set"], false);

    for who in [&env.member, &env.outsider] {
        let denied = req(reqwest::Method::GET, url.clone(), who)
            .send()
            .await
            .unwrap();
        assert_eq!(denied.status(), reqwest::StatusCode::FORBIDDEN);
        let put = req(reqwest::Method::PUT, url.clone(), who)
            .json(&json!({"enabled":true,"host":"h","port":25,"security":"none","from_address":"a@b.c"}))
            .send()
            .await
            .unwrap();
        assert_eq!(put.status(), reqwest::StatusCode::FORBIDDEN);
    }

    let invalid = req(reqwest::Method::PUT, url.clone(), &env.owner)
        .json(&json!({"enabled":true,"host":"","port":25,"security":"none","from_address":"a@b.c"}))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid.status(), reqwest::StatusCode::UNPROCESSABLE_ENTITY);
    let injected = req(reqwest::Method::PUT, url.clone(), &env.owner)
        .json(&json!({"enabled":true,"host":"h","port":25,"security":"none","from_address":"a@b.c\r\nBcc: x@y.z"}))
        .send()
        .await
        .unwrap();
    assert_eq!(injected.status(), reqwest::StatusCode::UNPROCESSABLE_ENTITY);

    let saved = configure(&env, 2525, true, 300, 300).await;
    assert_eq!(saved["password_set"], true);
    assert!(!saved.to_string().contains(SECRET));
    let read = req(reqwest::Method::GET, url.clone(), &env.owner)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(!read.contains(SECRET));
    assert!(read.contains("\"password_set\":true"));

    let stored: Vec<u8> = sqlx::query_scalar(
        "SELECT password_ciphertext FROM workspace_email_settings WHERE workspace_id=$1",
    )
    .bind(env.workspace)
    .fetch_one(&env.db)
    .await
    .unwrap();
    assert!(!stored.is_empty());
    assert!(!String::from_utf8_lossy(&stored).contains(SECRET));

    // Omitting the password keeps the stored secret.
    let kept: Value = req(reqwest::Method::PUT, url.clone(), &env.owner)
        .json(&json!({"enabled":false,"host":"127.0.0.1","port":2525,"security":"none","from_address":"weft@example.com"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(kept["password_set"], true);
    assert_eq!(kept["enabled"], false);
    cleanup(env).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn test_send_reports_success_or_the_failure_reason() {
    let env = setup().await;
    let (port, fake) = fake_smtp().await;
    configure(&env, port, false, 300, 300).await;
    let url = format!(
        "{}/api/v1/workspaces/{}/email/test",
        env.origin, env.workspace
    );

    let denied = req(reqwest::Method::POST, url.clone(), &env.member)
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), reqwest::StatusCode::FORBIDDEN);

    let ok: Value = req(reqwest::Method::POST, url.clone(), &env.owner)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(ok["ok"], true);
    {
        let state = fake.lock().unwrap();
        assert_eq!(state.messages.len(), 1);
        assert_eq!(state.messages[0].to, "owner@example.com");
        assert_eq!(state.messages[0].from, "weft@example.com");
        let expected = STANDARD.encode(format!("\0weft\0{SECRET}"));
        assert_eq!(state.auth_lines[0], format!("AUTH PLAIN {expected}"));
    }

    fake.lock().unwrap().reject_auth = true;
    let failed: Value = req(reqwest::Method::POST, url.clone(), &env.owner)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(failed["ok"], false);
    assert!(failed["error"].as_str().unwrap().contains("535"));
    assert!(!failed.to_string().contains(SECRET));

    // A dead host also yields a reason instead of an error status.
    let dead = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dead_port = dead.local_addr().unwrap().port();
    drop(dead);
    configure(&env, dead_port, false, 300, 300).await;
    let refused: Value = req(reqwest::Method::POST, url, &env.owner)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(refused["ok"], false);
    assert!(!refused["error"].as_str().unwrap().is_empty());
    cleanup(env).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn assignment_email_goes_to_the_assignee_and_nothing_is_sent_while_email_is_off() {
    let env = setup().await;
    let (port, fake) = fake_smtp().await;
    let project = project_with_member(&env).await;
    // Email off (the default): an assignment sends nothing.
    configure(&env, port, false, 300, 300).await;
    create_task(
        &env,
        project,
        "Quiet task",
        json!([{"type":"user","id":env.member.user}]),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(1800)).await;
    assert!(fake.lock().unwrap().messages.is_empty());

    configure(&env, port, true, 300, 300).await;
    let task = create_task(
        &env,
        project,
        "Ship the invoice export",
        json!([{"type":"user","id":env.member.user}]),
    )
    .await;
    wait_for("assignment email", || {
        !fake.lock().unwrap().messages.is_empty()
    })
    .await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let messages = fake.lock().unwrap().messages.clone();
    assert_eq!(
        messages.len(),
        1,
        "enabling email must not replay old entries"
    );
    assert_eq!(messages[0].to, "member@example.com");
    let text = messages[0].text();
    assert!(text.contains("Ship the invoice export"), "{text}");
    assert!(!text.contains("Quiet task"));
    assert!(task["number"].is_i64());
    let list = deliveries(&env).await;
    assert_eq!(list["deliveries"][0]["status"], "sent");
    cleanup(env).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn attribute_change_emails_are_debounced_and_follow_chosen_events() {
    let env = setup().await;
    let (port, fake) = fake_smtp().await;
    let project = project_with_member(&env).await;
    configure(&env, port, true, 2, 300).await;
    let task = create_task(&env, project, "Draft", json!([])).await;
    let other = create_task(&env, project, "Unwatched", json!([])).await;
    watch_updates(&env, &task).await;
    let mut version = task["version"].as_i64().unwrap();
    for title in ["Draft 1", "Draft 2", "Draft 3"] {
        version = rename(&env, &task, version, title).await;
    }
    rename(&env, &other, other["version"].as_i64().unwrap(), "Other 1").await;
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert!(
        fake.lock().unwrap().messages.is_empty(),
        "debounce window must hold the email"
    );
    wait_for("debounced email", || {
        !fake.lock().unwrap().messages.is_empty()
    })
    .await;
    tokio::time::sleep(Duration::from_millis(3500)).await;
    let messages = fake.lock().unwrap().messages.clone();
    assert_eq!(messages.len(), 1, "three edits collapse to one email");
    assert!(messages[0].text().contains("Draft 3"));
    assert!(!messages[0].text().contains("Other"));
    cleanup(env).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn send_time_access_check_drops_email_for_someone_who_lost_access() {
    let env = setup().await;
    let (port, fake) = fake_smtp().await;
    let project = project_with_member(&env).await;
    configure(&env, port, true, 2, 300).await;
    let task = create_task(&env, project, "Secret roadmap", json!([])).await;
    watch_updates(&env, &task).await;
    rename(
        &env,
        &task,
        task["version"].as_i64().unwrap(),
        "Secret roadmap v2",
    )
    .await;
    sqlx::query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2")
        .bind(project)
        .bind(env.member.user)
        .execute(&env.db)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(5000)).await;
    assert!(
        fake.lock().unwrap().messages.is_empty(),
        "no email may carry a title the recipient cannot read"
    );
    let list = deliveries(&env).await;
    let row = &list["deliveries"][0];
    assert_eq!(row["status"], "skipped");
    assert!(!row.to_string().contains("Secret roadmap"));
    cleanup(env).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn undo_cancels_a_pending_email_but_never_recalls_a_sent_one() {
    let env = setup().await;
    let (port, fake) = fake_smtp().await;
    let project = project_with_member(&env).await;
    configure(&env, port, true, 3, 300).await;
    let task = create_task(&env, project, "Undo me", json!([])).await;
    watch_updates(&env, &task).await;
    let version = rename(&env, &task, task["version"].as_i64().unwrap(), "Undo me 2").await;
    let undo_url = format!(
        "{}/api/v1/workspaces/{}/history/undo",
        env.origin, env.workspace
    );
    let undone = req(reqwest::Method::POST, undo_url.clone(), &env.owner)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(undone.status(), reqwest::StatusCode::OK);
    tokio::time::sleep(Duration::from_millis(5500)).await;
    assert!(
        fake.lock().unwrap().messages.is_empty(),
        "pending email cancelled"
    );

    let version = rename(&env, &task, version + 1, "Undo me 3").await;
    wait_for("email", || !fake.lock().unwrap().messages.is_empty()).await;
    let undone = req(reqwest::Method::POST, undo_url, &env.owner)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(undone.status(), reqwest::StatusCode::OK);
    let _ = version;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(fake.lock().unwrap().messages.len(), 1);
    let list = deliveries(&env).await;
    let statuses: Vec<&str> = list["deliveries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["status"].as_str().unwrap())
        .collect();
    assert!(statuses.contains(&"sent"), "{statuses:?}");
    cleanup(env).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn failed_sends_are_retried_a_bounded_number_of_times_and_visible_to_the_admin() {
    let env = setup().await;
    let (port, fake) = fake_smtp().await;
    let project = project_with_member(&env).await;
    configure(&env, port, true, 0, 1).await;

    // Two temporary failures, then the server recovers: delivered on the third attempt.
    fake.lock().unwrap().rcpt_failures = 2;
    create_task(
        &env,
        project,
        "Flaky delivery",
        json!([{"type":"user","id":env.member.user}]),
    )
    .await;
    wait_for("retried email", || {
        !fake.lock().unwrap().messages.is_empty()
    })
    .await;
    let list = deliveries(&env).await;
    assert_eq!(list["deliveries"][0]["status"], "sent");
    assert_eq!(list["deliveries"][0]["attempts"], 3);

    // A server that never recovers: bounded attempts, then failed with a visible reason.
    fake.lock().unwrap().rcpt_failures = 1000;
    create_task(
        &env,
        project,
        "Dead delivery",
        json!([{"type":"user","id":env.member.user}]),
    )
    .await;
    let mut failed = Value::Null;
    for _ in 0..150 {
        let list = deliveries(&env).await;
        if let Some(row) = list["deliveries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["status"] == "failed")
        {
            failed = row.clone();
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(failed["attempts"], 3, "{failed}");
    assert!(failed["last_error"].as_str().unwrap().contains("451"));
    assert!(!failed.to_string().contains(SECRET));
    let consumed = fake.lock().unwrap().rcpt_failures;
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert_eq!(
        fake.lock().unwrap().rcpt_failures,
        consumed,
        "no further retries"
    );
    assert_eq!(fake.lock().unwrap().messages.len(), 1);

    let member_view = req(
        reqwest::Method::GET,
        format!(
            "{}/api/v1/workspaces/{}/email/deliveries",
            env.origin, env.workspace
        ),
        &env.member,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(member_view.status(), reqwest::StatusCode::FORBIDDEN);
    cleanup(env).await;
}
