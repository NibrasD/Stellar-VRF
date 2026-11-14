/**
 * vrf.test.ts — the worker's proof must be byte-identical to what the V2
 * contract verifies.
 *
 * The vectors below are the SAME ones the contract's Rust tests fulfill on a
 * real Soroban host (soroban-contract/src/test.rs, the E1 and E2 constants), built on a real
 * drand quicknet beacon (round 32427720). If this test and the contract tests
 * both pass, worker and contract agree on alpha (incl. epoch id), gamma and
 * beta encodings.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("./config.js", () => ({
  VRF_DST: "SOROBAN_VRF_BLS12381G1_XMD:SHA-256_SSWU_RO_",
  BETA_DOMAIN: "VREP_BETA_V1",
  ALPHA_DOMAIN: "STELLAR_VRF_ALPHA_V2",
}));
vi.mock("./utils.js", async (orig) => {
  const actual: any = await orig();
  return { ...actual, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() } };
});

import { Keypair } from "@stellar/stellar-sdk";
import { generateVrfProof } from "./vrf.js";
import { makeKeySet, selectKeySet, blsPublicKeyOf } from "./keys.js";

const ROUND = 32427720;
/** The contract address the Rust test fixtures were generated for. */
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM";
const CONTEXT = Buffer.from("Nonzero-fee Mainnet CPU Profiling 2026");
/** drand quicknet round 32427720, compressed G1 as served by the drand API. */
const DRAND_SIG_COMPRESSED = "a4d855b2de9c5c21ee0390b2b9180296a919a1af4351cac6fd20007ba1c610e01e5bd0eb7dc56a793c602d7942bc0b3d";

const E1 = {
  sk: "4e82796bf7172e571ec88c6241f2e097956eba569a3ff9bf60b17038b433f449",
  pk: "08c82bc4988f2d2f0ff31e4a953ae4ff2422dd704727c59d888e808830eb171668480146cd07384506f3fd0780d0b07409c99db12935bdae81c62a95007fe2483451f08ced4f736f3970c6abdd13581f71402ba4d87ef0a2f7494d11dd19046f15d869b4af6e799e907d342803f54d8d9b7bfb87fce50cda1d3c6a007dde8e0c572b883bc397c92c2efd282a73ab64cd15da2f310caf09e821bb495073a6bd080e1a6eaf88e6b3b77e1a5c57055000c144f9c5de48978f2da4c1fd6a18c9f1d7",
  alpha: "37e663a06f92f4b25cedff36dd48e370a767153556e09cbb71bc82080e6140a4",
  gamma: "1551efbb0dd62cb602520be4a8db15be5526b3422589665dd591a5292f1a0f4e8ae50067ef0506688b3e3b5db7e6bd4f086efb0bee89a6be7c26842b076f0d7930d8ea706530be0b19048fef4f531bf14f755daf60ebdf685b7a1a81db57af6b",
  beta: "eb8b5a7670d158aa89e1497ecac00e0c77e201aba4c4da41681625d501e6536d",
  requestId: 7450777608292806116n,
  epochId: 1,
};

const E2 = {
  sk: "15f0eae9a15c85a00ec16553ced00c1665046a2f5ba9c6fe1f9a802a37ce20c9",
  pk: "1784e8d759343475392ed4a9a22f3068abb6d44a1c8391615cd1ec9136f7a5d26bb5aa2eb6bc61f94726f287c9ae87b5088383265e937be2160acd917814cf3a6ba603b09bd98d57717954266e563b762f731db51cffa265fe376c045c1f9bd80b775ac56e90aac380c924602c8b2d98c38e47a68e9af3c8d10ffc162262cda7d6e073e27c1c75827f46b51402ccba630a5e62f2c48da0f6e9abc04e232116522bb28e0bcb6e0d90f7758b46fb0703335b5bda4191401a3d24716cb39b40defa",
  alpha: "b8bc176d033ee8b9428374b9e5290c9ad587469e8baac7612c82163fcc43dbcc",
  gamma: "036d9de5bbd01d67a37737dd460409cc4bbb8f690bf4cc2bd78e1f6bef75062a6e067bfa474c3b7a1fb73405d51fba5f00e73b0fbd54e276f28b03d2d4b13c99be579eec0caf31dcac213511b3642ce95c576fb184b64a50bed17bda0b7f91a5",
  beta: "aa2a5c0fdf865898d5595f4950ab7215796c17df42b496bdee566e850af76e76",
  requestId: 12819282031553731624n,
  epochId: 2,
};

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function keysFor(sk: string) {
  return makeKeySet("current", Keypair.random().secret(), sk, "TEST_BLS");
}

describe("generateVrfProof matches the contract fixtures", () => {
  for (const [name, e] of [["epoch 1, first request of the fixture requester", E1], ["epoch 2, its second request", E2]] as const) {
    it(name, () => {
      const keys = keysFor(e.sk);
      expect(hex(keys.blsPublicKey)).toBe(e.pk);
      const p = generateVrfProof(
        e.requestId,
        CONTEXT,
        { round: ROUND, randomness: "", signature: DRAND_SIG_COMPRESSED },
        e.epochId,
        keys,
        CONTRACT
      );
      expect(hex(p.alphaSeed)).toBe(e.alpha);
      expect(hex(p.gammaPoint)).toBe(e.gamma);
      expect(hex(p.betaOutput)).toBe(e.beta);
      expect(p.drandRound).toBe(BigInt(ROUND));
      expect(p.drandSignature.length).toBe(96);
    });
  }

  it("a different epoch id changes alpha (no cross-epoch replay)", () => {
    const keys = keysFor(E1.sk);
    const beacon = { round: ROUND, randomness: "", signature: DRAND_SIG_COMPRESSED };
    const a = generateVrfProof(1n, CONTEXT, beacon, 1, keys, CONTRACT);
    const b = generateVrfProof(1n, CONTEXT, beacon, 2, keys, CONTRACT);
    expect(hex(a.alphaSeed)).not.toBe(hex(b.alphaSeed));
  });

  it("a different contract changes alpha (no cross-deployment replay)", () => {
    const keys = keysFor(E1.sk);
    const beacon = { round: ROUND, randomness: "", signature: DRAND_SIG_COMPRESSED };
    const a = generateVrfProof(1n, CONTEXT, beacon, 1, keys, CONTRACT);
    const b = generateVrfProof(
      1n, CONTEXT, beacon, 1, keys, "CAW6KECQMHRTX2GS3JVHWBMOB5JNNOHNOCE635RQS4SWJ72YF56EUPRX"
    );
    expect(hex(a.alphaSeed)).not.toBe(hex(b.alphaSeed));
  });
});

describe("selectKeySet", () => {
  const current = keysFor(E2.sk);
  const previous = { ...keysFor(E1.sk), label: "previous" as const };
  const keys = [current, previous];

  it("picks the key set registered for the request's epoch", () => {
    const epoch1 = { oraclePk: blsPublicKeyOf(BigInt("0x" + E1.sk)), oracleAddress: previous.stellar.publicKey() };
    expect(selectKeySet(keys, epoch1)?.label).toBe("previous");
    const epoch2 = { oraclePk: current.blsPublicKey, oracleAddress: current.stellar.publicKey() };
    expect(selectKeySet(keys, epoch2)?.label).toBe("current");
  });

  it("requires BLS key and operator account from the same set", () => {
    expect(
      selectKeySet(keys, { oraclePk: current.blsPublicKey, oracleAddress: previous.stellar.publicKey() })
    ).toBeNull();
  });

  it("rejects out-of-range BLS secrets", () => {
    expect(() => makeKeySet("current", Keypair.random().secret(), "01", "X")).toThrow(/\[2, r\)/);
    expect(() => makeKeySet("current", Keypair.random().secret(), "zz", "X")).toThrow(/hex/);
  });
});
