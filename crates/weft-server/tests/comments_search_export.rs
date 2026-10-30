use sha2::{Digest, Sha256};
use std::{env, net::SocketAddr, time::Duration};
use uuid::Uuid;
use weft_server::{serve, ServerConfig};

struct Session {
    cookie: String,
    csrf: String,
    user_id: Uuid,
}

async fn setup() -> (
    String,
    tokio::task::JoinHandle<()>,
    String,
    sqlx::PgPool,
    sqlx::PgPool,
    Uuid,
    Session,
    Session,
) {
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!("collab_{}_{}", std::process::id(), Uuid::new_v4().simple());
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
        if let Err(error) = serve(listener, ServerConfig::new(server_db, root)).await {
            eprintln!("test server exited: {error}");
        }
    });
    let origin = format!("http://{address}");
    let client = reqwest::Client::new();
    let mut ready = false;
    for _ in 0..3000 {
        if client
            .get(format!("{origin}/health/ready"))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
        {
            ready = true;
            break;
        }
        if server.is_finished() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(ready, "test server failed to become ready");
    let pool = sqlx::PgPool::connect(&scoped).await.unwrap();
    weft_server::bootstrap_admin(
        &pool,
        "owner@example.com",
        "secret password",
        "Test Workspace",
    )
    .await
    .unwrap();
    let (workspace, owner): (Uuid, Uuid) = sqlx::query_as("SELECT w.id,m.user_id FROM workspaces w JOIN workspace_memberships m ON m.workspace_id=w.id WHERE m.role='owner'").fetch_one(&pool).await.unwrap();
    let member = add_user(&pool, workspace, "member@example.com", "member").await;
    (
        origin,
        server,
        schema,
        admin,
        pool.clone(),
        workspace,
        session(&pool, owner).await,
        session(&pool, member).await,
    )
}

async fn add_user(pool: &sqlx::PgPool, workspace: Uuid, email: &str, role: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'unused')")
        .bind(id)
        .bind(email)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,$3)")
        .bind(workspace)
        .bind(id)
        .bind(role)
        .execute(pool)
        .await
        .unwrap();
    id
}
async fn session(pool: &sqlx::PgPool, user: Uuid) -> Session {
    let id = Uuid::new_v4();
    let token = Uuid::new_v4().to_string();
    let csrf = Uuid::new_v4().to_string();
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')").bind(id).bind(user).bind(hash).bind(&csrf).execute(pool).await.unwrap();
    Session {
        cookie: format!("weft_session={token}; weft_csrf={csrf}"),
        csrf,
        user_id: user,
    }
}
fn req(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: String,
    who: &Session,
) -> reqwest::RequestBuilder {
    client
        .request(method, url)
        .header(reqwest::header::COOKIE, &who.cookie)
        .header("x-csrf-token", &who.csrf)
}
async fn cleanup(server: tokio::task::JoinHandle<()>, schema: String, admin: sqlx::PgPool) {
    server.abort();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn comments_are_idempotent_editable_and_search_respects_restricted_projects() {
    let (origin, server, schema, admin, _db, workspace, owner, member) = setup().await;
    let client = reqwest::Client::new();
    let project: serde_json::Value = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/projects"),
        &member,
    )
    .json(&serde_json::json!({"name":"Private","visibility":"restricted"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let task: serde_json::Value = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks"),
        &member,
    )
    .json(&serde_json::json!({"project_id":project["id"],"title":"ประเทศไทยเรื่อง","description":"Searchable description detail"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let task_id = task["id"].as_str().unwrap();
    let attr:serde_json::Value=req(&client,reqwest::Method::POST,format!("{origin}/api/v1/workspaces/{workspace}/attributes"),&owner).json(&serde_json::json!({"name":"Thai marker","value_type":"text","project_ids":[project["id"]]})).send().await.unwrap().json().await.unwrap();
    let attr_write = req(
        &client,
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/tasks/{task_id}/attributes"),
        &member,
    )
    .json(&serde_json::json!({"values":[{"attribute_id":attr["id"],"value":"ค่าเฉพาะ"}]}))
    .send()
    .await
    .unwrap();
    assert_eq!(attr_write.status(), reqwest::StatusCode::OK);
    let uploaded = req(&client, reqwest::Method::POST, format!("{origin}/api/v1/tasks/{task_id}/attachments"), &member)
        .json(&serde_json::json!({"file_name":"proof.bin","content_type":"application/octet-stream","content_hex":"0001ff"}))
        .send().await.unwrap();
    assert_eq!(uploaded.status(), reqwest::StatusCode::CREATED);
    let command = Uuid::new_v4();
    let comment_url = format!("{origin}/api/v1/tasks/{task_id}/comments");
    let first = req(&client, reqwest::Method::POST, comment_url.clone(), &member)
        .json(&serde_json::json!({"request_id":command,"body":"สวัสดีประเทศไทย"}))
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), reqwest::StatusCode::CREATED);
    let comment: serde_json::Value = first.json().await.unwrap();
    assert!(comment["html"]
        .as_str()
        .unwrap()
        .contains("<p>สวัสดีประเทศไทย</p>"));
    let comment_id = comment["id"].as_str().unwrap();
    let retry = req(&client, reqwest::Method::POST, comment_url.clone(), &member)
        .json(&serde_json::json!({"request_id":command,"body":"สวัสดีประเทศไทย"}))
        .send()
        .await
        .unwrap();
    assert_eq!(retry.status(), reqwest::StatusCode::OK);
    assert_eq!(
        retry.json::<serde_json::Value>().await.unwrap()["id"],
        comment["id"]
    );
    let edited = req(
        &client,
        reqwest::Method::PATCH,
        format!("{comment_url}/{comment_id}"),
        &member,
    )
    .json(&serde_json::json!({"body":"แก้ไขแล้ว"}))
    .send()
    .await
    .unwrap();
    let edited_status = edited.status();
    let edited_body = edited.text().await.unwrap();
    assert_eq!(edited_status, reqwest::StatusCode::OK, "{edited_body}");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&edited_body).unwrap()["edited"],
        true
    );
    let search_url = format!("{origin}/api/v1/workspaces/{workspace}/search?q=ไทย&page=1&limit=10");
    let visible = req(&client, reqwest::Method::GET, search_url.clone(), &member)
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    assert!(visible["results"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["task_number"] == task["number"]));
    let exact_thai_title: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/search?q=ประเทศไทยเรื่อง"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(exact_thai_title["count"], 1);
    let exact = req(
        &client,
        reqwest::Method::GET,
        format!(
            "{origin}/api/v1/workspaces/{workspace}/search?q={}",
            task["number"]
        ),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json::<serde_json::Value>()
    .await
    .unwrap();
    assert_eq!(exact["count"], 1);
    let attribute = req(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/search?q=ค่าเฉพาะ"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json::<serde_json::Value>()
    .await
    .unwrap();
    assert_eq!(attribute["count"], 1);
    let description_search: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/search?q=description%20detail"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(description_search["count"], 1);
    assert!(description_search["results"][0]["snippet"]
        .as_str()
        .unwrap()
        .contains("Searchable description detail"));
    let comment_search: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/search?q=แก้ไขแล้ว"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(comment_search["count"], 1);
    assert!(comment_search["results"][0]["snippet"]
        .as_str()
        .unwrap()
        .contains("แก้ไขแล้ว"));

    let second_task: serde_json::Value = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks"),
        &member,
    )
    .json(&serde_json::json!({"project_id":project["id"],"title":"Another discussion"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    req(
        &client,
        reqwest::Method::POST,
        format!(
            "{origin}/api/v1/tasks/{}/comments",
            second_task["id"].as_str().unwrap()
        ),
        &member,
    )
    .json(&serde_json::json!({"request_id":Uuid::new_v4(),"body":"แก้ไขแล้ว"}))
    .send()
    .await
    .unwrap();
    let first_page: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/search?q=แก้ไขแล้ว&limit=1"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(first_page["results"].as_array().unwrap().len(), 1);
    let cursor = first_page["next_cursor"]
        .as_str()
        .unwrap_or_else(|| panic!("more search results have a cursor: {first_page}"));
    let next_page: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/search?q=แก้ไขแล้ว&limit=1&cursor={cursor}"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(next_page["results"].as_array().unwrap().len(), 1);
    assert_ne!(
        first_page["results"][0]["task_id"],
        next_page["results"][0]["task_id"]
    );
    let hidden = req(&client, reqwest::Method::GET, search_url, &owner)
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    assert_eq!(hidden["count"], 0);
    assert!(hidden["results"].as_array().unwrap().is_empty());
    let too_complex = req(
        &client,
        reqwest::Method::GET,
        format!(
            "{origin}/api/v1/workspaces/{workspace}/search?q={}",
            "ก".repeat(101)
        ),
        &member,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(
        too_complex.status(),
        reqwest::StatusCode::UNPROCESSABLE_ENTITY
    );
    let too_many_terms = req(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/search?q=one%20two%20three%20four%20five%20six%20seven%20eight%20nine"),
        &member,
    ).send().await.unwrap();
    assert_eq!(
        too_many_terms.status(),
        reqwest::StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        too_many_terms.json::<serde_json::Value>().await.unwrap()["error"]["code"],
        "search_too_many_terms"
    );
    // Export only holds Projects the exporting admin can read, so open the Project first.
    let opened = req(
        &client,
        reqwest::Method::PATCH,
        format!(
            "{origin}/api/v1/projects/{}",
            project["id"].as_str().unwrap()
        ),
        &member,
    )
    .json(&serde_json::json!({"visibility":"workspace"}))
    .send()
    .await
    .unwrap();
    assert_eq!(opened.status(), reqwest::StatusCode::OK);
    let denied = req(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/export"),
        &member,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(denied.status(), reqwest::StatusCode::FORBIDDEN);
    let exported: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/export"),
        &owner,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(exported["schema_version"], "1.0");
    assert_eq!(exported["tasks"][0]["title"], "ประเทศไทยเรื่อง");
    assert_eq!(exported["comments"][0]["body"], "แก้ไขแล้ว");
    assert_eq!(exported["attachments"][0]["content_hex"], "0001ff");
    let denied_delete = req(
        &client,
        reqwest::Method::DELETE,
        format!("{comment_url}/{comment_id}"),
        &owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(denied_delete.status(), reqwest::StatusCode::NOT_FOUND);
    let deleted = req(
        &client,
        reqwest::Method::DELETE,
        format!("{comment_url}/{comment_id}"),
        &member,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(deleted.status(), reqwest::StatusCode::NO_CONTENT);
    let after_delete = req(&client, reqwest::Method::GET, comment_url, &member)
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    assert!(after_delete["comments"].as_array().unwrap().is_empty());
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn creating_a_task_from_a_comment_links_both_sides_and_undoes_as_one_operation() {
    let (origin, server, schema, admin, db, workspace, _owner, member) = setup().await;
    let client = reqwest::Client::new();
    let project: serde_json::Value = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/projects"),
        &member,
    )
    .json(&serde_json::json!({"name":"Work","visibility":"restricted"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let source: serde_json::Value = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks"),
        &member,
    )
    .json(&serde_json::json!({"project_id":project["id"],"title":"Source"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let body =
        "Turn this into work\n\nKeep the decision and see #1; @member@example.com is involved.";
    let comment: serde_json::Value = req(
        &client,
        reqwest::Method::POST,
        format!(
            "{origin}/api/v1/tasks/{}/comments",
            source["id"].as_str().unwrap()
        ),
        &member,
    )
    .json(&serde_json::json!({"request_id":Uuid::new_v4(),"body":body}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(comment["mentions"], serde_json::json!([member.user_id]));
    let url = format!(
        "{origin}/api/v1/tasks/{}/comments/{}/create-task",
        source["id"].as_str().unwrap(),
        comment["id"].as_str().unwrap()
    );
    let created = req(&client, reqwest::Method::POST, url.clone(), &member)
        .json(&serde_json::json!({"project_id":project["id"],"title":"Decision task","description":body}))
        .send().await.unwrap();
    let created_status = created.status();
    let created_body = created.text().await.unwrap();
    assert_eq!(
        created_status,
        reqwest::StatusCode::CREATED,
        "{created_body}"
    );
    let created: serde_json::Value = serde_json::from_str(&created_body).unwrap();
    assert_eq!(created["title"], "Decision task");
    assert_eq!(created["description"], body);
    assert_eq!(created["created_from"]["comment_id"], comment["id"]);
    assert_eq!(created["mentions"], serde_json::json!([member.user_id]));
    let history: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!(
            "{origin}/api/v1/tasks/{}/history",
            created["id"].as_str().unwrap()
        ),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(history["operations"].as_array().unwrap().len(), 1);
    let backlinks: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!(
            "{origin}/api/v1/tasks/{}/references",
            source["id"].as_str().unwrap()
        ),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert!(backlinks["references"]
        .as_array()
        .unwrap()
        .iter()
        .any(|reference| reference["task_number"] == created["number"]));
    let comments: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!(
            "{origin}/api/v1/tasks/{}/comments",
            source["id"].as_str().unwrap()
        ),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(
        comments["comments"][0]["created_tasks"][0]["id"], created["id"],
        "{comments}"
    );
    let target_project: serde_json::Value = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/projects"),
        &member,
    )
    .json(&serde_json::json!({"name":"Separate work","visibility":"restricted"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let source_reader_id = add_user(&db, workspace, "source-reader@example.com", "member").await;
    let target_reader_id = add_user(&db, workspace, "target-reader@example.com", "member").await;
    sqlx::query("INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2,$3,'viewer'),($1,$4,$5,'viewer')")
        .bind(workspace).bind(uuid::Uuid::parse_str(project["id"].as_str().unwrap()).unwrap()).bind(source_reader_id)
        .bind(uuid::Uuid::parse_str(target_project["id"].as_str().unwrap()).unwrap()).bind(target_reader_id)
        .execute(&db).await.unwrap();
    let source_reader = session(&db, source_reader_id).await;
    let target_reader = session(&db, target_reader_id).await;
    let cross_project = req(&client, reqwest::Method::POST, url.clone(), &member)
        .json(&serde_json::json!({"project_id":target_project["id"],"title":"Separate task","description":body}))
        .send().await.unwrap();
    assert_eq!(cross_project.status(), reqwest::StatusCode::CREATED);
    let cross_project: serde_json::Value = cross_project.json().await.unwrap();
    assert!(!cross_project["created_from"].is_null());
    let target_task: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!(
            "{origin}/api/v1/workspaces/{workspace}/tasks/{}",
            cross_project["number"]
        ),
        &target_reader,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert!(
        target_task["created_from"].is_null(),
        "a Task reader without source access cannot learn the comment link"
    );
    let source_view: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!(
            "{origin}/api/v1/tasks/{}/comments",
            source["id"].as_str().unwrap()
        ),
        &source_reader,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let visible_links = source_view["comments"][0]["created_tasks"]
        .as_array()
        .unwrap();
    assert_eq!(visible_links.len(), 1);
    assert_eq!(visible_links[0]["id"], created["id"]);
    let undo = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/history/undo"),
        &member,
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap();
    assert_eq!(undo.status(), reqwest::StatusCode::OK);
    let undo = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/history/undo"),
        &member,
    )
    .json(&serde_json::json!({}))
    .send()
    .await
    .unwrap();
    assert_eq!(undo.status(), reqwest::StatusCode::OK);
    let comments: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!(
            "{origin}/api/v1/tasks/{}/comments",
            source["id"].as_str().unwrap()
        ),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert!(comments["comments"][0]["created_tasks"]
        .as_array()
        .unwrap()
        .is_empty());
    let outsider_id = add_user(&db, workspace, "outsider@example.com", "member").await;
    let outsider = session(&db, outsider_id).await;
    assert_eq!(
        req(&client, reqwest::Method::POST, url, &outsider)
            .json(
                &serde_json::json!({"project_id":project["id"],"title":"leak","description":body})
            )
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::NOT_FOUND
    );
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn comment_attachments_are_acl_checked_and_never_trust_hostile_documents() {
    let (origin, server, schema, admin, db, workspace, owner, member) = setup().await;
    let client = reqwest::Client::new();
    let project: serde_json::Value = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/projects"),
        &owner,
    )
    .json(&serde_json::json!({"name":"Private attachments","visibility":"restricted"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let project_id: Uuid = project["id"].as_str().unwrap().parse().unwrap();
    let task: serde_json::Value = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks"),
        &owner,
    )
    .json(&serde_json::json!({"project_id":project_id,"title":"Attachment access"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let task_id = task["id"].as_str().unwrap();
    let comment: serde_json::Value = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/tasks/{task_id}/comments"),
        &owner,
    )
    .json(&serde_json::json!({"request_id":Uuid::new_v4(),"body":"Evidence"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let comment_id = comment["id"].as_str().unwrap();
    let hidden = req(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/tasks/{task_id}/comments"),
        &member,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(hidden.status(), reqwest::StatusCode::NOT_FOUND);
    assert!(hidden.text().await.unwrap().is_empty());
    sqlx::query("INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2,$3,'viewer')")
        .bind(workspace).bind(project_id).bind(member.user_id).execute(&db).await.unwrap();
    let upload_url = format!("{origin}/api/v1/tasks/{task_id}/comments/{comment_id}/attachments");
    let uploaded = req(&client, reqwest::Method::POST, upload_url.clone(), &owner)
        .json(&serde_json::json!({"file_name":"<img onerror=alert(1)>.svg","content_type":"image/svg+xml","content_hex":"3c7376673e3c7363726970743e616c6572742831293c2f7363726970743e3c2f7376673e"}))
        .send().await.unwrap();
    assert_eq!(uploaded.status(), reqwest::StatusCode::CREATED);
    let attachment: serde_json::Value = uploaded.json().await.unwrap();
    assert_eq!(attachment["file_name"], "<img onerror=alert(1)>.svg");
    let storage_key = attachment["storage_key"]
        .as_str()
        .expect("opaque storage key");
    assert_ne!(storage_key, attachment["file_name"]);

    let comments: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/tasks/{task_id}/comments"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(
        comments["comments"][0]["attachments"][0]["file_name"],
        attachment["file_name"]
    );
    let download_url = format!("{origin}/api/v1/attachments/{storage_key}");
    let preview = req(
        &client,
        reqwest::Method::GET,
        format!("{download_url}?preview=true"),
        &member,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(
        preview.status(),
        reqwest::StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    let download = req(&client, reqwest::Method::GET, download_url.clone(), &member)
        .send()
        .await
        .unwrap();
    assert_eq!(download.status(), reqwest::StatusCode::OK);
    assert_eq!(
        download.headers()[reqwest::header::X_CONTENT_TYPE_OPTIONS],
        "nosniff"
    );
    assert_eq!(
        download.headers()[reqwest::header::CONTENT_TYPE],
        "application/octet-stream"
    );
    assert!(download.headers()[reqwest::header::CONTENT_DISPOSITION]
        .to_str()
        .unwrap()
        .starts_with("attachment;"));

    let pdf: serde_json::Value = req(&client, reqwest::Method::POST, upload_url.clone(), &owner)
        .json(&serde_json::json!({"file_name":"preview.pdf","content_type":"application/pdf","content_hex":"255044462d312e37"}))
        .send().await.unwrap().json().await.unwrap();
    let pdf_preview = req(
        &client,
        reqwest::Method::GET,
        format!(
            "{origin}/api/v1/attachments/{}?preview=true",
            pdf["storage_key"].as_str().unwrap()
        ),
        &member,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(pdf_preview.status(), reqwest::StatusCode::OK);
    assert_eq!(
        pdf_preview.headers()[reqwest::header::CONTENT_TYPE],
        "application/pdf"
    );
    assert_eq!(
        pdf_preview.headers()[reqwest::header::CONTENT_DISPOSITION],
        "inline"
    );

    sqlx::query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2")
        .bind(project_id)
        .bind(member.user_id)
        .execute(&db)
        .await
        .unwrap();
    let revoked = req(&client, reqwest::Method::GET, download_url, &member)
        .send()
        .await
        .unwrap();
    assert_eq!(revoked.status(), reqwest::StatusCode::NOT_FOUND);
    assert!(revoked.text().await.unwrap().is_empty());
    let too_large = "00".repeat(10 * 1024 * 1024 + 1);
    let oversize = req(&client, reqwest::Method::POST, upload_url, &owner)
        .json(&serde_json::json!({"file_name":"too-big.png","content_type":"image/png","content_hex":too_large}))
        .send().await.unwrap();
    assert_eq!(oversize.status(), reqwest::StatusCode::UNPROCESSABLE_ENTITY);

    req(
        &client,
        reqwest::Method::DELETE,
        format!("{origin}/api/v1/tasks/{task_id}/comments/{comment_id}"),
        &owner,
    )
    .send()
    .await
    .unwrap();
    let deleted = req(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/attachments/{storage_key}"),
        &owner,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(deleted.status(), reqwest::StatusCode::NOT_FOUND);
    let export: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/export"),
        &owner,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert!(export["comments"][0]["deleted_at"].is_string());
    assert!(export["attachments"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["storage_key"] == storage_key && item["comment_id"] == comment_id));
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn readable_task_references_create_filtered_backlinks_and_update_on_edit() {
    let (origin, server, schema, admin, db, workspace, owner, member) = setup().await;
    let client = reqwest::Client::new();
    let project: serde_json::Value = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/projects"),
        &member,
    )
    .json(&serde_json::json!({"name":"Shared","visibility":"workspace"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let source: serde_json::Value = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks"),
        &member,
    )
    .json(&serde_json::json!({"project_id":project["id"],"title":"Source"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let target: serde_json::Value = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks"),
        &member,
    )
    .json(&serde_json::json!({"project_id":project["id"],"title":"Target"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let hidden_project: serde_json::Value = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/projects"),
        &owner,
    )
    .json(&serde_json::json!({"name":"Restricted","visibility":"restricted"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let hidden: serde_json::Value = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks"),
        &owner,
    )
    .json(&serde_json::json!({"project_id":hidden_project["id"],"title":"Secret"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let source_id = source["id"].as_str().unwrap();
    let target_id = target["id"].as_str().unwrap();
    let number = target["number"].as_i64().unwrap();
    let comment: serde_json::Value = req(&client, reqwest::Method::POST, format!("{origin}/api/v1/tasks/{source_id}/comments"), &member)
        .json(&serde_json::json!({"request_id":Uuid::new_v4(),"body":format!("See #{number}, #{number}, `#{number}`, and #{}; pasted /w/{workspace}/tasks/{number}", hidden["number"])}))
        .send().await.unwrap().json().await.unwrap();
    assert!(comment["html"]
        .as_str()
        .unwrap()
        .contains("data-task-reference=\"true\""));
    assert_eq!(
        comment["html"]
            .as_str()
            .unwrap()
            .matches("data-task-reference=\"true\"")
            .count(),
        3
    );
    assert!(!comment["html"].as_str().unwrap().contains(">pasted /w/"));
    assert!(comment["html"].as_str().unwrap().contains("Target"));
    assert!(!comment["html"].as_str().unwrap().contains("Secret"));
    let backlinks: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/tasks/{target_id}/references"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(backlinks["references"].as_array().unwrap().len(), 1);
    assert_eq!(backlinks["references"][0]["comment_id"], comment["id"]);
    let hidden_id = hidden["id"].as_str().unwrap();
    let hidden_backlinks = req(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/tasks/{hidden_id}/references"),
        &member,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(hidden_backlinks.status(), reqwest::StatusCode::NOT_FOUND);
    let member_id = member.user_id;
    let hidden_project_id: Uuid = hidden_project["id"].as_str().unwrap().parse().unwrap();
    sqlx::query("INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2,$3,'viewer')")
        .bind(workspace)
        .bind(hidden_project_id)
        .bind(member_id)
        .execute(&db)
        .await
        .unwrap();
    let restricted_comment: serde_json::Value = req(&client, reqwest::Method::POST, format!("{origin}/api/v1/tasks/{source_id}/comments"), &member)
        .json(&serde_json::json!({"request_id":Uuid::new_v4(),"body":format!("Granted reference #{}", hidden["number"])}))
        .send().await.unwrap().json().await.unwrap();
    assert!(restricted_comment["html"]
        .as_str()
        .unwrap()
        .contains("Secret"));
    sqlx::query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2")
        .bind(hidden_project_id)
        .bind(member_id)
        .execute(&db)
        .await
        .unwrap();
    let comments_after_revocation: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/tasks/{source_id}/comments"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let revoked_comment = comments_after_revocation["comments"]
        .as_array()
        .unwrap()
        .iter()
        .find(|comment| comment["id"] == restricted_comment["id"])
        .unwrap();
    assert!(!revoked_comment["html"].as_str().unwrap().contains("Secret"));
    assert!(!revoked_comment["html"]
        .as_str()
        .unwrap()
        .contains("data-task-reference=\"true\""));
    let comment_id = comment["id"].as_str().unwrap();
    let edited = req(
        &client,
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/tasks/{source_id}/comments/{comment_id}"),
        &member,
    )
    .json(&serde_json::json!({"body":"No reference now"}))
    .send()
    .await
    .unwrap();
    let edited_status = edited.status();
    let edited_body = edited.text().await.unwrap();
    assert_eq!(edited_status, reqwest::StatusCode::OK, "{edited_body}");
    let backlinks: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/tasks/{target_id}/references"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert!(backlinks["references"].as_array().unwrap().is_empty());
    let source_task: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!(
            "{origin}/api/v1/workspaces/{workspace}/tasks/{}",
            source["number"]
        ),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let changed = req(&client, reqwest::Method::PATCH, format!("{origin}/api/v1/tasks/{source_id}"), &member)
        .json(&serde_json::json!({"expected_version":source_task["version"],"description":format!("Description points to #{number}")}))
        .send().await.unwrap();
    assert_eq!(changed.status(), reqwest::StatusCode::OK);
    let backlinks: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/tasks/{target_id}/references"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(backlinks["references"].as_array().unwrap().len(), 1);
    assert_eq!(
        backlinks["references"][0]["source_kind"],
        "task_description"
    );
    let undone = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/history/undo"),
        &member,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(undone.status(), reqwest::StatusCode::OK);
    let backlinks: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/tasks/{target_id}/references"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert!(backlinks["references"].as_array().unwrap().is_empty());
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn mentions_replies_reactions_and_timeline_are_access_filtered() {
    let (origin, server, schema, admin, db, workspace, owner, member) = setup().await;
    let hidden = add_user(&db, workspace, "hidden@example.com", "member").await;
    let hidden_session = session(&db, hidden).await;
    let team_id = Uuid::new_v4();
    sqlx::query("INSERT INTO teams(id,workspace_id,name) VALUES($1,$2,'Blue')")
        .bind(team_id)
        .bind(workspace)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO team_memberships(workspace_id,team_id,user_id) VALUES($1,$2,$3)")
        .bind(workspace)
        .bind(team_id)
        .bind(member.user_id)
        .execute(&db)
        .await
        .unwrap();
    let client = reqwest::Client::new();
    let project: serde_json::Value = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/projects"),
        &member,
    )
    .json(&serde_json::json!({"name":"Private discussion","visibility":"restricted"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let task: serde_json::Value = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks"),
        &member,
    )
    .json(&serde_json::json!({"project_id":project["id"],"title":"Private task"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let task_id = task["id"].as_str().unwrap();
    sqlx::query("INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2,$3,'viewer')")
        .bind(workspace)
        .bind(Uuid::parse_str(project["id"].as_str().unwrap()).unwrap())
        .bind(owner.user_id)
        .execute(&db)
        .await
        .unwrap();
    let suggestions = req(
        &client,
        reqwest::Method::GET,
        format!(
            "{origin}/api/v1/workspaces/{workspace}/mention-suggestions?q=hidden&task_id={task_id}"
        ),
        &member,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(suggestions.status(), reqwest::StatusCode::OK);
    assert!(
        suggestions.json::<serde_json::Value>().await.unwrap()["results"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let visible_suggestions: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!(
            "{origin}/api/v1/workspaces/{workspace}/mention-suggestions?q=member&task_id={task_id}"
        ),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert!(visible_suggestions["results"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["id"] == serde_json::json!(member.user_id)));
    let parent: serde_json::Value = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/tasks/{task_id}/comments"),
        &member,
    )
    .json(&serde_json::json!({"request_id":Uuid::new_v4(),"body":"Hello @hidden@example.com @member@example.com @team:blue"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(
        parent["mentions"].as_array().unwrap(),
        &[serde_json::json!(member.user_id)]
    );
    let stored_mentions: i64 =
        sqlx::query_scalar("SELECT count(*) FROM task_comment_mentions WHERE comment_id=$1")
            .bind(Uuid::parse_str(parent["id"].as_str().unwrap()).unwrap())
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(
        stored_mentions, 1,
        "the Team mention resolves only its current readable member"
    );
    sqlx::query("INSERT INTO team_memberships(workspace_id,team_id,user_id) VALUES($1,$2,$3)")
        .bind(workspace)
        .bind(team_id)
        .bind(owner.user_id)
        .execute(&db)
        .await
        .unwrap();
    let posted_mentions: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/tasks/{task_id}/comments"),
        &owner,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(
        posted_mentions["comments"][0]["mentions"]
            .as_array()
            .unwrap(),
        &[serde_json::json!(member.user_id)]
    );
    let reply: serde_json::Value = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/tasks/{task_id}/comments"),
        &member,
    )
    .json(&serde_json::json!({"request_id":Uuid::new_v4(),"body":"Reply","reply_to":parent["id"]}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(reply["reply_to"], parent["id"]);
    let comment_id = parent["id"].as_str().unwrap();
    let reacted = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/tasks/{task_id}/comments/{comment_id}/reactions"),
        &member,
    )
    .json(&serde_json::json!({"emoji":"👍"}))
    .send()
    .await
    .unwrap();
    assert_eq!(reacted.status(), reqwest::StatusCode::OK);
    let comments: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/tasks/{task_id}/comments"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(comments["comments"][0]["reactions"][0]["count"], 1);
    let removed = req(
        &client,
        reqwest::Method::DELETE,
        format!(
            "{origin}/api/v1/tasks/{task_id}/comments/{comment_id}/reactions?emoji=%F0%9F%91%8D"
        ),
        &member,
    )
    .send()
    .await
    .unwrap();
    assert_eq!(removed.status(), reqwest::StatusCode::NO_CONTENT);
    assert_eq!(
        req(
            &client,
            reqwest::Method::GET,
            format!("{origin}/api/v1/tasks/{task_id}/comments"),
            &hidden_session
        )
        .send()
        .await
        .unwrap()
        .status(),
        reqwest::StatusCode::NOT_FOUND
    );
    let timeline: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/tasks/{task_id}/activity?filter=discussion"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(timeline["items"].as_array().unwrap().len(), 2);
    let _ = owner;
    cleanup(server, schema, admin).await;
}
