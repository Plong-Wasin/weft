use std::{env, process::Command, time::Duration};
use weft_server::{serve, ServerConfig};

#[tokio::test]
async fn bootstrap_refuses_second_admin_and_cli_can_reset_password() {
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".to_owned());
    let admin = weft_server::connect(&base).await.unwrap();
    let schema = format!(
        "cli_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&admin)
        .await
        .unwrap();
    let database_url = format!("{base}?options=-csearch_path%3D{schema}");
    let binary = env!("CARGO_BIN_EXE_weft");
    let bootstrap = Command::new(binary)
        .args([
            "bootstrap-admin",
            "owner@example.com",
            "initial password",
            "Weft",
        ])
        .env("DATABASE_URL", &database_url)
        .output()
        .unwrap();
    assert!(
        bootstrap.status.success(),
        "{}",
        String::from_utf8_lossy(&bootstrap.stderr)
    );
    let root = std::env::temp_dir().join(format!("weft-cli-{schema}"));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("index.html"), "<title>Weft</title>").unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(serve(listener, ServerConfig::new(&database_url, &root)));
    let origin = format!("http://{address}");
    let client = reqwest::Client::new();
    for _ in 0..100 {
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
    let old_login = client
        .post(format!("{origin}/api/v1/auth/sign-in"))
        .json(&serde_json::json!({"email":"owner@example.com","password":"initial password"}))
        .send()
        .await
        .unwrap();
    assert_eq!(old_login.status(), reqwest::StatusCode::OK);
    let old_cookie = old_login
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let second = Command::new(binary)
        .args(["bootstrap-admin", "second@example.com", "initial password"])
        .env("DATABASE_URL", &database_url)
        .output()
        .unwrap();
    assert!(
        !second.status.success(),
        "only one initial admin can be bootstrapped"
    );
    let reset = Command::new(binary)
        .args(["reset-password", "owner@example.com", "recovered password"])
        .env("DATABASE_URL", &database_url)
        .output()
        .unwrap();
    assert!(
        reset.status.success(),
        "{}",
        String::from_utf8_lossy(&reset.stderr)
    );
    let revoked_session = client
        .get(format!("{origin}/api/v1/auth/me"))
        .header(reqwest::header::COOKIE, &old_cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(revoked_session.status(), reqwest::StatusCode::UNAUTHORIZED);
    let old_password = client
        .post(format!("{origin}/api/v1/auth/sign-in"))
        .json(&serde_json::json!({"email":"owner@example.com","password":"initial password"}))
        .send()
        .await
        .unwrap();
    assert_eq!(old_password.status(), reqwest::StatusCode::UNAUTHORIZED);
    let new_password = client
        .post(format!("{origin}/api/v1/auth/sign-in"))
        .json(&serde_json::json!({"email":"owner@example.com","password":"recovered password"}))
        .send()
        .await
        .unwrap();
    assert_eq!(new_password.status(), reqwest::StatusCode::OK);
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    server.abort();
    std::fs::remove_dir_all(&root).unwrap();
    admin.close().await;
}
