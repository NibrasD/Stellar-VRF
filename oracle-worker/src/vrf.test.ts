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
  alpha: "7beb6ec732b9ac655bdaed2a71f98dad0a02b03f2a577e858d2d80c9fa847dcb",
  gamma: "0baf7be530b5c4aa4d35a2cc07780cafe13c7c4e0a975a1685d4b0c30b82f13f146a31ea7e8d16338e48f808ba492b5f03d22b8ab3490799fe2883f951708207dacc86cf04bcd9ea27431d1d2377ca71132b4da7352cf34df28677abd4654693",
  beta: "e35a05180ac9baaf2e75419fa3bc8ea4e877a0077c24184505f2657fcefeab48",
  requestId: 1n,
  epochId: 1,
};

const E2 = {
  sk: "15f0eae9a15c85a00ec16553ced00c1665046a2f5ba9c6fe1f9a802a37ce20c9",
  pk: "1784e8d759343475392ed4a9a22f3068abb6d44a1c8391615cd1ec9136f7a5d26bb5aa2eb6bc61f94726f287c9ae87b5088383265e937be2160acd917814cf3a6ba603b09bd98d57717954266e563b762f731db51cffa265fe376c045c1f9bd80b775ac56e90aac380c924602c8b2d98c38e47a68e9af3c8d10ffc162262cda7d6e073e27c1c75827f46b51402ccba630a5e62f2c48da0f6e9abc04e232116522bb28e0bcb6e0d90f7758b46fb0703335b5bda4191401a3d24716cb39b40defa",
  alpha: "1b610e414dd86c6dc8d8f9331fd026c754a27c485c6d53e5fa0ef62b73d03996",
  gamma: "04f8f957023fa0e4284988af15c308cf0ff2d6edf2a73091ada33e48b444186bbff3987925960b3ebda49756e34e4e540be996277c2e8bae52c7f1739079918b9bc86248ded546e8799b730b7c462265a009c1521daf4bcd9d1a7e1f4079ecc5",
  beta: "4646ff6c798ca2aef214d403629a8598374997ba879a2ca4fbd1de19fd28cc4b",
  requestId: 2n,
  epochId: 2,
};

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function keysFor(sk: string) {
  return makeKeySet("current", Keypair.random().secret(), sk, "TEST_BLS");
}

describe("generateVrfProof matches the contract fixtures", () => {
  for (const [name, e] of [["epoch 1, request 1", E1], ["epoch 2, request 2", E2]] as const) {
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
