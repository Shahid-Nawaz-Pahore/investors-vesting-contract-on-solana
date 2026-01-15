use anchor_lang::prelude::*;

use crate::error::VestingError;
use crate::state::ScheduleState;

pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
    let st = &mut ctx.accounts.schedule_state;
    require_keys_eq!(ctx.accounts.admin.key(), st.admin, VestingError::UnauthorizedAdmin);
    require!(st.paused, VestingError::ScheduleNotPaused);
    st.paused = false;
    emit!(ScheduleUnpaused { admin: st.admin });
    Ok(())
}

#[derive(Accounts)]
pub struct Unpause<'info> {
    #[account(mut, seeds = [b"schedule_state"], bump)]
    pub schedule_state: Account<'info, ScheduleState>,
    pub admin: Signer<'info>,
}

#[event]
pub struct ScheduleUnpaused {
    pub admin: Pubkey,
}


