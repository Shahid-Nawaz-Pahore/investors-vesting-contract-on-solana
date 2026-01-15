use anchor_lang::prelude::*;

use crate::error::VestingError;
use crate::state::ScheduleState;

pub fn set_distributor(ctx: Context<SetDistributor>, new_distributor: Pubkey) -> Result<()> {
    require!(new_distributor != Pubkey::default(), VestingError::InvalidPubkey);

    let schedule_state_key = ctx.accounts.schedule_state.key();
    let st = &mut ctx.accounts.schedule_state;
    require_keys_eq!(ctx.accounts.admin.key(), st.admin, VestingError::UnauthorizedAdmin);

    require!(
        new_distributor != st.admin,
        VestingError::InvalidConfig
    );
    require!(
        new_distributor != schedule_state_key,
        VestingError::InvalidConfig
    );
    require!(new_distributor != crate::ID, VestingError::InvalidConfig);

    // Spec: distributor must not be any program PDA (cannot sign). Explicitly block the known PDAs.
    let (vault_pda, _) =
        Pubkey::find_program_address(&[b"vault", schedule_state_key.as_ref()], &crate::ID);
    let (recipients_pda, _) = Pubkey::find_program_address(
        &[b"recipients", schedule_state_key.as_ref()],
        &crate::ID,
    );
    require!(new_distributor != vault_pda, VestingError::InvalidConfig);
    require!(new_distributor != recipients_pda, VestingError::InvalidConfig);

    let old = st.distributor;
    st.distributor = new_distributor;

    emit!(DistributorSet {
        admin: st.admin,
        old_distributor: old,
        new_distributor,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetDistributor<'info> {
    #[account(mut, seeds = [b"schedule_state"], bump)]
    pub schedule_state: Account<'info, ScheduleState>,

    pub admin: Signer<'info>,
}

#[event]
pub struct DistributorSet {
    pub admin: Pubkey,
    pub old_distributor: Pubkey,
    pub new_distributor: Pubkey,
}


