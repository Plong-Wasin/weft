//! Recurring Tasks. A rule (daily, weekly on chosen days, monthly on a day or the last day) is stored
//! beside a Task. Completing the Task creates the next occurrence inside the same Operation group, so
//! Undo of the completion archives it again and Redo restores it. Dates are date-only: the rule is
//! pure calendar arithmetic, and the Workspace time zone only decides what "today" is for a Task that
//! has no date to shift. A rule never grants access: the next occurrence is created only in the
//! Project the completer can write, and archived Tasks or Projects never recur.

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{post, put},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use std::fmt;
use uuid::Uuid;

use crate::{
    auth::{require_session, AuthState},
    tasks::{
        assignees_value, can_write, replace_assignees, serialize_task, task_row, validate_assignees,
    },
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Date {
    pub year: i32,
    pub month: u32,
    pub day: u32,
}

impl Date {
    pub fn new(year: i32, month: u32, day: u32) -> Option<Date> {
        (1..=12)
            .contains(&month)
            .then_some(())
            .filter(|_| day >= 1 && day <= days_in_month(year, month))
            .map(|_| Date { year, month, day })
    }

    pub fn parse(text: &str) -> Option<Date> {
        let mut parts = text.splitn(3, '-');
        let year = parts.next()?.parse().ok()?;
        let month = parts.next()?.parse().ok()?;
        let day = parts.next()?.parse().ok()?;
        Date::new(year, month, day)
    }

    /// Days since 1970-01-01 (proleptic Gregorian).
    pub fn to_days(self) -> i64 {
        let y = i64::from(self.year) - i64::from(self.month <= 2);
        let era = y.div_euclid(400);
        let yoe = y.rem_euclid(400);
        let m = i64::from(self.month);
        let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(self.day) - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146_097 + doe - 719_468
    }

    pub fn from_days(days: i64) -> Date {
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
        let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
        let year = (yoe + era * 400 + i64::from(month <= 2)) as i32;
        Date { year, month, day }
    }

    pub fn add_days(self, days: i64) -> Date {
        Date::from_days(self.to_days() + days)
    }

    /// ISO weekday: 1 = Monday .. 7 = Sunday.
    pub fn weekday(self) -> u8 {
        // 1970-01-01 was a Thursday (4).
        ((self.to_days() + 3).rem_euclid(7) + 1) as u8
    }
}

impl fmt::Display for Date {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }
}

pub fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        _ => 28,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Frequency {
    Daily,
    Weekly,
    Monthly,
}

impl Frequency {
    fn as_str(self) -> &'static str {
        match self {
            Frequency::Daily => "daily",
            Frequency::Weekly => "weekly",
            Frequency::Monthly => "monthly",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rule {
    pub frequency: Frequency,
    /// ISO weekdays (1 = Monday .. 7 = Sunday), sorted and unique; weekly rules only.
    pub weekdays: Vec<u8>,
    /// Day of the month; a month that is too short uses its last day. Monthly rules only.
    pub month_day: Option<u8>,
    pub last_day_of_month: bool,
}

impl Rule {
    pub fn daily() -> Rule {
        Rule {
            frequency: Frequency::Daily,
            weekdays: Vec::new(),
            month_day: None,
            last_day_of_month: false,
        }
    }

    pub fn weekly(days: &[u8]) -> Option<Rule> {
        let mut weekdays = days.to_vec();
        weekdays.sort_unstable();
        weekdays.dedup();
        (!weekdays.is_empty() && weekdays.iter().all(|d| (1..=7).contains(d))).then_some(Rule {
            frequency: Frequency::Weekly,
            weekdays,
            month_day: None,
            last_day_of_month: false,
        })
    }

    pub fn monthly_on(day: u8) -> Option<Rule> {
        (1..=31).contains(&day).then_some(Rule {
            frequency: Frequency::Monthly,
            weekdays: Vec::new(),
            month_day: Some(day),
            last_day_of_month: false,
        })
    }

    pub fn monthly_last_day() -> Rule {
        Rule {
            frequency: Frequency::Monthly,
            weekdays: Vec::new(),
            month_day: None,
            last_day_of_month: true,
        }
    }

    /// The first occurrence strictly after `date`.
    pub fn next_after(&self, date: Date) -> Date {
        match self.frequency {
            Frequency::Daily => date.add_days(1),
            Frequency::Weekly => (1..=7)
                .map(|offset| date.add_days(offset))
                .find(|candidate| self.weekdays.contains(&candidate.weekday()))
                .unwrap_or_else(|| date.add_days(7)),
            Frequency::Monthly => {
                let in_month = |year: i32, month: u32| {
                    let last = days_in_month(year, month);
                    let day = if self.last_day_of_month {
                        last
                    } else {
                        u32::from(self.month_day.unwrap_or(1)).min(last)
                    };
                    Date { year, month, day }
                };
                let this_month = in_month(date.year, date.month);
                if this_month > date {
                    this_month
                } else if date.month == 12 {
                    in_month(date.year + 1, 1)
                } else {
                    in_month(date.year, date.month + 1)
                }
            }
        }
    }

    /// Start and due date of the next occurrence. The rule moves the Task's own anchor (its due
    /// date, else its start date) to the next occurrence and shifts both dates by the same number of
    /// days, so the span between them is kept. With no date at all the next occurrence is due on the
    /// first occurrence after `today` (the Workspace-local date, passed in).
    pub fn shift(
        &self,
        start: Option<Date>,
        due: Option<Date>,
        today: Date,
    ) -> (Option<Date>, Option<Date>) {
        match due.or(start) {
            Some(anchor) => {
                let delta = self.next_after(anchor).to_days() - anchor.to_days();
                (
                    start.map(|d| d.add_days(delta)),
                    due.map(|d| d.add_days(delta)),
                )
            }
            None => (None, Some(self.next_after(today))),
        }
    }

    pub fn from_json(value: &Value) -> Option<Rule> {
        let object = value.as_object()?;
        if object.keys().any(|key| {
            !["frequency", "weekdays", "month_day", "last_day_of_month"].contains(&key.as_str())
        }) {
            return None;
        }
        let last_day = match object.get("last_day_of_month") {
            None | Some(Value::Null) => false,
            Some(Value::Bool(flag)) => *flag,
            Some(_) => return None,
        };
        let present = |key: &str| object.get(key).is_some_and(|v| !v.is_null());
        let empty_weekdays = object
            .get("weekdays")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty);
        match object.get("frequency")?.as_str()? {
            "daily" => {
                (!present("month_day") && (!present("weekdays") || empty_weekdays) && !last_day)
                    .then(Rule::daily)
            }
            "weekly" => {
                if present("month_day") || last_day {
                    return None;
                }
                let days: Option<Vec<u8>> = object
                    .get("weekdays")?
                    .as_array()?
                    .iter()
                    .map(|v| v.as_u64().and_then(|n| u8::try_from(n).ok()))
                    .collect();
                Rule::weekly(&days?)
            }
            "monthly" => {
                if present("weekdays") && !empty_weekdays {
                    return None;
                }
                let day = match object.get("month_day") {
                    None | Some(Value::Null) => None,
                    Some(v) => Some(u8::try_from(v.as_u64()?).ok()?),
                };
                match (day, last_day) {
                    (Some(_), true) | (None, false) => None,
                    (Some(day), false) => Rule::monthly_on(day),
                    (None, true) => Some(Rule::monthly_last_day()),
                }
            }
            _ => None,
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "frequency": self.frequency.as_str(),
            "weekdays": self.weekdays,
            "month_day": self.month_day,
            "last_day_of_month": self.last_day_of_month,
        })
    }

    fn from_row(row: &sqlx::postgres::PgRow) -> Option<Rule> {
        let frequency = match row.get::<String, _>("frequency").as_str() {
            "daily" => Frequency::Daily,
            "weekly" => Frequency::Weekly,
            "monthly" => Frequency::Monthly,
            _ => return None,
        };
        Some(Rule {
            frequency,
            weekdays: row
                .get::<Vec<i16>, _>("weekdays")
                .into_iter()
                .filter_map(|d| u8::try_from(d).ok())
                .collect(),
            month_day: row
                .get::<Option<i16>, _>("month_day")
                .and_then(|d| u8::try_from(d).ok()),
            last_day_of_month: row.get("last_day_of_month"),
        })
    }
}

/// The calendar date of `instant` in `zone`, computed by Postgres so daylight-saving rules are the
/// database's tz data. Callers pass the instant in; production passes the current time.
pub async fn local_date(
    conn: impl sqlx::PgExecutor<'_>,
    zone: &str,
    instant: Option<&str>,
) -> Result<Date, sqlx::Error> {
    let text: String = sqlx::query_scalar(
        "SELECT ((COALESCE($1::timestamptz, now())) AT TIME ZONE $2)::date::text",
    )
    .bind(instant)
    .bind(zone)
    .fetch_one(conn)
    .await?;
    Date::parse(&text).ok_or(sqlx::Error::RowNotFound)
}

/// The rule of a Task as shown on it (null when it does not repeat).
pub(crate) async fn summary(
    pool: impl sqlx::PgExecutor<'_>,
    task: Uuid,
) -> Result<Value, sqlx::Error> {
    Ok(sqlx::query("SELECT frequency,weekdays,month_day,last_day_of_month FROM task_recurrences WHERE task_id=$1")
        .bind(task)
        .fetch_optional(pool)
        .await?
        .and_then(|row| Rule::from_row(&row))
        .map_or(Value::Null, |rule| rule.to_json()))
}

/// Creates the next occurrence of a Task that was just completed by `user`, as part of the Operation
/// `group`. Returns the new Task, or `None` when the Task does not recur: no rule, an archived Task or
/// Project, a completer without write access, or an occurrence that is already waiting. `now` is the
/// time the rule is evaluated at (None means the database clock).
pub(crate) async fn spawn_next(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    task: Uuid,
    group: Uuid,
    user: Uuid,
    now: Option<&str>,
) -> Result<Option<Uuid>, sqlx::Error> {
    let Some(rule_row) = sqlx::query("SELECT frequency,weekdays,month_day,last_day_of_month,spawned_task_id FROM task_recurrences WHERE task_id=$1 FOR UPDATE")
        .bind(task)
        .fetch_optional(&mut **tx)
        .await?
    else {
        return Ok(None);
    };
    let Some(rule) = Rule::from_row(&rule_row) else {
        return Ok(None);
    };
    let source = sqlx::query("SELECT t.workspace_id,t.project_id,t.parent_task_id,t.title,t.description,t.priority,t.milestone_id,t.start_date::text AS start_date,t.due_date::text AS due_date,w.time_zone FROM tasks t JOIN projects p ON p.id=t.project_id JOIN workspaces w ON w.id=t.workspace_id WHERE t.id=$1 AND t.archived_at IS NULL AND p.archived_at IS NULL")
        .bind(task)
        .fetch_optional(&mut **tx)
        .await?;
    let Some(source) = source else {
        return Ok(None);
    };
    let workspace: Uuid = source.get("workspace_id");
    let project: Uuid = source.get("project_id");
    // A live occurrence spawned from this Task is still waiting, whatever happened to the rule
    // since (stop and set again included).
    let waiting: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM tasks WHERE spawned_from_task_id=$1 AND archived_at IS NULL)",
    )
    .bind(task)
    .fetch_one(&mut **tx)
    .await?;
    if waiting {
        return Ok(None);
    }
    if !can_write(&mut **tx, project, user).await? {
        return Ok(None);
    }
    let parent: Option<Uuid> = source.get("parent_task_id");
    if let Some(parent) = parent {
        let live: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=$1 AND archived_at IS NULL)",
        )
        .bind(parent)
        .fetch_one(&mut **tx)
        .await?;
        if !live {
            return Ok(None);
        }
    }
    let zone: String = source.get("time_zone");
    let today = local_date(&mut **tx, &zone, now).await?;
    let start = source
        .get::<Option<String>, _>("start_date")
        .and_then(|d| Date::parse(&d));
    let due = source
        .get::<Option<String>, _>("due_date")
        .and_then(|d| Date::parse(&d));
    let (next_start, next_due) = rule.shift(start, due, today);
    let status: Option<String> = sqlx::query_scalar("SELECT status_key FROM workspace_statuses WHERE workspace_id=$1 AND category='not_started' AND archived_at IS NULL ORDER BY (status_key='backlog') DESC,position LIMIT 1")
        .bind(workspace)
        .fetch_optional(&mut **tx)
        .await?;
    let Some(status) = status else {
        return Ok(None);
    };
    let milestone: Option<Uuid> = match source.get::<Option<Uuid>, _>("milestone_id") {
        Some(milestone) if crate::milestones::assignable(tx, project, milestone).await? => {
            Some(milestone)
        }
        _ => None,
    };
    let number: i64 = sqlx::query_scalar(
        "UPDATE workspaces SET next_task_number=next_task_number+1 WHERE id=$1 RETURNING next_task_number-1",
    )
    .bind(workspace)
    .fetch_one(&mut **tx)
    .await?;
    let next = Uuid::new_v4();
    sqlx::query("INSERT INTO tasks(id,workspace_id,number,project_id,parent_task_id,title,description,status,priority,start_date,due_date,milestone_id,created_by,spawned_from_task_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11::date,$12,$13,$14)")
        .bind(next)
        .bind(workspace)
        .bind(number)
        .bind(project)
        .bind(parent)
        .bind(source.get::<String, _>("title"))
        .bind(source.get::<String, _>("description"))
        .bind(status)
        .bind(source.get::<String, _>("priority"))
        .bind(next_start.map(|d| d.to_string()))
        .bind(next_due.map(|d| d.to_string()))
        .bind(milestone)
        .bind(user)
        .bind(task)
        .execute(&mut **tx)
        .await?;
    sqlx::query("INSERT INTO task_checklist_items(id,workspace_id,task_id,title,checked,position) SELECT gen_random_uuid(),workspace_id,$2,title,false,position FROM task_checklist_items WHERE task_id=$1")
        .bind(task)
        .bind(next)
        .execute(&mut **tx)
        .await?;
    sqlx::query("INSERT INTO task_attribute_values(workspace_id,task_id,attribute_id,value) SELECT workspace_id,$2,attribute_id,value FROM task_attribute_values WHERE task_id=$1")
        .bind(task)
        .bind(next)
        .execute(&mut **tx)
        .await?;
    // Assignment never grants access: keep only assignees who can still read the Project.
    let assignees = assignees_value(&mut **tx, task).await?;
    if assignees.as_array().is_some_and(|a| !a.is_empty())
        && validate_assignees(tx, workspace, project, &assignees).await?
    {
        replace_assignees(tx, next, workspace, &assignees).await?;
    }
    sqlx::query("INSERT INTO task_recurrences(task_id,workspace_id,frequency,weekdays,month_day,last_day_of_month,created_by) SELECT $2,workspace_id,frequency,weekdays,month_day,last_day_of_month,$3 FROM task_recurrences WHERE task_id=$1")
        .bind(task)
        .bind(next)
        .bind(user)
        .execute(&mut **tx)
        .await?;
    sqlx::query("UPDATE task_recurrences SET spawned_task_id=$2,updated_at=now() WHERE task_id=$1")
        .bind(task)
        .bind(next)
        .execute(&mut **tx)
        .await?;
    // Same shape as Duplicate and template creation: Undo archives the new Task, Redo restores it.
    sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,'archived','true'::jsonb,'false'::jsonb,1)")
        .bind(Uuid::new_v4())
        .bind(group)
        .bind(next)
        .execute(&mut **tx)
        .await?;
    Ok(Some(next))
}

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route(
            "/tasks/:task_id/recurrence",
            put(set_rule).delete(stop_rule),
        )
        .route("/tasks/:task_id/recurrence/skip", post(skip_occurrence))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetRule {
    frequency: String,
    #[serde(default)]
    weekdays: Option<Vec<u8>>,
    #[serde(default)]
    month_day: Option<u8>,
    #[serde(default)]
    last_day_of_month: Option<bool>,
    expected_version: i64,
    #[serde(default)]
    command_id: Option<Uuid>,
}

#[derive(Deserialize)]
struct StopRule {
    expected_version: i64,
    #[serde(default)]
    command_id: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Skip {
    expected_version: i64,
    #[serde(default)]
    command_id: Option<Uuid>,
}

struct Target {
    workspace: Uuid,
    number: i64,
    project: Uuid,
    version: i64,
    start: Option<String>,
    due: Option<String>,
}

enum Gate {
    Ready(Target),
    Reply(Response),
}

fn error(status: StatusCode, code: &'static str) -> Response {
    (status, Json(json!({"error": code}))).into_response()
}

/// Access first, then the version: the caller must be able to write the Task's Project before it
/// learns anything about the Task.
async fn gate(state: &AuthState, task: Uuid, user: Uuid, expected_version: i64) -> Gate {
    let row = match sqlx::query("SELECT t.workspace_id,t.number,t.project_id,t.version,t.start_date::text AS start_date,t.due_date::text AS due_date FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=$1 AND t.archived_at IS NULL AND p.archived_at IS NULL")
        .bind(task)
        .fetch_optional(&state.pool)
        .await
    {
        Ok(Some(row)) => row,
        Ok(None) => return Gate::Reply(StatusCode::NOT_FOUND.into_response()),
        Err(_) => return Gate::Reply(StatusCode::INTERNAL_SERVER_ERROR.into_response()),
    };
    let project: Uuid = row.get("project_id");
    match can_write(&state.pool, project, user).await {
        Ok(true) => {}
        Ok(false) => return Gate::Reply(StatusCode::NOT_FOUND.into_response()),
        Err(_) => return Gate::Reply(StatusCode::INTERNAL_SERVER_ERROR.into_response()),
    }
    if row.get::<i64, _>("version") != expected_version {
        return Gate::Reply(error(StatusCode::CONFLICT, "version_conflict"));
    }
    Gate::Ready(Target {
        workspace: row.get("workspace_id"),
        number: row.get("number"),
        project,
        version: row.get("version"),
        start: row.get("start_date"),
        due: row.get("due_date"),
    })
}

/// Locks the Task row, re-checks version, archive state and write access inside the transaction and
/// returns the new version once the write has been recorded as one Operation group.
async fn record(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    task: Uuid,
    target: &Target,
    user: Uuid,
    command: Option<Uuid>,
    changes: &[(&str, Value, Value)],
) -> Result<Option<i64>, sqlx::Error> {
    let version = sqlx::query_scalar::<_, i64>("UPDATE tasks SET version=version+1,updated_at=now() WHERE id=$1 AND version=$2 AND archived_at IS NULL RETURNING version")
        .bind(task)
        .bind(target.version)
        .fetch_optional(&mut **tx)
        .await?;
    let Some(version) = version else {
        return Ok(None);
    };
    if !can_write(&mut **tx, target.project, user).await? {
        return Ok(None);
    }
    let group = Uuid::new_v4();
    sqlx::query("INSERT INTO task_operation_groups(id,command_id,workspace_id,actor_id) VALUES($1,$2,$3,$4)")
        .bind(group)
        .bind(command.unwrap_or_else(Uuid::new_v4))
        .bind(target.workspace)
        .bind(user)
        .execute(&mut **tx)
        .await?;
    sqlx::query("UPDATE task_operation_groups SET state='suppressed' WHERE workspace_id=$1 AND actor_id=$2 AND state='undone'")
        .bind(target.workspace)
        .bind(user)
        .execute(&mut **tx)
        .await?;
    for (field, before, after) in changes {
        sqlx::query("INSERT INTO task_operations(id,group_id,task_id,field_key,before_value,after_value,task_version) VALUES($1,$2,$3,$4,$5,$6,$7)")
            .bind(Uuid::new_v4())
            .bind(group)
            .bind(task)
            .bind(*field)
            .bind(before)
            .bind(after)
            .bind(version)
            .execute(&mut **tx)
            .await?;
    }
    Ok(Some(version))
}

async fn reply_task(state: &AuthState, target: &Target, user: Uuid) -> Response {
    match task_row(&state.pool, target.workspace, target.number, false).await {
        Ok(Some(row)) => match serialize_task(&state.pool, &row, Some(user)).await {
            Ok(value) => Json(value).into_response(),
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        },
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Takes the Milestone lock (when the Task has one) and then the Task row, before the handler
/// touches the recurrence rule. Task completion locks in this order (Milestone, Task, rule), so
/// the rule handlers must too, or the two deadlock.
async fn lock_task_first(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    task: Uuid,
) -> Result<(), sqlx::Error> {
    crate::milestones::lock_for_tasks(tx, &[task]).await?;
    sqlx::query("SELECT id FROM tasks WHERE id=$1 FOR UPDATE")
        .bind(task)
        .fetch_optional(&mut **tx)
        .await?;
    Ok(())
}

async fn set_rule(
    State(state): State<AuthState>,
    Path(task): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<SetRule>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let target = match gate(&state, task, user, input.expected_version).await {
        Gate::Ready(target) => target,
        Gate::Reply(response) => return response,
    };
    let mut candidate = serde_json::Map::new();
    candidate.insert("frequency".into(), json!(input.frequency));
    if let Some(weekdays) = &input.weekdays {
        candidate.insert("weekdays".into(), json!(weekdays));
    }
    if let Some(day) = input.month_day {
        candidate.insert("month_day".into(), json!(day));
    }
    if let Some(flag) = input.last_day_of_month {
        candidate.insert("last_day_of_month".into(), json!(flag));
    }
    let Some(rule) = Rule::from_json(&Value::Object(candidate)) else {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_rule");
    };
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if lock_task_first(&mut tx, task).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let before = match summary(&mut *tx, task).await {
        Ok(v) => v,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let after = rule.to_json();
    if before == after {
        let _ = tx.rollback().await;
        return reply_task(&state, &target, user).await;
    }
    let written = sqlx::query("INSERT INTO task_recurrences(task_id,workspace_id,frequency,weekdays,month_day,last_day_of_month,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(task_id) DO UPDATE SET frequency=EXCLUDED.frequency,weekdays=EXCLUDED.weekdays,month_day=EXCLUDED.month_day,last_day_of_month=EXCLUDED.last_day_of_month,updated_at=now()")
        .bind(task)
        .bind(target.workspace)
        .bind(rule.frequency.as_str())
        .bind(rule.weekdays.iter().map(|d| i16::from(*d)).collect::<Vec<_>>())
        .bind(rule.month_day.map(i16::from))
        .bind(rule.last_day_of_month)
        .bind(user)
        .execute(&mut *tx)
        .await;
    if written.is_err() {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_rule");
    }
    match record(
        &mut tx,
        task,
        &target,
        user,
        input.command_id,
        &[("recurrence", before, after)],
    )
    .await
    {
        Ok(Some(_)) => {}
        Ok(None) => {
            let _ = tx.rollback().await;
            return error(StatusCode::CONFLICT, "version_conflict");
        }
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    reply_task(&state, &target, user).await
}

async fn stop_rule(
    State(state): State<AuthState>,
    Path(task): Path<Uuid>,
    Query(input): Query<StopRule>,
    headers: HeaderMap,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let target = match gate(&state, task, user, input.expected_version).await {
        Gate::Ready(target) => target,
        Gate::Reply(response) => return response,
    };
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if lock_task_first(&mut tx, task).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let before = match summary(&mut *tx, task).await {
        Ok(v) => v,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if before.is_null() {
        let _ = tx.rollback().await;
        return reply_task(&state, &target, user).await;
    }
    if sqlx::query("DELETE FROM task_recurrences WHERE task_id=$1")
        .bind(task)
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    match record(
        &mut tx,
        task,
        &target,
        user,
        input.command_id,
        &[("recurrence", before, Value::Null)],
    )
    .await
    {
        Ok(Some(_)) => {}
        Ok(None) => {
            let _ = tx.rollback().await;
            return error(StatusCode::CONFLICT, "version_conflict");
        }
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    reply_task(&state, &target, user).await
}

/// Skips one occurrence: the Task's own dates move to the next occurrence of the rule, as one
/// undoable History entry, without completing the Task.
async fn skip_occurrence(
    State(state): State<AuthState>,
    Path(task): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<Skip>,
) -> Response {
    let (_, user) = match require_session(&state.pool, &headers, true).await {
        Ok(v) => v,
        Err(s) => return s.into_response(),
    };
    let target = match gate(&state, task, user, input.expected_version).await {
        Gate::Ready(target) => target,
        Gate::Reply(response) => return response,
    };
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if lock_task_first(&mut tx, task).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let rule = match sqlx::query("SELECT frequency,weekdays,month_day,last_day_of_month FROM task_recurrences WHERE task_id=$1 FOR UPDATE")
        .bind(task)
        .fetch_optional(&mut *tx)
        .await
    {
        Ok(Some(row)) => Rule::from_row(&row),
        Ok(None) => return error(StatusCode::NOT_FOUND, "no_recurrence"),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let Some(rule) = rule else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let start = target.start.as_deref().and_then(Date::parse);
    let due = target.due.as_deref().and_then(Date::parse);
    if start.is_none() && due.is_none() {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "date_required");
    }
    let (next_start, next_due) = rule.shift(
        start,
        due,
        Date {
            year: 1970,
            month: 1,
            day: 1,
        },
    );
    let mut changes = Vec::new();
    for (field, before, after) in [
        ("start_date", start, next_start),
        ("due_date", due, next_due),
    ] {
        if before != after {
            changes.push((
                field,
                json!(before.map(|d| d.to_string())),
                json!(after.map(|d| d.to_string())),
            ));
        }
    }
    for (field, _, after) in &changes {
        let sql = if *field == "start_date" {
            "UPDATE tasks SET start_date=$2::date WHERE id=$1"
        } else {
            "UPDATE tasks SET due_date=$2::date WHERE id=$1"
        };
        if sqlx::query(sql)
            .bind(task)
            .bind(after.as_str())
            .execute(&mut *tx)
            .await
            .is_err()
        {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    match record(&mut tx, task, &target, user, input.command_id, &changes).await {
        Ok(Some(_)) => {}
        Ok(None) => {
            let _ = tx.rollback().await;
            return error(StatusCode::CONFLICT, "version_conflict");
        }
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    if tx.commit().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    reply_task(&state, &target, user).await
}
