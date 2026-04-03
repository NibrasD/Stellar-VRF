/**
 * drand - Distributed Randomness Beacon
 *
 * The League of Entropy (Cloudflare, EPFL, Protocol Labs, Ethereum Foundation, …)
 * runs a threshold BLS-signature network. Every round each node signs the same
 * message (H(prev_sig || round)), and shares are combined into a single signature
 * whose sha256 is the "randomness". Because the signature is a threshold scheme,
 * NO single operator can bias or predict the output.
 *
 * This is the key property that solves the NebulaVRF problem: even if our oracle
 * is malicious it cannot pre-select the drand output, so any VRF alpha seed
 * derived from drand round randomness is guaranteed unbiasable.
 *
 * Chains used:
 *   - default (G1, BLS12-381, chained, 30s period)
 *     hash: 8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce
 *   - quicknet (G2, BLS12-381, unchained, 3s period)
 *     hash: 52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971
 *
 * References:
 *   https://drand.love
 *   https://github.com/drand/drand
 *   RFC: https://drand.love/docs/cryptography/
 */

const DRAND_BASE = "https://api.drand.sh";

export const CHAINS = {
  default: {
    name: "default (chained, BLS12-381 G1, 30 s)",
    hash: "8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce",
    period: 30,
    genesisTime: 1595431050,
    schemeId: "pedersen-bls-chained",
  },
  quicknet: {
    name: "quicknet (unchained, BLS12-381 G2, 3 s)",
    hash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
    period: 3,
    genesisTime: 1692803367,
    schemeId: "bls-unchained-g1-rfc9380",
  },
} as const;

export type ChainId = keyof typeof CHAINS;

export interface DrandBeacon {
  round: number;
  randomness: string;
  signature: string;
  previousSignature?: string;
}

export interface DrandChainInfo {
  chainId: string;
  name: string;
  hash: string;
  period: number;
  genesisTime: number;
  schemeId: string;
  publicKey?: string;
}

export interface DrandLatestResponse {
  chain: DrandChainInfo;
  beacon: DrandBeacon;
  /** Expected time of next beacon (Unix seconds) */
  nextRoundAt: number;
  /** How many seconds until the next beacon */
  secondsUntilNext: number;
  /** Combines chain hash + round number to derive a VRF alpha seed */
  suggestedAlphaSeed: string;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`drand HTTP ${res.status}: ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

function chainUrl(chainId: ChainId): string {
  const chain = CHAINS[chainId];
  // The default chain can be addressed as /public/... directly
  if (chainId === "default") return `${DRAND_BASE}/public`;
  return `${DRAND_BASE}/${chain.hash}/public`;
}

/**
 * Fetch the latest beacon for a given chain.
 */
export async function fetchLatestBeacon(chainId: ChainId = "quicknet"): Promise<DrandLatestResponse> {
  const chain = CHAINS[chainId];
  const beacon = await fetchJson<DrandBeacon>(`${chainUrl(chainId)}/latest`);

  const now = Math.floor(Date.now() / 1000);
  const nextRoundAt = chain.genesisTime + (beacon.round + 1) * chain.period;
  const secondsUntilNext = Math.max(0, nextRoundAt - now);

  // Deterministic alpha seed: sha256 is not available in this context as we use
  // the hex randomness directly (it already IS sha256(sig))
  const suggestedAlphaSeed = `drand:${chain.hash.slice(0, 16)}:round:${beacon.round}:${beacon.randomness}`;

  return {
    chain: {
      chainId,
      name: chain.name,
      hash: chain.hash,
      period: chain.period,
      genesisTime: chain.genesisTime,
      schemeId: chain.schemeId,
    },
    beacon,
    nextRoundAt,
    secondsUntilNext,
    suggestedAlphaSeed,
  };
}

/**
 * Fetch a specific beacon round.
 */
export async function fetchBeaconRound(round: number, chainId: ChainId = "quicknet"): Promise<DrandLatestResponse> {
  const chain = CHAINS[chainId];
  const beacon = await fetchJson<DrandBeacon>(`${chainUrl(chainId)}/${round}`);

  const nextRoundAt = chain.genesisTime + (beacon.round + 1) * chain.period;
  const now = Math.floor(Date.now() / 1000);
  const secondsUntilNext = Math.max(0, nextRoundAt - now);
  const suggestedAlphaSeed = `drand:${chain.hash.slice(0, 16)}:round:${beacon.round}:${beacon.randomness}`;

  return {
    chain: {
      chainId,
      name: chain.name,
      hash: chain.hash,
      period: chain.period,
      genesisTime: chain.genesisTime,
      schemeId: chain.schemeId,
    },
    beacon,
    nextRoundAt,
    secondsUntilNext,
    suggestedAlphaSeed,
  };
}

/**
 * Build an ECVRF alpha seed by mixing a drand beacon with a user-provided
 * context string. This is the recommended way to request VRF randomness:
 * the oracle cannot predict or manipulate the output because drand's
 * randomness is produced by a threshold network outside its control.
 *
 * Format: "drand:<chain>:<round>:<drand_randomness_hex>:<user_context>"
 */
export function buildDrandAlphaSeed(beacon: DrandBeacon, chainHash: string, userContext: string): string {
  return `drand:${chainHash.slice(0, 16)}:r${beacon.round}:${beacon.randomness}:${userContext}`;
}
