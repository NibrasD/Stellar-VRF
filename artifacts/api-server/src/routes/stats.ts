import { Router, type IRouter } from "express";
import { eq, count, avg, desc } from "drizzle-orm";
import { db, vrfRequestsTable, vrfProofsTable, activityLogTable } from "@workspace/db";

const router: IRouter = Router();

router.get("/stats/dashboard", async (_req, res): Promise<void> => {
  const allRequests = await db.select().from(vrfRequestsTable);
  const allProofs = await db.select().from(vrfProofsTable);

  const totalRequests = allRequests.length;
  const pendingRequests = allRequests.filter((r) => r.status === "pending").length;
  const fulfilledRequests = allRequests.filter((r) => r.status === "fulfilled").length;
  const failedRequests = allRequests.filter((r) => r.status === "failed").length;

  const totalProofsGenerated = allProofs.length;
  const verifiedProofs = allProofs.filter((p) => p.verificationStatus === "verified").length;
  const proofSuccessRate = totalProofsGenerated > 0 ? (verifiedProofs / totalProofsGenerated) * 100 : 0;

  const gasValues = allRequests.map((r) => r.gasEstimate).filter((g) => g > 0);
  const avgGasPerVerification = gasValues.length > 0 ? Math.floor(gasValues.reduce((a, b) => a + b, 0) / gasValues.length) : 0;

  const fulfilledWithTime = allRequests.filter((r) => r.status === "fulfilled" && r.fulfilledAt);
  const avgFulfillmentTimeMs =
    fulfilledWithTime.length > 0
      ? Math.floor(
          fulfilledWithTime.reduce((sum, r) => {
            const ms = r.fulfilledAt!.getTime() - r.createdAt.getTime();
            return sum + ms;
          }, 0) / fulfilledWithTime.length
        )
      : 0;

  res.json({
    totalRequests,
    pendingRequests,
    fulfilledRequests,
    failedRequests,
    proofSuccessRate: Math.round(proofSuccessRate * 100) / 100,
    avgGasPerVerification,
    avgFulfillmentTimeMs,
    totalProofsGenerated,
    totalProofsVerified: verifiedProofs,
  });
});

router.get("/stats/randomness-distribution", async (_req, res): Promise<void> => {
  const fulfilled = await db
    .select()
    .from(vrfRequestsTable)
    .where(eq(vrfRequestsTable.status, "fulfilled"));

  const buckets: Record<string, number> = {
    "00-0F": 0,
    "10-1F": 0,
    "20-2F": 0,
    "30-3F": 0,
    "40-4F": 0,
    "50-5F": 0,
    "60-6F": 0,
    "70-7F": 0,
    "80-8F": 0,
    "90-9F": 0,
    "A0-AF": 0,
    "B0-BF": 0,
    "C0-CF": 0,
    "D0-DF": 0,
    "E0-EF": 0,
    "F0-FF": 0,
  };

  const bucketKeys = Object.keys(buckets);

  for (const req of fulfilled) {
    if (req.randomOutput && req.randomOutput.length >= 2) {
      const firstByte = parseInt(req.randomOutput.slice(0, 2), 16);
      const bucketIndex = Math.floor(firstByte / 16);
      const key = bucketKeys[bucketIndex];
      if (key !== undefined) {
        buckets[key]++;
      }
    }
  }

  const total = fulfilled.length || 1;
  const distribution = bucketKeys.map((bucket) => ({
    bucket,
    count: buckets[bucket],
    percentage: Math.round((buckets[bucket] / total) * 10000) / 100,
  }));

  res.json(distribution);
});

router.get("/stats/recent-activity", async (_req, res): Promise<void> => {
  const activities = await db
    .select()
    .from(activityLogTable)
    .orderBy(desc(activityLogTable.timestamp))
    .limit(20);

  res.json(
    activities.map((a) => ({
      ...a,
      timestamp: a.timestamp.toISOString(),
    }))
  );
});

export default router;
