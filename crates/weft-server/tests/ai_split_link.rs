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

async fn make_task(f: &Fixture, project: Uuid, title: &str) -> (Uuid, i64) {
    let id = Uuid::new_v4();
    let number: i64 = sqlx::query_scalar(
        "UPDATE workspaces SET next_task_number=next_task_number+1 WHERE id=$1 RETURNING next_task_number-1",
    )
    .bind(f.workspace)
    .fetch_one(&f.db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO tasks(id,workspace_id,number,project_id,title,description,created_by) VALUES($1,$2,$3,$4,$5,'',$6)")
        .bind(id).bind(f.workspace).bind(number).bind(project).bind(title).bind(f.user)
        .execute(&f.db).await.unwrap();
    (id, 1)
}

fn link(id: &str, kind: &str, source: &str, target: &str) -> serde_json::Value {
    serde_json::json!({"id":id,"kind":"relation","relation":kind,"source_task_id":source,"target_task_id":target,"reason":"they overlap","sources":[]})
}

fn split_item(
    id: &str,
    project: Uuid,
    title: &str,
    source: Uuid,
    version: i64,
) -> serde_json::Value {
    serde_json::json!({"id":id,"kind":"task","project_id":project,"title":title,"reason":"separable piece of work","sources":[],"source_task_id":source,"expected_version":version})
}

fn proposals_url(f: &Fixture) -> String {
    format!("{}/api/v1/workspaces/{}/proposals", f.origin, f.workspace)
}

async fn get_proposal(a: &Agent, f: &Fixture, id: &str) -> serde_json::Value {
    json_of(
        request(
            &a.client,
            reqwest::Method::GET,
            format!("{}/{id}", proposals_url(f)),
            f,
        )
        .send()
        .await
        .unwrap(),
    )
    .await
    .1
}

async fn approve(
    a: &Agent,
    f: &Fixture,
    id: &str,
    revision: &serde_json::Value,
) -> (reqwest::StatusCode, serde_json::Value) {
    json_of(
        request(
            &a.client,
            reqwest::Method::POST,
            format!("{}/{id}/approve", proposals_url(f)),
            f,
        )
        .header("idempotency-key", Uuid::new_v4().to_string())
        .json(&serde_json::json!({"revision":revision}))
        .send()
        .await
        .unwrap(),
    )
    .await
}

async fn completed_proposal_id(a: &Agent, f: &Fixture, proposal: serde_json::Value) -> String {
    a.complete(proposal).await;
    let run = a.run_state(f).await;
    assert_eq!(run["state"], "waiting_for_approval", "{run}");
    run["result"]["proposal_id"].as_str().unwrap().to_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn split_names_what_stays_adds_subtasks_and_peers_with_reasons_and_keeps_context() {
    let f = fixture().await;
    let a = start_run(&f, "split").await;
    sqlx::query("INSERT INTO task_comments(id,workspace_id,task_id,author_id,request_id,body) VALUES($1,$2,$3,$4,$5,'keep me')")
        .bind(Uuid::new_v4()).bind(f.workspace).bind(a.task).bind(f.user).bind(Uuid::new_v4())
        .execute(&f.db).await.unwrap();
    let peer = {
        let mut item = split_item(
            "tmp-peer",
            a.project,
            "Design the layout",
            a.task,
            a.task_version,
        );
        item["split_mode"] = serde_json::json!("peer");
        item
    };
    let id = completed_proposal_id(
        &a,
        &f,
        serde_json::json!({"schema_version":1,
            "items":[split_item("tmp-sub", a.project, "Collect Q3 numbers", a.task, a.task_version), peer],
            "remaining_in_original":["Publishing and sign-off stay here"],
            "assumptions":[],"open_questions":[]}),
    )
    .await;
    let proposal = get_proposal(&a, &f, &id).await;
    assert_eq!(
        proposal["remaining_in_original"][0],
        "Publishing and sign-off stay here"
    );
    let items = proposal["items"].as_array().unwrap();
    assert!(items
        .iter()
        .filter(|item| item["kind"] == "task")
        .all(|item| item["reason"] == "separable piece of work"));
    assert_eq!(items.iter().filter(|i| i["kind"] == "relation").count(), 2);
    assert_eq!(proposal["stale_items"], serde_json::json!([]));
    let (status, applied) = approve(&a, &f, &id, &proposal["revision"]).await;
    assert_eq!(status, reqwest::StatusCode::OK, "{applied}");
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
    assert_eq!(parent_of("Design the layout").await, None);
    let related: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM task_relations WHERE (source_task_id=$1 OR target_task_id=$1) AND kind='related'",
    )
    .bind(a.task)
    .fetch_one(&f.db)
    .await
    .unwrap();
    assert_eq!(related, 2, "both new Tasks link back to the source");
    let comments: i64 = sqlx::query_scalar("SELECT count(*) FROM task_comments WHERE task_id=$1")
        .bind(a.task)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(comments, 1, "comments stay on the source Task");
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn split_and_link_runs_only_produce_their_own_kind_of_items() {
    let f = fixture().await;
    let a = start_run(&f, "split").await;
    // A Split must cut new Tasks from an existing source Task.
    a.complete(serde_json::json!({"schema_version":1,"items":[draft("tmp-a", a.project, "Loose task")],"assumptions":[],"open_questions":[]})).await;
    assert_eq!(a.run_state(&f).await["state"], "failed");
    cleanup(f).await;
    let f = fixture().await;
    let b = start_run(&f, "link").await;
    b.complete(serde_json::json!({"schema_version":1,"items":[draft("tmp-a", b.project, "Loose task")],"assumptions":[],"open_questions":[]})).await;
    assert_eq!(b.run_state(&f).await["state"], "failed");
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn suggested_links_show_their_type_apply_once_and_undo_as_one_group() {
    let f = fixture().await;
    let a = start_run(&f, "link").await;
    let (second, _) = make_task(&f, a.project, "Publish the quarterly report copy").await;
    let (third, _) = make_task(&f, a.project, "Prepare slides").await;
    let (fourth, _) = make_task(&f, a.project, "Review slides").await;
    let (child, _) = make_task(&f, a.project, "Slide notes").await;
    let (task, second_s, third_s, fourth_s, child_s) = (
        a.task.to_string(),
        second.to_string(),
        third.to_string(),
        fourth.to_string(),
        child.to_string(),
    );
    let id = completed_proposal_id(
        &a,
        &f,
        serde_json::json!({"schema_version":1,"items":[
            link("tmp-dup", "duplicate", &second_s, &task),
            link("tmp-blocks", "blocks", &third_s, &fourth_s),
            link("tmp-rel", "related", &task, &third_s),
            link("tmp-parent", "parent", &fourth_s, &child_s)],
            "assumptions":[],"open_questions":[]}),
    )
    .await;
    let proposal = get_proposal(&a, &f, &id).await;
    let kinds: Vec<&str> = proposal["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["relation"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["duplicate", "blocks", "related", "parent"]);
    let (status, applied) = approve(&a, &f, &id, &proposal["revision"]).await;
    assert_eq!(status, reqwest::StatusCode::OK, "{applied}");
    let relation_count = || async {
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM task_relations WHERE workspace_id=$1")
            .bind(f.workspace)
            .fetch_one(&f.db)
            .await
            .unwrap()
    };
    assert_eq!(relation_count().await, 3);
    let parent: Option<Uuid> = sqlx::query_scalar("SELECT parent_task_id FROM tasks WHERE id=$1")
        .bind(child)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(parent, Some(fourth));
    // A duplicate suggestion never closes or archives anything.
    let flags: Vec<(Option<String>, String)> = sqlx::query_as(
        "SELECT archived_at::text,status FROM tasks WHERE id=ANY($1) ORDER BY number",
    )
    .bind(vec![a.task, second])
    .fetch_all(&f.db)
    .await
    .unwrap();
    assert!(flags
        .iter()
        .all(|(archived, status)| archived.is_none() && status == "backlog"));
    let (status, undone) = json_of(
        request(
            &a.client,
            reqwest::Method::POST,
            format!("{}/{id}/undo", proposals_url(&f)),
            &f,
        )
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{undone}");
    assert_eq!(relation_count().await, 0);
    let parent: Option<Uuid> = sqlx::query_scalar("SELECT parent_task_id FROM tasks WHERE id=$1")
        .bind(child)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(parent, None);
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn links_between_drafts_and_existing_tasks_are_validated() {
    let f = fixture().await;
    let a = start_run(&f, "split").await;
    let (other, _) = make_task(&f, a.project, "Existing peer").await;
    let (nested, _) = make_task(&f, a.project, "Nested").await;
    sqlx::query("UPDATE tasks SET parent_task_id=$1 WHERE id=$2")
        .bind(a.task)
        .bind(nested)
        .execute(&f.db)
        .await
        .unwrap();
    let task = a.task.to_string();
    let base = |extra: Vec<serde_json::Value>| {
        let mut items = vec![
            split_item("tmp-a", a.project, "Part A", a.task, a.task_version),
            split_item("tmp-b", a.project, "Part B", a.task, a.task_version),
        ];
        items.extend(extra);
        items
    };
    let check = |items: Vec<serde_json::Value>, expected: &'static str| {
        let a = &a;
        async move {
            let body = a.validate(serde_json::Value::Array(items)).await;
            assert_eq!(body["valid"], false, "{body}");
            assert_eq!(
                body["error"]["detail"],
                format!("proposal_validation:{expected}")
            );
        }
    };
    check(
        base(vec![link("tmp-l", "related", "tmp-a", "tmp-a")]),
        "self_reference",
    )
    .await;
    check(
        base(vec![link("tmp-l", "parent", &task, &task)]),
        "self_reference",
    )
    .await;
    // The split already makes tmp-a a child of the source; the source under tmp-a is a cycle.
    check(
        base(vec![link("tmp-l", "parent", "tmp-a", &task)]),
        "parent_cycle",
    )
    .await;
    check(
        base(vec![
            link("tmp-l1", "parent", "tmp-a", "tmp-b"),
            link("tmp-l2", "parent", "tmp-b", "tmp-a"),
        ]),
        "parent_already_set",
    )
    .await;
    check(
        base(vec![link(
            "tmp-l",
            "parent",
            &other.to_string(),
            &nested.to_string(),
        )]),
        "parent_already_set",
    )
    .await;
    check(
        base(vec![
            link("tmp-l1", "blocks", "tmp-a", &other.to_string()),
            link("tmp-l2", "blocks", &other.to_string(), "tmp-a"),
        ]),
        "relation cycle",
    )
    .await;
    // Cycle through the existing hierarchy: nested is already a child of the source Task.
    check(
        base(vec![link("tmp-l", "parent", &nested.to_string(), &task)]),
        "parent_cycle",
    )
    .await;
    // A valid mix of draft and existing links passes.
    let ok = a
        .validate(serde_json::Value::Array(base(vec![
            link("tmp-l1", "blocks", "tmp-a", "tmp-b"),
            link("tmp-l2", "related", "tmp-b", &other.to_string()),
            link("tmp-l3", "duplicate", &other.to_string(), "tmp-a"),
        ])))
        .await;
    assert_eq!(ok["valid"], true, "{ok}");
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_task_changed_after_the_run_started_makes_items_stale_until_refreshed_or_removed() {
    let f = fixture().await;
    let a = start_run(&f, "split").await;
    // The requester edits the source Task while the run is working.
    sqlx::query("UPDATE tasks SET title='Publish the Q3 report',version=version+1,updated_at=now() WHERE id=$1")
        .bind(a.task)
        .execute(&f.db)
        .await
        .unwrap();
    let (other, _) = make_task(&f, a.project, "Unrelated").await;
    let (id_s, other_s) = ("tmp-split".to_owned(), other.to_string());
    let id = completed_proposal_id(
        &a,
        &f,
        serde_json::json!({"schema_version":1,"items":[
            split_item(&id_s, a.project, "Collect Q3 numbers", a.task, a.task_version),
            link("tmp-keep", "related", &other_s, "tmp-split")],
            "assumptions":[],"open_questions":[]}),
    )
    .await;
    let proposal = get_proposal(&a, &f, &id).await;
    let stale: Vec<&str> = proposal["stale_items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap())
        .collect();
    // The split item, its back link and the link that depends on it are all stale.
    for expected in ["tmp-split", "tmp-link-tmp-split", "tmp-keep"] {
        assert!(stale.contains(&expected), "{expected} in {stale:?}");
    }
    let (status, blocked) = approve(&a, &f, &id, &proposal["revision"]).await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT, "{blocked}");
    assert_eq!(blocked["error"], "proposal_stale");
    assert!(blocked["stale_items"].as_array().unwrap().len() >= 3);
    let tasks: i64 = sqlx::query_scalar("SELECT count(*) FROM tasks WHERE project_id=$1")
        .bind(a.project)
        .fetch_one(&f.db)
        .await
        .unwrap();
    assert_eq!(tasks, 2, "a blocked Approve writes nothing");

    // Editing a stale draft is allowed, and unticking removes it from the Approve set.
    let mut items = proposal["items"].clone();
    items[0]["title"] = serde_json::json!("Collect the Q3 numbers");
    let (status, edited) = json_of(
        request(
            &a.client,
            reqwest::Method::PATCH,
            format!("{}/{id}", proposals_url(&f)),
            &f,
        )
        .json(&serde_json::json!({"expected_revision":proposal["revision"],"items":items}))
        .send()
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{edited}");
    assert!(!edited["stale_items"].as_array().unwrap().is_empty());

    // Refresh brings the recorded versions up to date and unblocks Approve.
    let (status, refreshed) = json_of(
        request(
            &a.client,
            reqwest::Method::POST,
            format!("{}/{id}/refresh", proposals_url(&f)),
            &f,
        )
        .json(&serde_json::json!({"expected_revision":edited["revision"]}))
        .send()
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{refreshed}");
    assert_eq!(refreshed["stale_items"], serde_json::json!([]));
    assert_eq!(refreshed["items"][0]["title"], "Collect the Q3 numbers");
    let (status, applied) = approve(&a, &f, &id, &refreshed["revision"]).await;
    assert_eq!(status, reqwest::StatusCode::OK, "{applied}");

    // A second Task change after Approve cannot be refreshed into an applied Proposal.
    let (status, _) = json_of(
        request(
            &a.client,
            reqwest::Method::POST,
            format!("{}/{id}/refresh", proposals_url(&f)),
            &f,
        )
        .json(&serde_json::json!({"expected_revision":refreshed["revision"]}))
        .send()
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT);
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn stale_items_can_be_removed_instead_of_refreshed() {
    let f = fixture().await;
    let a = start_run(&f, "split").await;
    let (other, other_version) = make_task(&f, a.project, "Other").await;
    sqlx::query("UPDATE tasks SET title='Changed',version=version+1,updated_at=now() WHERE id=$1")
        .bind(a.task)
        .execute(&f.db)
        .await
        .unwrap();
    let id = completed_proposal_id(
        &a,
        &f,
        serde_json::json!({"schema_version":1,"items":[
            split_item("tmp-stale", a.project, "Stale piece", a.task, a.task_version),
            split_item("tmp-fresh", a.project, "Fresh piece", other, other_version)],
            "assumptions":[],"open_questions":[]}),
    )
    .await;
    let proposal = get_proposal(&a, &f, &id).await;
    let (status, _) = approve(&a, &f, &id, &proposal["revision"]).await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT);
    let (status, off) = json_of(
        request(&a.client, reqwest::Method::PATCH, format!("{}/{id}", proposals_url(&f)), &f)
            .json(&serde_json::json!({"expected_revision":proposal["revision"],"items":proposal["items"],"toggle":{"item_id":"tmp-stale","selected":false}}))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{off}");
    let (status, applied) = approve(&a, &f, &id, &off["revision"]).await;
    assert_eq!(status, reqwest::StatusCode::OK, "{applied}");
    let titles: Vec<String> =
        sqlx::query_scalar("SELECT title FROM tasks WHERE title LIKE '% piece'")
            .fetch_all(&f.db)
            .await
            .unwrap();
    assert_eq!(titles, ["Fresh piece"]);
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_invented_version_is_rejected_not_treated_as_stale() {
    let f = fixture().await;
    let a = start_run(&f, "split").await;
    let body = a
        .validate(serde_json::json!([split_item(
            "tmp-x",
            a.project,
            "Piece",
            a.task,
            a.task_version + 7
        )]))
        .await;
    assert_eq!(body["valid"], false);
    // Behind the current version but the Task never changed after the run started.
    sqlx::query("UPDATE tasks SET version=version+1,updated_at=now()-interval '1 day' WHERE id=$1")
        .bind(a.task)
        .execute(&f.db)
        .await
        .unwrap();
    let body = a
        .validate(serde_json::json!([split_item(
            "tmp-x",
            a.project,
            "Piece",
            a.task,
            a.task_version
        )]))
        .await;
    assert_eq!(body["valid"], false, "{body}");
    cleanup(f).await;
}
