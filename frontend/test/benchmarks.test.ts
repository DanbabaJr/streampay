import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BENCHMARK_METADATA,
  ECONOMIC_ASSUMPTIONS,
  STORAGE_AXIS,
  RENT_AXIS,
  OPERATIONS_BENCHMARK,
  CITATIONS,
  calculateLifecycleCost,
} from "../lib/benchmark-data.ts";

describe("Protocol Benchmark Data & Methodology Integrity", () => {
  it("exposes valid benchmark metadata and sdk versions", () => {
    assert.ok(BENCHMARK_METADATA.version);
    assert.ok(BENCHMARK_METADATA.updatedAt);
    assert.ok(BENCHMARK_METADATA.reproducibleHarness);
    assert.ok(ECONOMIC_ASSUMPTIONS.ethPriceUsd > 0);
    assert.ok(ECONOMIC_ASSUMPTIONS.xlmPriceUsd > 0);
  });

  it("maintains verified storage footprints for all 3 protocols", () => {
    assert.equal(STORAGE_AXIS.streampay.totalEffectiveBytes, 484);
    assert.equal(STORAGE_AXIS.sablier_v2.totalEffectiveBytes, 160);
    assert.equal(STORAGE_AXIS.superfluid_cfa.totalEffectiveBytes, 128);
  });

  it("calculates exact state rent economics on Soroban", () => {
    const spRent = RENT_AXIS.streampay;
    assert.ok(spRent.nativeCostPerSecond.includes("0.968"));
    assert.ok(spRent.usdPerSecond > 0);
    assert.ok(spRent.usdPer30Days > 0.02 && spRent.usdPer30Days < 0.04);
  });

  it("contains complete operation benchmarks for create, claim, and cancel", () => {
    assert.ok(OPERATIONS_BENCHMARK.create.length >= 3);
    assert.ok(OPERATIONS_BENCHMARK.claim.length >= 3);
    assert.ok(OPERATIONS_BENCHMARK.cancel.length >= 3);

    // StreamPay metrics
    const spClaim = OPERATIONS_BENCHMARK.claim.find((c) => c.protocol.includes("StreamPay"));
    assert.ok(spClaim);
    assert.equal(spClaim.nativeValue, 384170);

    const spCancel = OPERATIONS_BENCHMARK.cancel.find((c) => c.protocol.includes("StreamPay"));
    assert.ok(spCancel);
    assert.equal(spCancel.nativeValue, 591737);
  });

  it("calculates realistic lifecycle costs across duration and claim frequencies", () => {
    const monthly4Claims = calculateLifecycleCost(30, 4, 3000);

    // StreamPay should cost fractions of a cent ($0.03 total mostly rent)
    assert.ok(monthly4Claims.streampay.totalUsd < 0.05);

    // Sablier Arbitrum L2 should be around ~$0.16
    assert.ok(monthly4Claims.sablierArbitrum.totalUsd > 0.1 && monthly4Claims.sablierArbitrum.totalUsd < 0.3);

    // Sablier Ethereum L1 should be > $20
    assert.ok(monthly4Claims.sablierEthereum.totalUsd > 20);

    // Superfluid Arbitrum L2 should have $0 claim cost
    assert.equal(monthly4Claims.superfluidArbitrum.claimsUsd, 0);
  });

  it("includes verifiable citations with contract addresses for all competitors", () => {
    assert.equal(CITATIONS.length, 3);
    for (const citation of CITATIONS) {
      assert.ok(citation.protocol);
      assert.ok(citation.contractName);
      assert.ok(citation.repositoryUrl.startsWith("https://github.com/"));
      assert.ok(Object.keys(citation.contractAddresses).length > 0);
      assert.ok(citation.auditReferences.length > 0);
    }
  });
});
