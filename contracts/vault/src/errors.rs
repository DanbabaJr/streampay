//! Error types for the StreamPay Vault contract.
//!
//! Codes are stable once deployed — never renumber or reuse a variant.
//! Only append new ones at the bottom with the next free code.

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VaultError {
    /// The vault has not been initialized yet.
    NotInitialized = 1,
    /// The vault has already been initialized.
    AlreadyInitialized = 2,
    /// The recipient is not registered in the vault.
    RecipientNotFound = 3,
    /// The recipient is already registered in the vault.
    RecipientAlreadyExists = 4,
    /// A provided amount or weight is zero or negative.
    ZeroValue = 5,
    /// An intermediate computation overflowed.
    MathOverflow = 6,
    /// A rebalance would leave the vault over-committed (invariant violation).
    Insolvent = 7,
    /// The recipient has nothing available to withdraw at this time.
    NothingToWithdraw = 8,
    /// `end_time` must be strictly after `start_time`, and `start_time` must
    /// not be in the past.
    InvalidTimeRange = 9,
    /// The vault is closed (past its horizon); no new recipients can be added.
    VaultClosed = 10,
    /// The vault is at maximum recipient capacity (`MAX_RECIPIENTS`).
    TooManyRecipients = 11,
    /// Token pull failed during vault funding (insufficient balance or allowance).
    FundTransferFailed = 12,
    /// Token payout failed during recipient withdrawal.
    WithdrawTransferFailed = 13,
    /// Token payout failed during recipient removal.
    RecipientPayoutFailed = 14,
}
