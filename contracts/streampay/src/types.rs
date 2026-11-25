use soroban_sdk::{contracttype, Address, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AmendmentRecord {
    pub old_rate: i128,
    pub new_rate: i128,
    pub old_end_time: u64,
    pub new_end_time: u64,
    pub effective_timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    RefillRule(u64),
    GovernanceCaps,
    Agents(u64),
    AmendmentLog(u64), // stream_id -> Vec<AmendmentRecord>
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StreamPayError {
    Unauthorized = 200,
    RefillRuleNotFound = 201,
    CadenceNotElapsed = 202,
    MaxTopupsExceeded = 203,
    BudgetExceeded = 204,
    StreamPaused = 205,
    GovernanceCapExceeded = 206,
    TooManyAgents = 300,
    AgentNotFound = 301,
    InvalidAgentSignature = 302,
    TooManyAmendments = 400,
    InvalidAmendmentTerms = 401,
}
