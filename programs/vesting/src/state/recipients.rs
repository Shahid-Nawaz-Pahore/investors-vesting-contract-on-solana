use anchor_lang::prelude::*;

/// A single recipient entry stored in the recipients list PDA.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecipientEntry {
    pub wallet: Pubkey,
    pub allocation: u64,
    pub released_amount: u64,
    pub revoked: bool,
    pub monthly_amount: u64,
    pub final_amount: u64,
}

/// PDA holding the full recipients list (<= 35 entries).
#[account]
pub struct Recipients {
    /// Deterministic input ordering; sealed prevents reordering/mutation.
    pub entries: Vec<RecipientEntry>,
}

impl Recipients {
    /// Space for discriminator + vec len + max entries.
    pub fn space(max_entries: usize) -> usize {
        // discriminator
        8 +
        // vec length (u32)
        4 +
        // entries
        max_entries * RecipientEntry::SIZE
    }
}

impl RecipientEntry {
    pub const SIZE: usize =
        32 + // wallet
        8 +  // allocation
        8 +  // released_amount
        1 +  // revoked
        8 +  // monthly_amount
        8;   // final_amount
}

/// Instruction input (wallet + allocation).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecipientInput {
    pub wallet: Pubkey,
    pub allocation: u64,
}


