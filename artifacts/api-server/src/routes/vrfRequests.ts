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

  const [request] = await db
    .insert(vrfRequestsTable)
    .values({
      alphaSeed: parsed.data.alphaSeed,
      requesterAddress: parsed.data.requesterAddress,
      status: "pending",
      contractAddress,
      gasEstimate,
    })
    .returning();

  await db.insert(activityLogTable).values({
    type: "request_created",
    description: `New VRF request from ${parsed.data.requesterAddress.slice(0, 12)}... with seed ${parsed.data.alphaSeed.slice(0, 16)}`,
    requestId: request.id,
    proofId: null,
  });

  res.status(201).json({
    ...request,
    createdAt: request.createdAt.toISOString(),
    fulfilledAt: null,
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
});

export default router;
