use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::DURATION_MONTHS;
use crate::error::VestingError;
use crate::state::{Recipients, ScheduleState};
use crate::utils::time;

pub fn release_to_recipient(ctx: Context<ReleaseToRecipient>, wallet: Pubkey) -> Result<()> {
    // Avoid borrow checker conflicts: capture AccountInfos/keys before taking mutable borrows.
    let schedule_state_ai = ctx.accounts.schedule_state.to_account_info();
    let schedule_state_bump = ctx.bumps.schedule_state;

    let st = &mut ctx.accounts.schedule_state;
    require!(st.sealed, VestingError::RecipientsNotSealed);
    require!(!st.paused, VestingError::SchedulePaused);
    require_keys_eq!(
        ctx.accounts.distributor.key(),
        st.distributor,
        VestingError::UnauthorizedDistributor
    );

    let now = Clock::get()?.unix_timestamp;
    let month_idx = time::month_index(now, st.start_ts)?;

    // Enforce full funding before any release (released_supply == 0).
    if st.released_supply == 0 {
        require!(
            ctx.accounts.vault.amount == st.total_supply,
            VestingError::VaultNotExactlyFunded
        );
    }

    // Find recipient entry.
    let recipients = &mut ctx.accounts.recipients;
    let entry = recipients
        .entries
        .iter_mut()
        .take(st.recipient_count as usize)
        .find(|e| e.wallet == wallet)
        .ok_or(VestingError::RecipientNotFound)?;

    // Require recipient ATA exists and is correct.
    require_keys_eq!(ctx.accounts.mint.key(), st.mint, VestingError::InvalidTokenMint);
    require_keys_eq!(ctx.accounts.vault.mint, st.mint, VestingError::InvalidTokenMint);
    let expected_ata = expected_ata_address(&wallet, &st.mint)?;
    require_keys_eq!(
        ctx.accounts.recipient_ata.key(),
        expected_ata,
        VestingError::InvalidRecipientAta
    );
    // Strict ATA checks (pre-created ATA policy).
    require_keys_eq!(
        ctx.accounts.recipient_ata.mint,
        st.mint,
        VestingError::InvalidTokenMint
    );
    require_keys_eq!(
        ctx.accounts.recipient_ata.owner,
        wallet,
        VestingError::InvalidTokenAccount
    );

    // If revoked, no-op (stop future releases).
    if entry.revoked != 0 {
        return Ok(());
    }

    let vested = vested_amount(entry.monthly_amount, entry.final_amount, month_idx)?;
    let releasable = vested
        .checked_sub(entry.released_amount)
        .ok_or(VestingError::MathOverflow)?;
    if releasable == 0 {
        return Ok(());
    }

    require!(
        ctx.accounts.vault.amount >= releasable,
        VestingError::InsufficientVaultBalance
    );

    // CPI transfer from vault to recipient ATA, signed by schedule_state PDA.
    let signer_seeds: &[&[&[u8]]] = &[&[b"schedule_state", &[schedule_state_bump]]];
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

    entry.released_amount = entry
        .released_amount
        .checked_add(releasable)
        .ok_or(VestingError::MathOverflow)?;
    st.released_supply = st
        .released_supply
        .checked_add(releasable)
        .ok_or(VestingError::MathOverflow)?;

    emit!(TokensReleased {
        wallet,
        month_index: month_idx,
        amount: releasable,
        allocation: entry.allocation,
        released_total: entry.released_amount,
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
    // ATA derivation: PDA(owner, token_program_id, mint) with associated token program id.
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
    pub recipients: Box<Account<'info, Recipients>>,

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


