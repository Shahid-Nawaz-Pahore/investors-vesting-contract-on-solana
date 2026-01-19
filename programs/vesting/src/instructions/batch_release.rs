use anchor_lang::prelude::*;
use anchor_spl::token::Token;

use crate::state::{Recipients, ScheduleState};

// NOTE: `batch_release` handler logic lives in `src/lib.rs` to avoid Anchor
// `Context` lifetime invariance issues when delegating across modules.

#[derive(Accounts)]
pub struct BatchRelease<'info> {
    #[account(mut, seeds = [b"schedule_state"], bump)]
    pub schedule_state: Account<'info, ScheduleState>,

    #[account(
        mut,
        seeds = [b"recipients", schedule_state.key().as_ref()],
        bump
    )]
    pub recipients: Box<Account<'info, Recipients>>,

    #[account(
        mut,
        seeds = [b"vault", schedule_state.key().as_ref()],
        bump
    )]
    /// CHECK: Validated as an SPL Token account via unpacking in-handler.
    pub vault: UncheckedAccount<'info>,

    pub distributor: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[event]
pub struct TokensReleasedBatchItem {
    pub wallet: Pubkey,
    pub month_index: u8,
    pub amount: u64,
    pub allocation: u64,
    pub released_total: u64,
}


