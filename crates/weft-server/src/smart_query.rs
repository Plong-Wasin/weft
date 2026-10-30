//! Smart List query rules: the accepted shape, its limits, and the relative-date vocabulary.
//!
//! A query is `{filters, logic, sort, group, columns}`. An entry of `filters` is either a
//! condition (`field`, `op`, `value`) or a nested group (`logic`, `filters`). Dates are calendar
//! dates; "today" is the date in the Workspace time zone, passed in by the caller so month ends
//! can be tested without waiting for them.

use serde_json::Value;
use uuid::Uuid;

/// Deepest nesting of groups; the query itself is depth 1.
pub(crate) const MAX_DEPTH: usize = 4;
/// Conditions across the whole tree.
pub(crate) const MAX_CONDITIONS: usize = 20;
pub(crate) const MAX_SORTS: usize = 5;
/// Largest page a Smart List read may ask for, and the default page.
pub(crate) const MAX_PAGE: i64 = 500;
const MAX_NEXT_DAYS: i64 = 365;

const MILESTONE_STATES: [&str; 4] = ["planned", "active", "completed", "canceled"];

/// The Workspace's idea of today and of the first day of the week (0 = Sunday).
pub(crate) struct Clock {
    pub(crate) today: String,
    pub(crate) week_start: i16,
}

impl Clock {
    pub(crate) async fn load(
        executor: impl sqlx::PgExecutor<'_>,
        workspace: Uuid,
    ) -> Result<Self, sqlx::Error> {
        let (today, week_start): (String, i16) = sqlx::query_as(
            "SELECT (now() AT TIME ZONE time_zone)::date::text,week_start FROM workspaces WHERE id=$1",
        )
        .bind(workspace)
        .fetch_one(executor)
        .await?;
        Ok(Self { today, week_start })
    }
}

/// An inclusive window of days; a missing end is open.
pub(crate) type Window = (Option<String>, Option<String>);

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn parse_day(day: &str) -> Option<i64> {
    let mut parts = day.split('-').map(str::parse::<i64>);
    let (y, m, d) = (
        parts.next()?.ok()?,
        parts.next()?.ok()?,
        parts.next()?.ok()?,
    );
    parts
        .next()
        .is_none()
        .then(|| days_from_civil(y, m, d))
        .filter(|days| civil_from_days(*days) == (y, m, d))
}

fn format_day(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

fn month_bounds(days: i64, offset: i64) -> (i64, i64) {
    let (y, m, _) = civil_from_days(days);
    let index = y * 12 + (m - 1) + offset;
    let first = days_from_civil(index.div_euclid(12), index.rem_euclid(12) + 1, 1);
    let next = index + 1;
    let after = days_from_civil(next.div_euclid(12), next.rem_euclid(12) + 1, 1);
    (first, after - 1)
}

/// `next_N_days` with N in 1..=365.
fn next_days(name: &str) -> Option<i64> {
    let n: i64 = name
        .strip_prefix("next_")?
        .strip_suffix("_days")?
        .parse()
        .ok()?;
    (1..=MAX_NEXT_DAYS).contains(&n).then_some(n)
}

pub(crate) fn is_relative(name: &str) -> bool {
    matches!(
        name,
        "today" | "overdue" | "this_week" | "next_week" | "this_month" | "next_month"
    ) || next_days(name).is_some()
}

/// The days a relative value covers, or `None` for an unknown value or an unreadable "today".
pub(crate) fn relative_window(name: &str, clock: &Clock) -> Option<Window> {
    let today = parse_day(&clock.today)?;
    let some = |from: i64, to: i64| Some((Some(format_day(from)), Some(format_day(to))));
    let week = || {
        let back = (((today.rem_euclid(7) + 4) % 7) - i64::from(clock.week_start)).rem_euclid(7);
        today - back
    };
    match name {
        "today" => some(today, today),
        "overdue" => Some((None, Some(format_day(today - 1)))),
        "this_week" => some(week(), week() + 6),
        "next_week" => some(week() + 7, week() + 13),
        "this_month" => {
            let (first, last) = month_bounds(today, 0);
            some(first, last)
        }
        "next_month" => {
            let (first, last) = month_bounds(today, 1);
            some(first, last)
        }
        other => some(today, today + next_days(other)?),
    }
}

fn is_date_field(field: &str) -> bool {
    matches!(field, "due_date" | "start_date")
}

fn is_sortable(field: &str) -> bool {
    matches!(
        field,
        "title"
            | "status"
            | "priority"
            | "number"
            | "due_date"
            | "start_date"
            | "milestone"
            | "milestone_state"
    ) || field.starts_with("attribute:")
}

fn check_logic(node: &Value) -> Result<(), String> {
    match node.get("logic") {
        None | Some(Value::Null) => Ok(()),
        Some(Value::String(logic)) if logic == "and" || logic == "or" => Ok(()),
        Some(_) => Err("logic must be \"and\" or \"or\"".into()),
    }
}

fn check_condition(condition: &Value) -> Result<(), String> {
    let field = condition
        .get("field")
        .and_then(Value::as_str)
        .ok_or("a condition needs a field")?;
    let known = [
        "status",
        "priority",
        "assignee",
        "assignee_including_team",
        "due_date",
        "start_date",
        "milestone",
        "milestone_state",
    ]
    .contains(&field)
        || field.starts_with("attribute:");
    if !known {
        return Err(format!("unknown field \"{field}\""));
    }
    let op = condition
        .get("op")
        .and_then(Value::as_str)
        .ok_or("a condition needs an op")?;
    if !["eq", "neq", "contains", "before", "after", "relative"].contains(&op) {
        return Err(format!("unknown operator \"{op}\""));
    }
    let value = condition.get("value").unwrap_or(&Value::Null);
    // An empty value matches nothing, so the list would look empty for no visible reason.
    if value.as_str().is_some_and(|text| text.trim().is_empty()) {
        return Err("a condition needs a value".into());
    }
    if op == "relative" {
        if !is_date_field(field) {
            return Err("relative dates apply to due_date and start_date only".into());
        }
        return match value.as_str() {
            Some(name) if is_relative(name) => Ok(()),
            _ => Err(format!(
                "unknown relative date; use today, overdue, next_N_days (N 1 to {MAX_NEXT_DAYS}), this_week, next_week, this_month or next_month"
            )),
        };
    }
    match field {
        "milestone" => {
            if !["eq", "neq"].contains(&op) {
                return Err("milestone supports eq and neq".into());
            }
            match value {
                Value::Null => Ok(()),
                Value::String(id) if Uuid::parse_str(id).is_ok() => Ok(()),
                _ => Err("milestone value must be a Milestone id or null".into()),
            }
        }
        "milestone_state" => {
            if !["eq", "neq"].contains(&op) {
                return Err("milestone_state supports eq and neq".into());
            }
            match value {
                Value::Null => Ok(()),
                Value::String(state) if MILESTONE_STATES.contains(&state.as_str()) => Ok(()),
                _ => Err("milestone_state must be planned, active, completed or canceled".into()),
            }
        }
        _ => Ok(()),
    }
}

fn check_group(
    group: &Value,
    depth: usize,
    conditions: &mut usize,
    root: bool,
) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Err(format!("groups are nested too deeply (limit {MAX_DEPTH})"));
    }
    check_logic(group)?;
    let filters = group
        .get("filters")
        .and_then(Value::as_array)
        .ok_or("a group needs a filters array")?;
    if filters.is_empty() && !root {
        return Err("a nested group needs at least one condition".into());
    }
    for node in filters {
        if !node.is_object() {
            return Err("every filter must be an object".into());
        }
        match (node.get("field").is_some(), node.get("filters").is_some()) {
            (true, false) => {
                *conditions += 1;
                if *conditions > MAX_CONDITIONS {
                    return Err(format!("too many conditions (limit {MAX_CONDITIONS})"));
                }
                check_condition(node)?;
            }
            (false, true) => check_group(node, depth + 1, conditions, false)?,
            _ => return Err("a filter is either a condition or a group".into()),
        }
    }
    Ok(())
}

/// Why a query is refused, in words a person can act on.
pub(crate) fn validate(query: &Value) -> Result<(), String> {
    if !query.is_object() {
        return Err("the query must be an object".into());
    }
    check_group(query, 1, &mut 0, true)?;
    match query.get("sort") {
        None | Some(Value::Null) => {}
        Some(Value::Array(rules)) => {
            if rules.len() > MAX_SORTS {
                return Err(format!("too many sort rules (limit {MAX_SORTS})"));
            }
            for rule in rules {
                let field = rule.get("field").and_then(Value::as_str).unwrap_or("");
                if !is_sortable(field) {
                    return Err(format!("cannot sort by \"{field}\""));
                }
                if !matches!(
                    rule.get("direction").and_then(Value::as_str),
                    None | Some("asc" | "desc")
                ) {
                    return Err("sort direction must be asc or desc".into());
                }
            }
        }
        Some(_) => return Err("sort must be an array".into()),
    }
    match query.get("group") {
        None | Some(Value::Null) => {}
        Some(Value::String(field)) if is_sortable(field) => {}
        Some(_) => return Err("cannot group by that field".into()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn clock(today: &str, week_start: i16) -> Clock {
        Clock {
            today: today.into(),
            week_start,
        }
    }

    fn window(name: &str, today: &str, week_start: i16) -> (String, String) {
        let (from, to) = relative_window(name, &clock(today, week_start)).unwrap();
        (from.unwrap_or_default(), to.unwrap_or_default())
    }

    #[test]
    fn month_end_windows() {
        assert_eq!(
            window("next_7_days", "2026-01-28", 1),
            ("2026-01-28".into(), "2026-02-04".into())
        );
        assert_eq!(
            window("next_30_days", "2028-02-15", 1),
            ("2028-02-15".into(), "2028-03-16".into())
        );
        assert_eq!(
            window("this_month", "2026-01-31", 1),
            ("2026-01-01".into(), "2026-01-31".into())
        );
        assert_eq!(
            window("next_month", "2026-01-31", 1),
            ("2026-02-01".into(), "2026-02-28".into())
        );
        assert_eq!(
            window("next_month", "2028-01-31", 1),
            ("2028-02-01".into(), "2028-02-29".into())
        );
        assert_eq!(
            window("next_month", "2026-12-31", 1),
            ("2027-01-01".into(), "2027-01-31".into())
        );
        assert_eq!(
            window("this_month", "2028-02-29", 1),
            ("2028-02-01".into(), "2028-02-29".into())
        );
        assert_eq!(
            window("overdue", "2026-03-01", 1),
            (String::new(), "2026-02-28".into())
        );
        assert_eq!(
            window("today", "2026-04-30", 1),
            ("2026-04-30".into(), "2026-04-30".into())
        );
    }

    #[test]
    fn week_windows_follow_the_workspace_week_start() {
        // 2026-04-30 is a Thursday.
        assert_eq!(
            window("this_week", "2026-04-30", 1),
            ("2026-04-27".into(), "2026-05-03".into())
        );
        assert_eq!(
            window("next_week", "2026-04-30", 1),
            ("2026-05-04".into(), "2026-05-10".into())
        );
        assert_eq!(
            window("this_week", "2026-04-30", 0),
            ("2026-04-26".into(), "2026-05-02".into())
        );
        // A Monday with a Monday week starts today; a Sunday with a Monday week starts six days back.
        assert_eq!(
            window("this_week", "2026-04-27", 1),
            ("2026-04-27".into(), "2026-05-03".into())
        );
        assert_eq!(
            window("this_week", "2026-05-03", 1),
            ("2026-04-27".into(), "2026-05-03".into())
        );
        assert_eq!(
            window("this_week", "2026-12-31", 1),
            ("2026-12-28".into(), "2027-01-03".into())
        );
    }

    #[test]
    fn unknown_relative_values_have_no_window() {
        for name in [
            "next_0_days",
            "next_366_days",
            "next_x_days",
            "last_week",
            "",
        ] {
            assert!(
                relative_window(name, &clock("2026-04-30", 1)).is_none(),
                "{name}"
            );
        }
    }

    #[test]
    fn nesting_condition_and_shape_limits() {
        let leaf = json!({"field":"status","op":"eq","value":"todo"});
        let mut deep = json!({"logic":"or","filters":[leaf.clone()]});
        for _ in 0..MAX_DEPTH {
            deep = json!({"logic":"and","filters":[deep]});
        }
        assert!(validate(&json!({"filters":[deep],"logic":"and"}))
            .unwrap_err()
            .contains("deeply"));
        let fits = json!({"filters":[{"logic":"or","filters":[{"logic":"and","filters":[leaf.clone()]}]}],"logic":"and"});
        assert!(validate(&fits).is_ok());
        let many = json!({"filters": vec![leaf.clone(); MAX_CONDITIONS + 1], "logic":"and"});
        assert!(validate(&many).unwrap_err().contains("too many conditions"));
        assert!(validate(&json!({"filters":[{"logic":"or","filters":[]}]})).is_err());
        assert!(validate(&json!({"filters":[{"field":"status","op":"eq","filters":[]}]})).is_err());
        assert!(validate(
            &json!({"filters":[{"field":"due_date","op":"relative","value":"soon"}]})
        )
        .is_err());
        assert!(
            validate(&json!({"filters":[{"field":"status","op":"relative","value":"today"}]}))
                .is_err()
        );
        assert!(validate(
            &json!({"filters":[{"field":"milestone_state","op":"eq","value":"later"}]})
        )
        .is_err());
        assert!(validate(
            &json!({"filters":[{"field":"milestone","op":"eq","value":"not-an-id"}]})
        )
        .is_err());
        assert!(validate(&json!({"filters":[],"sort":[{"field":"milestone","direction":"desc"}],"group":"milestone_state"})).is_ok());
        assert!(validate(&json!({"filters":[],"group":"password"})).is_err());
    }

    #[test]
    fn empty_values_are_refused() {
        for field in [
            "status",
            "priority",
            "due_date",
            "milestone",
            "milestone_state",
        ] {
            for value in ["", "  "] {
                let query = json!({"filters":[{"field":field,"op":"eq","value":value}]});
                assert!(
                    validate(&query).unwrap_err().contains("needs a value"),
                    "{field}"
                );
            }
        }
        assert!(
            validate(&json!({"filters":[{"field":"milestone","op":"eq","value":null}]})).is_ok()
        );
        assert_eq!(MAX_CONDITIONS, 20);
    }
}
