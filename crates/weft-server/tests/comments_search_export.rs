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
    .json(&serde_json::json!({"project_id":project["id"],"title":"ประเทศไทยเรื่อง"}))
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
async fn note_references_respect_private_vault_access_and_render_neutral_text() {
    let (origin, server, schema, admin, db, workspace, owner, member) = setup().await;
    let client = reqwest::Client::new();
    let project: serde_json::Value = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/projects"),
        &owner,
    )
    .json(&serde_json::json!({"name":"Shared notes task","visibility":"workspace"}))
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
        &owner,
    )
    .json(&serde_json::json!({"project_id":project["id"],"title":"Reference private notes"}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let vault = Uuid::new_v4();
    sqlx::query("INSERT INTO vaults(id,workspace_id,name,visibility,repository_path,created_by) VALUES($1,$2,'Private Notes','restricted',$3,$4)")
        .bind(vault).bind(workspace).bind(format!("/tmp/{schema}-vault")).bind(owner.user_id)
        .execute(&db).await.unwrap();
    sqlx::query("INSERT INTO vault_user_memberships(workspace_id,vault_id,user_id,role) VALUES($1,$2,$3,'manager')")
        .bind(workspace).bind(vault).bind(owner.user_id).execute(&db).await.unwrap();
    sqlx::query("INSERT INTO vault_indexed_files(vault_id,path,text_content,title,search_text,parser_version) VALUES($1,'Runbooks/Guide.md','# Deployment Guide','Deployment Guide','Deployment Guide', 'comrak-0.59-index-1')")
        .bind(vault).execute(&db).await.unwrap();
    sqlx::query(
        "INSERT INTO vault_note_identities(id,vault_id,path) VALUES($1,$2,'Runbooks/Guide.md')",
    )
    .bind(Uuid::new_v4())
    .bind(vault)
    .execute(&db)
    .await
    .unwrap();
    sqlx::query("INSERT INTO vault_search_states(vault_id,status,parser_version) VALUES($1,'ready','comrak-0.59-index-1')")
        .bind(vault).execute(&db).await.unwrap();

    let task_before: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!(
            "{origin}/api/v1/workspaces/{workspace}/tasks/{}",
            task["number"]
        ),
        &owner,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let description_update = req(
        &client,
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/tasks/{}", task["id"].as_str().unwrap()),
        &owner,
    )
    .json(&serde_json::json!({"expected_version":task_before["version"],"description":"See [[Private Notes/Runbooks/Guide.md]]."}))
    .send()
    .await
    .unwrap();
    let description_update_status = description_update.status();
    let description_update_body = description_update.text().await.unwrap();
    assert_eq!(
        description_update_status,
        reqwest::StatusCode::OK,
        "{description_update_body}"
    );
    let member_task: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!(
            "{origin}/api/v1/workspaces/{workspace}/tasks/{}",
            task["number"]
        ),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(member_task["description"], "See [[note]].");
    assert!(member_task["description_html"]
        .as_str()
        .unwrap()
        .contains("See note."));
    assert!(!member_task["description_html"]
        .as_str()
        .unwrap()
        .contains("Private Notes"));
    assert!(!member_task.to_string().contains("data-note-reference"));

    let hidden_suggestions: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/knowledge/names?q=Guide"),
        &member,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert!(hidden_suggestions["results"].as_array().unwrap().is_empty());
    let readable_suggestions: serde_json::Value = req(
        &client,
        reqwest::Method::GET,
        format!("{origin}/api/v1/workspaces/{workspace}/knowledge/names?q=Guide"),
        &owner,
    )
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(
        readable_suggestions["results"][0]["path"],
        "Runbooks/Guide.md"
    );

    let source_id = task["id"].as_str().unwrap();
    let comment: serde_json::Value = req(&client, reqwest::Method::POST,
        format!("{origin}/api/v1/tasks/{source_id}/comments"), &owner)
        .json(&serde_json::json!({"request_id":Uuid::new_v4(),"body":"See [[Private Notes/Runbooks/Guide.md]]."}))
        .send().await.unwrap().json().await.unwrap();
    assert!(comment["html"]
        .as_str()
        .unwrap()
        .contains("Deployment Guide · Private Notes"));
    assert!(comment["html"]
        .as_str()
        .unwrap()
        .contains("data-note-reference=\"true\""));
    let member_comments: serde_json::Value = req(
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
    let html = member_comments["comments"][0]["html"].as_str().unwrap();
    assert!(html.contains("See note."));
    assert!(!member_comments.to_string().contains("data-note-reference"));
    assert!(!html.contains("Deployment Guide"));
    assert!(!html.contains("Private Notes"));
    assert_eq!(member_comments["comments"][0]["body"], "See [[note]].");
    let pasted_url_comment: serde_json::Value = req(
        &client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/tasks/{source_id}/comments"),
        &owner,
    )
    .json(&serde_json::json!({
        "request_id":Uuid::new_v4(),
        "body":format!("Pasted https://weft.example/api/v1/vaults/{vault}/notes?path=Runbooks%2fGuide.md")
    }))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert!(pasted_url_comment["html"]
        .as_str()
        .unwrap()
        .contains("Deployment Guide · Private Notes"));
    let member_after_paste: serde_json::Value = req(
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
    assert!(!member_after_paste.to_string().contains("Private Notes"));
    assert!(!member_after_paste.to_string().contains(&vault.to_string()));
    cleanup(server, schema, admin).await;
}
