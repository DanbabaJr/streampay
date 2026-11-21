use soroban_sdk::{Env, Address};
use crate::types::{GovernanceCaps, DataKey};

pub fn set_governance_caps(env: Env, admin: Address, max_per_stream: i128, max_global: i128) {
    admin.require_auth();
    let caps = GovernanceCaps {
        max_per_stream_cap: max_per_stream,
        max_global_account_cap: max_global,
    };
    env.storage().instance().set(&DataKey::GovernanceCaps, &caps);
}
