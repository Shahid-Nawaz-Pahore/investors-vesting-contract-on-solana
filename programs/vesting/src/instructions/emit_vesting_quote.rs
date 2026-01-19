use anchor_lang::prelude::*;

use crate::constants::DURATION_MONTHS;
use crate::error::VestingError;
use crate::state::{Recipients, ScheduleState};
use crate::utils::time;

pub fn emit_vesting_quote(ctx: Context<EmitVestingQuote>, wallet: Pubkey) -> Result<()> {
    let st = &ctx.accounts.schedule_state;
    let now = Clock::get()?.unix_timestamp;
    let month_idx = time::month_index(now, st.start_ts)?;

    let recipients = &ctx.accounts.recipients;
    let entry = recipients
        .entries
        .iter()
        .take(st.recipient_count as usize)
        .find(|e| e.wallet == wallet)
        .ok_or(VestingError::RecipientNotFound)?;

    let vested = vested_amount(entry.monthly_amount, entry.final_amount, month_idx)?;
    let releasable = vested
        .checked_sub(entry.released_amount)
        .ok_or(VestingError::MathOverflow)?;

    emit!(VestingQuote {
        wallet,
        month_index: month_idx,
        vested_amount: vested,
        released_amount: entry.released_amount,
        releasable,
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

#[derive(Accounts)]
pub struct EmitVestingQuote<'info> {
    #[account(seeds = [b"schedule_state"], bump)]
    pub schedule_state: Account<'info, ScheduleState>,

    #[account(
        seeds = [b"recipients", schedule_state.key().as_ref()],
        bump
    )]
    pub recipients: Box<Account<'info, Recipients>>,
}

#[event]
pub struct VestingQuote {
    pub wallet: Pubkey,
    pub month_index: u8,
    pub vested_amount: u64,
    pub released_amount: u64,
    pub releasable: u64,
}


