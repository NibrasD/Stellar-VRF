/**
 * configCheck.test.ts — the worker must refuse to run with drand or oracle
 * key configuration that disagrees with the contract.
 */

import { describe, it, expect } from "vitest";
import { bls12_381 } from "@noble/curves/bls12-381";
import { Networks } from "@stellar/stellar-sdk";
import {
  compareChainConfig,
  verifyChainConfig,
  chainConfigSkipPolicyError,
  g2ToUncompressed,
  type LocalChainConfig,
  type OnChainConfig,
} from "./configCheck.js";

const QUICKNET_PK =
  "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c" +
  "3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab" +
  "4af5a6e9c76a4bc09e76eae8991ef5ece45a";

const oraclePk = bls12_381.G2.ProjectivePoint.BASE.multiply(7n).toRawBytes(false);
const ORACLE = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";

const local: LocalChainConfig = {
  drandGenesisTime: 1692803367,
  drandPeriod: 3,
  drandPublicKeyHex: QUICKNET_PK,
  oracleBlsPublicKey: oraclePk,
  oracleAddress: ORACLE,
};

const chain: OnChainConfig = {
  drandGenesis: 1692803367n,
  drandPeriod: 3n,
  drandPk: g2ToUncompressed(QUICKNET_PK),
  oraclePk,
  oracleAddress: ORACLE,
};

describe("compareChainConfig", () => {
  it("accepts matching config (compressed env key vs uncompressed on-chain key)", () => {
    expect(g2ToUncompressed(QUICKNET_PK).length).toBe(192);
    expect(compareChainConfig(local, chain)).toEqual([]);
  });

  it("flags a genesis mismatch", () => {
    expect(compareChainConfig({ ...local, drandGenesisTime: 1595431050 }, chain)[0]).toMatch(/DRAND_GENESIS_TIME/);
  });

  it("flags a period mismatch", () => {
    expect(compareChainConfig({ ...local, drandPeriod: 30 }, chain)[0]).toMatch(/DRAND_PERIOD/);
  });

  it("flags a rotated drand key", () => {
    const rotated = { ...chain, drandPk: bls12_381.G2.ProjectivePoint.BASE.multiply(3n).toRawBytes(false) };
    expect(compareChainConfig(local, rotated)[0]).toMatch(/rotate_drand_pk/);
  });

  it("flags an invalid local drand key", () => {
    expect(compareChainConfig({ ...local, drandPublicKeyHex: "00".repeat(96) }, chain)[0]).toMatch(/not a valid G2/);
  });

  it("flags a rotated oracle BLS key", () => {
    const rotated = { ...chain, oraclePk: bls12_381.G2.ProjectivePoint.BASE.multiply(8n).toRawBytes(false) };
    expect(compareChainConfig(local, rotated)[0]).toMatch(/OraclePK/);
  });

  it("flags a different oracle address", () => {
    const other = { ...chain, oracleAddress: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7" };
    expect(compareChainConfig(local, other)[0]).toMatch(/OracleAddr/);
  });

  it("reports every problem at once", () => {
    expect(compareChainConfig({ ...local, drandGenesisTime: 1, drandPeriod: 30 }, chain)).toHaveLength(2);
  });
});

describe("verifyChainConfig", () => {
  it("resolves when config matches", async () => {
    await expect(verifyChainConfig(local, async () => chain)).resolves.toBeUndefined();
  });

  it("throws a single descriptive error on mismatch", async () => {
    await expect(verifyChainConfig({ ...local, drandPeriod: 30 }, async () => chain)).rejects.toThrow(
      /does not match the deployed contract[\s\S]*DRAND_PERIOD/
    );
  });

  it("propagates read failures (fails closed)", async () => {
    await expect(
      verifyChainConfig(local, async () => {
        throw new Error("rpc down");
      })
    ).rejects.toThrow(/rpc down/);
  });
});

describe("chainConfigSkipPolicyError", () => {
  it("never allows skipping on Mainnet", () => {
    expect(chainConfigSkipPolicyError(true, Networks.PUBLIC, undefined, Networks.PUBLIC)).toMatch(/Mainnet/);
  });
  it("never allows skipping with NODE_ENV=production", () => {
    expect(chainConfigSkipPolicyError(true, Networks.TESTNET, "production", Networks.PUBLIC)).toMatch(/production/);
  });
  it("allows skipping only for testnet debugging, and not skipping always", () => {
    expect(chainConfigSkipPolicyError(true, Networks.TESTNET, undefined, Networks.PUBLIC)).toBeNull();
    expect(chainConfigSkipPolicyError(false, Networks.PUBLIC, "production", Networks.PUBLIC)).toBeNull();
  });
});
