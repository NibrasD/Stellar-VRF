import { Router, type IRouter } from "express";
import { getStellarNetworkStats, getRecentLedgers, estimateSorobanVrfFee } from "../lib/stellarNetwork.js";

const router: IRouter = Router();

router.get("/stellar/network", async (req, res): Promise<void> => {
  try {
    const [stats, ledgers, fee] = await Promise.all([
      getStellarNetworkStats(),
      getRecentLedgers(5),
      estimateSorobanVrfFee(),
    ]);
    res.json({ stats, ledgers, fee });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch Stellar network data");
    res.status(503).json({ error: "Could not reach Stellar Horizon — check network connectivity" });
  }
});

export default router;
