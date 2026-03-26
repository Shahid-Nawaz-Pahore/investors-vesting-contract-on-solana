use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::DURATION_MONTHS;
use crate::error::VestingError;
use crate::state::{Recipients, ScheduleState};
use crate::utils::time;

pub fn release_to_recipient(ctx: Context<ReleaseToRecipient>, wallet: Pubkey) -> Result<()> {
    let schedule_state_ai = ctx.accounts.schedule_state.to_account_info();
    let schedule_state_bump = ctx.bumps.schedule_state;

    // Copy needed fields from st before taking recipients borrow.
    let sealed = ctx.accounts.schedule_state.sealed;
    let paused = ctx.accounts.schedule_state.paused;
    let distributor = ctx.accounts.schedule_state.distributor;
    let released_supply = ctx.accounts.schedule_state.released_supply;
    let total_supply = ctx.accounts.schedule_state.total_supply;
    let recipient_count = ctx.accounts.schedule_state.recipient_count;
    let mint = ctx.accounts.schedule_state.mint;
    let start_ts = ctx.accounts.schedule_state.start_ts;

    require!(sealed, VestingError::RecipientsNotSealed);
    require!(!paused, VestingError::SchedulePaused);
    require_keys_eq!(
        ctx.accounts.distributor.key(),
        distributor,
        VestingError::UnauthorizedDistributor
    );

    let now = Clock::get()?.unix_timestamp;
    let month_idx = time::month_index(now, start_ts)?;

    if released_supply == 0 {
        require!(
            ctx.accounts.vault.amount == total_supply,
            VestingError::VaultNotExactlyFunded
        );
    }

    // Load recipients via zero_copy.
    let mut recipients = ctx.accounts.recipients.load_mut()?;
    let entry = recipients
        .entries
        .iter_mut()
        .take(recipient_count as usize)
        .find(|e| e.wallet == wallet)
        .ok_or(VestingError::RecipientNotFound)?;

    require_keys_eq!(ctx.accounts.mint.key(), mint, VestingError::InvalidTokenMint);
    require_keys_eq!(ctx.accounts.vault.mint, mint, VestingError::InvalidTokenMint);
    let expected_ata = expected_ata_address(&wallet, &mint)?;
    require_keys_eq!(
        ctx.accounts.recipient_ata.key(),
        expected_ata,
        VestingError::InvalidRecipientAta
    );
    require_keys_eq!(
        ctx.accounts.recipient_ata.mint,
        mint,
        VestingError::InvalidTokenMint
    );
    require_keys_eq!(
        ctx.accounts.recipient_ata.owner,
        wallet,
        VestingError::InvalidTokenAccount
    );

    if entry.revoked != 0 {
        return Err(VestingError::RecipientRevoked.into());
    }

    let vested = vested_amount(entry.monthly_amount, entry.final_amount, month_idx)?;
    let releasable = vested
        .checked_sub(entry.released_amount)
        .ok_or(VestingError::MathOverflow)?;
    if releasable == 0 {
        return Err(VestingError::NothingToRelease.into());
    }

    require!(
        ctx.accounts.vault.amount >= releasable,
        VestingError::InsufficientVaultBalance
    );

    let signer_seeds: &[&[&[u8]]] = &[&[b"schedule_state", &[schedule_state_bump]]];

    // Drop recipients borrow before CPI.
let (_monthly_amount, _final_amount, allocation) =
        (entry.monthly_amount, entry.final_amount, entry.allocation);
    let new_released = entry
        .released_amount
        .checked_add(releasable)
        .ok_or(VestingError::MathOverflow)?;
    entry.released_amount = new_released;
    drop(recipients);

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.recipient_ata.to_account_info(),
                authority: schedule_state_ai,
            },
            signer_seeds,
        ),
        releasable,
    )?;

    // Update schedule_state after CPI.
    ctx.accounts.schedule_state.released_supply = released_supply
        .checked_add(releasable)
        .ok_or(VestingError::MathOverflow)?;

    emit!(TokensReleased {
        wallet,
        month_index: month_idx,
        amount: releasable,
        allocation,
        released_total: new_released,
    });

    Ok(())
}

fn vested_amount(monthly: u64, final_amount: u64, month_index: u8) -> Result<u64> {
    let m = month_index.min(DURATION_MONTHS);
    if m == DURATION_MONTHS {
        let v = (monthly as u128)
            .checked_mul(11)
            .ok_or(VestingError::MathOverflow)?
            .checked_add(final_amount as u128)
            .ok_or(VestingError::MathOverflow)?;
        Ok(u64::try_from(v).map_err(|_| VestingError::MathOverflow)?)
    } else {
        let v = (monthly as u128)
            .checked_mul(m as u128)
            .ok_or(VestingError::MathOverflow)?;
        Ok(u64::try_from(v).map_err(|_| VestingError::MathOverflow)?)
    }
}

fn expected_ata_address(owner: &Pubkey, mint: &Pubkey) -> Result<Pubkey> {
    let seeds: &[&[u8]] = &[
        owner.as_ref(),
        anchor_spl::token::ID.as_ref(),
        mint.as_ref(),
    ];
    let (ata, _) = Pubkey::find_program_address(seeds, &anchor_spl::associated_token::ID);
    Ok(ata)
}

#[derive(Accounts)]
pub struct ReleaseToRecipient<'info> {
    #[account(mut, seeds = [b"schedule_state"], bump)]
    pub schedule_state: Account<'info, ScheduleState>,

    #[account(
        mut,
        seeds = [b"recipients", schedule_state.key().as_ref()],
        bump
    )]
    pub recipients: AccountLoader<'info, Recipients>,

    #[account(
        mut,
        seeds = [b"vault", schedule_state.key().as_ref()],
        bump,
        constraint = vault.mint == schedule_state.mint @ VestingError::InvalidTokenMint,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub recipient_ata: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    pub distributor: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[event]
pub struct TokensReleased {
    pub wallet: Pubkey,
    pub month_index: u8,
    pub amount: u64,
    pub allocation: u64,
    pub released_total: u64,
}