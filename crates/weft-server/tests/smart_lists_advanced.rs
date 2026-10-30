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
    let schema = format!("smartq_{}_{}", std::process::id(), Uuid::new_v4().simple());
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

use serde_json::{json, Value};

struct Fx {
    origin: String,
    workspace: Uuid,
    client: reqwest::Client,
    pool: sqlx::PgPool,
    owner: Session,
    member: Session,
}

impl Fx {
    async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        who: &Session,
        body: Option<Value>,
    ) -> (reqwest::StatusCode, Value) {
        let mut builder = request(
            &self.client,
            method,
            format!("{}/api/v1{path}", self.origin),
            who,
        );
        if let Some(body) = body {
            builder = builder.json(&body);
        }
        let response = builder.send().await.unwrap();
        let status = response.status();
        let text = response.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    async fn project(&self, name: &str, visibility: &str) -> Uuid {
        let (status, body) = self
            .call(
                reqwest::Method::POST,
                &format!("/workspaces/{}/projects", self.workspace),
                &self.owner,
                Some(json!({"name":name,"visibility":visibility})),
            )
            .await;
        assert_eq!(status, 201, "{body}");
        body["id"].as_str().unwrap().parse().unwrap()
    }

    async fn task(&self, project: Uuid, title: &str, extra: Value) -> Value {
        let mut body = json!({"project_id":project,"title":title});
        for (key, value) in extra.as_object().unwrap() {
            body[key] = value.clone();
        }
        let (status, task) = self
            .call(
                reqwest::Method::POST,
                &format!("/workspaces/{}/tasks", self.workspace),
                &self.owner,
                Some(body),
            )
            .await;
        assert_eq!(status, 201, "{task}");
        task
    }

    async fn milestone(&self, project: Uuid, name: &str, state: &str) -> Uuid {
        let (status, body) = self
            .call(
                reqwest::Method::POST,
                &format!("/projects/{project}/milestones"),
                &self.owner,
                Some(json!({"name":name,"state":state})),
            )
            .await;
        assert_eq!(status, 201, "{body}");
        body["id"].as_str().unwrap().parse().unwrap()
    }

    async fn assign(&self, task: &Value, milestone: Uuid) {
        let (status, body) = self
            .call(
                reqwest::Method::PATCH,
                &format!("/tasks/{}", task["id"].as_str().unwrap()),
                &self.owner,
                Some(json!({"expected_version":task["version"],"milestone_id":milestone})),
            )
            .await;
        assert_eq!(status, 200, "{body}");
    }

    async fn smart(&self, who: &Session, query: Value) -> Value {
        let (status, list) = self
            .call(
                reqwest::Method::POST,
                &format!("/workspaces/{}/lists", self.workspace),
                who,
                Some(json!({"name":"Smart","kind":"smart","query":query})),
            )
            .await;
        assert_eq!(status, 201, "{list}");
        list
    }

    async fn run(&self, who: &Session, list: &Value) -> Value {
        let (status, body) = self
            .call(
                reqwest::Method::GET,
                &format!(
                    "/workspaces/{}/lists/{}",
                    self.workspace,
                    list["id"].as_str().unwrap()
                ),
                who,
                None,
            )
            .await;
        assert_eq!(status, 200, "{body}");
        body
    }

    async fn titles(&self, who: &Session, query: Value) -> Vec<String> {
        let list = self.smart(who, query).await;
        let mut titles: Vec<String> = self.run(who, &list).await["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["title"].as_str().unwrap().to_owned())
            .collect();
        titles.sort();
        titles
    }

    async fn today(&self) -> String {
        let (_, settings) = self
            .call(
                reqwest::Method::GET,
                &format!("/workspaces/{}/settings", self.workspace),
                &self.member,
                None,
            )
            .await;
        settings["today"].as_str().unwrap().to_owned()
    }

    async fn day(&self, offset: i32) -> String {
        sqlx::query_scalar("SELECT ($1::date + $2::int)::text")
            .bind(self.today().await)
            .bind(offset)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }
}

async fn fx() -> (Fx, tokio::task::JoinHandle<()>, String, sqlx::PgPool) {
    let (origin, server, schema, admin, workspace, owner, member) = setup().await;
    let pool = sqlx::PgPool::connect(&format!(
        "{}?options=-csearch_path%3D{schema}",
        env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://weft:weft@127.0.0.1:55432/postgres".into())
    ))
    .await
    .unwrap();
    (
        Fx {
            origin,
            workspace,
            client: reqwest::Client::new(),
            pool,
            owner,
            member,
        },
        server,
        schema,
        admin,
    )
}

fn cond(field: &str, op: &str, value: Value) -> Value {
    json!({"field":field,"op":op,"value":value})
}

#[tokio::test(flavor = "multi_thread")]
async fn nested_and_or_groups_combine_conditions() {
    let (fx, server, schema, admin) = fx().await;
    let project = fx.project("Plan", "workspace").await;
    let today = fx.day(0).await;
    let past = fx.day(-3).await;
    let later = fx.day(30).await;
    fx.task(
        project,
        "urgent today",
        json!({"priority":"urgent","due_date":today}),
    )
    .await;
    fx.task(
        project,
        "normal today",
        json!({"priority":"normal","due_date":today}),
    )
    .await;
    fx.task(
        project,
        "urgent overdue",
        json!({"priority":"urgent","due_date":past}),
    )
    .await;
    fx.task(
        project,
        "urgent later",
        json!({"priority":"urgent","due_date":later}),
    )
    .await;
    fx.task(project, "plain", json!({})).await;
    // (due today OR overdue) AND priority urgent
    let query = json!({"logic":"and","filters":[
        {"logic":"or","filters":[cond("due_date","relative",json!("today")),cond("due_date","relative",json!("overdue"))]},
        cond("priority","eq",json!("urgent"))
    ]});
    assert_eq!(
        fx.titles(&fx.owner, query).await,
        ["urgent overdue", "urgent today"]
    );
    // OR of an AND group and a leaf, two levels deep
    let query = json!({"logic":"or","filters":[
        {"logic":"and","filters":[cond("priority","eq",json!("normal")),{"logic":"or","filters":[cond("due_date","relative",json!("today"))]}]},
        cond("due_date","relative",json!("overdue"))
    ]});
    assert_eq!(
        fx.titles(&fx.owner, query).await,
        ["normal today", "urgent overdue"]
    );
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn relative_dates_cover_next_days_week_and_month() {
    let (fx, server, schema, admin) = fx().await;
    let project = fx.project("Dates", "workspace").await;
    let today = fx.today().await;
    let (first, last, next_first, next_last, week_first, week_last): (String, String, String, String, String, String) =
        sqlx::query_as("SELECT date_trunc('month',$1::date)::date::text,(date_trunc('month',$1::date)+interval '1 month - 1 day')::date::text,(date_trunc('month',$1::date)+interval '1 month')::date::text,(date_trunc('month',$1::date)+interval '2 month - 1 day')::date::text,($1::date-((extract(dow FROM $1::date)::int-1+7)%7))::text,($1::date-((extract(dow FROM $1::date)::int-1+7)%7)+6)::text")
            .bind(&today)
            .fetch_one(&fx.pool)
            .await
            .unwrap();
    let after_next = fx.day(120).await;
    for (title, date) in [
        ("month first", &first),
        ("month last", &last),
        ("next month first", &next_first),
        ("next month last", &next_last),
        ("week first", &week_first),
        ("week last", &week_last),
        ("far", &after_next),
        ("in 3", &fx.day(3).await),
        ("in 12", &fx.day(12).await),
    ] {
        fx.task(project, title, json!({"due_date":date})).await;
    }
    let titles = |name: &str| {
        let query = json!({"logic":"and","filters":[cond("due_date","relative",json!(name))]});
        let name = name.to_owned();
        async move { (name, query) }
    };
    let (_, q) = titles("this_month").await;
    let this_month = fx.titles(&fx.owner, q).await;
    assert!(
        this_month.contains(&"month first".to_owned())
            && this_month.contains(&"month last".to_owned())
    );
    assert!(
        !this_month.contains(&"next month first".to_owned())
            && !this_month.contains(&"far".to_owned())
    );
    let (_, q) = titles("next_month").await;
    let next_month = fx.titles(&fx.owner, q).await;
    assert!(
        next_month.contains(&"next month first".to_owned())
            && next_month.contains(&"next month last".to_owned())
    );
    for outside in ["month first", "month last", "far"] {
        assert!(!next_month.contains(&outside.to_owned()), "{outside}");
    }
    let (_, q) = titles("this_week").await;
    let this_week = fx.titles(&fx.owner, q).await;
    assert!(
        this_week.contains(&"week first".to_owned()) && this_week.contains(&"week last".to_owned())
    );
    assert!(!this_week.contains(&"far".to_owned()));
    let (_, q) = titles("next_5_days").await;
    let five = fx.titles(&fx.owner, q).await;
    assert!(five.contains(&"in 3".to_owned()) && !five.contains(&"in 12".to_owned()));
    let (_, q) = titles("next_14_days").await;
    assert!(fx.titles(&fx.owner, q).await.contains(&"in 12".to_owned()));
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn today_follows_the_workspace_time_zone() {
    let (fx, server, schema, admin) = fx().await;
    let project = fx.project("Zone", "workspace").await;
    let settings = format!("/workspaces/{}/settings", fx.workspace);
    let patch = |zone: &'static str| {
        fx.call(
            reqwest::Method::PATCH,
            &settings,
            &fx.owner,
            Some(json!({"time_zone":zone})),
        )
    };
    assert_eq!(patch("Pacific/Kiritimati").await.0, 200);
    let east = fx.today().await;
    assert_eq!(patch("Etc/GMT+12").await.0, 200);
    let west = fx.today().await;
    assert_ne!(east, west, "zones 26 hours apart must disagree on the date");
    fx.task(project, "east day", json!({"due_date":east})).await;
    fx.task(project, "west day", json!({"due_date":west})).await;
    let today_query =
        || json!({"logic":"and","filters":[cond("due_date","relative",json!("today"))]});
    assert_eq!(fx.titles(&fx.owner, today_query()).await, ["west day"]);
    assert_eq!(patch("Pacific/Kiritimati").await.0, 200);
    assert_eq!(fx.titles(&fx.owner, today_query()).await, ["east day"]);
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn milestone_and_milestone_state_filter_sort_and_group() {
    let (fx, server, schema, admin) = fx().await;
    let project = fx.project("Delivery", "workspace").await;
    let beta = fx.milestone(project, "Beta", "active").await;
    let alpha = fx.milestone(project, "Alpha", "completed").await;
    let t_beta = fx.task(project, "in beta", json!({})).await;
    let t_alpha = fx.task(project, "in alpha", json!({})).await;
    fx.task(project, "loose", json!({})).await;
    fx.assign(&t_beta, beta).await;
    fx.assign(&t_alpha, alpha).await;
    let q = |filter: Value| json!({"logic":"and","filters":[filter]});
    assert_eq!(
        fx.titles(&fx.owner, q(cond("milestone", "eq", json!(beta))))
            .await,
        ["in beta"]
    );
    assert_eq!(
        fx.titles(&fx.owner, q(cond("milestone", "eq", Value::Null)))
            .await,
        ["loose"]
    );
    assert_eq!(
        fx.titles(&fx.owner, q(cond("milestone", "neq", json!(beta))))
            .await,
        ["in alpha", "loose"]
    );
    assert_eq!(
        fx.titles(
            &fx.owner,
            q(cond("milestone_state", "eq", json!("completed")))
        )
        .await,
        ["in alpha"]
    );
    assert_eq!(
        fx.titles(
            &fx.owner,
            q(cond("milestone_state", "neq", json!("completed")))
        )
        .await,
        ["in beta", "loose"]
    );
    let sorted = fx
        .smart(&fx.owner, json!({"logic":"and","filters":[],"sort":[{"field":"milestone","direction":"desc"}],"group":"milestone_state"}))
        .await;
    assert_eq!(sorted["query"]["group"], "milestone_state");
    let run = fx.run(&fx.owner, &sorted).await;
    let order: Vec<&str> = run["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["title"].as_str().unwrap())
        .collect();
    assert_eq!(order, ["in beta", "in alpha", "loose"]);
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn invalid_and_over_complex_queries_are_refused_with_a_message() {
    let (fx, server, schema, admin) = fx().await;
    let leaf = cond("status", "eq", json!("todo"));
    let mut deep = json!({"logic":"and","filters":[leaf.clone()]});
    for _ in 0..5 {
        deep = json!({"logic":"or","filters":[deep]});
    }
    let bad = [
        json!({"logic":"and","filters":[deep]}),
        json!({"logic":"and","filters":vec![leaf.clone(); 51]}),
        json!({"logic":"and","filters":[cond("due_date","relative",json!("next_9999_days"))]}),
        json!({"logic":"and","filters":[cond("status","relative",json!("today"))]}),
        json!({"logic":"and","filters":[cond("milestone_state","eq",json!("someday"))]}),
        json!({"logic":"xor","filters":[]}),
        json!({"logic":"and","filters":[{"logic":"or","filters":[]}]}),
        json!({"logic":"and","filters":[],"sort":[{"field":"secret","direction":"asc"}]}),
    ];
    for query in bad {
        let (status, body) = fx
            .call(
                reqwest::Method::POST,
                &format!("/workspaces/{}/lists", fx.workspace),
                &fx.owner,
                Some(json!({"name":"Bad","kind":"smart","query":query})),
            )
            .await;
        assert_eq!(status, 422, "{query}");
        assert!(!body["message"].as_str().unwrap_or("").is_empty(), "{body}");
    }
    let list = fx
        .smart(&fx.owner, json!({"logic":"and","filters":[]}))
        .await;
    let (status, body) = fx
        .call(
            reqwest::Method::PATCH,
            &format!(
                "/workspaces/{}/lists/{}",
                fx.workspace,
                list["id"].as_str().unwrap()
            ),
            &fx.owner,
            Some(json!({"query":{"logic":"and","filters":[{"logic":"or","filters":[]}]}})),
        )
        .await;
    assert_eq!(status, 422);
    assert!(body["message"].is_string());
    let path = format!(
        "/workspaces/{}/lists/{}",
        fx.workspace,
        list["id"].as_str().unwrap()
    );
    for page in ["limit=501", "limit=0", "offset=-1"] {
        let (status, _) = fx
            .call(
                reqwest::Method::GET,
                &format!("{path}?{page}"),
                &fx.owner,
                None,
            )
            .await;
        assert_eq!(status, 422, "{page}");
    }
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn pages_slice_the_visible_results_and_report_the_visible_total() {
    let (fx, server, schema, admin) = fx().await;
    let project = fx.project("Many", "workspace").await;
    for n in 0..5 {
        fx.task(project, &format!("task {n}"), json!({})).await;
    }
    let list = fx
        .smart(
            &fx.owner,
            json!({"logic":"and","filters":[],"sort":[{"field":"number","direction":"asc"}]}),
        )
        .await;
    let path = format!(
        "/workspaces/{}/lists/{}?limit=2&offset=2",
        fx.workspace,
        list["id"].as_str().unwrap()
    );
    let (status, page) = fx.call(reqwest::Method::GET, &path, &fx.owner, None).await;
    assert_eq!(status, 200);
    assert_eq!(page["total"], 5);
    let titles: Vec<&str> = page["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["title"].as_str().unwrap())
        .collect();
    assert_eq!(titles, ["task 2", "task 3"]);
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn results_use_the_openers_access_and_counts_hide_unreadable_tasks() {
    let (fx, server, schema, admin) = fx().await;
    let open = fx.project("Open", "workspace").await;
    let secret = fx.project("Secret", "restricted").await;
    let open_milestone = fx.milestone(open, "Open delivery", "active").await;
    let secret_milestone = fx.milestone(secret, "Secret delivery", "active").await;
    let visible = fx.task(open, "visible", json!({})).await;
    let hidden = fx.task(secret, "hidden title", json!({})).await;
    fx.assign(&visible, open_milestone).await;
    fx.assign(&hidden, secret_milestone).await;
    // The owner builds the list and shares it; the other member opens it.
    let list = fx
        .smart(
            &fx.owner,
            json!({"logic":"or","filters":[
                cond("milestone_state","eq",json!("active")),
                cond("milestone","eq",json!(secret_milestone)),
                {"logic":"and","filters":[cond("milestone","neq",Value::Null)]}
            ]}),
        )
        .await;
    let as_owner = fx.run(&fx.owner, &list).await;
    assert_eq!(as_owner["total"], 2);
    let as_member = fx.run(&fx.member, &list).await;
    assert_eq!(as_member["total"], 1);
    let body = as_member.to_string();
    assert!(body.contains("visible"));
    assert!(
        !body.contains("hidden title") && !body.contains("Secret delivery"),
        "{body}"
    );
    // Filtering on a hidden Milestone id reveals nothing: an empty result, same as an unknown id.
    let probe = fx
        .smart(
            &fx.member,
            json!({"logic":"and","filters":[cond("milestone","eq",json!(secret_milestone))]}),
        )
        .await;
    let hit = fx.run(&fx.member, &probe).await;
    let unknown = fx
        .smart(
            &fx.member,
            json!({"logic":"and","filters":[cond("milestone","eq",json!(Uuid::new_v4()))]}),
        )
        .await;
    let miss = fx.run(&fx.member, &unknown).await;
    assert_eq!(
        (hit["total"].clone(), hit["tasks"].clone()),
        (miss["total"].clone(), miss["tasks"].clone())
    );
    cleanup(server, schema, admin).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn existing_smart_lists_keep_working_unchanged() {
    let (fx, server, schema, admin) = fx().await;
    let project = fx.project("Legacy", "workspace").await;
    fx.task(project, "soon", json!({"due_date":fx.day(2).await}))
        .await;
    fx.task(project, "later", json!({"due_date":fx.day(40).await}))
        .await;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO task_lists(id,workspace_id,name,kind,query,created_by) VALUES($1,$2,'Old','smart',$3,$4)")
        .bind(id)
        .bind(fx.workspace)
        .bind(json!({"filters":[{"field":"due_date","op":"relative","value":"next_7_days"}],"logic":"and","sort":[],"group":null,"columns":["title"]}))
        .bind(fx.owner.user_id)
        .execute(&fx.pool)
        .await
        .unwrap();
    let run = fx.run(&fx.member, &json!({"id":id})).await;
    let titles: Vec<&str> = run["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["title"].as_str().unwrap())
        .collect();
    assert_eq!(titles, ["soon"]);
    assert_eq!(run["query"]["logic"], "and");
    cleanup(server, schema, admin).await;
}
