use anchor_lang::prelude::*;
use bytemuck::{Pod, Zeroable};

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

unsafe impl Pod for RecipientEntry {}
unsafe impl Zeroable for RecipientEntry {}

impl RecipientEntry {
    pub const SIZE: usize = core::mem::size_of::<RecipientEntry>();
}

/// PDA holding the full recipients list (<= 70 entries).
#[account(zero_copy)]
#[repr(C)]
pub struct Recipients {
    pub entries: [RecipientEntry; 70],
}

impl Recipients {
    pub const fn space() -> usize {
        8 + core::mem::size_of::<Recipients>()
    }
}

/// Instruction input (wallet + allocation).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecipientInput {
    pub wallet: Pubkey,
    pub allocation: u64,
}