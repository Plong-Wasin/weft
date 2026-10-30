use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{env, net::SocketAddr, time::Duration};
use uuid::Uuid;
use weft_server::recurrence::{local_date, Date, Rule};
use weft_server::{serve, ServerConfig};

struct Session {
    user: Uuid,
    cookie: String,
    csrf: String,
}

struct Env {
    origin: String,
    server: tokio::task::JoinHandle<()>,
    schema: String,
    admin: sqlx::PgPool,
    pool: sqlx::PgPool,
    workspace: Uuid,
    owner: Session,
    member: Session,
}

async fn setup() -> Env {
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!("recur_{}_{}", std::process::id(), Uuid::new_v4().simple());
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
    let pool = sqlx::PgPool::connect(&scoped).await.unwrap();
    weft_server::bootstrap_admin(
        &pool,
        "owner@example.com",
        "secret password",
        "Test Workspace",
    )
    .await
    .unwrap();
    let (workspace, owner): (Uuid, Uuid) = sqlx::query_as(
        "SELECT w.id,m.user_id FROM workspaces w JOIN workspace_memberships m ON m.workspace_id=w.id WHERE m.role='owner'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let member = add_user(&pool, workspace, "member@example.com", "member").await;
    Env {
        origin,
        server,
        schema,
        admin,
        workspace,
        owner: session(&pool, owner).await,
        member: session(&pool, member).await,
        pool,
    }
}

async fn add_user(pool: &sqlx::PgPool, workspace: Uuid, email: &str, role: &str) -> Uuid {
    let user = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'unused')")
        .bind(user)
        .bind(email)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,$3)")
        .bind(workspace)
        .bind(user)
        .bind(role)
        .execute(pool)
        .await
        .unwrap();
    user
}

async fn session(pool: &sqlx::PgPool, user: Uuid) -> Session {
    let token = Uuid::new_v4().to_string();
    let csrf = Uuid::new_v4().to_string();
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    sqlx::query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')")
        .bind(Uuid::new_v4())
        .bind(user)
        .bind(hash)
        .bind(&csrf)
        .execute(pool)
        .await
        .unwrap();
    Session {
        user,
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

async fn call(
    env: &Env,
    method: reqwest::Method,
    path: &str,
    who: &Session,
    body: Option<serde_json::Value>,
) -> (u16, serde_json::Value) {
    let url = format!("{}/api/v1{path}", env.origin);
    let mut builder = request(&reqwest::Client::new(), method, url, who);
    if let Some(body) = body {
        builder = builder.json(&body);
    }
    let response = builder.send().await.unwrap();
    let status = response.status().as_u16();
    let body = response.json().await.unwrap_or(serde_json::Value::Null);
    (status, body)
}

async fn post(
    env: &Env,
    path: &str,
    who: &Session,
    body: serde_json::Value,
) -> (u16, serde_json::Value) {
    call(env, reqwest::Method::POST, path, who, Some(body)).await
}

async fn get(env: &Env, path: &str, who: &Session) -> (u16, serde_json::Value) {
    call(env, reqwest::Method::GET, path, who, None).await
}

async fn project(env: &Env, who: &Session, visibility: &str) -> Uuid {
    let (status, body) = post(
        env,
        &format!("/workspaces/{}/projects", env.workspace),
        who,
        serde_json::json!({"name":"Delivery","visibility":visibility}),
    )
    .await;
    assert_eq!(status, 201);
    body["id"].as_str().unwrap().parse().unwrap()
}

async fn grant(env: &Env, project: Uuid, user: Uuid, role: &str) {
    sqlx::query(
        "INSERT INTO project_memberships(workspace_id,project_id,user_id,role) VALUES($1,$2,$3,$4)",
    )
    .bind(env.workspace)
    .bind(project)
    .bind(user)
    .bind(role)
    .execute(&env.pool)
    .await
    .unwrap();
}

async fn put(
    env: &Env,
    path: &str,
    who: &Session,
    body: serde_json::Value,
) -> (u16, serde_json::Value) {
    call(env, reqwest::Method::PUT, path, who, Some(body)).await
}

async fn patch(
    env: &Env,
    path: &str,
    who: &Session,
    body: serde_json::Value,
) -> (u16, serde_json::Value) {
    call(env, reqwest::Method::PATCH, path, who, Some(body)).await
}

async fn cleanup(env: Env) {
    env.server.abort();
    sqlx::query(&format!("DROP SCHEMA {} CASCADE", env.schema))
        .execute(&env.admin)
        .await
        .unwrap();
    env.admin.close().await;
}

async fn make_task(
    env: &Env,
    who: &Session,
    project: Uuid,
    start: Option<&str>,
    due: Option<&str>,
) -> Value {
    let (status, task) = post(
        env,
        &format!("/workspaces/{}/tasks", env.workspace),
        who,
        json!({"project_id":project,"title":"Water the plants","description":"weekly chore","start_date":start,"due_date":due,"priority":"high"}),
    )
    .await;
    assert_eq!(status, 201);
    task
}

async fn complete(env: &Env, who: &Session, task: &Value) -> (u16, Value) {
    patch(
        env,
        &format!("/tasks/{}", task["id"].as_str().unwrap()),
        who,
        json!({"expected_version":task["version"],"status":"completed"}),
    )
    .await
}

async fn live_tasks(env: &Env) -> Vec<(Uuid, i64, Option<String>, Option<String>, String)> {
    sqlx::query_as("SELECT id,number,start_date::text,due_date::text,status FROM tasks WHERE archived_at IS NULL ORDER BY number")
        .fetch_all(&env.pool)
        .await
        .unwrap()
}

async fn set_rule(env: &Env, who: &Session, task: &Value, rule: Value) -> (u16, Value) {
    let mut body = rule;
    body["expected_version"] = task["version"].clone();
    put(
        env,
        &format!("/tasks/{}/recurrence", task["id"].as_str().unwrap()),
        who,
        body,
    )
    .await
}

async fn reread(env: &Env, who: &Session, task: &Value) -> Value {
    let (status, body) = get(
        env,
        &format!("/workspaces/{}/tasks/{}", env.workspace, task["number"]),
        who,
    )
    .await;
    assert_eq!(status, 200);
    body
}

// ---- the rule itself, with the time passed in ----

fn d(text: &str) -> Date {
    Date::parse(text).unwrap()
}

#[test]
fn daily_rule_crosses_month_year_and_leap_day() {
    let rule = Rule::daily();
    assert_eq!(rule.next_after(d("2024-02-28")).to_string(), "2024-02-29");
    assert_eq!(rule.next_after(d("2024-02-29")).to_string(), "2024-03-01");
    assert_eq!(rule.next_after(d("2025-02-28")).to_string(), "2025-03-01");
    assert_eq!(rule.next_after(d("2025-12-31")).to_string(), "2026-01-01");
}

#[test]
fn weekly_rule_picks_the_next_chosen_weekday() {
    // 2026-03-02 is a Monday. Monday + Thursday.
    let rule = Rule::weekly(&[4, 1, 1]).unwrap();
    assert_eq!(d("2026-03-02").weekday(), 1);
    assert_eq!(rule.next_after(d("2026-03-02")).to_string(), "2026-03-05");
    assert_eq!(rule.next_after(d("2026-03-05")).to_string(), "2026-03-09");
    assert_eq!(rule.next_after(d("2026-03-04")).to_string(), "2026-03-05");
    // A single day moves a full week, not zero days.
    let single = Rule::weekly(&[1]).unwrap();
    assert_eq!(single.next_after(d("2026-03-02")).to_string(), "2026-03-09");
    assert!(Rule::weekly(&[]).is_none());
    assert!(Rule::weekly(&[0]).is_none());
    assert!(Rule::weekly(&[8]).is_none());
}

#[test]
fn monthly_last_day_follows_month_lengths_and_leap_years() {
    let rule = Rule::monthly_last_day();
    assert_eq!(rule.next_after(d("2025-01-31")).to_string(), "2025-02-28");
    assert_eq!(rule.next_after(d("2024-01-31")).to_string(), "2024-02-29");
    assert_eq!(rule.next_after(d("2024-02-29")).to_string(), "2024-03-31");
    assert_eq!(rule.next_after(d("2024-04-15")).to_string(), "2024-04-30");
    assert_eq!(rule.next_after(d("2024-12-31")).to_string(), "2025-01-31");
    // 1900 is not a leap year, 2000 is.
    assert_eq!(rule.next_after(d("1900-01-31")).to_string(), "1900-02-28");
    assert_eq!(rule.next_after(d("2000-01-31")).to_string(), "2000-02-29");
}

#[test]
fn monthly_on_a_day_uses_the_last_day_of_a_short_month_without_drifting() {
    let rule = Rule::monthly_on(31).unwrap();
    assert_eq!(rule.next_after(d("2025-01-31")).to_string(), "2025-02-28");
    assert_eq!(rule.next_after(d("2025-02-28")).to_string(), "2025-03-31");
    assert_eq!(rule.next_after(d("2025-03-31")).to_string(), "2025-04-30");
    let leap = Rule::monthly_on(29).unwrap();
    assert_eq!(leap.next_after(d("2024-01-29")).to_string(), "2024-02-29");
    assert_eq!(leap.next_after(d("2025-01-29")).to_string(), "2025-02-28");
    assert_eq!(leap.next_after(d("2025-02-28")).to_string(), "2025-03-29");
    let fifteenth = Rule::monthly_on(15).unwrap();
    assert_eq!(
        fifteenth.next_after(d("2025-12-10")).to_string(),
        "2025-12-15"
    );
    assert_eq!(
        fifteenth.next_after(d("2025-12-15")).to_string(),
        "2026-01-15"
    );
    assert!(Rule::monthly_on(0).is_none());
    assert!(Rule::monthly_on(32).is_none());
}

#[test]
fn shifting_keeps_the_span_and_uses_today_only_without_dates() {
    let rule = Rule::monthly_last_day();
    let today = d("2025-06-10");
    let (start, due) = rule.shift(Some(d("2025-01-29")), Some(d("2025-01-31")), today);
    assert_eq!(start.unwrap().to_string(), "2025-02-26");
    assert_eq!(due.unwrap().to_string(), "2025-02-28");
    let (start, due) = rule.shift(Some(d("2025-01-31")), None, today);
    assert_eq!(start.unwrap().to_string(), "2025-02-28");
    assert!(due.is_none());
    let (start, due) = rule.shift(None, None, today);
    assert!(start.is_none());
    assert_eq!(due.unwrap().to_string(), "2025-06-30");
}

#[tokio::test]
async fn the_workspace_local_date_follows_the_zone_across_daylight_saving_changes() {
    let base = env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into());
    let pool = sqlx::PgPool::connect(&base).await.unwrap();
    let local = |zone: &'static str, instant: &'static str| {
        let pool = pool.clone();
        async move {
            local_date(&pool, zone, Some(instant))
                .await
                .unwrap()
                .to_string()
        }
    };
    // New York springs forward on 2024-03-10 (07:00Z) and falls back on 2024-11-03 (06:00Z).
    assert_eq!(
        local("America/New_York", "2024-03-10T04:59:59Z").await,
        "2024-03-09"
    );
    assert_eq!(
        local("America/New_York", "2024-03-10T05:00:00Z").await,
        "2024-03-10"
    );
    assert_eq!(
        local("America/New_York", "2024-03-11T03:59:59Z").await,
        "2024-03-10"
    );
    assert_eq!(
        local("America/New_York", "2024-03-11T04:00:00Z").await,
        "2024-03-11"
    );
    assert_eq!(
        local("America/New_York", "2024-11-04T04:59:59Z").await,
        "2024-11-03"
    );
    assert_eq!(
        local("America/New_York", "2024-11-04T05:00:00Z").await,
        "2024-11-04"
    );
    // Same instant, different calendar day in two zones.
    assert_eq!(local("UTC", "2024-06-30T18:00:00Z").await, "2024-06-30");
    assert_eq!(
        local("Pacific/Auckland", "2024-06-30T18:00:00Z").await,
        "2024-07-01"
    );
    // The Southern Hemisphere changes the other way round: Auckland ends DST on 2024-04-07 (14:00Z).
    assert_eq!(
        local("Pacific/Auckland", "2024-04-06T10:59:59Z").await,
        "2024-04-06"
    );
    assert_eq!(
        local("Pacific/Auckland", "2024-04-06T11:00:00Z").await,
        "2024-04-07"
    );
    assert_eq!(
        local("Pacific/Auckland", "2024-04-07T11:59:59Z").await,
        "2024-04-07"
    );
    assert_eq!(
        local("Pacific/Auckland", "2024-04-07T12:00:00Z").await,
        "2024-04-08"
    );
    // The rule then runs on that local date: a Friday evening in New York is already Saturday UTC.
    let friday = local("America/New_York", "2024-03-09T23:30:00Z").await;
    assert_eq!(friday, "2024-03-09");
    let monday = Rule::weekly(&[1]).unwrap().next_after(d(&friday));
    assert_eq!(monday.to_string(), "2024-03-11");
    pool.close().await;
}

// ---- the API ----

#[tokio::test]
async fn completing_a_repeating_task_creates_the_next_occurrence_and_undo_removes_it() {
    let env = setup().await;
    let project = project(&env, &env.owner, "workspace").await;
    let task = make_task(
        &env,
        &env.owner,
        project,
        Some("2025-01-29"),
        Some("2025-01-31"),
    )
    .await;
    let item = post(
        &env,
        &format!("/tasks/{}/checklist", task["id"].as_str().unwrap()),
        &env.owner,
        json!({"title":"Fill the can"}),
    )
    .await;
    assert_eq!(item.0, 201);
    let task = reread(&env, &env.owner, &task).await;
    let (status, with_rule) = set_rule(
        &env,
        &env.owner,
        &task,
        json!({"frequency":"monthly","last_day_of_month":true}),
    )
    .await;
    assert_eq!(status, 200, "{with_rule}");
    assert_eq!(with_rule["recurrence"]["frequency"], "monthly");
    assert_eq!(with_rule["recurrence"]["last_day_of_month"], true);
    assert_eq!(live_tasks(&env).await.len(), 1);

    let (status, done) = complete(&env, &env.owner, &with_rule).await;
    assert_eq!(status, 200, "{done}");
    let tasks = live_tasks(&env).await;
    assert_eq!(tasks.len(), 2);
    let next = &tasks[1];
    assert_eq!(next.2.as_deref(), Some("2025-02-26"));
    assert_eq!(next.3.as_deref(), Some("2025-02-28"));
    assert_eq!(next.4, "backlog");
    let next_task = get(
        &env,
        &format!("/workspaces/{}/tasks/{}", env.workspace, next.1),
        &env.owner,
    )
    .await
    .1;
    assert_eq!(next_task["title"], "Water the plants");
    assert_eq!(next_task["description"], "weekly chore");
    assert_eq!(next_task["priority"], "high");
    assert_eq!(next_task["project_id"], json!(project));
    assert_eq!(next_task["checklist"][0]["title"], "Fill the can");
    assert_eq!(next_task["checklist"][0]["checked"], false);
    assert_eq!(next_task["recurrence"]["last_day_of_month"], true);

    // Undo of the completion removes the occurrence and reopens the Task in one step.
    let (status, _) = post(
        &env,
        &format!("/workspaces/{}/history/undo", env.workspace),
        &env.owner,
        json!({}),
    )
    .await;
    assert_eq!(status, 200);
    let tasks = live_tasks(&env).await;
    assert_eq!(tasks.len(), 1);
    assert_ne!(tasks[0].4, "completed");
    // Redo brings both back.
    let (status, _) = post(
        &env,
        &format!("/workspaces/{}/history/redo", env.workspace),
        &env.owner,
        json!({}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(live_tasks(&env).await.len(), 2);
    cleanup(env).await;
}

#[tokio::test]
async fn completing_again_after_undo_never_leaves_two_live_occurrences() {
    let env = setup().await;
    let project = project(&env, &env.owner, "workspace").await;
    let task = make_task(&env, &env.owner, project, None, Some("2030-03-02")).await;
    let (_, task) = set_rule(
        &env,
        &env.owner,
        &task,
        json!({"frequency":"weekly","weekdays":[1]}),
    )
    .await;
    let (_, done) = complete(&env, &env.owner, &task).await;
    assert_eq!(live_tasks(&env).await.len(), 2);
    let undo = format!("/workspaces/{}/history/undo", env.workspace);
    assert_eq!(post(&env, &undo, &env.owner, json!({})).await.0, 200);
    assert_eq!(live_tasks(&env).await.len(), 1);
    let reopened = reread(&env, &env.owner, &done).await;
    let (status, _) = complete(&env, &env.owner, &reopened).await;
    assert_eq!(status, 200);
    let tasks = live_tasks(&env).await;
    assert_eq!(tasks.len(), 2);
    assert_eq!(tasks[1].3.as_deref(), Some("2030-03-04"));
    // Reopening and completing the original while the occurrence is waiting adds nothing.
    let waiting = live_tasks(&env).await.len();
    let current = reread(&env, &env.owner, &done).await;
    let (_, reopened) = patch(
        &env,
        &format!("/tasks/{}", current["id"].as_str().unwrap()),
        &env.owner,
        json!({"expected_version":current["version"],"status":"active"}),
    )
    .await;
    complete(&env, &env.owner, &reopened).await;
    assert_eq!(live_tasks(&env).await.len(), waiting);
    cleanup(env).await;
}

#[tokio::test]
async fn bulk_completion_creates_the_occurrence_in_the_same_group() {
    let env = setup().await;
    let project = project(&env, &env.owner, "workspace").await;
    let task = make_task(&env, &env.owner, project, None, Some("2030-05-10")).await;
    let (_, task) = set_rule(&env, &env.owner, &task, json!({"frequency":"daily"})).await;
    let (status, body) = post(
        &env,
        &format!("/workspaces/{}/tasks/bulk", env.workspace),
        &env.owner,
        json!({"items":[{"task_id":task["id"],"expected_version":task["version"],"status":"completed"}]}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let tasks = live_tasks(&env).await;
    assert_eq!(tasks.len(), 2);
    assert_eq!(tasks[1].3.as_deref(), Some("2030-05-11"));
    let undo = format!("/workspaces/{}/history/undo", env.workspace);
    assert_eq!(post(&env, &undo, &env.owner, json!({})).await.0, 200);
    assert_eq!(live_tasks(&env).await.len(), 1);
    cleanup(env).await;
}

#[tokio::test]
async fn a_task_without_dates_gets_a_due_date_from_the_workspace_today() {
    let env = setup().await;
    let project = project(&env, &env.owner, "workspace").await;
    let task = make_task(&env, &env.owner, project, None, None).await;
    let (_, task) = set_rule(&env, &env.owner, &task, json!({"frequency":"daily"})).await;
    complete(&env, &env.owner, &task).await;
    let (zone, today): (String, String) = sqlx::query_as(
        "SELECT time_zone,(now() AT TIME ZONE time_zone)::date::text FROM workspaces",
    )
    .fetch_one(&env.pool)
    .await
    .unwrap();
    assert!(!zone.is_empty());
    let tasks = live_tasks(&env).await;
    assert_eq!(tasks.len(), 2);
    let expected = Rule::daily().next_after(d(&today)).to_string();
    let alternative = Rule::daily().next_after(d(&today).add_days(1)).to_string();
    // The clock may tick over midnight between the two reads.
    assert!(
        tasks[1].3.as_deref() == Some(expected.as_str())
            || tasks[1].3.as_deref() == Some(alternative.as_str())
    );
    assert!(tasks[1].2.is_none());
    cleanup(env).await;
}

#[tokio::test]
async fn a_stopped_rule_does_not_recur_and_a_skip_moves_only_the_dates() {
    let env = setup().await;
    let project = project(&env, &env.owner, "workspace").await;
    let task = make_task(
        &env,
        &env.owner,
        project,
        Some("2030-03-04"),
        Some("2030-03-06"),
    )
    .await;
    let (_, task) = set_rule(
        &env,
        &env.owner,
        &task,
        json!({"frequency":"weekly","weekdays":[3]}),
    )
    .await;
    let (status, skipped) = post(
        &env,
        &format!("/tasks/{}/recurrence/skip", task["id"].as_str().unwrap()),
        &env.owner,
        json!({"expected_version":task["version"]}),
    )
    .await;
    assert_eq!(status, 200, "{skipped}");
    assert_eq!(skipped["start_date"], "2030-03-11");
    assert_eq!(skipped["due_date"], "2030-03-13");
    assert_ne!(skipped["status"], "completed");
    assert_eq!(live_tasks(&env).await.len(), 1);
    // The skip is one undoable entry.
    let undo = format!("/workspaces/{}/history/undo", env.workspace);
    assert_eq!(post(&env, &undo, &env.owner, json!({})).await.0, 200);
    let back = reread(&env, &env.owner, &task).await;
    assert_eq!(back["due_date"], "2030-03-06");
    // Stop the rule: completing creates nothing, and a stale version is refused.
    let (status, _) = call(
        &env,
        reqwest::Method::DELETE,
        &format!(
            "/tasks/{}/recurrence?expected_version=1",
            task["id"].as_str().unwrap()
        ),
        &env.owner,
        None,
    )
    .await;
    assert_eq!(status, 409);
    let (status, stopped) = call(
        &env,
        reqwest::Method::DELETE,
        &format!(
            "/tasks/{}/recurrence?expected_version={}",
            task["id"].as_str().unwrap(),
            back["version"]
        ),
        &env.owner,
        None,
    )
    .await;
    assert_eq!(status, 200, "{stopped}");
    assert!(stopped["recurrence"].is_null());
    complete(&env, &env.owner, &stopped).await;
    assert_eq!(live_tasks(&env).await.len(), 1);
    // Undo of the completion, then of the stop, brings the rule back (the Task is unchanged since).
    assert_eq!(post(&env, &undo, &env.owner, json!({})).await.0, 200);
    let (status, body) = post(&env, &undo, &env.owner, json!({})).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        reread(&env, &env.owner, &task).await["recurrence"]["frequency"],
        "weekly"
    );
    // Skip needs a rule and a date.
    let plain = make_task(&env, &env.owner, project, None, None).await;
    let (status, _) = post(
        &env,
        &format!("/tasks/{}/recurrence/skip", plain["id"].as_str().unwrap()),
        &env.owner,
        json!({"expected_version":plain["version"]}),
    )
    .await;
    assert_eq!(status, 404);
    cleanup(env).await;
}

#[tokio::test]
async fn invalid_rules_are_refused_with_422() {
    let env = setup().await;
    let project = project(&env, &env.owner, "workspace").await;
    let task = make_task(&env, &env.owner, project, None, Some("2030-03-04")).await;
    for rule in [
        json!({"frequency":"yearly"}),
        json!({"frequency":"weekly"}),
        json!({"frequency":"weekly","weekdays":[]}),
        json!({"frequency":"weekly","weekdays":[0]}),
        json!({"frequency":"weekly","weekdays":[8]}),
        json!({"frequency":"daily","weekdays":[1]}),
        json!({"frequency":"monthly"}),
        json!({"frequency":"monthly","month_day":32}),
        json!({"frequency":"monthly","month_day":0}),
        json!({"frequency":"monthly","month_day":5,"last_day_of_month":true}),
        json!({"frequency":"monthly","weekdays":[1],"month_day":5}),
    ] {
        let (status, _) = set_rule(&env, &env.owner, &task, rule.clone()).await;
        assert_eq!(status, 422, "{rule}");
    }
    assert!(reread(&env, &env.owner, &task).await["recurrence"].is_null());
    cleanup(env).await;
}

#[tokio::test]
async fn only_a_writer_manages_a_rule_and_nothing_leaks_to_others() {
    let env = setup().await;
    let project = project(&env, &env.owner, "restricted").await;
    let task = make_task(&env, &env.owner, project, None, Some("2030-03-04")).await;
    // A member with no access sees nothing: 404 whether or not the version is right.
    for version in [json!(task["version"]), json!(99)] {
        let (status, body) = put(
            &env,
            &format!("/tasks/{}/recurrence", task["id"].as_str().unwrap()),
            &env.member,
            json!({"frequency":"daily","expected_version":version}),
        )
        .await;
        assert_eq!(status, 404);
        assert!(body.is_null() || body.get("error").is_none());
    }
    // A viewer may look but not change.
    grant(&env, project, env.member.user, "viewer").await;
    let (status, _) = set_rule(&env, &env.member, &task, json!({"frequency":"daily"})).await;
    assert_eq!(status, 404);
    let (status, _) = call(
        &env,
        reqwest::Method::DELETE,
        &format!(
            "/tasks/{}/recurrence?expected_version={}",
            task["id"].as_str().unwrap(),
            task["version"]
        ),
        &env.member,
        None,
    )
    .await;
    assert_eq!(status, 404);
    let (status, _) = post(
        &env,
        &format!("/tasks/{}/recurrence/skip", task["id"].as_str().unwrap()),
        &env.member,
        json!({"expected_version":task["version"]}),
    )
    .await;
    assert_eq!(status, 404);
    // A contributor sets the rule.
    sqlx::query(
        "UPDATE project_memberships SET role='contributor' WHERE project_id=$1 AND user_id=$2",
    )
    .bind(project)
    .bind(env.member.user)
    .execute(&env.pool)
    .await
    .unwrap();
    let (status, with_rule) =
        set_rule(&env, &env.member, &task, json!({"frequency":"daily"})).await;
    assert_eq!(status, 200);
    // Once write access is gone the Task does not recur for that person: the completion is refused
    // and no occurrence exists.
    sqlx::query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2")
        .bind(project)
        .bind(env.member.user)
        .execute(&env.pool)
        .await
        .unwrap();
    let (status, _) = complete(&env, &env.member, &with_rule).await;
    assert_eq!(status, 404);
    assert_eq!(live_tasks(&env).await.len(), 1);
    cleanup(env).await;
}

#[tokio::test]
async fn archived_tasks_and_projects_do_not_recur_and_cannot_take_a_rule() {
    let env = setup().await;
    let project = project(&env, &env.owner, "workspace").await;
    let task = make_task(&env, &env.owner, project, None, Some("2030-03-04")).await;
    let (_, task) = set_rule(&env, &env.owner, &task, json!({"frequency":"daily"})).await;
    // An archived Project: the completion may be recorded but nothing is created.
    sqlx::query("UPDATE projects SET archived_at=now() WHERE id=$1")
        .bind(project)
        .execute(&env.pool)
        .await
        .unwrap();
    let (status, _) = set_rule(
        &env,
        &env.owner,
        &task,
        json!({"frequency":"weekly","weekdays":[2]}),
    )
    .await;
    assert_eq!(status, 404);
    complete(&env, &env.owner, &task).await;
    assert_eq!(live_tasks(&env).await.len(), 1);
    sqlx::query("UPDATE projects SET archived_at=NULL WHERE id=$1")
        .bind(project)
        .execute(&env.pool)
        .await
        .unwrap();
    // An archived Task takes no rule.
    sqlx::query("UPDATE tasks SET archived_at=now()")
        .execute(&env.pool)
        .await
        .unwrap();
    let (status, _) = set_rule(&env, &env.owner, &task, json!({"frequency":"daily"})).await;
    assert_eq!(status, 404);
    cleanup(env).await;
}

#[tokio::test]
async fn the_occurrence_drops_assignees_who_cannot_read_and_keeps_the_milestone() {
    let env = setup().await;
    let project = project(&env, &env.owner, "workspace").await;
    let (status, milestone) = post(
        &env,
        &format!("/projects/{project}/milestones"),
        &env.owner,
        json!({"name":"Beta"}),
    )
    .await;
    assert_eq!(status, 201, "{milestone}");
    let task = make_task(&env, &env.owner, project, None, Some("2030-03-04")).await;
    let (status, task) = patch(&env, &format!("/tasks/{}", task["id"].as_str().unwrap()), &env.owner, json!({"expected_version":task["version"],"milestone_id":milestone["id"],"assignees":[{"type":"user","id":env.member.user}]})).await;
    assert_eq!(status, 200, "{task}");
    let (_, task) = set_rule(&env, &env.owner, &task, json!({"frequency":"daily"})).await;
    complete(&env, &env.owner, &task).await;
    let tasks = live_tasks(&env).await;
    assert_eq!(tasks.len(), 2);
    let next = get(
        &env,
        &format!("/workspaces/{}/tasks/{}", env.workspace, tasks[1].1),
        &env.owner,
    )
    .await
    .1;
    assert_eq!(next["milestone_id"], milestone["id"]);
    assert_eq!(next["assignees"][0]["id"], json!(env.member.user));
    cleanup(env).await;
}

#[tokio::test]
async fn the_workspace_time_zone_decides_the_spawned_due_date() {
    let env = setup().await;
    let project = project(&env, &env.owner, "workspace").await;
    // UTC+14 and UTC-12 never share a calendar date with each other, so at least one of them
    // differs from the UTC date at any moment.
    for zone in ["Pacific/Kiritimati", "Etc/GMT+12"] {
        sqlx::query("UPDATE workspaces SET time_zone=$1")
            .bind(zone)
            .execute(&env.pool)
            .await
            .unwrap();
        let task = make_task(&env, &env.owner, project, None, None).await;
        let (_, task) = set_rule(&env, &env.owner, &task, json!({"frequency":"daily"})).await;
        let before = local_date(&env.pool, zone, None).await.unwrap();
        let (status, _) = complete(&env, &env.owner, &task).await;
        assert_eq!(status, 200);
        let after = local_date(&env.pool, zone, None).await.unwrap();
        let spawned: Option<String> = sqlx::query_scalar(
            "SELECT due_date::text FROM tasks WHERE archived_at IS NULL AND status='backlog' AND parent_task_id IS NULL AND id<>$1 ORDER BY number DESC LIMIT 1",
        )
        .bind(task["id"].as_str().unwrap().parse::<Uuid>().unwrap())
        .fetch_one(&env.pool)
        .await
        .unwrap();
        let spawned = spawned.unwrap();
        let wanted = [
            Rule::daily().next_after(before).to_string(),
            Rule::daily().next_after(after).to_string(),
        ];
        assert!(
            wanted.contains(&spawned),
            "{zone}: spawned {spawned}, wanted one of {wanted:?}"
        );
    }
    cleanup(env).await;
}

#[tokio::test]
async fn stopping_and_setting_a_rule_again_never_allows_a_second_live_occurrence() {
    let env = setup().await;
    let project = project(&env, &env.owner, "workspace").await;
    let task = make_task(&env, &env.owner, project, None, Some("2030-03-02")).await;
    let (_, task) = set_rule(&env, &env.owner, &task, json!({"frequency":"daily"})).await;
    let (_, done) = complete(&env, &env.owner, &task).await;
    assert_eq!(live_tasks(&env).await.len(), 2);
    let done = reread(&env, &env.owner, &done).await;
    let id = done["id"].as_str().unwrap().to_owned();
    let (status, stopped) = call(
        &env,
        reqwest::Method::DELETE,
        &format!(
            "/tasks/{id}/recurrence?expected_version={}",
            done["version"]
        ),
        &env.owner,
        None,
    )
    .await;
    assert_eq!(status, 200, "{stopped}");
    let (status, again) = set_rule(&env, &env.owner, &stopped, json!({"frequency":"daily"})).await;
    assert_eq!(status, 200, "{again}");
    let (_, reopened) = patch(
        &env,
        &format!("/tasks/{id}"),
        &env.owner,
        json!({"expected_version":again["version"],"status":"active"}),
    )
    .await;
    complete(&env, &env.owner, &reopened).await;
    assert_eq!(live_tasks(&env).await.len(), 2);
    cleanup(env).await;
}

// Confirm delivery locks the Milestone and then its Tasks; completing a repeating Task in that
// Milestone must take the same order (Milestone, then Task) or the two deadlock.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn completing_a_repeating_task_races_confirm_delivery_without_a_deadlock() {
    let env = setup().await;
    let project = project(&env, &env.owner, "workspace").await;
    for round in 0..40 {
        let (status, milestone) = post(
            &env,
            &format!("/projects/{project}/milestones"),
            &env.owner,
            json!({"name":format!("Round {round}")}),
        )
        .await;
        assert_eq!(status, 201, "{milestone}");
        let milestone_id: Uuid = milestone["id"].as_str().unwrap().parse().unwrap();
        let task = make_task(
            &env,
            &env.owner,
            project,
            Some("2025-01-01"),
            Some("2025-01-02"),
        )
        .await;
        let task = reread(&env, &env.owner, &task).await;
        let (status, ruled) = set_rule(&env, &env.owner, &task, json!({"frequency":"daily"})).await;
        assert_eq!(status, 200, "{ruled}");
        sqlx::query("UPDATE tasks SET milestone_id=$2 WHERE id=$1")
            .bind(task["id"].as_str().unwrap().parse::<Uuid>().unwrap())
            .bind(milestone_id)
            .execute(&env.pool)
            .await
            .unwrap();
        let confirm_path = format!("/milestones/{milestone_id}/confirm-delivery");
        let ((done_status, done), (confirm_status, confirm)) = tokio::join!(
            complete(&env, &env.owner, &ruled),
            post(
                &env,
                &confirm_path,
                &env.owner,
                json!({"expected_version":milestone["version"]}),
            )
        );
        assert_eq!(done_status, 200, "round {round}: {done}");
        // Either order is fine: confirmation succeeds before the completion, or is refused
        // because the next occurrence is open; it never fails with a server error.
        assert!(
            matches!(confirm_status, 200 | 409),
            "round {round}: {confirm_status} {confirm}"
        );
        let state: String = sqlx::query_scalar("SELECT state FROM milestones WHERE id=$1")
            .bind(milestone_id)
            .fetch_one(&env.pool)
            .await
            .unwrap();
        assert_eq!(state == "completed", confirm_status == 200, "round {round}");
        let open_in_milestone: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM tasks WHERE milestone_id=$1 AND archived_at IS NULL AND status<>'completed'",
        )
        .bind(milestone_id)
        .fetch_one(&env.pool)
        .await
        .unwrap();
        // A confirmed Milestone has no open Task; otherwise the next occurrence stays in it.
        assert!(confirm_status == 409 || open_in_milestone == 0 || state == "completed");
    }
    cleanup(env).await;
}

// Completion locks the Task row and then the recurrence row; the rule handlers must take the Task
// row first as well, or a completion racing them deadlocks.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn completing_a_repeating_task_races_rule_edits_without_a_deadlock() {
    let env = setup().await;
    let project = project(&env, &env.owner, "workspace").await;
    for round in 0..60 {
        for bulk in [false, true] {
            for op in ["stop", "set", "skip"] {
                let task = make_task(
                    &env,
                    &env.owner,
                    project,
                    Some("2025-01-01"),
                    Some("2025-01-02"),
                )
                .await;
                let task = reread(&env, &env.owner, &task).await;
                let (status, ruled) =
                    set_rule(&env, &env.owner, &task, json!({"frequency":"daily"})).await;
                assert_eq!(status, 200, "{ruled}");
                let id = ruled["id"].as_str().unwrap().to_string();
                let version = ruled["version"].clone();
                let completion = async {
                    if bulk {
                        post(
                            &env,
                            &format!("/workspaces/{}/tasks/bulk", env.workspace),
                            &env.owner,
                            json!({"items":[{"task_id":id,"expected_version":version,"status":"completed"}]}),
                        )
                        .await
                    } else {
                        complete(&env, &env.owner, &ruled).await
                    }
                };
                let rule_edit = async {
                    match op {
                        "stop" => {
                            call(
                                &env,
                                reqwest::Method::DELETE,
                                &format!("/tasks/{id}/recurrence?expected_version={version}"),
                                &env.owner,
                                None,
                            )
                            .await
                        }
                        "set" => put(
                            &env,
                            &format!("/tasks/{id}/recurrence"),
                            &env.owner,
                            json!({"expected_version":version,"frequency":"weekly","weekdays":[1]}),
                        )
                        .await,
                        _ => {
                            post(
                                &env,
                                &format!("/tasks/{id}/recurrence/skip"),
                                &env.owner,
                                json!({"expected_version":version}),
                            )
                            .await
                        }
                    }
                };
                let ((done_status, done), (edit_status, edit)) =
                    tokio::join!(completion, rule_edit);
                assert!(
                    matches!(done_status, 200 | 409),
                    "round {round} bulk={bulk} {op}: completion {done_status} {done}"
                );
                assert!(
                    matches!(edit_status, 200 | 404 | 409),
                    "round {round} bulk={bulk} {op}: edit {edit_status} {edit}"
                );
            }
        }
    }
    cleanup(env).await;
}
