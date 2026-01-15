use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::error::VestingError;
use crate::state::{Recipients, ScheduleState};
use crate::utils::time;

pub fn sweep_dust_after_end(ctx: Context<SweepDustAfterEnd>) -> Result<()> {
    let st = &ctx.accounts.schedule_state;
    require_keys_eq!(ctx.accounts.admin.key(), st.admin, VestingError::UnauthorizedAdmin);

    let now = Clock::get()?.unix_timestamp;
    require!(
        time::is_after_vesting_end(now, st.start_ts)?,
        VestingError::SweepBeforeEnd
    );

    // Disallow sweeping if any non-revoked recipient has not received full allocation.
    for e in ctx.accounts.recipients.entries.iter() {
        if !e.revoked && e.released_amount != e.allocation {
            return Err(VestingError::SweepNotAllowedOutstanding.into());
        }
    }

    require_keys_eq!(ctx.accounts.mint.key(), st.mint, VestingError::InvalidTokenMint);
    require_keys_eq!(ctx.accounts.vault.mint, st.mint, VestingError::InvalidTokenMint);
    require_keys_eq!(
        ctx.accounts.admin_destination.mint,
        st.mint,
        VestingError::InvalidTokenMint
    );
    require_keys_eq!(
        ctx.accounts.admin_destination.owner,
        ctx.accounts.admin.key(),
        VestingError::InvalidTokenAccount
    );

    let amount = ctx.accounts.vault.amount;
    if amount == 0 {
        emit!(DustSwept {
            admin: st.admin,
            amount: 0,
        });
        return Ok(());
    }

    let signer_seeds: &[&[&[u8]]] = &[&[b"schedule_state", &[ctx.bumps.schedule_state]]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.admin_destination.to_account_info(),
                authority: ctx.accounts.schedule_state.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    emit!(DustSwept {
        admin: st.admin,
        amount,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SweepDustAfterEnd<'info> {
    #[account(mut, seeds = [b"schedule_state"], bump)]
    pub schedule_state: Account<'info, ScheduleState>,

    #[account(
        seeds = [b"recipients", schedule_state.key().as_ref()],
        bump
    )]
    pub recipients: Account<'info, Recipients>,

    #[account(
        mut,
        seeds = [b"vault", schedule_state.key().as_ref()],
        bump,
        constraint = vault.mint == schedule_state.mint @ VestingError::InvalidTokenMint,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub admin_destination: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    pub admin: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[event]
pub struct DustSwept {
    pub admin: Pubkey,
    pub amount: u64,
}


