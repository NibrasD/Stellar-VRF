import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, vrfProofsTable, vrfRequestsTable, activityLogTable } from "@workspace/db";
import { VerifyVrfProofParams } from "@workspace/api-zod";
import { verifyEcvrfProof } from "../lib/vrfCrypto.js";

const router: IRouter = Router();

router.get("/vrf-proofs", async (_req, res): Promise<void> => {
  const proofs = await db
    .select()
    .from(vrfProofsTable)
    .orderBy(desc(vrfProofsTable.computedAt));

  res.json(
    proofs.map((p) => ({
      ...p,
      computedAt: p.computedAt.toISOString(),
    }))
  );
});

router.post("/vrf-proofs/:id/verify", async (req, res): Promise<void> => {
  const params = VerifyVrfProofParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [proof] = await db
    .select()
    .from(vrfProofsTable)
    .where(eq(vrfProofsTable.id, params.data.id));

  if (!proof) {
    res.status(404).json({ error: "VRF proof not found" });
    return;
  }

  const [request] = await db
    .select()
    .from(vrfRequestsTable)
    .where(eq(vrfRequestsTable.id, proof.requestId));

  const alphaSeed = request?.alphaSeed ?? "";

  const result = verifyEcvrfProof(
    {
      gammaPoint: proof.gammaPoint,
      challengeScalar: proof.challengeScalar,
      responseScalar: proof.responseScalar,
      publicKey: proof.publicKey,
      proofBytes: proof.proofBytes,
    },
    alphaSeed
  );

  const newStatus = result.valid ? "verified" : "invalid";

  await db
    .update(vrfProofsTable)
    .set({
      verificationStatus: newStatus,
      verificationSteps: JSON.stringify(result.steps),
    })
    .where(eq(vrfProofsTable.id, proof.id));

  await db.insert(activityLogTable).values({
    type: "proof_verified",
    description: `Proof #${proof.id} verification: ${result.valid ? "PASSED" : "FAILED"} (${result.steps.filter((s) => s.passed).length}/${result.steps.length} checks passed)`,
    requestId: proof.requestId,
    proofId: proof.id,
  });

  res.json({
    proofId: proof.id,
    valid: result.valid,
    steps: result.steps,
    gasUsed: result.gasUsed,
    blockTime: result.blockTime,
  });
});

export default router;
