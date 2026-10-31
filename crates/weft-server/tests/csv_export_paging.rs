use sha2::{Digest, Sha256};
use std::{env, net::SocketAddr, time::Duration};
use uuid::Uuid;
use weft_server::{serve, ServerConfig};

struct Session {
    _user_id: Uuid,
    cookie: String,
    csrf: String,
}

async fn setup() -> (
    String,
    tokio::task::JoinHandle<()>,
    String,
    sqlx::PgPool,
    Uuid,
    Session,
    Session,
) {
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!("csvx_{}_{}", std::process::id(), Uuid::new_v4().simple());
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
    let member = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users(id,email,password_hash) VALUES($1,'member@example.com','unused')",
    )
    .bind(member)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'member')",
    )
    .bind(workspace)
    .bind(member)
    .execute(&pool)
    .await
    .unwrap();
    let owner = session(&pool, owner).await;
    let member = session(&pool, member).await;
    (origin, server, schema, admin, workspace, owner, member)
}

async fn session(pool: &sqlx::PgPool, user: Uuid) -> Session {
    let token = Uuid::new_v4().to_string();
    let csrf = Uuid::new_v4().to_string();
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')").bind(Uuid::new_v4()).bind(user).bind(hash).bind(&csrf).execute(pool).await.unwrap();
    Session {
        _user_id: user,
        cookie: format!("weft_session={token}; weft_csrf={csrf}"),
        csrf,
    }
}

fn request(
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

use serde_json::{json, Value};

/// Every test in this binary uses the same limits: a 3 row ceiling and pages of 2 rows.
fn limits() {
    std::env::set_var("WEFT_EXPORT_ROW_CEILING", "3");
    std::env::set_var("WEFT_EXPORT_BATCH", "2");
}

struct Fx {
    origin: String,
    workspace: Uuid,
    client: reqwest::Client,
}

impl Fx {
    async fn post(&self, who: &Session, path: &str, body: Value) -> reqwest::Response {
        request(
            &self.client,
            reqwest::Method::POST,
            format!("{}/api/v1/workspaces/{}{path}", self.origin, self.workspace),
            who,
        )
        .json(&body)
        .send()
        .await
        .unwrap()
    }

    async fn project(&self, who: &Session, name: &str, visibility: &str) -> String {
        let project: Value = self
            .post(
                who,
                "/projects",
                json!({"name":name,"visibility":visibility}),
            )
            .await
            .json()
            .await
            .unwrap();
        project["id"].as_str().unwrap().to_owned()
    }

    async fn task(&self, who: &Session, project: &str, title: &str) {
        let response = self
            .post(who, "/tasks", json!({"project_id":project,"title":title}))
            .await;
        assert!(response.status().is_success());
    }

    async fn sorted_list(&self, who: &Session) -> String {
        let list: Value = self
            .post(
                who,
                "/lists",
                json!({"name":"By title","kind":"smart","query":{"logic":"and","filters":[],"sort":[{"field":"title","direction":"asc"}],"columns":["title"]}}),
            )
            .await
            .json()
            .await
            .unwrap();
        list["id"].as_str().unwrap().to_owned()
    }
}

fn titles(text: &str) -> Vec<String> {
    text.lines()
        .skip(1)
        .filter(|line| !line.contains("not a backup"))
        .map(|line| line.split(',').nth(1).unwrap().to_owned())
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn paging_crosses_pages_and_a_gap_of_unreadable_rows() {
    limits();
    let (origin, server, schema, admin, workspace, owner, member) = setup().await;
    let fx = Fx {
        origin,
        workspace,
        client: reqwest::Client::new(),
    };
    let open = fx.project(&owner, "Open", "workspace").await;
    let secret = fx.project(&owner, "Secret", "restricted").await;
    // Pages of 2 rows: [open1, secret], [secret, secret], [open2, open3].
    fx.task(&owner, &open, "open1").await;
    for n in 0..3 {
        fx.task(&owner, &secret, &format!("secret{n}")).await;
    }
    fx.task(&owner, &open, "open2").await;
    fx.task(&owner, &open, "open3").await;
    let response = fx.post(&member, "/tasks/export.csv", json!({})).await;
    assert_eq!(response.headers()["x-weft-export-truncated"], "false");
    let text = response.text().await.unwrap();
    assert_eq!(titles(&text), ["open1", "open2", "open3"]);
    assert!(!text.contains("secret"));
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sorted_view_over_the_ceiling_exports_the_head_of_its_sort() {
    limits();
    let (origin, server, schema, admin, workspace, owner, _member) = setup().await;
    let fx = Fx {
        origin,
        workspace,
        client: reqwest::Client::new(),
    };
    let project = fx.project(&owner, "P", "workspace").await;
    for title in ["e", "d", "c", "b", "a"] {
        fx.task(&owner, &project, title).await;
    }
    let list = fx.sorted_list(&owner).await;
    let response = fx
        .post(&owner, "/tasks/export.csv", json!({"list_id":list}))
        .await;
    assert_eq!(response.headers()["x-weft-export-truncated"], "true");
    let notice = response.headers()["x-weft-export-notice"]
        .to_str()
        .unwrap()
        .to_owned();
    assert!(notice.contains("head of the view's sort"), "{notice}");
    assert_eq!(titles(&response.text().await.unwrap()), ["a", "b", "c"]);
    // Without a sort the notice says the rows are the first by Task number.
    let response = fx.post(&owner, "/tasks/export.csv", json!({})).await;
    let notice = response.headers()["x-weft-export-notice"]
        .to_str()
        .unwrap()
        .to_owned();
    assert!(notice.contains("first by Task number"), "{notice}");
    assert_eq!(titles(&response.text().await.unwrap()), ["e", "d", "c"]);
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_scan_that_hits_its_cap_says_so() {
    limits();
    let (origin, server, schema, admin, workspace, owner, _member) = setup().await;
    let fx = Fx {
        origin,
        workspace,
        client: reqwest::Client::new(),
    };
    let project = fx.project(&owner, "P", "workspace").await;
    // The cap is 50 times the ceiling: 150 Tasks scanned, the 151st left out.
    for n in 0..151 {
        fx.task(&owner, &project, &format!("t{n:03}")).await;
    }
    let list = fx.sorted_list(&owner).await;
    let response = fx
        .post(&owner, "/tasks/export.csv", json!({"list_id":list}))
        .await;
    assert_eq!(response.headers()["x-weft-export-truncated"], "true");
    assert_eq!(response.headers()["x-weft-export-rows"], "3");
    let notice = response.headers()["x-weft-export-notice"]
        .to_str()
        .unwrap()
        .to_owned();
    assert!(notice.contains("scanning 150 Tasks"), "{notice}");
    cleanup(server, schema, admin).await;
}
