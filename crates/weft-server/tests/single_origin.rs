use std::{env, net::SocketAddr, time::Duration};
use weft_server::{serve, ServerConfig};

async fn test_database_url() -> (String, String, sqlx::PgPool) {
    let base_url = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".to_owned());
    let admin = sqlx::PgPool::connect(&base_url)
        .await
        .expect("shared PostgreSQL is available");
    let schema = format!("ticket02_{}", uuid_suffix());
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&admin)
        .await
        .expect("test schema is created");
    let scoped_url = format!("{base_url}?options=-csearch_path%3D{schema}");
    (scoped_url, schema, admin)
}

fn uuid_suffix() -> String {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock follows the Unix epoch")
        .as_nanos();
    format!("{}_{timestamp:x}", std::process::id())
}

#[tokio::test(flavor = "multi_thread")]
async fn one_origin_serves_shell_api_health_and_migrates_against_isolated_postgres() {
    let (database_url, schema, admin) = test_database_url().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address: SocketAddr = listener.local_addr().unwrap();
    let web_root = format!("{}/../../apps/web/dist", env!("CARGO_MANIFEST_DIR"));
    let mut migration_gate = admin.acquire().await.unwrap();
    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(0x574546540001_i64)
        .execute(&mut *migration_gate)
        .await
        .unwrap();
    let server = tokio::spawn(serve(listener, ServerConfig::new(database_url, web_root)));
    let client = reqwest::Client::new();
    let origin = format!("http://{address}");

    let mut live = None;
    for _ in 0..100 {
        if let Ok(result) = client.get(format!("{origin}/health/live")).send().await {
            live = Some(result);
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(live.unwrap().status(), reqwest::StatusCode::OK);
    assert_eq!(
        client
            .get(format!("{origin}/health/ready"))
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::SERVICE_UNAVAILABLE
    );

    sqlx::query("SELECT pg_advisory_unlock($1)")
        .bind(0x574546540001_i64)
        .execute(&mut *migration_gate)
        .await
        .unwrap();

    let mut ready = None;
    for _ in 0..100 {
        if let Ok(result) = client.get(format!("{origin}/health/ready")).send().await {
            if result.status().is_success() {
                ready = Some(result);
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(ready.unwrap().status(), reqwest::StatusCode::OK);

    let shell = client.get(&origin).send().await.unwrap();
    assert_eq!(shell.status(), reqwest::StatusCode::OK);
    assert!(shell.text().await.unwrap().contains("Weft"));

    let api = client.get(format!("{origin}/api/v1")).send().await.unwrap();
    assert_eq!(api.status(), reqwest::StatusCode::OK);
    assert_eq!(
        api.json::<serde_json::Value>().await.unwrap()["api_version"],
        "v1"
    );

    let live = client
        .get(format!("{origin}/health/live"))
        .send()
        .await
        .unwrap();
    assert_eq!(live.status(), reqwest::StatusCode::OK);
    let ready = client
        .get(format!("{origin}/health/ready"))
        .send()
        .await
        .unwrap();
    assert_eq!(ready.status(), reqwest::StatusCode::OK);

    for path in ["/manifest.webmanifest", "/service-worker.js"] {
        let response = client.get(format!("{origin}{path}")).send().await.unwrap();
        assert_eq!(
            response.status(),
            reqwest::StatusCode::OK,
            "{path} is included in the PWA shell"
        );
    }

    let migrated = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'weft_installation')",
    )
    .bind(&schema)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert!(
        migrated,
        "the server applies migrations before reporting ready"
    );

    server.abort();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}
