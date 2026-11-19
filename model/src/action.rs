//! Actions that can be applied to both the reference model and the Soroban contract.

#[cfg(feature = "arbitrary")]
use arbitrary::{Arbitrary, Unstructured};

/// An entrypoint operation or ledger advancement.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    CreateStream {
        sender_idx: u8,
        recipient_idx: u8,
        deposit_amount: i128,
        start_delay_secs: u32,
        duration_secs: u32,
        cancelable: bool,
    },
    Withdraw {
        stream_id: u64,
        amount: i128,
    },
    WithdrawMax {
        stream_id: u64,
    },
    CancelStream {
        caller_idx: u8,
        stream_id: u64,
    },
    TopUp {
        caller_idx: u8,
        stream_id: u64,
        amount: i128,
    },
    SetFeeBps {
        caller_is_gov: bool,
        new_fee_bps: u32,
    },
    NominateGovernor {
        caller_is_gov: bool,
        nominee_idx: u8,
    },
    AcceptGovernor {
        caller_idx: u8,
    },
    WithdrawTreasury {
        caller_is_gov: bool,
        recipient_idx: u8,
        amount: i128,
    },
    AdvanceTime {
        seconds: u32,
    },
}

impl Action {
    /// Writes binary encoding of action.
    pub fn write_bytes(&self, out: &mut Vec<u8>) {
        match self {
            Action::CreateStream {
                sender_idx,
                recipient_idx,
                deposit_amount,
                start_delay_secs,
                duration_secs,
                cancelable,
            } => {
                out.push(1);
                out.push(*sender_idx);
                out.push(*recipient_idx);
                out.extend_from_slice(&deposit_amount.to_le_bytes());
                out.extend_from_slice(&start_delay_secs.to_le_bytes());
                out.extend_from_slice(&duration_secs.to_le_bytes());
                out.push(if *cancelable { 1 } else { 0 });
            }
            Action::Withdraw { stream_id, amount } => {
                out.push(2);
                out.extend_from_slice(&stream_id.to_le_bytes());
                out.extend_from_slice(&amount.to_le_bytes());
            }
            Action::WithdrawMax { stream_id } => {
                out.push(3);
                out.extend_from_slice(&stream_id.to_le_bytes());
            }
            Action::CancelStream {
                caller_idx,
                stream_id,
            } => {
                out.push(4);
                out.push(*caller_idx);
                out.extend_from_slice(&stream_id.to_le_bytes());
            }
            Action::TopUp {
                caller_idx,
                stream_id,
                amount,
            } => {
                out.push(5);
                out.push(*caller_idx);
                out.extend_from_slice(&stream_id.to_le_bytes());
                out.extend_from_slice(&amount.to_le_bytes());
            }
            Action::SetFeeBps {
                caller_is_gov,
                new_fee_bps,
            } => {
                out.push(6);
                out.push(if *caller_is_gov { 1 } else { 0 });
                out.extend_from_slice(&new_fee_bps.to_le_bytes());
            }
            Action::NominateGovernor {
                caller_is_gov,
                nominee_idx,
            } => {
                out.push(7);
                out.push(if *caller_is_gov { 1 } else { 0 });
                out.push(*nominee_idx);
            }
            Action::AcceptGovernor { caller_idx } => {
                out.push(8);
                out.push(*caller_idx);
            }
            Action::WithdrawTreasury {
                caller_is_gov,
                recipient_idx,
                amount,
            } => {
                out.push(9);
                out.push(if *caller_is_gov { 1 } else { 0 });
                out.push(*recipient_idx);
                out.extend_from_slice(&amount.to_le_bytes());
            }
            Action::AdvanceTime { seconds } => {
                out.push(10);
                out.extend_from_slice(&seconds.to_le_bytes());
            }
        }
    }

    /// Reads binary encoding of action.
    pub fn read_bytes(data: &mut &[u8]) -> Option<Self> {
        if data.is_empty() {
            return None;
        }
        let tag = data[0];
        *data = &data[1..];
        match tag {
            1 => {
                if data.len() < 2 + 16 + 4 + 4 + 1 {
                    return None;
                }
                let sender_idx = data[0];
                let recipient_idx = data[1];
                let deposit_amount = i128::from_le_bytes(data[2..18].try_into().ok()?);
                let start_delay_secs = u32::from_le_bytes(data[18..22].try_into().ok()?);
                let duration_secs = u32::from_le_bytes(data[22..26].try_into().ok()?);
                let cancelable = data[26] != 0;
                *data = &data[27..];
                Some(Action::CreateStream {
                    sender_idx,
                    recipient_idx,
                    deposit_amount,
                    start_delay_secs,
                    duration_secs,
                    cancelable,
                })
            }
            2 => {
                if data.len() < 8 + 16 {
                    return None;
                }
                let stream_id = u64::from_le_bytes(data[0..8].try_into().ok()?);
                let amount = i128::from_le_bytes(data[8..24].try_into().ok()?);
                *data = &data[24..];
                Some(Action::Withdraw { stream_id, amount })
            }
            3 => {
                if data.len() < 8 {
                    return None;
                }
                let stream_id = u64::from_le_bytes(data[0..8].try_into().ok()?);
                *data = &data[8..];
                Some(Action::WithdrawMax { stream_id })
            }
            4 => {
                if data.len() < 1 + 8 {
                    return None;
                }
                let caller_idx = data[0];
                let stream_id = u64::from_le_bytes(data[1..9].try_into().ok()?);
                *data = &data[9..];
                Some(Action::CancelStream {
                    caller_idx,
                    stream_id,
                })
            }
            5 => {
                if data.len() < 1 + 8 + 16 {
                    return None;
                }
                let caller_idx = data[0];
                let stream_id = u64::from_le_bytes(data[1..9].try_into().ok()?);
                let amount = i128::from_le_bytes(data[9..25].try_into().ok()?);
                *data = &data[25..];
                Some(Action::TopUp {
                    caller_idx,
                    stream_id,
                    amount,
                })
            }
            6 => {
                if data.len() < 1 + 4 {
                    return None;
                }
                let caller_is_gov = data[0] != 0;
                let new_fee_bps = u32::from_le_bytes(data[1..5].try_into().ok()?);
                *data = &data[5..];
                Some(Action::SetFeeBps {
                    caller_is_gov,
                    new_fee_bps,
                })
            }
            7 => {
                if data.len() < 1 + 1 {
                    return None;
                }
                let caller_is_gov = data[0] != 0;
                let nominee_idx = data[1];
                *data = &data[2..];
                Some(Action::NominateGovernor {
                    caller_is_gov,
                    nominee_idx,
                })
            }
            8 => {
                if data.is_empty() {
                    return None;
                }
                let caller_idx = data[0];
                *data = &data[1..];
                Some(Action::AcceptGovernor { caller_idx })
            }
            9 => {
                if data.len() < 1 + 1 + 16 {
                    return None;
                }
                let caller_is_gov = data[0] != 0;
                let recipient_idx = data[1];
                let amount = i128::from_le_bytes(data[2..18].try_into().ok()?);
                *data = &data[18..];
                Some(Action::WithdrawTreasury {
                    caller_is_gov,
                    recipient_idx,
                    amount,
                })
            }
            10 => {
                if data.len() < 4 {
                    return None;
                }
                let seconds = u32::from_le_bytes(data[0..4].try_into().ok()?);
                *data = &data[4..];
                Some(Action::AdvanceTime { seconds })
            }
            _ => None,
        }
    }
}

#[cfg(feature = "arbitrary")]
impl<'a> Arbitrary<'a> for Action {
    fn arbitrary(u: &mut Unstructured<'a>) -> arbitrary::Result<Self> {
        let choice: u8 = u.int_in_range(0..=9)?;
        match choice {
            0 => Ok(Action::CreateStream {
                sender_idx: u.int_in_range(0..=3)?,
                recipient_idx: u.int_in_range(0..=3)?,
                deposit_amount: u.int_in_range(1..=1_000_000_000_000i128)?,
                start_delay_secs: u.int_in_range(0..=86400)?,
                duration_secs: u.int_in_range(1..=86400 * 365)?,
                cancelable: u.arbitrary()?,
            }),
            1 => Ok(Action::Withdraw {
                stream_id: u.int_in_range(1..=50)?,
                amount: u.int_in_range(1..=1_000_000_000_000i128)?,
            }),
            2 => Ok(Action::WithdrawMax {
                stream_id: u.int_in_range(1..=50)?,
            }),
            3 => Ok(Action::CancelStream {
                caller_idx: u.int_in_range(0..=3)?,
                stream_id: u.int_in_range(1..=50)?,
            }),
            4 => Ok(Action::TopUp {
                caller_idx: u.int_in_range(0..=3)?,
                stream_id: u.int_in_range(1..=50)?,
                amount: u.int_in_range(1..=1_000_000_000_000i128)?,
            }),
            5 => Ok(Action::SetFeeBps {
                caller_is_gov: u.arbitrary()?,
                new_fee_bps: u.int_in_range(0..=150)?,
            }),
            6 => Ok(Action::NominateGovernor {
                caller_is_gov: u.arbitrary()?,
                nominee_idx: u.int_in_range(0..=3)?,
            }),
            7 => Ok(Action::AcceptGovernor {
                caller_idx: u.int_in_range(0..=3)?,
            }),
            8 => Ok(Action::WithdrawTreasury {
                caller_is_gov: u.arbitrary()?,
                recipient_idx: u.int_in_range(0..=3)?,
                amount: u.int_in_range(1..=1_000_000_000_000i128)?,
            }),
            _ => Ok(Action::AdvanceTime {
                seconds: u.int_in_range(0..=86400 * 30)?,
            }),
        }
    }
}

/// A sequence of actions to be executed differentially.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ActionSequence {
    pub actions: Vec<Action>,
}

impl ActionSequence {
    pub fn new(actions: Vec<Action>) -> Self {
        Self { actions }
    }

    /// Serializes action sequence with magic header `STMP`.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(8 + self.actions.len() * 32);
        out.extend_from_slice(b"STMP");
        out.extend_from_slice(&(self.actions.len() as u32).to_le_bytes());
        for action in &self.actions {
            action.write_bytes(&mut out);
        }
        out
    }

    /// Deserializes from raw bytes.
    ///
    /// If prefixed with `STMP`, decodes deterministically.
    /// Otherwise, if the `arbitrary` feature is enabled, uses `Unstructured`.
    pub fn from_bytes(mut data: &[u8]) -> Option<Self> {
        if data.starts_with(b"STMP") {
            data = &data[4..];
            if data.len() < 4 {
                return None;
            }
            let count = u32::from_le_bytes(data[0..4].try_into().ok()?) as usize;
            data = &data[4..];
            let mut actions = Vec::with_capacity(count.min(1000));
            for _ in 0..count {
                let action = Action::read_bytes(&mut data)?;
                actions.push(action);
            }
            Some(Self { actions })
        } else {
            #[cfg(feature = "arbitrary")]
            {
                let mut u = Unstructured::new(data);
                Vec::<Action>::arbitrary(&mut u)
                    .ok()
                    .map(|actions| Self { actions })
            }
            #[cfg(not(feature = "arbitrary"))]
            None
        }
    }
}
