use anchor_lang::prelude::*;

declare_id!("61EiRiRNSU4ZEhnn8JpC6L9VRHz6oKvD9YzSP6bNZNWp");

#[program]
pub mod vesting {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
