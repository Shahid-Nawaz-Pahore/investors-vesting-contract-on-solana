use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::error::VestingError;
use crate::state::ScheduleState;

pub fn deposit_tokens(ctx: Context<DepositTokens>, amount: u64) -> Result<()> {
    require!(amount > 0, VestingError::InvalidConfig);

    let st = &ctx.accounts.schedule_state;
    require_keys_eq!(ctx.accounts.admin.key(), st.admin, VestingError::UnauthorizedAdmin);

    let now = Clock::get()?.unix_timestamp;
    require!(now < st.start_ts, VestingError::DepositAfterStart);

    require_keys_eq!(ctx.accounts.vault.mint, st.mint, VestingError::InvalidTokenMint);
    require_keys_eq!(ctx.accounts.admin_token_account.mint, st.mint, VestingError::InvalidTokenMint);
    require_keys_eq!(
        ctx.accounts.admin_token_account.owner,
        ctx.accounts.admin.key(),
        VestingError::InvalidTokenAccount
    );

    // Over-deposit protection.
    let pre = ctx.accounts.vault.amount as u128;
    let add = amount as u128;
    let post = pre
        .checked_add(add)
        .ok_or(VestingError::MathOverflow)?;
    require!(post <= st.total_supply as u128, VestingError::OverDeposit);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.admin_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.admin.to_account_info(),
            },
        ),
        amount,
    )?;

    ctx.accounts.vault.reload()?;
    require!(ctx.accounts.vault.amount <= st.total_supply, VestingError::OverDeposit);

    emit!(TokensDeposited {
        admin: st.admin,
        amount,
        vault_balance: ctx.accounts.vault.amount,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct DepositTokens<'info> {
    #[account(seeds = [b"schedule_state"], bump)]
    pub schedule_state: Account<'info, ScheduleState>,

    #[account(
        mut,
        seeds = [b"vault", schedule_state.key().as_ref()],
        bump,
        constraint = vault.mint == schedule_state.mint @ VestingError::InvalidTokenMint,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub admin_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[event]
pub struct TokensDeposited {
    pub admin: Pubkey,
    pub amount: u64,
    pub vault_balance: u64,
}


