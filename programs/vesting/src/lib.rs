use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod state;
pub mod instructions;
pub mod utils;

pub use constants::*;
pub use error::*;
pub use state::*;
// Avoid glob re-exports to prevent ambiguous names with #[program] entrypoints.
pub use instructions::{
    AddRecipients, BatchRelease, DepositTokens, EmitVestingQuote, InitializeSchedule, Pause,
    ReleaseToRecipient, RevokeRecipient, SetDistributor, SweepDustAfterEnd, Unpause,
};

// Anchor's #[program] macro expects `crate::__client_accounts_*` modules.
// The derive-generated modules under `instructions::*` are `pub(crate)`, so we provide
// crate-root public shims that re-export their *contents* (not the modules themselves).
pub mod __client_accounts_initialize_schedule {
    pub use crate::instructions::__client_accounts_initialize_schedule::*;
}
pub mod __client_accounts_add_recipients {
    pub use crate::instructions::__client_accounts_add_recipients::*;
}
pub mod __client_accounts_deposit_tokens {
    pub use crate::instructions::__client_accounts_deposit_tokens::*;
}
pub mod __client_accounts_set_distributor {
    pub use crate::instructions::__client_accounts_set_distributor::*;
}
pub mod __client_accounts_pause {
    pub use crate::instructions::__client_accounts_pause::*;
}
pub mod __client_accounts_unpause {
    pub use crate::instructions::__client_accounts_unpause::*;
}
pub mod __client_accounts_revoke_recipient {
    pub use crate::instructions::__client_accounts_revoke_recipient::*;
}
pub mod __client_accounts_release_to_recipient {
    pub use crate::instructions::__client_accounts_release_to_recipient::*;
}
pub mod __client_accounts_batch_release {
    pub use crate::instructions::__client_accounts_batch_release::*;
}
pub mod __client_accounts_emit_vesting_quote {
    pub use crate::instructions::__client_accounts_emit_vesting_quote::*;
}
pub mod __client_accounts_sweep_dust_after_end {
    pub use crate::instructions::__client_accounts_sweep_dust_after_end::*;
}

declare_id!("61EiRiRNSU4ZEhnn8JpC6L9VRHz6oKvD9YzSP6bNZNWp");

#[program]
pub mod vesting {
    use super::*;
    use anchor_lang::solana_program::program_pack::Pack;
    use anchor_spl::token::{self, Transfer};
    use anchor_spl::token::spl_token::state::Account as SplTokenAccount;

    /// Create the schedule state PDA, recipients list PDA, and vault token account PDA.
    pub fn initialize_schedule(
        ctx: Context<InitializeSchedule>,
        distributor: Pubkey,
        start_ts: i64,
        total_supply: u64,
    ) -> Result<()> {
        instructions::initialize_schedule::initialize_schedule(ctx, distributor, start_ts, total_supply)
    }

    /// Add recipients in deterministic input order (batched). Optionally seal.
    pub fn add_recipients(
        ctx: Context<AddRecipients>,
        inputs: Vec<RecipientInput>,
        seal: bool,
    ) -> Result<()> {
        instructions::add_recipients::add_recipients(ctx, inputs, seal)
    }

    /// Deposit tokens into the vault before start. Reject post-start and over-deposit.
    pub fn deposit_tokens(ctx: Context<DepositTokens>, amount: u64) -> Result<()> {
        instructions::deposit_tokens::deposit_tokens(ctx, amount)
    }

    /// Set distributor (admin-only). Enforces distributor != admin.
    pub fn set_distributor(ctx: Context<SetDistributor>, new_distributor: Pubkey) -> Result<()> {
        instructions::set_distributor::set_distributor(ctx, new_distributor)
    }

    /// Pause releases (admin-only). Accrual continues.
    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        instructions::pause::pause(ctx)
    }

    /// Unpause releases (admin-only). Catch-up allowed.
    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        instructions::unpause::unpause(ctx)
    }

    /// Revoke a recipient (admin-only). Stops future releases.
    pub fn revoke_recipient(ctx: Context<RevokeRecipient>, wallet: Pubkey) -> Result<()> {
        instructions::revoke_recipient::revoke_recipient(ctx, wallet)
    }

    /// Release tokens to a single recipient (distributor-only).
    pub fn release_to_recipient(ctx: Context<ReleaseToRecipient>, wallet: Pubkey) -> Result<()> {
        instructions::release_to_recipient::release_to_recipient(ctx, wallet)
    }

    /// Batch release tokens to up to 5 recipients (distributor-only). Atomic.
    pub fn batch_release<'info>(
        ctx: Context<'_, '_, '_, 'info, BatchRelease<'info>>,
        wallets: Vec<Pubkey>,
    ) -> Result<()> {
        // NOTE: We implement the batch logic directly in the entrypoint to avoid
        // `anchor_lang::Context` invariance lifetime coercion issues when delegating.
        // This keeps everything in a single `'info` region.

        // Capture infos/keys before taking mutable borrows.
        let schedule_state_ai = ctx.accounts.schedule_state.to_account_info();
        let token_program_key = ctx.accounts.token_program.key();
        let token_program_ai = ctx.accounts.token_program.to_account_info();
        let vault_ai = ctx.accounts.vault.to_account_info();

        let st = &mut ctx.accounts.schedule_state;
        require!(st.sealed, VestingError::RecipientsNotSealed);
        require!(!st.paused, VestingError::SchedulePaused);
        require_keys_eq!(
            ctx.accounts.distributor.key(),
            st.distributor,
            VestingError::UnauthorizedDistributor
        );

        require!(!wallets.is_empty(), VestingError::EmptyBatch);
        require!(
            wallets.len() <= MAX_BATCH_RELEASE,
            VestingError::BatchTooLarge
        );
        require!(
            ctx.remaining_accounts.len() == wallets.len(),
            VestingError::InvalidConfig
        );

        let now = Clock::get()?.unix_timestamp;
        let month_idx = crate::utils::time::month_index(now, st.start_ts)?;

        // Validate vault SPL token account.
        // IMPORTANT: do NOT hold any account data borrows across CPIs (will cause AccountBorrowFailed).
        require_keys_eq!(*vault_ai.owner, token_program_key, VestingError::InvalidTokenProgram);
        let mut vault_balance: u64 = {
            let vault_data = vault_ai.try_borrow_data()?;
            let vault_state = SplTokenAccount::unpack(&vault_data)
                .map_err(|_| VestingError::InvalidTokenAccount)?;
            require_keys_eq!(vault_state.mint, st.mint, VestingError::InvalidTokenMint);
            vault_state.amount
        };

        // Enforce full funding before any release (released_supply == 0).
        if st.released_supply == 0 {
            require!(vault_balance == st.total_supply, VestingError::VaultNotExactlyFunded);
        }

        let signer_seeds: &[&[&[u8]]] = &[&[b"schedule_state", &[ctx.bumps.schedule_state]]];

        for (i, wallet) in wallets.iter().enumerate() {
            let ata_ai = &ctx.remaining_accounts[i];

            // Canonical ATA check.
            let expected = {
                let seeds: &[&[u8]] = &[
                    wallet.as_ref(),
                    anchor_spl::token::ID.as_ref(),
                    st.mint.as_ref(),
                ];
                let (ata, _) =
                    Pubkey::find_program_address(seeds, &anchor_spl::associated_token::ID);
                ata
            };
            require_keys_eq!(ata_ai.key(), expected, VestingError::InvalidRecipientAta);

            // Token account must be SPL Token owned; unpack and validate mint/owner.
            require_keys_eq!(*ata_ai.owner, token_program_key, VestingError::InvalidTokenProgram);
            {
                let ata_data = ata_ai.try_borrow_data()?;
                let ata_state = SplTokenAccount::unpack(&ata_data)
                    .map_err(|_| VestingError::InvalidTokenAccount)?;
                require_keys_eq!(ata_state.mint, st.mint, VestingError::InvalidTokenMint);
                require_keys_eq!(ata_state.owner, *wallet, VestingError::InvalidTokenAccount);
            }

            // Find recipient entry.
            let entry = ctx
                .accounts
                .recipients
                .entries
                .iter_mut()
                .find(|e| e.wallet == *wallet)
                .ok_or(VestingError::RecipientNotFound)?;

            if entry.revoked {
                continue;
            }

            let vested = {
                let m = month_idx.min(DURATION_MONTHS);
                if m == DURATION_MONTHS {
                    let v = (entry.monthly_amount as u128)
                        .checked_mul(11)
                        .ok_or(VestingError::MathOverflow)?
                        .checked_add(entry.final_amount as u128)
                        .ok_or(VestingError::MathOverflow)?;
                    u64::try_from(v).map_err(|_| VestingError::MathOverflow)?
                } else {
                    let v = (entry.monthly_amount as u128)
                        .checked_mul(m as u128)
                        .ok_or(VestingError::MathOverflow)?;
                    u64::try_from(v).map_err(|_| VestingError::MathOverflow)?
                }
            };

            let releasable = vested
                .checked_sub(entry.released_amount)
                .ok_or(VestingError::MathOverflow)?;
            if releasable == 0 {
                continue;
            }

            require!(vault_balance >= releasable, VestingError::InsufficientVaultBalance);

            token::transfer(
                CpiContext::new_with_signer(
                    token_program_ai.clone(),
                    Transfer {
                        from: vault_ai.clone(),
                        to: ata_ai.clone(),
                        authority: schedule_state_ai.clone(),
                    },
                    signer_seeds,
                ),
                releasable,
            )?;

            vault_balance = vault_balance
                .checked_sub(releasable)
                .ok_or(VestingError::MathOverflow)?;

            entry.released_amount = entry
                .released_amount
                .checked_add(releasable)
                .ok_or(VestingError::MathOverflow)?;
            st.released_supply = st
                .released_supply
                .checked_add(releasable)
                .ok_or(VestingError::MathOverflow)?;

            emit!(instructions::batch_release::TokensReleasedBatchItem {
                wallet: *wallet,
                month_index: month_idx,
                amount: releasable,
                allocation: entry.allocation,
                released_total: entry.released_amount,
            });
        }

        Ok(())
    }

    /// Emit a read-only vesting quote log for UX/parity checks.
    pub fn emit_vesting_quote(ctx: Context<EmitVestingQuote>, wallet: Pubkey) -> Result<()> {
        instructions::emit_vesting_quote::emit_vesting_quote(ctx, wallet)
    }

    /// Sweep remaining vault dust after vesting end (admin-only).
    pub fn sweep_dust_after_end(ctx: Context<SweepDustAfterEnd>) -> Result<()> {
        instructions::sweep_dust_after_end::sweep_dust_after_end(ctx)
    }
}
