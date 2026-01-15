use anchor_lang::prelude::*;

/// Custom error codes for the investor vesting program (spec-authoritative).
#[error_code]
pub enum VestingError {
    #[msg("Unauthorized: admin signature required")]
    UnauthorizedAdmin,

    #[msg("Unauthorized: distributor signature required")]
    UnauthorizedDistributor,

    #[msg("Invalid public key")]
    InvalidPubkey,

    #[msg("Invalid configuration")]
    InvalidConfig,

    #[msg("Invalid timestamp")]
    InvalidTimestamp,

    #[msg("Recipients list is sealed")]
    RecipientsSealed,

    #[msg("Recipients list is not sealed")]
    RecipientsNotSealed,

    #[msg("Recipient list is full")]
    RecipientListFull,

    #[msg("Duplicate recipient wallet")]
    DuplicateRecipient,

    #[msg("Invalid allocation (must be > 0)")]
    InvalidAllocation,

    #[msg("Allocation sum would exceed total supply")]
    AllocationSumExceedsTotalSupply,

    #[msg("Allocation sum does not equal total supply at seal")]
    AllocationSumMismatchAtSeal,

    #[msg("Schedule is paused")]
    SchedulePaused,

    #[msg("Schedule is not paused")]
    ScheduleNotPaused,

    #[msg("Release called before start timestamp")]
    BeforeStart,

    #[msg("Batch size too large")]
    BatchTooLarge,

    #[msg("Empty batch")]
    EmptyBatch,

    #[msg("Recipient not found")]
    RecipientNotFound,

    #[msg("Recipient is revoked")]
    RecipientRevoked,

    #[msg("Invalid token program (SPL Token only)")]
    InvalidTokenProgram,

    #[msg("Invalid token mint")]
    InvalidTokenMint,

    #[msg("Invalid token account")]
    InvalidTokenAccount,

    #[msg("Invalid associated token account for recipient")]
    InvalidRecipientAta,

    #[msg("Insufficient vault balance")]
    InsufficientVaultBalance,

    #[msg("Deposit would exceed total supply")]
    OverDeposit,

    #[msg("Deposit after start timestamp is not allowed")]
    DepositAfterStart,

    #[msg("Vault must be exactly funded to total supply before start")]
    VaultNotExactlyFunded,

    #[msg("Math overflow")]
    MathOverflow,

    #[msg("Sweep not allowed before vesting end")]
    SweepBeforeEnd,

    #[msg("Sweep not allowed: unreleased (non-revoked) allocations remain")]
    SweepNotAllowedOutstanding,
}

