use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::{DURATION_MONTHS, MAX_RECIPIENTS};
use crate::error::VestingError;
use crate::state::{Recipients, ScheduleState};

pub fn initialize_schedule(
    ctx: Context<InitializeSchedule>,
    distributor: Pubkey,
    start_ts: i64,
    total_supply: u64,
) -> Result<()> {
    require!(total_supply > 0, VestingError::InvalidConfig);
    require!(start_ts > 0, VestingError::InvalidTimestamp);
    require!(distributor != Pubkey::default(), VestingError::InvalidPubkey);
    require!(
        distributor != ctx.accounts.admin.key(),
        VestingError::InvalidConfig
    );
    require!(
        distributor != ctx.accounts.schedule_state.key(),
        VestingError::InvalidConfig
    );
    require!(distributor != crate::ID, VestingError::InvalidConfig);

    // Spec: distributor must not be any program PDA (cannot sign). Explicitly block the known PDAs.
    let schedule_state_key = ctx.accounts.schedule_state.key();
    let (vault_pda, _) = Pubkey::find_program_address(
        &[b"vault", schedule_state_key.as_ref()],
        &crate::ID,
    );
    let (recipients_pda, _) = Pubkey::find_program_address(
        &[b"recipients", schedule_state_key.as_ref()],
        &crate::ID,
    );
    require!(distributor != vault_pda, VestingError::InvalidConfig);
    require!(distributor != recipients_pda, VestingError::InvalidConfig);

    let st = &mut ctx.accounts.schedule_state;
    st.mint = ctx.accounts.mint.key();
    st.admin = ctx.accounts.admin.key();
    st.distributor = distributor;
    st.start_ts = start_ts;
    st.duration_months = DURATION_MONTHS;
    st.paused = false;
    st.total_supply = total_supply;
    st.released_supply = 0;
    st.recipient_count = 0;
    st.sealed = false;

    // Initialize recipients list as empty (deterministic input order).
    let recipients = &mut ctx.accounts.recipients;
    recipients.entries = Vec::with_capacity(MAX_RECIPIENTS);

    emit!(ScheduleInitialized {
        mint: st.mint,
        admin: st.admin,
        distributor: st.distributor,
        start_ts: st.start_ts,
        total_supply: st.total_supply,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct InitializeSchedule<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + ScheduleState::SIZE,
        seeds = [b"schedule_state"],
        bump
    )]
    pub schedule_state: Account<'info, ScheduleState>,

    #[account(
        init,
        payer = admin,
        space = Recipients::space(MAX_RECIPIENTS),
        seeds = [b"recipients", schedule_state.key().as_ref()],
        bump
    )]
    pub recipients: Account<'info, Recipients>,

    #[account(
        init,
        payer = admin,
        token::mint = mint,
        token::authority = schedule_state,
        seeds = [b"vault", schedule_state.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[event]
pub struct ScheduleInitialized {
    pub mint: Pubkey,
    pub admin: Pubkey,
    pub distributor: Pubkey,
    pub start_ts: i64,
    pub total_supply: u64,
}


