//! UTC calendar-month vesting utilities (no drift; day-of-month clamped).
//! Spec-authoritative:
//! - boundary_k = start date/time + k calendar months, day clamped to last valid day
//! - months_between = largest k s.t. now >= boundary_k (inclusive)
//! - month_index = clamp(1 + months_between, 1, 12)

use crate::constants::{DURATION_MONTHS, SECONDS_PER_DAY};
use crate::error::VestingError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DateTimeUtc {
    pub year: i32,  // e.g. 2026
    pub month: u32, // 1-12
    pub day: u32,   // 1-31
    pub sod: u32,   // seconds of day [0, 86399]
}

pub fn month_index(now_ts: i64, start_ts: i64) -> Result<u8, VestingError> {
    if now_ts < start_ts {
        return Err(VestingError::BeforeStart);
    }
    let mb = months_between(now_ts, start_ts)?;
    // 1 + mb, clamped to [1, 12]
    let raw = mb.saturating_add(1);
    Ok(raw.min(DURATION_MONTHS))
}

/// Return largest k such that now >= boundary_k(start, k), inclusive at boundaries.
/// Caps k at 12 (we only care up to and including end boundary).
pub fn months_between(now_ts: i64, start_ts: i64) -> Result<u8, VestingError> {
    if now_ts < start_ts {
        return Err(VestingError::BeforeStart);
    }
    let start_dt = datetime_from_unix(start_ts)?;
    let mut last_ok: u8 = 0;
    for k in 0..=DURATION_MONTHS {
        let b = boundary_ts_from_start(start_dt, k)?;
        if now_ts >= b {
            last_ok = k;
        } else {
            break;
        }
    }
    Ok(last_ok)
}

/// True if now is at or after vesting end boundary (start + 12 months).
pub fn is_after_vesting_end(now_ts: i64, start_ts: i64) -> Result<bool, VestingError> {
    if now_ts < start_ts {
        return Ok(false);
    }
    let start_dt = datetime_from_unix(start_ts)?;
    let end_boundary = boundary_ts_from_start(start_dt, DURATION_MONTHS)?;
    Ok(now_ts >= end_boundary)
}

fn boundary_ts_from_start(start: DateTimeUtc, months_to_add: u8) -> Result<i64, VestingError> {
    let (y, m) = add_months_ym(start.year, start.month, months_to_add as i32)?;
    let dim = days_in_month(y, m)?;
    let d = start.day.min(dim);
    unix_from_datetime(DateTimeUtc {
        year: y,
        month: m,
        day: d,
        sod: start.sod,
    })
}

fn add_months_ym(year: i32, month: u32, add: i32) -> Result<(i32, u32), VestingError> {
    if !(1..=12).contains(&month) {
        return Err(VestingError::InvalidTimestamp);
    }
    let base = (year as i64)
        .checked_mul(12)
        .ok_or(VestingError::MathOverflow)?
        .checked_add((month as i64) - 1)
        .ok_or(VestingError::MathOverflow)?;
    let next = base
        .checked_add(add as i64)
        .ok_or(VestingError::MathOverflow)?;
    let y = (next.div_euclid(12)) as i32;
    let m0 = (next.rem_euclid(12)) as u32;
    Ok((y, m0 + 1))
}

fn datetime_from_unix(ts: i64) -> Result<DateTimeUtc, VestingError> {
    // floor division for positive ts; spec uses positive timestamps.
    if ts < 0 {
        return Err(VestingError::InvalidTimestamp);
    }
    let days = ts / SECONDS_PER_DAY;
    let sod = (ts % SECONDS_PER_DAY) as u32;
    let (y, m, d) = civil_from_days(days);
    Ok(DateTimeUtc {
        year: y,
        month: m,
        day: d,
        sod,
    })
}

fn unix_from_datetime(dt: DateTimeUtc) -> Result<i64, VestingError> {
    if dt.sod >= 86_400 {
        return Err(VestingError::InvalidTimestamp);
    }
    let days = days_from_civil(dt.year, dt.month, dt.day)?;
    days.checked_mul(SECONDS_PER_DAY)
        .ok_or(VestingError::MathOverflow)?
        .checked_add(dt.sod as i64)
        .ok_or(VestingError::MathOverflow)
}

fn days_in_month(year: i32, month: u32) -> Result<u32, VestingError> {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => Ok(31),
        4 | 6 | 9 | 11 => Ok(30),
        2 => Ok(if is_leap_year(year) { 29 } else { 28 }),
        _ => Err(VestingError::InvalidTimestamp),
    }
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

/// Proleptic Gregorian conversion: days from civil date.
/// Algorithm by Howard Hinnant (public domain).
fn days_from_civil(y: i32, m: u32, d: u32) -> Result<i64, VestingError> {
    if !(1..=12).contains(&m) || d == 0 || d > 31 {
        return Err(VestingError::InvalidTimestamp);
    }
    let y = y as i64 - if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 }.div_euclid(400);
    let yoe = (y - era * 400) as i64; // [0, 399]
    let mp = (m as i64 + if m > 2 { -3 } else { 9 }) as i64; // [0, 11]
    let doy = (153 * mp + 2).div_euclid(5) + (d as i64) - 1; // [0, 365]
    let doe = yoe * 365 + yoe.div_euclid(4) - yoe.div_euclid(100) + doy; // [0, 146096]
    Ok(era * 146097 + doe - 719468) // days since 1970-01-01
}

/// Proleptic Gregorian conversion: civil date from days since epoch.
/// Algorithm by Howard Hinnant (public domain).
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 }.div_euclid(146097);
    let doe = (z - era * 146097) as i64; // [0, 146096]
    let yoe = (doe - doe.div_euclid(1460) + doe.div_euclid(36524) - doe.div_euclid(146096))
        .div_euclid(365); // [0, 399]
    let y = (yoe as i64 + era * 400) as i32;
    let doy = doe - (365 * yoe + yoe.div_euclid(4) - yoe.div_euclid(100)); // [0, 365]
    let mp = (5 * doy + 2).div_euclid(153); // [0, 11]
    let d = (doy - (153 * mp + 2).div_euclid(5) + 1) as u32; // [1, 31]
    let m = (mp + if mp < 10 { 3 } else { -9 }) as u32; // [1, 12]
    let y = y + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(y: i32, m: u32, d: u32, sod: u32) -> i64 {
        unix_from_datetime(DateTimeUtc {
            year: y,
            month: m,
            day: d,
            sod,
        })
        .unwrap()
    }

    #[test]
    fn month_boundary_inclusive() {
        let start = ts(2026, 4, 11, 0);
        // now == start => month_index 1
        assert_eq!(month_index(start, start).unwrap(), 1);

        // boundary_1(start) should be 2026-05-11 00:00:00
        let b1 = ts(2026, 5, 11, 0);
        assert_eq!(months_between(b1, start).unwrap(), 1);
        assert_eq!(month_index(b1, start).unwrap(), 2);
        // one second before boundary_1 => still month_index 1
        assert_eq!(month_index(b1 - 1, start).unwrap(), 1);
    }

    #[test]
    fn short_month_clamp_31_to_feb() {
        // 2024 is leap year: Jan 31 + 1 month => Feb 29
        let start = ts(2024, 1, 31, 0);
        let feb29 = ts(2024, 2, 29, 0);
        assert_eq!(months_between(feb29, start).unwrap(), 1);
        assert_eq!(month_index(feb29, start).unwrap(), 2);

        // One second before Feb 29 boundary still month_index 1.
        assert_eq!(month_index(feb29 - 1, start).unwrap(), 1);
    }

    #[test]
    fn month_index_saturates_at_12() {
        let start = ts(2020, 1, 1, 0);
        // Well after 12 months => saturates.
        let now = ts(2030, 1, 1, 0);
        assert_eq!(month_index(now, start).unwrap(), 12);
        assert!(is_after_vesting_end(now, start).unwrap());
    }
}


