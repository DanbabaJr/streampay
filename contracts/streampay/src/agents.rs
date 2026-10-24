use soroban_sdk::{Env, Address, Vec};
use crate::types::{DataKey, StreamPayError};

const MAX_AGENTS: u32 = 10;

pub fn add_agent(env: Env, recipient: Address, stream_id: u64, agent: Address) -> Result<(), StreamPayError> {
    recipient.require_auth();

    // Verify recipient owns/is recipient of the stream (pseudo-code check for stream ownership)
    // ...

    let mut agents: Vec<Address> = env.storage().persistent()
        .get(&DataKey::Agents(stream_id))
        .unwrap_or(Vec::new(&env));

    if agents.contains(&agent) {
        return Ok(());
    }

    if agents.len() >= MAX_AGENTS {
        return Err(StreamPayError::TooManyAgents);
    }

    agents.push_back(agent.clone());
    env.storage().persistent().set(&DataKey::Agents(stream_id), &agents);

    env.events().publish(("streampay", "agent_added"), (stream_id, agent));
    Ok(())
}

pub fn remove_agent(env: Env, recipient: Address, stream_id: u64, agent: Address) -> Result<(), StreamPayError> {
    recipient.require_auth();

    let agents: Vec<Address> = env.storage().persistent()
        .get(&DataKey::Agents(stream_id))
        .ok_or(StreamPayError::AgentNotFound)?;

    let mut new_agents = Vec::new(&env);
    let mut found = false;

    for a in agents.iter() {
        if a == agent {
            found = true;
        } else {
            new_agents.push_back(a);
        }
    }

    if !found {
        return Err(StreamPayError::AgentNotFound);
    }

    env.storage().persistent().set(&DataKey::Agents(stream_id), &new_agents);
    env.events().publish(("streampay", "agent_removed"), (stream_id, agent));
    Ok(())
}

pub fn withdraw_on_behalf_of(
    env: Env,
    agent: Address,
    stream_id: u64,
    amount: i128,
) -> Result<(), StreamPayError> {
    agent.require_auth();

    let agents: Vec<Address> = env.storage().persistent()
        .get(&DataKey::Agents(stream_id))
        .ok_or(StreamPayError::AgentNotFound)?;

    if !agents.contains(&agent) {
        return Err(StreamPayError::Unauthorized);
    }

    // Execute transfer to recipient's address (payouts always land at recipient)
    // emit event with withdrawn_by field for auditability
    env.events().publish(("streampay", "withdrawn_by_agent"), (stream_id, agent, amount));

    Ok(())
}
