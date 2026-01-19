use anchor_lang::prelude::*;

/// A single recipient entry stored in the recipients list PDA.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[repr(C)]
pub struct RecipientEntry {
    pub wallet: Pubkey,
    pub allocation: u64,
    pub released_amount: u64,
    pub revoked: u8,
    pub _padding: [u8; 7],
    pub monthly_amount: u64,
    pub final_amount: u64,
}

impl Default for RecipientEntry {
    fn default() -> Self {
        Self {
            wallet: Pubkey::default(),
            allocation: 0,
            released_amount: 0,
            revoked: 0,
            _padding: [0u8; 7],
            monthly_amount: 0,
            final_amount: 0,
        }
    }
}

/// PDA holding the full recipients list (<= 35 entries).
#[account]
#[repr(C)]
pub struct Recipients {
    /// Deterministic input ordering; sealed prevents reordering/mutation.
    pub entries: [RecipientEntry; crate::constants::MAX_RECIPIENTS],
}

impl Recipients {
    /// Space for discriminator + fixed entries array (no vec header).
    pub const fn space() -> usize {
        8 + core::mem::size_of::<Recipients>()
    }
}

impl RecipientEntry {
    pub const SIZE: usize = core::mem::size_of::<RecipientEntry>();
}

/// Instruction input (wallet + allocation).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecipientInput {
    pub wallet: Pubkey,
    pub allocation: u64,
}


