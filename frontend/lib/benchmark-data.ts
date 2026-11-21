/**
 * StreamPay Protocol Benchmark Dataset & Normalization Engine
 *
 * Public reproducible benchmark comparing StreamPay (Soroban) vs
 * Sablier V2 (EVM) vs Superfluid CFAv1 (EVM) on the 4 primary streaming axes:
 * 1. Storage bytes per stream
 * 2. Cost per second of stream life (rent economics)
 * 3. Claim cost
 * 4. Cancel cost
 */

export interface BenchmarkMetadata {
  version: string;
  updatedAt: string;
  measuredAt: string;
  reproducibleHarness: string;
  sorobanSdk: string;
}

export interface EconomicAssumptions {
  ethPriceUsd: number;
  xlmPriceUsd: number;
  l1GasPriceGwei: number;
  l2GasPriceGwei: number;
  stellarBaseFeeStroops: number;
  stellarRentRateStroopsPerByteLedger: number;
  secondsPerLedger: number;
  superfluidBufferHours: number;
  capitalCostApyPercent: number;
}

export interface StorageAxisData {
  protocol: string;
  rawStorageBytes: number;
  keysOrSlotsCount: number;
  additionalOverheadBytes: number;
  totalEffectiveBytes: number;
  stateModel: string;
  description: string;
}

export interface RentAxisData {
  protocol: string;
  nativeCostPerSecond: string;
  usdPerSecond: number;
  usdPer30Days: number;
  mechanism: string;
  prepaidBuffer: string;
  maintenanceNote: string;
}

export interface OperationCostData {
  protocol: string;
  operationName: string;
  nativeMetric: string;
  nativeValue: number;
  usdFeeL1?: number;
  usdFeeL2?: number;
  usdFeeStellar?: number;
  memoryOrAuxiliary?: string;
  breakdown: string;
}

export interface CompetitorCitation {
  protocol: string;
  contractName: string;
  repositoryUrl: string;
  commitOrVersion: string;
  contractAddresses: Record<string, string>;
  auditReferences: string[];
  lastVerifiedDate: string;
}

export const BENCHMARK_METADATA: BenchmarkMetadata = {
  version: "1.0.0",
  updatedAt: "2026-10-19",
  measuredAt: "2026-10-19",
  reproducibleHarness: "cargo run -p streampay-contract --example protocol_benchmark",
  sorobanSdk: "29.0",
};

export const ECONOMIC_ASSUMPTIONS: EconomicAssumptions = {
  ethPriceUsd: 3000.0,
  xlmPriceUsd: 0.12,
  l1GasPriceGwei: 20.0,
  l2GasPriceGwei: 0.1,
  stellarBaseFeeStroops: 100,
  stellarRentRateStroopsPerByteLedger: 0.01,
  secondsPerLedger: 5.0,
  superfluidBufferHours: 4.0,
  capitalCostApyPercent: 5.0,
};

export const STORAGE_AXIS: Record<string, StorageAxisData> = {
  streampay: {
    protocol: "StreamPay (Soroban)",
    rawStorageBytes: 444,
    keysOrSlotsCount: 1,
    additionalOverheadBytes: 40,
    totalEffectiveBytes: 484,
    stateModel: "Stellar Persistent Ledger Entry (TTL / State Archival)",
    description: "Monolithic Stream struct (444 B) + DataKey::Stream(u64) key (40 B) serialized as XDR. Optional pagination indices amortized.",
  },
  sablier_v2: {
    protocol: "Sablier V2 (EVM)",
    rawStorageBytes: 128,
    keysOrSlotsCount: 4,
    additionalOverheadBytes: 32,
    totalEffectiveBytes: 160,
    stateModel: "EVM Perpetual Contract Storage (Permanent State)",
    description: "4 32-byte storage slots for stream struct (amounts, timestamps, sender/recipient, broker) + 1 slot ERC-721 ownership entry.",
  },
  superfluid_cfa: {
    protocol: "Superfluid CFAv1 (EVM)",
    rawStorageBytes: 128,
    keysOrSlotsCount: 4,
    additionalOverheadBytes: 0,
    totalEffectiveBytes: 128,
    stateModel: "EVM Perpetual Contract Storage (Permanent State)",
    description: "2 slots CFA agreement struct (flowRate, timestamp, deposit) + 2 slots net-flow accumulator in SuperToken state.",
  },
};

export const RENT_AXIS: Record<string, RentAxisData> = {
  streampay: {
    protocol: "StreamPay (Soroban)",
    nativeCostPerSecond: "0.968 stroops / sec",
    usdPerSecond: 0.0000000116,
    usdPer30Days: 0.0301,
    mechanism: "Explicit State Archival Rent (0.01 stroops / byte / ledger, 5 s / ledger)",
    prepaidBuffer: "500,000 ledgers (~29 days) prepaid on creation (0.242 XLM ~ $0.029)",
    maintenanceNote: "Automatically renewed on any touch (claims, top-ups, cancellations). Zero risk of archival while active.",
  },
  sablier_v2: {
    protocol: "Sablier V2 (EVM)",
    nativeCostPerSecond: "0 gas / sec",
    usdPerSecond: 0.0,
    usdPer30Days: 0.0,
    mechanism: "None (EVM perpetual state; storage cost 100% front-loaded in 20,000 gas SSTORE write tax at creation)",
    prepaidBuffer: "None",
    maintenanceNote: "Storage persists perpetually on all full nodes without maintenance.",
  },
  superfluid_cfa: {
    protocol: "Superfluid CFAv1 (EVM)",
    nativeCostPerSecond: "0 gas / sec",
    usdPerSecond: 0.0,
    usdPer30Days: 0.0,
    mechanism: "No state rent; requires 4-hour stream value locked as liquidation buffer collateral",
    prepaidBuffer: "4-hour buffer deposit locked (opportunity cost: ~5% APY drag)",
    maintenanceNote: "Sender balance must remain positive; liquidation bots liquidate buffer if account depletes.",
  },
};

export const OPERATIONS_BENCHMARK = {
  create: [
    {
      protocol: "StreamPay (Stellar)",
      operationName: "create_stream",
      nativeMetric: "CPU Instructions",
      nativeValue: 546281,
      memoryOrAuxiliary: "214,280 B Memory | 396 B Event",
      usdFeeStellar: 0.000042,
      breakdown: "Deposit pull via SAC, stream initialization, sender & recipient index updates",
    },
    {
      protocol: "Sablier V2 (Arbitrum L2)",
      operationName: "createWithTimestamps",
      nativeMetric: "EVM Gas",
      nativeValue: 218450,
      memoryOrAuxiliary: "4 Storage Slots | ERC-721 Mint",
      usdFeeL2: 0.0655,
      breakdown: "ERC-721 mint (~55k), 3 SSTORE writes (~66k), ERC-20 safeTransferFrom (~45k), events (~31k)",
    },
    {
      protocol: "Sablier V2 (Ethereum L1)",
      operationName: "createWithTimestamps",
      nativeMetric: "EVM Gas",
      nativeValue: 218450,
      memoryOrAuxiliary: "4 Storage Slots | ERC-721 Mint",
      usdFeeL1: 13.11,
      breakdown: "Same EVM gas executed at 20 gwei and $3,000 ETH",
    },
    {
      protocol: "Superfluid CFA (Arbitrum L2)",
      operationName: "createFlow",
      nativeMetric: "EVM Gas",
      nativeValue: 174800,
      memoryOrAuxiliary: "2 Slots CFA + 2 Slots SuperToken",
      usdFeeL2: 0.0524,
      breakdown: "Host proxy dispatch, net-flow accumulator updates, buffer deposit hold, events",
    },
    {
      protocol: "Superfluid CFA (Ethereum L1)",
      operationName: "createFlow",
      nativeMetric: "EVM Gas",
      nativeValue: 174800,
      memoryOrAuxiliary: "2 Slots CFA + 2 Slots SuperToken",
      usdFeeL1: 10.49,
      breakdown: "Same EVM gas executed at 20 gwei and $3,000 ETH",
    },
  ],
  claim: [
    {
      protocol: "StreamPay (Stellar)",
      operationName: "withdraw / withdraw_max",
      nativeMetric: "CPU Instructions",
      nativeValue: 384170,
      memoryOrAuxiliary: "153,255 B Memory | 236 B Event",
      usdFeeStellar: 0.000029,
      breakdown: "CEI stream state update (1 RMW), SAC payout transfer, event emission",
    },
    {
      protocol: "Sablier V2 (Arbitrum L2)",
      operationName: "withdraw",
      nativeMetric: "EVM Gas",
      nativeValue: 59320,
      memoryOrAuxiliary: "1 SSTORE rewrite | ERC-20 Transfer",
      usdFeeL2: 0.0178,
      breakdown: "SLOAD stream, accrual math, SSTORE withdrawn balance, ERC-20 safeTransfer, event",
    },
    {
      protocol: "Sablier V2 (Ethereum L1)",
      operationName: "withdraw",
      nativeMetric: "EVM Gas",
      nativeValue: 59320,
      memoryOrAuxiliary: "1 SSTORE rewrite | ERC-20 Transfer",
      usdFeeL1: 3.56,
      breakdown: "Same EVM gas executed at 20 gwei and $3,000 ETH",
    },
    {
      protocol: "Superfluid CFA (Arbitrum L2)",
      operationName: "Passive Dynamic Flow",
      nativeMetric: "EVM Gas",
      nativeValue: 0,
      memoryOrAuxiliary: "0 on-chain tx required",
      usdFeeL2: 0.0,
      breakdown: "Balance is computed on the fly via timestamp differential. Note: unwrapping to ERC-20 takes ~52,000 gas ($0.015).",
    },
    {
      protocol: "Superfluid CFA (Ethereum L1)",
      operationName: "Passive Dynamic Flow",
      nativeMetric: "EVM Gas",
      nativeValue: 0,
      memoryOrAuxiliary: "0 on-chain tx required",
      usdFeeL1: 0.0,
      breakdown: "Balance is computed on the fly via timestamp differential. Note: unwrapping to ERC-20 takes ~52,000 gas ($3.12).",
    },
  ],
  cancel: [
    {
      protocol: "StreamPay (Stellar)",
      operationName: "cancel_stream",
      nativeMetric: "CPU Instructions",
      nativeValue: 591737,
      memoryOrAuxiliary: "197,100 B Memory | 248 B Event",
      usdFeeStellar: 0.000038,
      breakdown: "Status update (1 RMW), 2 SAC payouts (recipient accrued + sender refund), event",
    },
    {
      protocol: "Sablier V2 (Arbitrum L2)",
      operationName: "cancel",
      nativeMetric: "EVM Gas",
      nativeValue: 84150,
      memoryOrAuxiliary: "1 SSTORE rewrite | 2 ERC-20 Transfers",
      usdFeeL2: 0.0252,
      breakdown: "SLOAD stream, status rewrite, 2 safeTransfers (recipient accrued + sender refund), event",
    },
    {
      protocol: "Sablier V2 (Ethereum L1)",
      operationName: "cancel",
      nativeMetric: "EVM Gas",
      nativeValue: 84150,
      memoryOrAuxiliary: "1 SSTORE rewrite | 2 ERC-20 Transfers",
      usdFeeL1: 5.05,
      breakdown: "Same EVM gas executed at 20 gwei and $3,000 ETH",
    },
    {
      protocol: "Superfluid CFA (Arbitrum L2)",
      operationName: "deleteFlow",
      nativeMetric: "EVM Gas",
      nativeValue: 78600,
      memoryOrAuxiliary: "Net-flow zeroing | Buffer refund",
      usdFeeL2: 0.0236,
      breakdown: "Host proxy dispatch, net-flow zeroing SSTOREs, buffer deposit refund, agreement cleanup",
    },
    {
      protocol: "Superfluid CFA (Ethereum L1)",
      operationName: "deleteFlow",
      nativeMetric: "EVM Gas",
      nativeValue: 78600,
      memoryOrAuxiliary: "Net-flow zeroing | Buffer refund",
      usdFeeL1: 4.72,
      breakdown: "Same EVM gas executed at 20 gwei and $3,000 ETH",
    },
  ],
};

export const CITATIONS: CompetitorCitation[] = [
  {
    protocol: "Sablier V2 Lockup Linear",
    contractName: "SablierV2LockupLinear.sol",
    repositoryUrl: "https://github.com/sablier-labs/v2-core",
    commitOrVersion: "3eb3cfa (May 2023)",
    contractAddresses: {
      "Ethereum Mainnet": "0xAFb9797282b35606d649B25A775C17f920272B6c",
      "Arbitrum One": "0x2C460eb3aAadAd3c8e54736fdf5A5B63402cf894",
      "Optimism": "0xb180D81995dc6EC860F5F6c4EbF0d3148154D355",
    },
    auditReferences: [
      "Cantina Security Audit (May 2023)",
      "Code4rena Competitive Audit (June 2023)",
    ],
    lastVerifiedDate: "2024-10-15",
  },
  {
    protocol: "Superfluid Constant Flow Agreement (CFAv1)",
    contractName: "ConstantFlowAgreementV1.sol",
    repositoryUrl: "https://github.com/superfluid-finance/protocol-monorepo",
    commitOrVersion: "v1.0 (contracts/agreements/ConstantFlowAgreementV1.sol)",
    contractAddresses: {
      "CFAv1 Proxy (Multi-chain)": "0xEd6B5CD325f0F6E6705775a644b50997FAae61a8",
      "Host Contract": "0x4C08b64A5E0c077A1792383161a0E0630D268e37",
    },
    auditReferences: [
      "PeckShield Audit Report (2021-2022)",
      "Certora Formal Verification Report (2023)",
    ],
    lastVerifiedDate: "2024-03-12",
  },
  {
    protocol: "StreamPay (Stellar)",
    contractName: "contracts/streaming-payments",
    repositoryUrl: "https://github.com/streampay/streampay",
    commitOrVersion: "v0.4.0 (Stellar Soroban Protocol 20+)",
    contractAddresses: {
      "Stellar Mainnet": "Active Production Deploy",
      "Soroban Testnet": "CB25...DEPLOYED",
    },
    auditReferences: [
      "Formal Verification Pilot (Kani Bounded Model Checker)",
      "Continuous Checks-Effects-Interactions (CEI) Golden Ordering Traces",
    ],
    lastVerifiedDate: "2026-10-19",
  },
];

/**
 * Calculates total lifecycle costs for any combination of duration, claim frequency, and deposit.
 */
export function calculateLifecycleCost(
  durationDays: number,
  claimsCount: number,
  depositUsd: number
) {
  // StreamPay
  const spCreate = 0.000042;
  const spClaim = 0.000029 * claimsCount;
  const spCancel = 0.000038;
  const spRent = 0.0301 * (durationDays / 30);
  const spTotal = spCreate + spClaim + spRent + spCancel;

  // Sablier Arbitrum L2
  const sabL2Create = 0.0655;
  const sabL2Claim = 0.0178 * claimsCount;
  const sabL2Cancel = 0.0252;
  const sabL2Total = sabL2Create + sabL2Claim + sabL2Cancel;

  // Sablier Ethereum L1
  const sabL1Create = 13.11;
  const sabL1Claim = 3.56 * claimsCount;
  const sabL1Cancel = 5.05;
  const sabL1Total = sabL1Create + sabL1Claim + sabL1Cancel;

  // Superfluid Arbitrum L2
  const sfL2Create = 0.0524;
  const sfL2Claim = 0.0;
  const sfL2Cancel = 0.0236;
  // Buffer opportunity cost: 4 hours of stream deposit locked at 5% APY
  const bufferDeposit = (depositUsd / (durationDays * 24)) * 4.0;
  const bufferOpportunityCost = bufferDeposit * (0.05 * (durationDays / 365));
  const sfL2Total = sfL2Create + sfL2Claim + bufferOpportunityCost + sfL2Cancel;

  // Superfluid Ethereum L1
  const sfL1Create = 10.49;
  const sfL1Claim = 0.0;
  const sfL1Cancel = 4.72;
  const sfL1Total = sfL1Create + sfL1Claim + bufferOpportunityCost + sfL1Cancel;

  return {
    streampay: {
      createUsd: spCreate,
      claimsUsd: spClaim,
      rentUsd: spRent,
      cancelUsd: spCancel,
      totalUsd: spTotal,
    },
    sablierArbitrum: {
      createUsd: sabL2Create,
      claimsUsd: sabL2Claim,
      rentUsd: 0,
      cancelUsd: sabL2Cancel,
      totalUsd: sabL2Total,
    },
    sablierEthereum: {
      createUsd: sabL1Create,
      claimsUsd: sabL1Claim,
      rentUsd: 0,
      cancelUsd: sabL1Cancel,
      totalUsd: sabL1Total,
    },
    superfluidArbitrum: {
      createUsd: sfL2Create,
      claimsUsd: sfL2Claim,
      rentUsd: 0,
      bufferOpportunityCostUsd: bufferOpportunityCost,
      cancelUsd: sfL2Cancel,
      totalUsd: sfL2Total,
    },
    superfluidEthereum: {
      createUsd: sfL1Create,
      claimsUsd: sfL1Claim,
      rentUsd: 0,
      bufferOpportunityCostUsd: bufferOpportunityCost,
      cancelUsd: sfL1Cancel,
      totalUsd: sfL1Total,
    },
  };
}
