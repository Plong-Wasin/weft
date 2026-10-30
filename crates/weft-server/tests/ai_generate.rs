#![allow(dead_code)]

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
    workspace: Uuid,
    user: Uuid,
    cookie: String,
    csrf: String,
    connection: Uuid,
}

async fn fixture() -> Fixture {
    env::set_var(
        "WEFT_AGENT_SIGNING_KEY",
        "runner-test-signing-key-012345678901234567890123456789",
    );
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!("ai_runs_{}", Uuid::new_v4().simple());
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
    let (workspace, user): (Uuid, Uuid) = sqlx::query_as(
        "SELECT w.id,m.user_id FROM workspaces w JOIN workspace_memberships m ON m.workspace_id=w.id WHERE m.role='owner'",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    let connection = Uuid::new_v4();
    sqlx::query("INSERT INTO ai_connections(id,scope,workspace_id,provider,auth_mode,billing_mode,state,state_reason,created_by) VALUES($1,'workspace',$2,'scripted','provider_cli','api','ready','ready',$3)")
        .bind(connection).bind(workspace).bind(user).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO ai_connection_grants(connection_id,workspace_id) VALUES($1,$2)")
        .bind(connection)
        .bind(workspace)
        .execute(&db)
        .await
        .unwrap();
    let token = Uuid::new_v4().to_string();
    let csrf = Uuid::new_v4().to_string();
    let token_hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')")
        .bind(Uuid::new_v4()).bind(user).bind(token_hash).bind(&csrf).execute(&db).await.unwrap();
    Fixture {
        origin,
        server,
        schema,
        admin,
        db,
        workspace,
        user,
        cookie: format!("weft_session={token}; weft_csrf={csrf}"),
        csrf,
        connection,
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

fn request(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: String,
    f: &Fixture,
) -> reqwest::RequestBuilder {
    client
        .request(method, url)
        .header(reqwest::header::COOKIE, &f.cookie)
        .header("x-csrf-token", &f.csrf)
}

struct Agent {
    client: reqwest::Client,
    root: String,
    bearer: String,
    job: String,
    run: String,
    project: Uuid,
    other_project: Uuid,
    task: Uuid,
    task_version: i64,
}

async fn start_run(f: &Fixture, capability: &str) -> Agent {
    let client = reqwest::Client::new();
    let root = format!("{}/api/v1/ai", f.origin);
    let project = Uuid::new_v4();
    let other_project = Uuid::new_v4();
    let task = Uuid::new_v4();
    for (id, name) in [(project, "Scoped"), (other_project, "Other")] {
        sqlx::query("INSERT INTO projects(id,workspace_id,name,visibility,created_by) VALUES($1,$2,$3,'workspace',$4)")
            .bind(id).bind(f.workspace).bind(name).bind(f.user).execute(&f.db).await.unwrap();
        sqlx::query("INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2,$3,'manager')")
            .bind(f.workspace).bind(id).bind(f.user).execute(&f.db).await.unwrap();
    }
    sqlx::query("INSERT INTO tasks(id,workspace_id,number,project_id,title,description,created_by) VALUES($1,$2,1,$3,'Publish the quarterly report',$4,$5)")
        .bind(task).bind(f.workspace).bind(project).bind("Collect numbers").bind(f.user).execute(&f.db).await.unwrap();
    sqlx::query("UPDATE workspaces SET next_task_number=2 WHERE id=$1")
        .bind(f.workspace)
        .execute(&f.db)
        .await
        .unwrap();
    let task_version: i64 = sqlx::query_scalar("SELECT version FROM tasks WHERE id=$1")
        .bind(task)
        .fetch_one(&f.db)
        .await
        .unwrap();
    let code: serde_json::Value = request(
        &client,
        reqwest::Method::POST,
        format!("{root}/connections/{}/runners/pairing-codes", f.connection),
        f,
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let paired: serde_json::Value = client
        .post(format!("{root}/agent/pair"))
        .json(&serde_json::json!({"code":code["code"],"name":"scripted","version":"test","supported_modes":["scripted"]}))
        .send().await.unwrap().json().await.unwrap();
    let bearer = format!("Bearer {}", paired["token"].as_str().unwrap());
    client
        .post(format!("{root}/agent/heartbeat"))
        .header("authorization", &bearer)
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    let started: serde_json::Value = request(&client, reqwest::Method::POST, format!("{root}/runs"), f)
        .json(&serde_json::json!({"workspace_id":f.workspace,"connection_id":f.connection,"capability":capability,"scope":{"projects":[project]},"prompt":"plan"}))
        .send().await.unwrap().json().await.unwrap();
    let lease: serde_json::Value = client
        .post(format!("{root}/agent/jobs/lease"))
        .header("authorization", &bearer)
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    Agent {
        client,
        root,
        bearer,
        job: lease["job"]["id"].as_str().unwrap().to_owned(),
        run: started["id"].as_str().unwrap().to_owned(),
        project,
        other_project,
        task,
        task_version,
    }
}

impl Agent {
    async fn tool(&self, call: serde_json::Value) -> (reqwest::StatusCode, serde_json::Value) {
        let response = self
            .client
            .post(format!("{}/agent/jobs/{}/tools", self.root, self.job))
            .header("authorization", &self.bearer)
            .json(&serde_json::json!({ "call": call }))
            .send()
            .await
            .unwrap();
        let status = response.status();
        (status, response.json().await.unwrap_or_default())
    }

    async fn validate(&self, items: serde_json::Value) -> serde_json::Value {
        let (status, body) = self
            .tool(serde_json::json!({"tool":"validate_proposal","proposal":{"schema_version":1,"items":items,"assumptions":[],"open_questions":[]}}))
            .await;
        assert_eq!(status, reqwest::StatusCode::OK);
        body
    }

    async fn complete(&self, proposal: serde_json::Value) {
        let response = self
            .client
            .post(format!("{}/agent/jobs/{}/result", self.root, self.job))
            .header("authorization", &self.bearer)
            .json(&serde_json::json!({"result":{"summary":"done","outcome":"waiting_for_approval","proposal":proposal}}))
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
    }

    async fn run_state(&self, f: &Fixture) -> serde_json::Value {
        request(
            &self.client,
            reqwest::Method::GET,
            format!("{}/runs/{}", self.root, self.run),
            f,
        )
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
    }
}

fn draft(id: &str, project: Uuid, title: &str) -> serde_json::Value {
    serde_json::json!({"id":id,"kind":"task","project_id":project,"title":title,"reason":"needed","sources":[]})
}

fn relation(id: &str, kind: &str, source: &str, target: &str) -> serde_json::Value {
    serde_json::json!({"id":id,"kind":"relation","relation":kind,"source_task_id":source,"target_task_id":target,"reason":"order of work","sources":[]})
}

async fn json_of(response: reqwest::Response) -> (reqwest::StatusCode, serde_json::Value) {
    let status = response.status();
    (status, response.json().await.unwrap_or_default())
}

fn selected(proposal: &serde_json::Value) -> Vec<(String, bool)> {
    proposal["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            (
                item["id"].as_str().unwrap().to_owned(),
                item["selected"] == true,
            )
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn generated_plan_is_edited_approved_once_and_undone_as_one_group() {
    let f = fixture().await;
    let a = start_run(&f, "generate").await;
    let proposals = format!("{}/api/v1/workspaces/{}/proposals", f.origin, f.workspace);
    let active_tasks = || async {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM tasks WHERE project_id=$1 AND archived_at IS NULL",
        )
        .bind(a.project)
        .fetch_one(&f.db)
        .await
        .unwrap()
    };
    let mut parent = draft("tmp-parent", a.project, "Build the subscription API");
    parent["description"] = serde_json::json!("Expose plans and invoices");
    let mut child = draft("tmp-child", a.project, "Verify the API with QA");
    child["depends_on"] = serde_json::json!(["tmp-parent"]);
    a.complete(serde_json::json!({
        "schema_version":1,
        "items":[parent, child, relation("tmp-link","blocks","tmp-parent","tmp-child")],
        "assumptions":[],"open_questions":[]
    }))
    .await;
    let run = a.run_state(&f).await;
    assert_eq!(run["state"], "waiting_for_approval");
    let id = run["result"]["proposal_id"].as_str().unwrap().to_owned();
    // The AI run alone never writes Tasks: only the seeded Task exists before approval.
    assert_eq!(active_tasks().await, 1);

    // The runner credential is not a signed-in user session and cannot approve.
    let by_runner = a
        .client
        .post(format!("{proposals}/{id}/approve"))
        .header("authorization", &a.bearer)
        .header("idempotency-key", "runner-attempt")
        .json(&serde_json::json!({"revision":1}))
        .send()
        .await
        .unwrap();
    assert_eq!(by_runner.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert_eq!(active_tasks().await, 1);

    let (_, mut proposal) = json_of(
        request(
            &a.client,
            reqwest::Method::GET,
            format!("{proposals}/{id}"),
            &f,
        )
        .send()
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(proposal["status"], "ready");

    // Rename a row by hand.
    proposal["items"][0]["title"] = serde_json::json!("Build the billing API");
    let (status, renamed) = json_of(
        request(
            &a.client,
            reqwest::Method::PATCH,
            format!("{proposals}/{id}"),
            &f,
        )
        .json(&serde_json::json!({"expected_revision":1,"items":proposal["items"]}))
        .send()
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{renamed}");
    assert_eq!(renamed["revision"], 2);
    assert_eq!(renamed["items"][0]["title"], "Build the billing API");

    let toggle = |revision: i64, items: serde_json::Value, item: &str, on: bool| {
        request(&a.client, reqwest::Method::PATCH, format!("{proposals}/{id}"), &f)
            .json(&serde_json::json!({"expected_revision":revision,"items":items,"toggle":{"item_id":item,"selected":on}}))
            .send()
    };
    // Unticking the prerequisite unticks the dependent Task. The caller unticks the link between
    // them: the server cascades through `depends_on` and refuses a selected link to an unselected Task.
    let mut without_link = renamed["items"].clone();
    without_link[2]["selected"] = serde_json::json!(false);
    let (status, off) = json_of(toggle(2, without_link, "tmp-parent", false).await.unwrap()).await;
    assert_eq!(status, reqwest::StatusCode::OK, "{off}");
    assert_eq!(
        selected(&off),
        vec![
            ("tmp-parent".to_owned(), false),
            ("tmp-child".to_owned(), false),
            ("tmp-link".to_owned(), false)
        ]
    );
    // Ticking the dependent restores its prerequisite, but not the link it did not need.
    let (status, back) = json_of(
        toggle(3, off["items"].clone(), "tmp-child", true)
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{back}");
    assert_eq!(
        selected(&back),
        vec![
            ("tmp-parent".to_owned(), true),
            ("tmp-child".to_owned(), true),
            ("tmp-link".to_owned(), false)
        ]
    );
    let (_, all) = json_of(
        toggle(4, back["items"].clone(), "tmp-link", true)
            .await
            .unwrap(),
    )
    .await;
    assert!(selected(&all).iter().all(|(_, on)| *on));
    let revision = all["revision"].as_i64().unwrap();

    let approve = |key: &'static str| {
        request(
            &a.client,
            reqwest::Method::POST,
            format!("{proposals}/{id}/approve"),
            &f,
        )
        .header("idempotency-key", key)
        .json(&serde_json::json!({"revision":revision}))
        .send()
    };
    let (status, applied) = json_of(approve("approve-once").await.unwrap()).await;
    assert_eq!(status, reqwest::StatusCode::OK, "{applied}");
    assert_eq!(applied["created_tasks"].as_array().unwrap().len(), 2);
    assert_eq!(active_tasks().await, 3);
    let titles: Vec<String> = sqlx::query_scalar(
        "SELECT title FROM tasks WHERE project_id=$1 AND archived_at IS NULL ORDER BY number",
    )
    .bind(a.project)
    .fetch_all(&f.db)
    .await
    .unwrap();
    assert!(titles.contains(&"Build the billing API".to_owned()));
    let relations: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM task_relations WHERE workspace_id=$1 AND kind='blocks'",
    )
    .bind(f.workspace)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(relations, 1);

    // The same key replays the stored result; nothing is applied twice.
    let (status, replay) = json_of(approve("approve-once").await.unwrap()).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(replay["created_tasks"], applied["created_tasks"]);
    assert_eq!(active_tasks().await, 3);

    // One undo removes the whole generated group.
    let (status, undone) = json_of(
        request(
            &a.client,
            reqwest::Method::POST,
            format!("{proposals}/{id}/undo"),
            &f,
        )
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{undone}");
    assert_eq!(active_tasks().await, 1);
    cleanup(f).await;
}
