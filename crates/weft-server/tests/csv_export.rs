use sha2::{Digest, Sha256};
use std::{env, net::SocketAddr, time::Duration};
use uuid::Uuid;
use weft_server::{serve, ServerConfig};

struct Session {
    user_id: Uuid,
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
        user_id: user,
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

async fn project(
    client: &reqwest::Client,
    origin: &str,
    workspace: Uuid,
    who: &Session,
    name: &str,
    visibility: &str,
) -> String {
    let value: serde_json::Value = request(
        client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/projects"),
        who,
    )
    .json(&serde_json::json!({"name":name,"visibility":visibility}))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    value["id"].as_str().unwrap().to_owned()
}

async fn task(
    client: &reqwest::Client,
    origin: &str,
    workspace: Uuid,
    who: &Session,
    project: &str,
    title: &str,
) -> serde_json::Value {
    let response = request(
        client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks"),
        who,
    )
    .json(&serde_json::json!({"project_id":project,"title":title}))
    .send()
    .await
    .unwrap();
    assert!(response.status().is_success(), "create {title:?}");
    response.json().await.unwrap()
}

async fn export(
    client: &reqwest::Client,
    origin: &str,
    workspace: Uuid,
    who: &Session,
    body: serde_json::Value,
) -> reqwest::Response {
    request(
        client,
        reqwest::Method::POST,
        format!("{origin}/api/v1/workspaces/{workspace}/tasks/export.csv"),
        who,
    )
    .json(&body)
    .send()
    .await
    .unwrap()
}

fn parse(text: &str) -> Vec<Vec<String>> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let (mut rows, mut row, mut cell, mut quoted) = (vec![], vec![], String::new(), false);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match (quoted, c) {
            (true, '"') if chars.peek() == Some(&'"') => {
                cell.push('"');
                chars.next();
            }
            (true, '"') => quoted = false,
            (false, '"') => quoted = true,
            (false, ',') => row.push(std::mem::take(&mut cell)),
            (false, '\r') => {}
            (false, '\n') => {
                row.push(std::mem::take(&mut cell));
                rows.push(std::mem::take(&mut row));
            }
            (_, c) => cell.push(c),
        }
    }
    rows
}

#[tokio::test(flavor = "multi_thread")]
async fn export_holds_only_what_the_exporter_reads_and_neutralises_hostile_cells() {
    let (origin, server, schema, admin, workspace, owner, member) = setup().await;
    let client = reqwest::Client::new();
    let open = project(&client, &origin, workspace, &owner, "Open", "workspace").await;
    let secret = project(
        &client,
        &origin,
        workspace,
        &owner,
        "Restricted",
        "restricted",
    )
    .await;
    let hostile = [
        "=HYPERLINK(\"http://evil\",\"x\")",
        "+1+1",
        "-2+3",
        "@SUM(A1)",
        "\t=1",
        "\r=1",
        "plain, with \"quotes\"\nand newline",
        "งานด่วน, “สำคัญ”",
    ];
    for title in hostile {
        task(&client, &origin, workspace, &owner, &open, title).await;
    }
    task(
        &client,
        &origin,
        workspace,
        &owner,
        &secret,
        "TOPSECRET title",
    )
    .await;

    let response = export(&client, &origin, workspace, &member, serde_json::json!({})).await;
    assert_eq!(response.status(), 200);
    assert!(response.headers()["content-type"]
        .to_str()
        .unwrap()
        .starts_with("text/csv"));
    assert!(response.headers()["content-disposition"]
        .to_str()
        .unwrap()
        .starts_with("attachment"));
    let text = response.text().await.unwrap();
    assert!(
        !text.contains("TOPSECRET") && !text.contains("Restricted"),
        "restricted data leaked"
    );
    let rows = parse(&text);
    assert_eq!(rows[0][..2], ["number", "title"]);
    let titles: Vec<&str> = rows[1..rows.len() - 1]
        .iter()
        .map(|r| r[1].as_str())
        .collect();
    assert_eq!(titles.len(), hostile.len());
    for title in &titles {
        assert!(
            !title.starts_with(['=', '+', '-', '@', '\t', '\r']),
            "formula not neutralised: {title:?}"
        );
    }
    assert!(titles.contains(&"'=HYPERLINK(\"http://evil\",\"x\")"));
    assert!(
        titles.contains(&"'+1+1") && titles.contains(&"'-2+3") && titles.contains(&"'@SUM(A1)")
    );
    // Task titles are trimmed on create, so a leading tab or CR reaches the file as "=1"; the cell
    // unit tests cover tab and CR prefixes directly.
    assert_eq!(titles.iter().filter(|t| **t == "'=1").count(), 2);
    assert!(titles.contains(&"plain, with \"quotes\"\nand newline"));
    assert!(titles.contains(&"งานด่วน, “สำคัญ”"));
    let notice = rows.last().unwrap();
    assert!(notice[0].contains("not a backup"), "{notice:?}");

    let owner_text = export(&client, &origin, workspace, &owner, serde_json::json!({}))
        .await
        .text()
        .await
        .unwrap();
    assert!(owner_text.contains("TOPSECRET title"));
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn export_follows_smart_list_filter_and_task_selection_and_checks_access() {
    let (origin, server, schema, admin, workspace, owner, member) = setup().await;
    let client = reqwest::Client::new();
    let open = project(&client, &origin, workspace, &owner, "Open", "workspace").await;
    let secret = project(
        &client,
        &origin,
        workspace,
        &owner,
        "Restricted",
        "restricted",
    )
    .await;
    let urgent = task(&client, &origin, workspace, &owner, &open, "Urgent one").await;
    task(&client, &origin, workspace, &owner, &open, "Calm one").await;
    let hidden = task(&client, &origin, workspace, &owner, &secret, "Hidden one").await;
    let patched = request(
        &client,
        reqwest::Method::PATCH,
        format!("{origin}/api/v1/tasks/{}", urgent["id"].as_str().unwrap()),
        &owner,
    )
    .json(&serde_json::json!({"expected_version":urgent["version"],"priority":"urgent"}))
    .send()
    .await
    .unwrap();
    assert!(patched.status().is_success());
    let created = request(&client, reqwest::Method::POST, format!("{origin}/api/v1/workspaces/{workspace}/lists"), &owner)
        .json(&serde_json::json!({"name":"Urgent","kind":"smart","query":{"filters":[{"field":"priority","op":"eq","value":"urgent"}],"logic":"and","sort":[],"group":null,"columns":["title","priority"]}}))
        .send().await.unwrap();
    assert_eq!(created.status(), 201);
    let list: serde_json::Value = created.json().await.unwrap();
    let rows = parse(
        &export(
            &client,
            &origin,
            workspace,
            &member,
            serde_json::json!({"list_id":list["id"]}),
        )
        .await
        .text()
        .await
        .unwrap(),
    );
    assert_eq!(rows[0], ["number", "title", "priority"]);
    assert_eq!(rows.len(), 3, "header, one row, notice: {rows:?}");
    assert_eq!(rows[1][1], "Urgent one");

    // Selected ids: the unreadable id is dropped without any signal.
    let rows = parse(
        &export(
            &client,
            &origin,
            workspace,
            &member,
            serde_json::json!({"task_ids":[urgent["id"],hidden["id"]]}),
        )
        .await
        .text()
        .await
        .unwrap(),
    );
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[1][1], "Urgent one");
    let with_hidden = export(
        &client,
        &origin,
        workspace,
        &member,
        serde_json::json!({"task_ids":[hidden["id"]]}),
    )
    .await
    .text()
    .await
    .unwrap();
    assert_eq!(parse(&with_hidden).len(), 2);

    // A missing CSRF header is refused.
    let no_csrf = client
        .post(format!(
            "{origin}/api/v1/workspaces/{workspace}/tasks/export.csv"
        ))
        .header(reqwest::header::COOKIE, &member.cookie)
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    assert!(no_csrf.status().is_client_error());
    let unknown_list = export(
        &client,
        &origin,
        workspace,
        &member,
        serde_json::json!({"list_id":Uuid::new_v4()}),
    )
    .await;
    assert_eq!(unknown_list.status(), 404);
    cleanup(server, schema, admin).await;
}
