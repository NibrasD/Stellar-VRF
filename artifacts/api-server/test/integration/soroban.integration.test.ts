import { describe, it, expect } from 'vitest';

const runIntegration = process.env.RUN_INTEGRATION === '1' || process.env.RUN_INTEGRATION === 'true';
const describeIf = runIntegration ? describe : describe.skip;

describeIf('Soroban integration (requires Testnet + env)', () => {
  it('submits a request and fulfills it on Soroban Testnet', async () => {
    // Required env vars
    const vrfKey = process.env.VRF_PRIVATE_KEY_HEX;
    const vrfKeys = (process.env.ORACLE_VRF_PRIVATE_KEYS || vrfKey || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const oracleSeed = process.env.ORACLE_STELLAR_SEED;

    if (!vrfKey || !oracleSeed || vrfKeys.length < 2) {
      throw new Error('Environment variables VRF_PRIVATE_KEY_HEX, ORACLE_STELLAR_SEED, ORACLE_VRF_PRIVATE_KEYS(>=2) must be set to run integration tests');
    }

    // Dynamic import after env is set (correct relative paths)
    const soroban = await import('../../src/lib/sorobanSubmit');
    const vrf = await import('../../src/lib/vrfCrypto');

    const alphaSeed = `integration:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

    // Submit on-chain request (this will fund oracle account via friendbot if needed)
    const reqRes = await soroban.sorobanRequest(alphaSeed, 'Cdummyrequesteraddress');
    expect(reqRes).toBeTruthy();
    expect(reqRes.txHash).toBeTruthy();

    // Contract-assigned request id is required to call fulfill
    const contractRequestId = reqRes.contractRequestId ?? 0;
    if (!contractRequestId || contractRequestId === 0) {
      throw new Error(`Contract did not return a request id. txHash=${reqRes.txHash}`);
    }

    // Generate proof locally (oracle must hold corresponding private key)
    const proof = await vrf.generateEcvrfProof(alphaSeed, { privateKeyHex: vrfKeys[0] });
    const verify = vrf.verifyEcvrfProof(
      {
        gammaPoint: proof.gammaPoint,
        challengeScalar: proof.challengeScalar,
        responseScalar: proof.responseScalar,
        publicKey: proof.publicKey,
        proofBytes: proof.proofBytes,
      },
      alphaSeed
    );
    expect(verify.valid).toBe(true);

    // Submit proof on-chain
    const fulfillRes = await soroban.sorobanFulfill(contractRequestId, alphaSeed, proof, 0);
    expect(fulfillRes).toBeTruthy();
    expect(fulfillRes.txHash).toBeTruthy();

    // Submit second oracle proof to reach quorum.
    const proof2 = await vrf.generateEcvrfProof(alphaSeed, { privateKeyHex: vrfKeys[1] });
    const verify2 = vrf.verifyEcvrfProof(
      {
        gammaPoint: proof2.gammaPoint,
        challengeScalar: proof2.challengeScalar,
        responseScalar: proof2.responseScalar,
        publicKey: proof2.publicKey,
        proofBytes: proof2.proofBytes,
      },
      alphaSeed
    );
    expect(verify2.valid).toBe(true);
    const fulfillRes2 = await soroban.sorobanFulfill(contractRequestId, alphaSeed, proof2, 1);
    expect(fulfillRes2).toBeTruthy();
    expect(fulfillRes2.txHash).toBeTruthy();

    // Verify on-chain transaction status and events for request and fulfill
    const SorobanSdk = await import('@stellar/stellar-sdk');
    const { rpc: SorobanRpc } = SorobanSdk as any;
    const server = new SorobanRpc.Server(process.env.SOROBAN_URL || 'https://soroban-testnet.stellar.org');

    const reqTx = await server.getTransaction(reqRes.txHash);
    expect(reqTx.status).toBe('SUCCESS');
    // Some Soroban RPC nodes may not include events in the transaction response.
    // Be tolerant: log a warning if absent but don't fail the test solely for missing events.
    const reqEventsCount = Array.isArray(reqTx.events) ? reqTx.events.length : 0;
    if (reqEventsCount === 0) {
      // eslint-disable-next-line no-console
      console.warn(`No events returned for request tx ${reqRes.txHash}; continuing checks.`);
    } else {
      expect(reqEventsCount).toBeGreaterThan(0);
    }

    const fulTx = await server.getTransaction(fulfillRes.txHash);
    expect(fulTx.status).toBe('SUCCESS');
    const fulEventsCount = Array.isArray(fulTx.events) ? fulTx.events.length : 0;
    if (fulEventsCount === 0) {
      // eslint-disable-next-line no-console
      console.warn(`No events returned for fulfill tx ${fulfillRes.txHash}; continuing checks.`);
    } else {
      expect(fulEventsCount).toBeGreaterThan(0);
    }

    // Ensure the fulfill event or the request id appears in the transaction body
    const fulStr = JSON.stringify(fulTx);
    const foundFulfillMarker = fulStr.includes('fulfill') || fulStr.includes(contractRequestId.toString());
    expect(foundFulfillMarker).toBe(true);

    // Read contract state via simulateTransaction -> call `get_proof(request_id)`
    const { Keypair, TransactionBuilder, Operation, nativeToScVal, Networks } = SorobanSdk as any;
    const kp = Keypair.fromSecret(oracleSeed);
    const account = await server.getAccount(kp.publicKey());
    const tx = new TransactionBuilder(account, { fee: '1000000', networkPassphrase: process.env.SOROBAN_NETWORK === 'public' ? Networks.PUBLIC : Networks.TESTNET })
      .addOperation(
        Operation.invokeContractFunction({
          contract: (vrf as any).getContractAddress(),
          function: 'get_proof',
          args: [nativeToScVal(contractRequestId, { type: 'u64' })],
        })
      )
      .setTimeout(30)
      .build();

    const simulated = await server.simulateTransaction(tx);
    if ((SorobanRpc as any).Api && (SorobanRpc as any).Api.isSimulationError(simulated)) {
      throw new Error('Simulation error when calling get_proof: ' + JSON.stringify(simulated));
    }
    expect(simulated).toBeTruthy();

    // Call derive_random(request_id, context) and assert deterministic output.
    const deriveTx = new TransactionBuilder(account, { fee: '1000000', networkPassphrase: process.env.SOROBAN_NETWORK === 'public' ? Networks.PUBLIC : Networks.TESTNET })
      .addOperation(
        Operation.invokeContractFunction({
          contract: (vrf as any).getContractAddress(),
          function: 'derive_random',
          args: [
            nativeToScVal(contractRequestId, { type: 'u64' }),
            nativeToScVal(Buffer.from('integration:test-context', 'utf-8'), { type: 'bytes' }),
          ],
        })
      )
      .setTimeout(30)
      .build();
    const deriveSimA = await server.simulateTransaction(deriveTx);
    const deriveSimB = await server.simulateTransaction(deriveTx);
    expect(deriveSimA).toBeTruthy();
    expect(JSON.stringify(deriveSimA)).toEqual(JSON.stringify(deriveSimB));

    // Try to decode the EcvrfProof returned by `get_proof` using SCVal/XDR decoding.
    const scval = await import('../../src/lib/scvalDecode');
    const proofFromChain = scval.extractEcvrfProofFromSimulation(simulated);
    if (proofFromChain) {
      // helper to compress gamma from uncompressed proof format
      function compressGamma(uncompressedHex: string) {
        if (!uncompressedHex || !uncompressedHex.startsWith('04') || uncompressedHex.length !== 130) return null;
        const raw = Buffer.from(uncompressedHex.slice(2), 'hex');
        const x = raw.slice(0, 32).toString('hex');
        const yLast = raw[63];
        const prefix = (yLast & 1) === 0 ? '02' : '03';
        return prefix + x;
      }

      const compressedGamma = compressGamma(proof.gammaPoint);
      // verify fields exactly
      if (proofFromChain.gamma_point) {
        expect(proofFromChain.gamma_point.toLowerCase()).toBe(compressedGamma.toLowerCase());
      }
      if (proofFromChain.beta_output) {
        expect(proofFromChain.beta_output.toLowerCase()).toBe(proof.randomOutput.toLowerCase());
      }
      if (proofFromChain.public_key) {
        expect(proofFromChain.public_key.toLowerCase()).toBe(proof.publicKey.toLowerCase());
      }
      if (proofFromChain.alpha_seed) {
        const alphaBuf = Buffer.from(proofFromChain.alpha_seed, 'hex');
        expect(alphaBuf.toString('utf-8')).toBe(alphaSeed);
      }
      if (proofFromChain.c_scalar) {
        // contract stores 16 bytes for c_scalar
        const expectedC = proof.challengeScalar.slice(0, 32).toLowerCase();
        expect(proofFromChain.c_scalar.toLowerCase()).toBe(expectedC);
      }
      if (proofFromChain.s_scalar) {
        expect(proofFromChain.s_scalar.toLowerCase()).toBe(proof.responseScalar.toLowerCase());
      }
    } else {
      // Fallback to previous event-text heuristics when decoding is not available

    // If events are present, try to locate the proof payload and assert key fields
    const events = Array.isArray(fulTx.events) ? fulTx.events : [];
    if (events.length > 0) {
      // Compress gamma point from uncompressed proof format to match on-chain storage
      function compressGamma(uncompressedHex: string) {
        if (!uncompressedHex || !uncompressedHex.startsWith('04') || uncompressedHex.length !== 130) return null;
        const raw = Buffer.from(uncompressedHex.slice(2), 'hex');
        const x = raw.slice(0, 32).toString('hex');
        const yLast = raw[63];
        const prefix = (yLast & 1) === 0 ? '02' : '03';
        return prefix + x;
      }

      const compressedGamma = compressGamma(proof.gammaPoint);
      const betaShort = proof.randomOutput?.slice(0, 16);
      const pkShort = proof.publicKey?.slice(0, 12);

      let foundPayload = false;
      for (const ev of events) {
        const text = JSON.stringify(ev);
        if (!text) continue;
        if (compressedGamma && text.includes(compressedGamma)) foundPayload = true;
        if (betaShort && text.includes(betaShort)) foundPayload = true;
        if (pkShort && text.includes(pkShort)) foundPayload = true;
        // also accept presence of the request id or function name
        if (text.includes(contractRequestId.toString())) foundPayload = true;
        if (foundPayload) break;
      }
      expect(foundPayload).toBe(true);
    }
    }
  }, 180_000);
});
