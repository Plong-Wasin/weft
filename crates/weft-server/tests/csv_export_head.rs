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
    let schema = format!("csvs_{}_{}", std::process::id(), Uuid::new_v4().simple());
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

async fn post(
    client: &reqwest::Client,
    url: String,
    who: &Session,
    body: serde_json::Value,
) -> serde_json::Value {
    let response = request(client, reqwest::Method::POST, url, who)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success(), "{}", response.status());
    response.json().await.unwrap()
}

fn exported_titles(text: &str) -> Vec<String> {
    let lines: Vec<&str> = text.lines().collect();
    lines[1..lines.len() - 1]
        .iter()
        .map(|l| l.split(",").nth(1).unwrap().to_owned())
        .collect()
}

async fn get_json(client: &reqwest::Client, url: String, who: &Session) -> serde_json::Value {
    request(client, reqwest::Method::GET, url, who)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn sorted_export_over_many_batches_keeps_the_same_head_as_the_list() {
    std::env::set_var("WEFT_EXPORT_ROW_CEILING", "3");
    std::env::set_var("WEFT_EXPORT_BATCH", "2");
    let (origin, server, schema, admin, workspace, owner, _member) = setup().await;
    let client = reqwest::Client::new();
    let base = format!("{origin}/api/v1/workspaces/{workspace}");
    let project = post(
        &client,
        format!("{base}/projects"),
        &owner,
        serde_json::json!({"name":"P","visibility":"workspace"}),
    )
    .await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    // Titles sort against their numbers in a scrambled order across 5 batches of 2.
    for (n, title) in ["m", "c", "x", "a", "q", "b", "z", "d", "k"]
        .iter()
        .enumerate()
    {
        let _ = n;
        post(
            &client,
            format!("{base}/tasks"),
            &owner,
            serde_json::json!({"project_id":project,"title":title}),
        )
        .await;
    }
    for direction in ["asc", "desc"] {
        let query = serde_json::json!({"filters":[],"logic":"and","sort":[{"field":"title","direction":direction}],"group":null,"columns":["title"]});
        let list = post(
            &client,
            format!("{base}/lists"),
            &owner,
            serde_json::json!({"name":direction,"kind":"smart","query":query}),
        )
        .await;
        let list_id = list["id"].as_str().unwrap();
        let read = get_json(&client, format!("{base}/lists/{list_id}"), &owner).await;
        let expected: Vec<String> = read["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .take(3)
            .map(|t| t["title"].as_str().unwrap().to_owned())
            .collect();
        let want: Vec<&str> = if direction == "asc" {
            vec!["a", "b", "c"]
        } else {
            vec!["z", "x", "q"]
        };
        assert_eq!(expected, want);
        let response = request(
            &client,
            reqwest::Method::POST,
            format!("{base}/tasks/export.csv"),
            &owner,
        )
        .json(&serde_json::json!({"list_id":list_id}))
        .send()
        .await
        .unwrap();
        assert_eq!(response.headers()["x-weft-export-truncated"], "true");
        let text = response.text().await.unwrap();
        assert_eq!(exported_titles(&text), expected, "{direction}");
    }
    cleanup(server, schema, admin).await;
}
