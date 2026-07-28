/**
 * utils.ts — Shared utilities for the oracle worker
 */

import { sha256 } from "@noble/hashes/sha256";

/** Convert a u64 to 8-byte big-endian Buffer */
export function u64ToBeBytes(value: bigint | number): Buffer {
  const buf = Buffer.alloc(8);
  const big = typeof value === "number" ? BigInt(value) : value;
  buf.writeBigUInt64BE(big);
  return buf;
}

/** SHA-256 hash returning a 32-byte Buffer */
export function sha256Hash(data: Uint8Array): Buffer {
  return Buffer.from(sha256(data));
}

/** Concatenate multiple Buffers / Uint8Arrays */
export function concat(...parts: (Buffer | Uint8Array)[]): Buffer {
  return Buffer.concat(parts);
}

/** Hex string to Buffer */
export function hexToBytes(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}

/** Buffer / Uint8Array to hex string */
export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Sleep for ms milliseconds */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Format timestamp to ISO string */
export function timestamp(): string {
  return new Date().toISOString();
}

/** Logger with timestamp prefix */
export const log = {
  info: (msg: string, ...args: unknown[]) =>
    console.log(`[${timestamp()}] ℹ  ${msg}`, ...args),
  warn: (msg: string, ...args: unknown[]) =>
    console.warn(`[${timestamp()}] ⚠  ${msg}`, ...args),
  error: (msg: string, ...args: unknown[]) =>
    console.error(`[${timestamp()}] ✖  ${msg}`, ...args),
  success: (msg: string, ...args: unknown[]) =>
    console.log(`[${timestamp()}] ✔  ${msg}`, ...args),
};
