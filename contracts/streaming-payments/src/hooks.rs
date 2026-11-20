//! Integrator callback hooks with reentrancy-safe checks-effects-interactions (CEI).
//!
//! Integrator contracts register callbacks invoked on stream lifecycle transitions
//! (withdraw, cancel, complete) so external systems react atomically. Cross-contract
//! calls are guarded by a mechanical reentrancy lock and strict CEI ordering.

use soroban_sdk::{contracttype, Address, Env, IntoVal, Symbol, Val, Vec};

use crate::errors::StreamError;
use crate::events::{HookFailed, HookInvoked, HookRegistered};
use crate::stream::{DataKey, TTL_EXTEND_LEDGERS, TTL_THRESHOLD_LEDGERS};
use crate::surface::{self, Branch};

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Lifecycle transition event classes supported for callbacks."
)]
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum HookEventClass {
    Withdraw = 1,
    Cancel = 2,
    Complete = 3,
}

impl HookEventClass {
    pub fn as_symbol(self, env: &Env) -> Symbol {
        match self {
            HookEventClass::Withdraw => Symbol::new(env, "on_withdraw"),
            HookEventClass::Cancel => Symbol::new(env, "on_cancel"),
            HookEventClass::Complete => Symbol::new(env, "on_complete"),
        }
    }
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Failure policy for a callback invocation."
)]
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum HookFailurePolicy {
    EmitAndContinue = 0,
    Revert = 1,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Registered callback hook definition."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamHook {
    pub callback_contract: Address,
    pub selector: Symbol,
    pub failure_policy: HookFailurePolicy,
    pub registered_by: Address,
}

/// Returns whether stream `stream_id` is currently locked against reentrancy.
pub fn is_stream_locked(env: &Env, stream_id: u64) -> bool {
    env.storage()
        .temporary()
        .get(&DataKey::StreamReentrancyLock(stream_id))
        .unwrap_or(false)
}

/// Sets the reentrancy lock status for stream `stream_id`.
pub fn set_stream_locked(env: &Env, stream_id: u64, locked: bool) {
    let key = DataKey::StreamReentrancyLock(stream_id);
    if locked {
        env.storage().temporary().set(&key, &true);
    } else {
        env.storage().temporary().remove(&key);
    }
}

/// Returns the registered hook for (`stream_id`, `event_class`), if any.
pub fn get_hook(env: &Env, stream_id: u64, event_class: HookEventClass) -> Option<StreamHook> {
    let sym = event_class.as_symbol(env);
    env.storage()
        .persistent()
        .get(&DataKey::StreamHook(stream_id, sym))
}

/// Registers an integrator callback hook for stream `stream_id`.
pub fn register_hook(
    env: &Env,
    caller: Address,
    stream_id: u64,
    event_class: HookEventClass,
    callback_contract: Address,
    selector: Symbol,
    failure_policy: HookFailurePolicy,
) -> Result<(), StreamError> {
    caller.require_auth();

    let s = crate::stream::get_stream(env, stream_id)?;

    if caller != s.sender && caller != s.recipient {
        return Err(StreamError::NotAuthorized);
    }

    if selector == Symbol::new(env, "") {
        return Err(surface::reject(Branch::InvalidHookSelector));
    }

    if get_hook(env, stream_id, event_class).is_some() {
        return Err(surface::reject(Branch::HookAlreadyRegistered));
    }

    let hook = StreamHook {
        callback_contract: callback_contract.clone(),
        selector: selector.clone(),
        failure_policy,
        registered_by: caller,
    };

    let sym = event_class.as_symbol(env);
    let key = DataKey::StreamHook(stream_id, sym.clone());
    #[cfg(test)]
    crate::cei_trace::record(&std::format!("write persistent StreamHook({stream_id})"));
    env.storage().persistent().set(&key, &hook);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    #[cfg(test)]
    crate::cei_trace::record("event HookRegistered");
    HookRegistered {
        stream_id,
        event_class: sym,
        callback_contract,
        selector,
    }
    .publish(env);

    Ok(())
}

/// Unregisters a previously registered callback hook.
pub fn unregister_hook(
    env: &Env,
    caller: Address,
    stream_id: u64,
    event_class: HookEventClass,
) -> Result<(), StreamError> {
    caller.require_auth();

    let hook = get_hook(env, stream_id, event_class)
        .ok_or_else(|| surface::reject(Branch::HookNotFound))?;

    let s = crate::stream::get_stream(env, stream_id)?;

    if caller != hook.registered_by && caller != s.sender && caller != s.recipient {
        return Err(StreamError::NotAuthorized);
    }

    let sym = event_class.as_symbol(env);
    let key = DataKey::StreamHook(stream_id, sym);
    #[cfg(test)]
    crate::cei_trace::record(&std::format!("remove persistent StreamHook({stream_id})"));
    env.storage().persistent().remove(&key);

    Ok(())
}

/// Dispatches an external callback hook with reentrancy protection.
/// All state mutations and token transfers MUST have completed before this is called.
pub fn dispatch_hook(
    env: &Env,
    stream_id: u64,
    event_class: HookEventClass,
    amount: i128,
) -> Result<(), StreamError> {
    let Some(hook) = get_hook(env, stream_id, event_class) else {
        return Ok(());
    };

    if is_stream_locked(env, stream_id) {
        return Err(surface::reject(Branch::HookReentrancyBlocked));
    }

    set_stream_locked(env, stream_id, true);

    #[cfg(test)]
    crate::cei_trace::record("dispatch hook callback");

    let sym = event_class.as_symbol(env);

    // Call the external callback contract: selector(stream_id, amount)
    let mut args: Vec<Val> = Vec::new(env);
    args.push_back(stream_id.into_val(env));
    args.push_back(amount.into_val(env));

    let invoke_res = env.try_invoke_contract::<Val, soroban_sdk::InvokeError>(
        &hook.callback_contract,
        &hook.selector,
        args,
    );

    set_stream_locked(env, stream_id, false);

    match invoke_res {
        Ok(Ok(_)) => {
            #[cfg(test)]
            crate::cei_trace::record("event HookInvoked");
            HookInvoked {
                stream_id,
                event_class: sym,
                callback_contract: hook.callback_contract,
            }
            .publish(env);
            Ok(())
        }
        Ok(Err(_)) | Err(_) => {
            #[cfg(test)]
            crate::cei_trace::record("event HookFailed");
            HookFailed {
                stream_id,
                event_class: sym,
                callback_contract: hook.callback_contract,
                error_code: StreamError::HookExecutionFailed as u32,
            }
            .publish(env);

            match hook.failure_policy {
                HookFailurePolicy::EmitAndContinue => Ok(()),
                HookFailurePolicy::Revert => Err(surface::reject(Branch::HookExecutionFailed)),
            }
        }
    }
}
