use anchor_lang::prelude::*;

use crate::constants::{DURATION_MONTHS, MAX_RECIPIENTS};
use crate::error::VestingError;
use crate::state::{RecipientEntry, RecipientInput, Recipients, ScheduleState};

pub fn add_recipients(
    ctx: Context<AddRecipients>,
    inputs: Vec<RecipientInput>,
    seal: bool,
) -> Result<()> {
    let st = &mut ctx.accounts.schedule_state;
    require_keys_eq!(ctx.accounts.admin.key(), st.admin, VestingError::UnauthorizedAdmin);
    require!(!st.sealed, VestingError::RecipientsSealed);
    require!(st.duration_months == DURATION_MONTHS, VestingError::InvalidConfig);

    let recipients = &mut ctx.accounts.recipients;
    let mut added: u8 = 0;

    for (i, input) in inputs.iter().enumerate() {
        require!(input.wallet != Pubkey::default(), VestingError::InvalidPubkey);
        require!(input.allocation > 0, VestingError::InvalidAllocation);

        // Enforce cap.
        require!(
            (st.recipient_count as usize) < MAX_RECIPIENTS,
            VestingError::RecipientListFull
        );

        // Reject duplicates vs existing list.
        for e in recipients.entries.iter().take(st.recipient_count as usize) {
            if e.wallet == input.wallet {
                return Err(VestingError::DuplicateRecipient.into());
            }
        }
        // Reject duplicates within the batch itself.
        for j in 0..i {
            if inputs[j].wallet == input.wallet {
                return Err(VestingError::DuplicateRecipient.into());
            }
        }

        let monthly_amount = input.allocation / (DURATION_MONTHS as u64);
        let remainder = input.allocation % (DURATION_MONTHS as u64);
        let final_amount = monthly_amount
            .checked_add(remainder)
            .ok_or(VestingError::MathOverflow)?;

        let idx = st.recipient_count as usize;
        recipients.entries[idx] = RecipientEntry {
            wallet: input.wallet,
            allocation: input.allocation,
            released_amount: 0,
            revoked: 0,
            _padding: [0u8; 7],
            monthly_amount,
            final_amount,
        };
        st.recipient_count = st
            .recipient_count
            .checked_add(1)
            .ok_or(VestingError::MathOverflow)?;
        added = added.checked_add(1).ok_or(VestingError::MathOverflow)?;
    }

    // Enforce allocation sum does not exceed total supply at any point.
    let sum = allocations_sum_u128(&recipients.entries, st.recipient_count)?;
    require!(
        sum <= st.total_supply as u128,
        VestingError::AllocationSumExceedsTotalSupply
    );

    emit!(RecipientsAdded {
        count_added: added,
        new_total: st.recipient_count,
        sealed: false,
    });

    if seal {
        require!(
            sum == st.total_supply as u128,
            VestingError::AllocationSumMismatchAtSeal
        );
        st.sealed = true;
        emit!(RecipientsAdded {
            count_added: 0,
            new_total: st.recipient_count,
            sealed: true,
        });
    }

    Ok(())
}

fn allocations_sum_u128(entries: &[RecipientEntry], count: u8) -> Result<u128> {
    let mut sum: u128 = 0;
    for e in entries.iter().take(count as usize) {
        sum = sum
            .checked_add(e.allocation as u128)
            .ok_or(VestingError::MathOverflow)?;
    }
    Ok(sum)
}

#[derive(Accounts)]
pub struct AddRecipients<'info> {
    #[account(mut, seeds = [b"schedule_state"], bump)]
    pub schedule_state: Account<'info, ScheduleState>,

    #[account(
        mut,
        seeds = [b"recipients", schedule_state.key().as_ref()],
        bump
    )]
    pub recipients: Box<Account<'info, Recipients>>,

    #[account(mut)]
    pub admin: Signer<'info>,
}

#[event]
pub struct RecipientsAdded {
    pub count_added: u8,
    pub new_total: u8,
    pub sealed: bool,
}


