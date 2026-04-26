import { xdr } from "@stellar/stellar-sdk";

function bufferFromPossibleValue(v: any): Buffer | null {
  if (!v) return null;
  try {
    if (Buffer.isBuffer(v)) return v;
  } catch (e) {}
  if (v instanceof Uint8Array) return Buffer.from(v as Uint8Array);

  // Common generated shapes: object with .bytes() method
  try {
    if (typeof v.bytes === "function") {
      const b = v.bytes();
      if (Buffer.isBuffer(b)) return b;
      if (b instanceof Uint8Array) return Buffer.from(b as Uint8Array);
      if (Array.isArray(b)) return Buffer.from(b);
    }
  } catch (e) {}

  // Some ScVal shapes expose scvBytes
  try {
    if (v && v.scvBytes) {
      const b = v.scvBytes.bytes ?? v.scvBytes;
      if (Buffer.isBuffer(b)) return b;
      if (b instanceof Uint8Array) return Buffer.from(b as Uint8Array);
      if (Array.isArray(b)) return Buffer.from(b);
      if (typeof b === "string") {
        // could be base64 or hex
        if (/^[0-9a-fA-F]+$/.test(b)) return Buffer.from(b, "hex");
        try {
          return Buffer.from(b, "base64");
        } catch (e) {}
      }
    }
  } catch (e) {}

  // scvVec of u8 elements
  try {
    const vec = typeof v.scvVec === "function" ? v.scvVec() : v.scvVec;
    if (Array.isArray(vec)) {
      const bytes: number[] = [];
      for (const e of vec) {
        if (typeof e === "number") bytes.push(e);
        else if (e && typeof e.u8 === "function") {
          try { bytes.push(e.u8()); } catch (e) {}
        }
      }
      if (bytes.length) return Buffer.from(bytes);
    }
  } catch (e) {}

  // Last resorts: string that is hex or base64
  if (typeof v === "string") {
    if (/^[0-9a-fA-F]+$/.test(v) && v.length % 2 === 0) return Buffer.from(v, "hex");
    try { return Buffer.from(v, "base64"); } catch (e) {}
  }

  // Try stringify and extract base64-like tokens
  try {
    const j = JSON.stringify(v);
    const b64 = j.match(/([A-Za-z0-9+/=]{24,})/);
    if (b64) return Buffer.from(b64[1], "base64");
  } catch (e) {}
  return null;
}

function getMapEntries(scVal: any): any[] {
  if (!scVal) return [];
  // Try common accessor shapes
  try {
    if (typeof scVal.scvMap === "function") {
      const m = scVal.scvMap();
      if (m && Array.isArray(m.map)) return m.map;
      if (Array.isArray(m)) return m;
    }
  } catch (e) {}
  try {
    if (scVal && scVal.scvMap && Array.isArray(scVal.scvMap.map)) return scVal.scvMap.map;
    if (scVal && scVal.scvMap && Array.isArray(scVal.scvMap)) return scVal.scvMap;
    if (scVal && scVal.map && Array.isArray(scVal.map)) return scVal.map;
    if (scVal && scVal.value && scVal.value.map && Array.isArray(scVal.value.map)) return scVal.value.map;
  } catch (e) {}

  // Try JSON shape fallback
  try {
    const j = JSON.parse(JSON.stringify(scVal));
    if (j && j.scvMap && Array.isArray(j.scvMap.map)) return j.scvMap.map;
    if (j && j.map && Array.isArray(j.map)) return j.map;
  } catch (e) {}
  return [];
}

function keyToString(k: any): string | null {
  if (!k) return null;
  if (typeof k === "string") return k;
  try {
    if (k && k.scvSymbol) {
      const s = typeof k.scvSymbol === "function" ? k.scvSymbol() : k.scvSymbol;
      if (typeof s === "string") return s;
      if (s && s.symbol) return s.symbol;
    }
  } catch (e) {}
  try {
    if (typeof k.symbol === "string") return k.symbol;
  } catch (e) {}
  try { const j = JSON.stringify(k); const m = j.match(/"([a-zA-Z0-9_]+)"/); if (m) return m[1]; } catch (e) {}
  return null;
}

export function extractEcvrfProofFromSimulation(simulated: any): Record<string,string> | null {
  if (!simulated) return null;
  const candidates: any[] = [];
  if (simulated.returnValue) candidates.push(simulated.returnValue);
  if (Array.isArray(simulated.results)) {
    for (const r of simulated.results) {
      if (!r) continue;
      if (r.xdr) candidates.push(r.xdr);
      if (r.returnValue) candidates.push(r.returnValue);
      if (r.value) candidates.push(r.value);
    }
  }

  for (const cand of candidates) {
    try {
      let scVal = cand;
      if (typeof cand === "string") {
        try {
          scVal = xdr.ScVal.fromXDR(Buffer.from(cand, "base64"));
        } catch (e) {
          // not base64 xdr - skip
          continue;
        }
      }

      const entries = getMapEntries(scVal);
      if (!entries || entries.length === 0) continue;

      const out: Record<string,string> = {};
      for (const e of entries) {
        const keyObj = e.key ? (typeof e.key === 'function' ? e.key() : e.key) : e[0] ?? null;
        const valObj = e.val ? (typeof e.val === 'function' ? e.val() : e.val) : e[1] ?? null;
        const key = keyToString(keyObj);
        const buf = bufferFromPossibleValue(valObj);
        if (key && buf) out[key] = buf.toString('hex');
      }

      const need = ['alpha_seed','gamma_point','c_scalar','s_scalar','beta_output','public_key'];
      const hasAll = need.every(k => Object.prototype.hasOwnProperty.call(out, k));
      if (hasAll) return out;
    } catch (e) {
      // ignore and try next candidate
    }
  }
  return null;
}

export default { extractEcvrfProofFromSimulation };
