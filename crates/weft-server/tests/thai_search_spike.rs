use std::env;

use sqlx::{postgres::PgPoolOptions, Row};

#[tokio::test]
async fn simple_full_text_and_trigrams_characterize_thai_exact_and_substring_search() {
    let base_url = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".to_owned());
    let admin = PgPoolOptions::new()
        .connect(&base_url)
        .await
        .expect("shared PostgreSQL is available");
    let schema = format!("ticket16_{}", uuid_suffix());
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&admin)
        .await
        .expect("isolated test schema is created");
    let database_url = format!("{base_url}?options=-csearch_path%3D{schema}");
    weft_server::migrate(&database_url)
        .await
        .expect("the parser and search migrations apply");
    let pool = PgPoolOptions::new()
        .connect(&database_url)
        .await
        .expect("test connection uses the isolated schema");

    let row = sqlx::query(
        "SELECT
             to_tsvector('simple', $1) @@ plainto_tsquery('simple', $1) AS exact_full_text,
             to_tsvector('simple', $1) @@ plainto_tsquery('simple', $2) AS partial_full_text,
             public.word_similarity($2, $1) >= 0.3 AS substring_trigram,
             public.word_similarity($1, $1) = 1.0 AS exact_trigram",
    )
    .bind("ระบบจัดการงานทีม")
    .bind("จัดการ")
    .fetch_one(&pool)
    .await
    .expect("the simple dictionary and pg_trgm functions are available");

    assert!(row.get::<bool, _>("exact_full_text"));
    assert!(!row.get::<bool, _>("partial_full_text"));
    assert!(row.get::<bool, _>("substring_trigram"));
    assert!(row.get::<bool, _>("exact_trigram"));

    pool.close().await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await
        .expect("test schema is removed");
}

fn uuid_suffix() -> String {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock follows the Unix epoch")
        .as_nanos();
    format!("{}_{timestamp:x}", std::process::id())
}
