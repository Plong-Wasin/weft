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

async fn assert_rejected(agent: &Agent, items: serde_json::Value, detail: &str) {
    let body = agent.validate(items).await;
    assert_eq!(body["valid"], false, "{detail}: {body}");
    assert_eq!(body["error"]["code"], "invalid_proposal");
    let text = body["error"]["detail"].as_str().unwrap();
    assert!(text.contains(detail), "expected {detail} in {text}");
}

#[tokio::test(flavor = "multi_thread")]
async fn server_rejects_every_invalid_proposal_with_a_structured_error() {
    let f = fixture().await;
    let a = start_run(&f, "generate").await;
    let other = Uuid::new_v4();
    assert_rejected(
        &a,
        serde_json::json!([draft("tmp-a", a.other_project, "Out of scope")]),
        "item_outside_scope",
    )
    .await;
    assert_rejected(
        &a,
        serde_json::json!([draft("real-id", a.project, "Bad id")]),
        "temporary_id_invalid",
    )
    .await;
    assert_rejected(
        &a,
        serde_json::json!([
            draft("tmp-a", a.project, "One"),
            draft("tmp-a", a.project, "Two")
        ]),
        "duplicate item id",
    )
    .await;
    let mut dangling = draft("tmp-a", a.project, "One");
    dangling["depends_on"] = serde_json::json!(["tmp-missing"]);
    assert_rejected(&a, serde_json::json!([dangling]), "unknown dependency").await;
    let mut first = draft("tmp-a", a.project, "One");
    let mut second = draft("tmp-b", a.project, "Two");
    first["depends_on"] = serde_json::json!(["tmp-b"]);
    second["depends_on"] = serde_json::json!(["tmp-a"]);
    assert_rejected(&a, serde_json::json!([first, second]), "dependency_cycle").await;
    let link = |id: &str, source: &str, target: &str| serde_json::json!({"id":id,"kind":"relation","relation":"blocks","source_task_id":source,"target_task_id":target,"reason":"order","sources":[]});
    assert_rejected(
        &a,
        serde_json::json!([
            draft("tmp-a", a.project, "One"),
            link("tmp-l", "tmp-a", "tmp-ghost")
        ]),
        "relation endpoint missing",
    )
    .await;
    assert_rejected(
        &a,
        serde_json::json!([
            draft("tmp-a", a.project, "One"),
            draft("tmp-b", a.project, "Two"),
            link("tmp-l1", "tmp-a", "tmp-b"),
            link("tmp-l2", "tmp-b", "tmp-a")
        ]),
        "relation cycle",
    )
    .await;
    assert_rejected(
        &a,
        serde_json::json!([link("tmp-l", &a.task.to_string(), &other.to_string())]),
        "relation task missing",
    )
    .await;
    let mut stale = serde_json::json!({"id":"tmp-s","kind":"relation","relation":"related","source_task_id":a.task,"target_task_id":"tmp-a","expected_source_version":a.task_version + 5,"reason":"x","sources":[]});
    stale["expected_source_version"] = serde_json::json!(a.task_version + 5);
    assert_rejected(
        &a,
        serde_json::json!([draft("tmp-a", a.project, "One"), stale]),
        "stale base version",
    )
    .await;
    let mut split = draft("tmp-a", a.project, "Child");
    split["source_task_id"] = serde_json::json!(a.task);
    split["expected_version"] = serde_json::json!(a.task_version + 1);
    assert_rejected(&a, serde_json::json!([split]), "stale base version").await;
    assert_rejected(
        &a,
        serde_json::json!([draft("tmp-a", a.project, &"t".repeat(4001))]),
        "text_ceiling_exceeded",
    )
    .await;
    let many: Vec<_> = (0..101)
        .map(|n| draft(&format!("tmp-{n}"), a.project, "Many"))
        .collect();
    assert_rejected(&a, serde_json::json!(many), "item_ceiling_exceeded").await;
    let mut heavy: Vec<_> = (0..100)
        .map(|n| draft(&format!("tmp-{n}"), a.project, &format!("Edge {n}")))
        .collect();
    for item in &mut heavy {
        item["depends_on"] = serde_json::json!(["tmp-0", "tmp-0", "tmp-0"]);
    }
    assert_rejected(&a, serde_json::json!(heavy), "edge_ceiling_exceeded").await;
    assert_rejected(
        &a,
        serde_json::json!([{"id":"tmp-n","kind":"note_edit","reason":"x","sources":[]}]),
        "item_kind_not_allowed",
    )
    .await;
    // Validation is a dry run: it never creates the Proposal.
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM proposals WHERE ai_run_id IS NOT NULL")
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(count, 0);
    let ok = a
        .validate(serde_json::json!([draft("tmp-a", a.project, "Fine")]))
        .await;
    assert_eq!(ok["valid"], true, "{ok}");
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM proposals WHERE ai_run_id IS NOT NULL")
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(count, 0);
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn project_the_requester_can_no_longer_write_is_rejected() {
    let f = fixture().await;
    let a = start_run(&f, "generate").await;
    sqlx::query("UPDATE project_memberships SET role='viewer' WHERE project_id=$1")
        .bind(a.project)
        .execute(&f.db)
        .await
        .unwrap();
    assert_rejected(
        &a,
        serde_json::json!([draft("tmp-a", a.project, "Blocked")]),
        "initiator cannot write project",
    )
    .await;
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn tools_follow_run_capability_and_the_model_cannot_apply() {
    let f = fixture().await;
    let a = start_run(&f, "generate").await;
    let (status, _) = a
        .tool(serde_json::json!({"tool":"propose_links","items":[]}))
        .await;
    assert_eq!(status, reqwest::StatusCode::FORBIDDEN);
    for tool in ["approve_proposal", "apply_proposal"] {
        let (status, _) = a
            .tool(serde_json::json!({"tool":tool,"proposal_id":Uuid::new_v4()}))
            .await;
        assert_eq!(status, reqwest::StatusCode::UNPROCESSABLE_ENTITY, "{tool}");
    }
    let (status, body) = a
        .tool(
            serde_json::json!({"tool":"propose_tasks","items":[draft("tmp-a", a.project, "One")]}),
        )
        .await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(body["accepted"], true);
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn run_produces_one_ready_proposal_with_attribution_similarity_and_questions() {
    let f = fixture().await;
    let a = start_run(&f, "generate").await;
    let mut covered = draft("tmp-a", a.project, "Publish the quarterly report");
    covered["sources"] = serde_json::json!([{"kind":"task","id":"invented"}]);
    let proposal = serde_json::json!({"schema_version":1,"items":[covered,draft("tmp-b",a.project,"Brand new unrelated chore")],
        "assumptions":["Input was thin: assuming a report exists"],"open_questions":["Who approves the report?"]});
    a.complete(proposal.clone()).await;
    let run = a.run_state(&f).await;
    assert_eq!(run["state"], "waiting_for_approval");
    let id = run["result"]["proposal_id"].as_str().unwrap().to_owned();
    let proposal: serde_json::Value = request(
        &a.client,
        reqwest::Method::GET,
        format!(
            "{}/api/v1/workspaces/{}/proposals/{id}",
            f.origin, f.workspace
        ),
        &f,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(proposal["status"], "ready");
    assert_eq!(proposal["provider"], "scripted");
    assert_eq!(proposal["ai_run_id"], a.run);
    assert_eq!(
        proposal["assumptions"][0],
        "Input was thin: assuming a report exists"
    );
    assert_eq!(proposal["open_questions"][0], "Who approves the report?");
    assert_eq!(proposal["items"][0]["existing_task_covers_draft"], true);
    assert_eq!(
        proposal["items"][0]["similar_tasks"][0]["id"],
        a.task.to_string()
    );
    assert_eq!(proposal["items"][1]["existing_task_covers_draft"], false);
    // Model-supplied sources are replaced by the sources the server recorded.
    assert_eq!(proposal["items"][0]["sources"][0]["id"], "run_prompt");
    let initiator: Uuid =
        sqlx::query_scalar("SELECT initiator_id FROM proposals WHERE id=$1::uuid")
            .bind(&id)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(initiator, f.user);
    // Exactly one Proposal per run.
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM proposals WHERE ai_run_id=$1::uuid")
        .bind(&a.run)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(count, 1);
    // Nothing is written to Tasks until a human approves.
    let tasks: i64 = sqlx::query_scalar("SELECT count(*) FROM tasks WHERE project_id=$1")
        .bind(a.project)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(tasks, 1);
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn invalid_final_output_fails_the_run_without_a_proposal() {
    let f = fixture().await;
    let a = start_run(&f, "generate").await;
    a.complete(serde_json::json!({"schema_version":1,"items":[draft("tmp-a", a.other_project, "Out")],"assumptions":[],"open_questions":[]})).await;
    let run = a.run_state(&f).await;
    assert_eq!(run["state"], "failed");
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM proposals WHERE ai_run_id IS NOT NULL")
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert_eq!(count, 0);
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn split_keeps_parent_by_default_links_back_and_leaves_source_untouched() {
    let f = fixture().await;
    let a = start_run(&f, "split").await;
    sqlx::query("INSERT INTO task_comments(id,workspace_id,task_id,author_id,request_id,body) VALUES($1,$2,$3,$4,$5,'keep me')")
        .bind(Uuid::new_v4()).bind(f.workspace).bind(a.task).bind(f.user).bind(Uuid::new_v4())
        .execute(&f.db).await.unwrap();
    let mut child = draft("tmp-child", a.project, "Collect Q3 numbers");
    child["source_task_id"] = serde_json::json!(a.task);
    child["expected_version"] = serde_json::json!(a.task_version);
    let mut peer = draft("tmp-peer", a.project, "Draft layout");
    peer["source_task_id"] = serde_json::json!(a.task);
    peer["expected_version"] = serde_json::json!(a.task_version);
    peer["split_mode"] = serde_json::json!("peer");
    a.complete(serde_json::json!({"schema_version":1,"items":[child,peer],"assumptions":[],"open_questions":[]})).await;
    let run = a.run_state(&f).await;
    let id = run["result"]["proposal_id"].as_str().unwrap().to_owned();
    let url = format!(
        "{}/api/v1/workspaces/{}/proposals/{id}",
        f.origin, f.workspace
    );
    let proposal: serde_json::Value = request(&a.client, reqwest::Method::GET, url.clone(), &f)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let links = proposal["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["kind"] == "relation")
        .count();
    assert_eq!(links, 2, "each new Task links back to the source");
    assert_eq!(
        proposal["expected_versions"][a.task.to_string()],
        a.task_version
    );
    let approve = request(
        &a.client,
        reqwest::Method::POST,
        format!("{url}/approve"),
        &f,
    )
    .header("idempotency-key", Uuid::new_v4().to_string())
    .json(&serde_json::json!({"revision":proposal["revision"]}))
    .send()
    .await
    .unwrap();
    assert_eq!(
        approve.status(),
        reqwest::StatusCode::OK,
        "{}",
        approve.text().await.unwrap()
    );
    let parent_of = |title: &'static str| {
        let db = f.db.clone();
        async move {
            sqlx::query_scalar::<_, Option<Uuid>>("SELECT parent_task_id FROM tasks WHERE title=$1")
                .bind(title)
                .fetch_one(&db)
                .await
                .unwrap()
        }
    };
    assert_eq!(parent_of("Collect Q3 numbers").await, Some(a.task));
    assert_eq!(parent_of("Draft layout").await, None);
    // Adding the back links bumps the source version (existing relation behaviour), but
    // the source is never archived, completed or edited.
    let (archived, status): (Option<String>, String) =
        sqlx::query_as("SELECT archived_at::text,status FROM tasks WHERE id=$1")
            .bind(a.task)
            .fetch_one(&f.db)
            .await
            .unwrap();
    assert!(archived.is_none());
    assert_eq!(status, "backlog");
    let comments: i64 = sqlx::query_scalar("SELECT count(*) FROM task_comments WHERE task_id=$1")
        .bind(a.task)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(comments, 1);
    cleanup(f).await;
}
