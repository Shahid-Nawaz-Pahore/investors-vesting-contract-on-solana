use anchor_lang::prelude::*;

use crate::error::VestingError;
use crate::state::ScheduleState;

pub fn pause(ctx: Context<Pause>) -> Result<()> {
    let st = &mut ctx.accounts.schedule_state;
    require_keys_eq!(ctx.accounts.admin.key(), st.admin, VestingError::UnauthorizedAdmin);
    require!(!st.paused, VestingError::SchedulePaused);
    st.paused = true;
    emit!(SchedulePaused { admin: st.admin });
    Ok(())
}

#[derive(Accounts)]
pub struct Pause<'info> {
    #[account(mut, seeds = [b"schedule_state"], bump)]
    pub schedule_state: Account<'info, ScheduleState>,
    pub admin: Signer<'info>,
}

#[event]
pub struct SchedulePaused {
    pub admin: Pubkey,
}


