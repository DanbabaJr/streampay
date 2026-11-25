//! Reusable, versioned stream templates approved by governance.
//!
//! Integrators instantiate approved templates (rate/duration/policy presets)
//! without repeated parameter validation, creating auditable stream shapes
//! while preserving lineage and value conservation.

use soroban_sdk::{contracttype, Address, Env};

use crate::errors::StreamError;
use crate::events::TemplateApproved;
use crate::stream::{DataKey, TTL_EXTEND_LEDGERS, TTL_THRESHOLD_LEDGERS};
use crate::surface::{self, Branch};

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Immutable, versioned stream template preset."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamTemplate {
    pub id: u32,
    pub version: u32,
    pub token: Address,
    pub duration: u64,
    pub cancelable: bool,
    pub use_oracle: bool,
    pub min_deposit: i128,
    pub max_deposit: i128,
    pub created_at: u64,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Lineage linking an instantiated stream to its template preset."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TemplateLineage {
    pub template_id: u32,
    pub version: u32,
}

/// Returns the highest approved version for `template_id`, or 0 if none.
pub fn get_latest_template_version(env: &Env, template_id: u32) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::LatestTemplateVersion(template_id))
        .unwrap_or(0)
}

/// Returns the template for (`template_id`, `version`), if approved.
pub fn get_template(env: &Env, template_id: u32, version: u32) -> Option<StreamTemplate> {
    #[cfg(test)]
    crate::cei_trace::record(&std::format!(
        "read persistent Template({template_id}, {version})"
    ));
    env.storage()
        .persistent()
        .get(&DataKey::Template(template_id, version))
}

/// Approves a new template or template version.
/// Must be authorized by the governor.
pub fn approve_template(
    env: &Env,
    caller: Address,
    template_id: u32,
    version: u32,
    mut template: StreamTemplate,
) -> Result<(), StreamError> {
    crate::treasury::require_governor(env, &caller)?;

    let latest = get_latest_template_version(env, template_id);
    if version <= latest {
        return Err(surface::reject(Branch::TemplateAlreadyApproved));
    }
    if version != latest + 1 {
        return Err(surface::reject(Branch::TemplateVersionMismatch));
    }

    if template.duration == 0 || template.duration > crate::MAX_DURATION_SECONDS {
        return Err(surface::reject(Branch::TemplateValidationFailed));
    }
    if template.min_deposit <= 0 || template.max_deposit < template.min_deposit {
        return Err(surface::reject(Branch::TemplateValidationFailed));
    }

    // Check policy floors/ceilings
    let rate = template.min_deposit / template.duration as i128;
    if rate <= 0 {
        return Err(surface::reject(Branch::TemplateRateInvalid));
    }
    let token_opt = Some(template.token.clone());
    let policy = crate::policy::get_stream_policy(env, token_opt);
    crate::policy::validate_stream_args(policy.as_ref(), template.min_deposit, template.duration)?;

    template.id = template_id;
    template.version = version;
    template.created_at = env.ledger().timestamp();

    let key = DataKey::Template(template_id, version);
    #[cfg(test)]
    crate::cei_trace::record(&std::format!(
        "write persistent Template({template_id}, {version})"
    ));
    env.storage().persistent().set(&key, &template);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    env.storage()
        .instance()
        .set(&DataKey::LatestTemplateVersion(template_id), &version);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    #[cfg(test)]
    crate::cei_trace::record("event TemplateApproved");
    TemplateApproved {
        template_id,
        version,
        token: template.token,
        duration: template.duration,
    }
    .publish(env);

    Ok(())
}

/// Records the template lineage for an instantiated stream.
pub fn record_lineage(env: &Env, stream_id: u64, template_id: u32, version: u32) {
    let lineage = TemplateLineage {
        template_id,
        version,
    };
    let key = DataKey::StreamTemplateLineage(stream_id);
    #[cfg(test)]
    crate::cei_trace::record(&std::format!(
        "write persistent StreamTemplateLineage({stream_id})"
    ));
    env.storage().persistent().set(&key, &lineage);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Returns the template lineage for a stream, if instantiated from a template.
pub fn get_stream_lineage(env: &Env, stream_id: u64) -> Option<TemplateLineage> {
    #[cfg(test)]
    crate::cei_trace::record(&std::format!(
        "read persistent StreamTemplateLineage({stream_id})"
    ));
    env.storage()
        .persistent()
        .get(&DataKey::StreamTemplateLineage(stream_id))
}
