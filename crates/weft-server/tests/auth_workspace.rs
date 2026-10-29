use std::{env, net::SocketAddr, time::Duration};
use weft_server::{serve, ServerConfig};

async fn test_database() -> (String, String, sqlx::PgPool) {
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".to_owned());
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!(
        "auth_{}_{}",
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
    (
        format!("{base}?options=-csearch_path%3D{schema}"),
        schema,
        admin,
    )
}

async fn start_server() -> (
    String,
    tokio::task::JoinHandle<()>,
    String,
    sqlx::PgPool,
    String,
) {
    let (database_url, schema, admin) = test_database().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address: SocketAddr = listener.local_addr().unwrap();
    let root = std::env::temp_dir().join(format!("weft-auth-{schema}"));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("index.html"), "<title>Weft</title>").unwrap();
    let server_database_url = database_url.clone();
    let server = tokio::spawn(async move {
        let _ = serve(listener, ServerConfig::new(server_database_url, root)).await;
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
            return (origin, server, schema, admin, database_url);
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("server did not start");
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
async fn public_registration_is_closed_and_login_does_not_disclose_accounts() {
    let (origin, server, schema, admin, _) = start_server().await;
    let client = reqwest::Client::new();
    let registration = client
        .post(format!("{origin}/api/v1/auth/register"))
        .json(&serde_json::json!({"email":"a@example.com","password":"password"}))
        .send()
        .await
        .unwrap();
    assert_eq!(registration.status(), reqwest::StatusCode::NOT_FOUND);

    let login = client
        .post(format!("{origin}/api/v1/auth/sign-in"))
        .json(&serde_json::json!({"email":"nobody@example.com","password":"wrong"}))
        .send()
        .await
        .unwrap();
    assert_eq!(login.status(), reqwest::StatusCode::UNAUTHORIZED);
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn sign_in_issues_host_only_http_only_cookie_and_cookie_writes_require_csrf() {
    let (origin, server, schema, admin, scoped) = start_server().await;
    // Bootstrap via the same operation exposed by the operator CLI.
    let pool = sqlx::PgPool::connect(&scoped).await.unwrap();
    weft_server::bootstrap_admin(
        &pool,
        "owner@example.com",
        "correct horse battery staple",
        "Test Workspace",
    )
    .await
    .unwrap();
    pool.close().await;

    let client = reqwest::Client::new();
    let response = client.post(format!("{origin}/api/v1/auth/sign-in"))
        .json(&serde_json::json!({"email":"OWNER@example.com","password":"correct horse battery staple"}))
        .send().await.unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let cookies = response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    let session = cookies
        .iter()
        .find(|c| c.starts_with("weft_session="))
        .unwrap();
    assert!(session.contains("HttpOnly"));
    assert!(!session.to_ascii_lowercase().contains("domain="));
    assert!(session.contains("SameSite=Strict"));
    let csrf = cookies
        .iter()
        .find(|c| c.starts_with("weft_csrf="))
        .unwrap();
    let session_pair = session.split(';').next().unwrap();
    let csrf_pair = csrf.split(';').next().unwrap();
    let cookie_header = format!("{session_pair}; {csrf_pair}");
    let csrf_value = csrf_pair.split_once('=').unwrap().1;
    let no_csrf = client
        .post(format!("{origin}/api/v1/auth/invites"))
        .header(reqwest::header::COOKIE, &cookie_header)
        .json(&serde_json::json!({"role":"member"}))
        .send()
        .await
        .unwrap();
    assert_eq!(no_csrf.status(), reqwest::StatusCode::FORBIDDEN);
    let invite = client
        .post(format!("{origin}/api/v1/auth/invites"))
        .header(reqwest::header::COOKIE, &cookie_header)
        .header("x-csrf-token", csrf_value)
        .json(&serde_json::json!({"role":"member","expires_in_hours":24}))
        .send()
        .await
        .unwrap();
    assert_eq!(invite.status(), reqwest::StatusCode::CREATED);
    let invite: serde_json::Value = invite.json().await.unwrap();
    let accept=client.post(format!("{origin}/api/v1/auth/invites/accept"))
        .json(&serde_json::json!({"token":invite["token"],"email":"new@example.com","password":"join password"})).send().await.unwrap();
    assert_eq!(accept.status(), reqwest::StatusCode::CREATED);
    let reused=client.post(format!("{origin}/api/v1/auth/invites/accept"))
        .json(&serde_json::json!({"token":invite["token"],"email":"another@example.com","password":"join password"})).send().await.unwrap();
    assert_eq!(reused.status(), reqwest::StatusCode::GONE);
    let revocable = client
        .post(format!("{origin}/api/v1/auth/invites"))
        .header(reqwest::header::COOKIE, &cookie_header)
        .header("x-csrf-token", csrf_value)
        .json(&serde_json::json!({"role":"viewer"}))
        .send()
        .await
        .unwrap();
    let revocable: serde_json::Value = revocable.json().await.unwrap();
    let revoked_invite = client
        .delete(format!(
            "{origin}/api/v1/auth/invites/{}",
            revocable["id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &cookie_header)
        .header("x-csrf-token", csrf_value)
        .send()
        .await
        .unwrap();
    assert_eq!(revoked_invite.status(), reqwest::StatusCode::NO_CONTENT);
    let revoked_accept=client.post(format!("{origin}/api/v1/auth/invites/accept"))
        .json(&serde_json::json!({"token":revocable["token"],"email":"revoked@example.com","password":"join password"})).send().await.unwrap();
    assert_eq!(revoked_accept.status(), reqwest::StatusCode::GONE);
    let expiring = client
        .post(format!("{origin}/api/v1/auth/invites"))
        .header(reqwest::header::COOKIE, &cookie_header)
        .header("x-csrf-token", csrf_value)
        .json(&serde_json::json!({"role":"member","expires_in_seconds":1}))
        .send()
        .await
        .unwrap();
    let expiring: serde_json::Value = expiring.json().await.unwrap();
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let expired_accept=client.post(format!("{origin}/api/v1/auth/invites/accept"))
        .json(&serde_json::json!({"token":expiring["token"],"email":"expired@example.com","password":"join password"})).send().await.unwrap();
    assert_eq!(expired_accept.status(), reqwest::StatusCode::GONE);
    let owner_me: serde_json::Value = client
        .get(format!("{origin}/api/v1/auth/me"))
        .header(reqwest::header::COOKIE, &cookie_header)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let admin_invite = client
        .post(format!("{origin}/api/v1/auth/invites"))
        .header(reqwest::header::COOKIE, &cookie_header)
        .header("x-csrf-token", csrf_value)
        .json(&serde_json::json!({"role":"admin"}))
        .send()
        .await
        .unwrap();
    let admin_invite: serde_json::Value = admin_invite.json().await.unwrap();
    let admin_accept=client.post(format!("{origin}/api/v1/auth/invites/accept"))
        .json(&serde_json::json!({"token":admin_invite["token"],"email":"admin@example.com","password":"join password"})).send().await.unwrap();
    assert_eq!(admin_accept.status(), reqwest::StatusCode::CREATED);
    let admin_login = client
        .post(format!("{origin}/api/v1/auth/sign-in"))
        .json(&serde_json::json!({"email":"admin@example.com","password":"join password"}))
        .send()
        .await
        .unwrap();
    let admin_cookies = admin_login
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    let admin_session = admin_cookies
        .iter()
        .find(|c| c.starts_with("weft_session="))
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let admin_csrf = admin_cookies
        .iter()
        .find(|c| c.starts_with("weft_csrf="))
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let admin_csrf_value = admin_csrf.split_once('=').unwrap().1;
    let admin_cookie = format!("{admin_session}; {admin_csrf}");
    let admin_me: serde_json::Value = client
        .get(format!("{origin}/api/v1/auth/me"))
        .header(reqwest::header::COOKIE, &admin_cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(admin_me["workspaces"][0]["role"], "admin");
    let admin_cannot_remove_owner = client
        .delete(format!(
            "{origin}/api/v1/workspaces/{}/members/{}",
            admin_me["workspaces"][0]["id"].as_str().unwrap(),
            owner_me["user_id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &admin_cookie)
        .header("x-csrf-token", admin_csrf_value)
        .send()
        .await
        .unwrap();
    assert_eq!(
        admin_cannot_remove_owner.status(),
        reqwest::StatusCode::FORBIDDEN
    );
    let workspace_id = owner_me["workspaces"][0]["id"].as_str().unwrap();
    let owner_id = owner_me["user_id"].as_str().unwrap();
    let last_owner = client
        .patch(format!(
            "{origin}/api/v1/workspaces/{workspace_id}/members/{owner_id}"
        ))
        .header(reqwest::header::COOKIE, &cookie_header)
        .header("x-csrf-token", csrf_value)
        .json(&serde_json::json!({"role":"member"}))
        .send()
        .await
        .unwrap();
    assert_eq!(last_owner.status(), reqwest::StatusCode::CONFLICT);
    let member_login = client
        .post(format!("{origin}/api/v1/auth/sign-in"))
        .json(&serde_json::json!({"email":"new@example.com","password":"join password"}))
        .send()
        .await
        .unwrap();
    assert_eq!(member_login.status(), reqwest::StatusCode::OK);
    let member_cookies = member_login
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .map(|value| value.to_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    let member_session = member_cookies
        .iter()
        .find(|cookie| cookie.starts_with("weft_session="))
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let member_csrf = member_cookies
        .iter()
        .find(|cookie| cookie.starts_with("weft_csrf="))
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let member_csrf_value = member_csrf.split_once('=').unwrap().1;
    let member_cookie = format!("{member_session}; {member_csrf}");
    let member_me: serde_json::Value = client
        .get(format!("{origin}/api/v1/auth/me"))
        .header(reqwest::header::COOKIE, &member_cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(member_me["workspaces"][0]["role"], "member");
    let changed = client
        .patch(format!(
            "{origin}/api/v1/workspaces/{workspace_id}/members/{}",
            member_me["user_id"].as_str().unwrap()
        ))
        .header(reqwest::header::COOKIE, &cookie_header)
        .header("x-csrf-token", csrf_value)
        .json(&serde_json::json!({"role":"viewer"}))
        .send()
        .await
        .unwrap();
    assert_eq!(changed.status(), reqwest::StatusCode::NO_CONTENT);
    let viewer_write = client
        .post(format!("{origin}/api/v1/auth/invites"))
        .header(reqwest::header::COOKIE, &member_cookie)
        .header("x-csrf-token", member_csrf_value)
        .json(&serde_json::json!({"role":"member"}))
        .send()
        .await
        .unwrap();
    assert_eq!(viewer_write.status(), reqwest::StatusCode::FORBIDDEN);
    let events: serde_json::Value = client
        .get(format!("{origin}/api/v1/auth/audit-events"))
        .header(reqwest::header::COOKIE, &cookie_header)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let event_names = events["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["event"].as_str().unwrap())
        .collect::<Vec<_>>();
    for expected in [
        "sign_in",
        "invite.create",
        "invite.accept",
        "membership.role_change",
    ] {
        assert!(event_names.contains(&expected));
    }
    let sessions: serde_json::Value = client
        .get(format!("{origin}/api/v1/auth/sessions"))
        .header(reqwest::header::COOKIE, &cookie_header)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let session_id = sessions["sessions"][0]["id"].as_str().unwrap();
    let second_login=client.post(format!("{origin}/api/v1/auth/sign-in"))
        .json(&serde_json::json!({"email":"owner@example.com","password":"correct horse battery staple"})).send().await.unwrap();
    let second_cookies = second_login
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    let second_session = second_cookies
        .iter()
        .find(|c| c.starts_with("weft_session="))
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let second_csrf = second_cookies
        .iter()
        .find(|c| c.starts_with("weft_csrf="))
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let second_cookie_header = format!("{second_session}; {second_csrf}");
    let second_csrf_value = second_csrf.split_once('=').unwrap().1;
    let revoked = client
        .delete(format!("{origin}/api/v1/auth/sessions/{session_id}"))
        .header(reqwest::header::COOKIE, &cookie_header)
        .header("x-csrf-token", csrf_value)
        .send()
        .await
        .unwrap();
    assert_eq!(revoked.status(), reqwest::StatusCode::NO_CONTENT);
    let events: serde_json::Value = client
        .get(format!("{origin}/api/v1/auth/audit-events"))
        .header(reqwest::header::COOKIE, &second_cookie_header)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(events["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|event| event["event"] == "session.revoke"));
    let signed_out = client
        .post(format!("{origin}/api/v1/auth/sign-out"))
        .header(reqwest::header::COOKIE, &second_cookie_header)
        .header("x-csrf-token", second_csrf_value)
        .send()
        .await
        .unwrap();
    assert_eq!(signed_out.status(), reqwest::StatusCode::NO_CONTENT);
    let invalidated = client
        .get(format!("{origin}/api/v1/auth/me"))
        .header(reqwest::header::COOKIE, &cookie_header)
        .send()
        .await
        .unwrap();
    assert_eq!(invalidated.status(), reqwest::StatusCode::UNAUTHORIZED);
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn login_rate_limit_blocks_after_ten_failed_attempts() {
    let (origin, server, schema, admin, _) = start_server().await;
    let client = reqwest::Client::new();
    for attempt in 0..10 {
        let response = client
            .post(format!("{origin}/api/v1/auth/sign-in"))
            .json(&serde_json::json!({"email":"missing@example.com","password":"wrong"}))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            reqwest::StatusCode::UNAUTHORIZED,
            "attempt {attempt}"
        );
    }
    let limited = client
        .post(format!("{origin}/api/v1/auth/sign-in"))
        .json(&serde_json::json!({"email":"missing@example.com","password":"wrong"}))
        .send()
        .await
        .unwrap();
    assert_eq!(limited.status(), reqwest::StatusCode::TOO_MANY_REQUESTS);
    cleanup(server, schema, admin).await;
}
