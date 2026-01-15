use anchor_lang::prelude::*;

/// Single vesting schedule state PDA (spec-authoritative).
#[account]
pub struct ScheduleState {
    /// Token mint.
    pub mint: Pubkey,
    /// Admin authority (multisig recommended off-chain).
    pub admin: Pubkey,
    /// Distributor authority (backend signer).
    pub distributor: Pubkey,
    /// Vesting start timestamp (Unix seconds, UTC).
    pub start_ts: i64,
    /// Vesting duration in months (must be 12 by spec).
    pub duration_months: u8,
    /// Emergency pause flag (blocks transfers only; accrual continues).
    pub paused: bool,
    /// Total supply escrowed for vesting.
    pub total_supply: u64,
    /// Total released supply (sum of per-recipient released_amount).
    pub released_supply: u64,
    /// Recipient count (<= 35).
    pub recipient_count: u8,
    /// Recipients list sealed flag (prevents mutation/reordering).
    pub sealed: bool,
}

impl ScheduleState {
    pub const SIZE: usize =
        32 + // mint
        32 + // admin
        32 + // distributor
        8 +  // start_ts
        1 +  // duration_months
        1 +  // paused
        8 +  // total_supply
        8 +  // released_supply
        1 +  // recipient_count
        1;   // sealed
}


