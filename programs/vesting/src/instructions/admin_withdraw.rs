use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::error::VestingError;
use crate::state::{Recipients, ScheduleState};

pub fn admin_withdraw(ctx: Context<AdminWithdraw>, amount: u64, query_id: u64) -> Result<()> {
    require!(amount > 0, VestingError::InvalidConfig);

    let st = &ctx.accounts.schedule_state;
    require_keys_eq!(ctx.accounts.admin.key(), st.admin, VestingError::UnauthorizedAdmin);

    // NOTE: Admin withdrawal is allowed at any time by explicit request.

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

    require!(
        ctx.accounts.vault.amount >= amount,
        VestingError::InsufficientVaultBalance
    );

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

    emit!(AdminWithdrawn {
        admin: st.admin,
        amount,
        query_id,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct AdminWithdraw<'info> {
    #[account(mut, seeds = [b"schedule_state"], bump)]
    pub schedule_state: Account<'info, ScheduleState>,

    #[account(
        seeds = [b"recipients", schedule_state.key().as_ref()],
        bump
    )]
    pub recipients: Box<Account<'info, Recipients>>,

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
pub struct AdminWithdrawn {
    pub admin: Pubkey,
    pub amount: u64,
    pub query_id: u64,
}

