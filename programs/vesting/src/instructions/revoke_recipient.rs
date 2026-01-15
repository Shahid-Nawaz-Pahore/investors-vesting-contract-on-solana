use anchor_lang::prelude::*;

use crate::error::VestingError;
use crate::state::{Recipients, ScheduleState};

pub fn revoke_recipient(ctx: Context<RevokeRecipient>, wallet: Pubkey) -> Result<()> {
    let st = &ctx.accounts.schedule_state;
    require_keys_eq!(ctx.accounts.admin.key(), st.admin, VestingError::UnauthorizedAdmin);

    let recipients = &mut ctx.accounts.recipients;
    let mut found = false;
    for e in recipients.entries.iter_mut() {
        if e.wallet == wallet {
            if e.revoked {
                return Err(VestingError::RecipientRevoked.into());
            }
            e.revoked = true;
            found = true;
            break;
        }
    }
    require!(found, VestingError::RecipientNotFound);

    emit!(RecipientRevoked {
        admin: st.admin,
        wallet,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct RevokeRecipient<'info> {
    #[account(seeds = [b"schedule_state"], bump)]
    pub schedule_state: Account<'info, ScheduleState>,

    #[account(
        mut,
        seeds = [b"recipients", schedule_state.key().as_ref()],
        bump
    )]
    pub recipients: Account<'info, Recipients>,

    pub admin: Signer<'info>,
}

#[event]
pub struct RecipientRevoked {
    pub admin: Pubkey,
    pub wallet: Pubkey,
}


