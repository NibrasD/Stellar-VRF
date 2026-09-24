/**
 * resourceGuard.test.ts — one pathological consumer callback must not be able
 * to make a single fulfill() cost many times a normal one.
 */

import { describe, it, expect } from "vitest";
import { SorobanDataBuilder } from "@stellar/stellar-sdk";
import {
  checkSimulatedResources,
  resourceGuardOptionsFromEnv,
  simulatedResourcesOf,
} from "./resourceGuard.js";

const opts = { maxInstructions: 90_000_000, maxResourceFeeStroops: 5_000_000n, maxTxFeeStroops: 6_000_000n };
const normal = { instructions: 58_342_003, resourceFeeStroops: 1_400_000n, txFeeStroops: 1_500_000n };

describe("checkSimulatedResources", () => {
  it("accepts a normal fulfill (Mainnet-measured ~58M instructions)", () => {
    expect(checkSimulatedResources(normal, opts)).toEqual({ ok: true });
  });

  it("accepts exactly the limits (bounds are inclusive)", () => {
    const edge = { instructions: 90_000_000, resourceFeeStroops: 5_000_000n, txFeeStroops: 6_000_000n };
    expect(checkSimulatedResources(edge, opts).ok).toBe(true);
  });

  it("refuses an expensive callback by CPU", () => {
    const r = checkSimulatedResources({ ...normal, instructions: 90_000_001 }, opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/MAX_FULFILL_INSTRUCTIONS/);
  });

  it("refuses by resource fee (e.g. huge storage writes in on_vrf)", () => {
    const r = checkSimulatedResources({ ...normal, resourceFeeStroops: 5_000_001n }, opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/MAX_FULFILL_RESOURCE_FEE_STROOPS/);
  });

  it("refuses by assembled envelope max fee", () => {
    const r = checkSimulatedResources({ ...normal, txFeeStroops: 6_000_001n }, opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/MAX_FULFILL_TX_FEE_STROOPS/);
  });

  it("fails closed on a nonsensical instruction count", () => {
    expect(checkSimulatedResources({ ...normal, instructions: NaN }, opts).ok).toBe(false);
    expect(checkSimulatedResources({ ...normal, instructions: -1 }, opts).ok).toBe(false);
  });
});

describe("simulatedResourcesOf", () => {
  it("reads instructions from real SorobanTransactionData", () => {
    const builder = new SorobanDataBuilder().setResources(58_342_003, 1000, 2000).setResourceFee("1400000");
    const r = simulatedResourcesOf({ transactionData: builder, minResourceFee: "1400000" }, 1_500_000n);
    expect(r).toEqual({ instructions: 58_342_003, resourceFeeStroops: 1_400_000n, txFeeStroops: 1_500_000n });
  });

  it("throws (fail closed) when the simulation has no resource data", () => {
    expect(() => simulatedResourcesOf({}, 1n)).toThrow(/refusing to send unchecked/);
  });
});

describe("resourceGuardOptionsFromEnv", () => {
  it("has conservative project defaults (90M, well below the 400M Mainnet tx limit)", () => {
    const o = resourceGuardOptionsFromEnv({});
    expect(o.maxInstructions).toBe(90_000_000);
    expect(o.maxResourceFeeStroops).toBe(5_000_000n);
    expect(o.maxTxFeeStroops).toBe(6_000_000n);
  });

  it("honours overrides", () => {
    const o = resourceGuardOptionsFromEnv({ MAX_FULFILL_INSTRUCTIONS: "70000000", MAX_FULFILL_TX_FEE_STROOPS: "2000000" });
    expect(o.maxInstructions).toBe(70_000_000);
    expect(o.maxTxFeeStroops).toBe(2_000_000n);
  });

  it("refuses invalid values instead of silently disabling the guard", () => {
    for (const v of ["0", "-5", "abc", "1.5", ""]) {
      expect(() => resourceGuardOptionsFromEnv({ MAX_FULFILL_INSTRUCTIONS: v })).toThrow();
    }
  });
});
