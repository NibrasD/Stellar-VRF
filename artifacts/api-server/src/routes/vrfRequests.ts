import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, vrfRequestsTable, vrfProofsTable, activityLogTable } from "@workspace/db";
import {
  CreateVrfRequestBody,
  GetVrfRequestParams,
  FulfillVrfRequestParams,
  ListVrfRequestsQueryParams,
} from "@workspace/api-zod";
import { generateEcvrfProof, getContractAddress, estimateGas, verifyEcvrfProof } from "../lib/vrfCrypto.js";
import { sorobanRequest, sorobanFulfill } from "../lib/sorobanSubmit.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

router.get("/vrf-requests", async (req, res): Promise<void> => {
  const query = ListVrfRequestsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const { status, limit = 50 } = query.data;

  let rows;
  if (status) {
    rows = await db
      .select()
      .from(vrfRequestsTable)
      .where(eq(vrfRequestsTable.status, status))
      .orderBy(desc(vrfRequestsTable.createdAt))
      .limit(limit);
  } else {
    rows = await db
      .select()
      .from(vrfRequestsTable)
      .orderBy(desc(vrfRequestsTable.createdAt))
      .limit(limit);
  }

  res.json(rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    fulfilledAt: r.fulfilledAt ? r.fulfilledAt.toISOString() : null,
  })));
});

router.post("/vrf-requests", async (req, res): Promise<void> => {
  const parsed = CreateVrfRequestBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const contractAddress = getContractAddress();
  const gasEstimate = estimateGas();

  // ── Auto-fetch drand entropy if alphaSeed is not provided ─────────────────
  let alphaSeed = parsed.data.alphaSeed;
  let drandRound: number | undefined;

  if (!alphaSeed) {
    try {
      const { fetchLatestBeacon, buildDrandAlphaSeed } = await import("../lib/drand.js");
      const latest = await fetchLatestBeacon("quicknet");
      drandRound = latest.beacon.round;

      // Mix in user context if provided for domain separation
      const context = parsed.data.context || "vrf-request";
      alphaSeed = buildDrandAlphaSeed(latest.beacon, latest.chain.hash, context);

      logger.info(`Auto-fetched drand round ${drandRound} → alphaSeed: ${alphaSeed.slice(0, 40)}...`);
    } catch (err: any) {
      logger.error(`Failed to fetch drand beacon: ${err.message}`);
      res.status(502).json({ error: `Failed to fetch drand entropy: ${err.message}` });
      return;
    }
  } else if (parsed.data.context) {
    // If both alphaSeed and context provided, append context
    alphaSeed = `${alphaSeed}:${parsed.data.context}`;
  }

  // ── Default requester to oracle address ──────────────────────────────────
  const requesterAddress = parsed.data.requesterAddress || "oracle-auto";

  const [request] = await db
    .insert(vrfRequestsTable)
    .values({
      alphaSeed,
      requesterAddress,
      status: "pending",
      contractAddress,
      gasEstimate,
    })
    .returning();

  await db.insert(activityLogTable).values({
    type: "request_created",
    description: `New VRF request${drandRound ? ` (drand round #${drandRound})` : ""} with seed ${alphaSeed.slice(0, 40)}...`,
    requestId: request.id,
    proofId: null,
  });

  res.status(201).json({
    ...request,
    createdAt: request.createdAt.toISOString(),
    fulfilledAt: null,
    drandRound: drandRound ?? null,
  });

  // ── Fire-and-forget: submit request to Soroban contract ──────────────────
  setImmediate(async () => {
    try {
      const result = await sorobanRequest(alphaSeed!, requesterAddress);
      await db
        .update(vrfRequestsTable)
        .set({
          contractRequestId: result.contractRequestId,
          requestTxHash: result.txHash,
        })
        .where(eq(vrfRequestsTable.id, request.id));
      await db.insert(activityLogTable).values({
        type: "request_created",
        description: `On-chain request submitted — contract ID #${result.contractRequestId} · tx: ${result.txHash.slice(0, 12)}...`,
        requestId: request.id,
        proofId: null,
      });
      logger.info(`Soroban request submitted: contractId=${result.contractRequestId} tx=${result.txHash}`);
    } catch (err: any) {
      logger.error(`Soroban request submission failed: ${err.message}`);
    }
  });
});

router.get("/vrf-requests/:id", async (req, res): Promise<void> => {
  const params = GetVrfRequestParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [request] = await db
    .select()
    .from(vrfRequestsTable)
    .where(eq(vrfRequestsTable.id, params.data.id));

  if (!request) {
    res.status(404).json({ error: "VRF request not found" });
    return;
  }

  const [proof] = await db
    .select()
    .from(vrfProofsTable)
    .where(eq(vrfProofsTable.requestId, request.id));

  res.json({
    ...request,
    createdAt: request.createdAt.toISOString(),
    fulfilledAt: request.fulfilledAt ? request.fulfilledAt.toISOString() : null,
    proof: proof
      ? {
          ...proof,
          computedAt: proof.computedAt.toISOString(),
        }
      : null,
  });
});

router.post("/vrf-requests/:id/fulfill", async (req, res): Promise<void> => {
  const params = FulfillVrfRequestParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [request] = await db
    .select()
    .from(vrfRequestsTable)
    .where(eq(vrfRequestsTable.id, params.data.id));

  if (!request) {
    res.status(404).json({ error: "VRF request not found" });
    return;
  }

  if (request.status !== "pending") {
    res.status(400).json({ error: `Request is already ${request.status}` });
    return;
  }

  const ecvrf = generateEcvrfProof(request.alphaSeed);
  const verification = verifyEcvrfProof(ecvrf, request.alphaSeed);

  const [updatedRequest] = await db
    .update(vrfRequestsTable)
    .set({
      status: "fulfilled",
      randomOutput: ecvrf.randomOutput,
      fulfilledAt: new Date(),
    })
    .where(eq(vrfRequestsTable.id, params.data.id))
    .returning();

  const [proof] = await db
    .insert(vrfProofsTable)
    .values({
      requestId: request.id,
      gammaPoint: ecvrf.gammaPoint,
      challengeScalar: ecvrf.challengeScalar,
      responseScalar: ecvrf.responseScalar,
      publicKey: ecvrf.publicKey,
      proofBytes: ecvrf.proofBytes,
      verificationStatus: "unverified",
      verificationSteps: null,
    })
    .returning();

  await db.insert(activityLogTable).values([
    {
      type: "proof_generated",
      description: `ECVRF proof generated for request #${request.id}`,
      requestId: request.id,
      proofId: proof.id,
    },
    {
      type: "request_fulfilled",
      description: `Request #${request.id} fulfilled — output: 0x${ecvrf.randomOutput.slice(0, 12)}...`,
      requestId: request.id,
      proofId: proof.id,
    },
  ]);

  res.json({
    ...updatedRequest,
    createdAt: updatedRequest.createdAt.toISOString(),
    fulfilledAt: updatedRequest.fulfilledAt ? updatedRequest.fulfilledAt.toISOString() : null,
    proof: {
      ...proof,
      computedAt: proof.computedAt.toISOString(),
    },
  });

  // ── Fire-and-forget: submit proof to Soroban contract ────────────────────
  setImmediate(async () => {
    try {
      const contractId = request.contractRequestId ?? 1;
      const result = await sorobanFulfill(contractId, request.alphaSeed, ecvrf);
      // Update the proof record with on-chain transaction details
      await db
        .update(vrfProofsTable)
        .set({
          fulfillTxHash: result.txHash,
          onChainExplorerUrl: result.explorerUrl,
        })
        .where(eq(vrfProofsTable.id, proof.id));
      await db.insert(activityLogTable).values({
        type: "proof_generated",
        description: `Proof submitted on-chain · tx: ${result.txHash.slice(0, 16)}... · ${result.explorerUrl}`,
        requestId: request.id,
        proofId: proof.id,
      });
      logger.info(`Soroban fulfill tx: ${result.txHash}`);
    } catch (err: any) {
      logger.error(`Soroban fulfill submission failed: ${err.message}`);
    }
  });
});

export default router;
