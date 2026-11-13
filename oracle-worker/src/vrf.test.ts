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
}));
vi.mock("./utils.js", async (orig) => {
  const actual: any = await orig();
  return { ...actual, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() } };
});

import { Keypair } from "@stellar/stellar-sdk";
import { generateVrfProof } from "./vrf.js";
import { makeKeySet, selectKeySet, blsPublicKeyOf } from "./keys.js";

const ROUND = 32427720;
const CONTEXT = Buffer.from("Nonzero-fee Mainnet CPU Profiling 2026");
/** drand quicknet round 32427720, compressed G1 as served by the drand API. */
const DRAND_SIG_COMPRESSED = "a4d855b2de9c5c21ee0390b2b9180296a919a1af4351cac6fd20007ba1c610e01e5bd0eb7dc56a793c602d7942bc0b3d";

const E1 = {
  sk: "4e82796bf7172e571ec88c6241f2e097956eba569a3ff9bf60b17038b433f449",
  pk: "08c82bc4988f2d2f0ff31e4a953ae4ff2422dd704727c59d888e808830eb171668480146cd07384506f3fd0780d0b07409c99db12935bdae81c62a95007fe2483451f08ced4f736f3970c6abdd13581f71402ba4d87ef0a2f7494d11dd19046f15d869b4af6e799e907d342803f54d8d9b7bfb87fce50cda1d3c6a007dde8e0c572b883bc397c92c2efd282a73ab64cd15da2f310caf09e821bb495073a6bd080e1a6eaf88e6b3b77e1a5c57055000c144f9c5de48978f2da4c1fd6a18c9f1d7",
  alpha: "c638947f19b79c1bedfac26719438faaf5a9c5719f14a1f2263da39693103147",
  gamma: "06dae2f671601381adfd0ca9548ecc6b326c1ae72b327caaa4b7ea129f9fc3a6e039a917d49d32524556dbc6986c72830c5125631e2e11d97f03a596d73c89185e401303584e17b7b8a70bde563c71ae2a03b683b961ebe83c71ad547a46f8f0",
  beta: "2e74917fceb23851c8e76ae17b1959a72e2dc91286c1dbed716a65847c6ddaf9",
  requestId: 1n,
  epochId: 1,
};

const E2 = {
  sk: "15f0eae9a15c85a00ec16553ced00c1665046a2f5ba9c6fe1f9a802a37ce20c9",
  pk: "1784e8d759343475392ed4a9a22f3068abb6d44a1c8391615cd1ec9136f7a5d26bb5aa2eb6bc61f94726f287c9ae87b5088383265e937be2160acd917814cf3a6ba603b09bd98d57717954266e563b762f731db51cffa265fe376c045c1f9bd80b775ac56e90aac380c924602c8b2d98c38e47a68e9af3c8d10ffc162262cda7d6e073e27c1c75827f46b51402ccba630a5e62f2c48da0f6e9abc04e232116522bb28e0bcb6e0d90f7758b46fb0703335b5bda4191401a3d24716cb39b40defa",
  alpha: "6e30930b9f385b5c6481844ed46b8d770f30b1f9adb0100e82fede463051c626",
  gamma: "0969c943754062041945736928128798b65f7fa9e2f03fa3beb6111121c87ec1a2a4f87ae87d4b2608f9d8d41a76faed082474fb3ddfc3efb3ee058e3c404108c3b06a044c7dd6b922e98dbb05b19c7a5e904d15b5fab3a90c74c13383b8517e",
  beta: "76b5f644026c1fc414e1c2c860276cfb8840eb9045d2827b9e704a79be5b86d9",
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
        keys
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
    const a = generateVrfProof(1n, CONTEXT, beacon, 1, keys);
    const b = generateVrfProof(1n, CONTEXT, beacon, 2, keys);
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
