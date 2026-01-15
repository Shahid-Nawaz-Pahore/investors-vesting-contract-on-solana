//! Program-wide constants (spec-authoritative).

/// Max recipients stored on-chain in the recipients list PDA.
pub const MAX_RECIPIENTS: usize = 35;

/// Max recipients processed per `batch_release` call.
pub const MAX_BATCH_RELEASE: usize = 5;

/// Vesting duration in calendar months.
pub const DURATION_MONTHS: u8 = 12;

/// Seconds per day (UTC).
pub const SECONDS_PER_DAY: i64 = 86_400;

