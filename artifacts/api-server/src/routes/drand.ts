import { Router, type IRouter } from "express";
import { fetchLatestBeacon, fetchBeaconRound, type ChainId } from "../lib/drand";

const router: IRouter = Router();

/**
 * GET /drand/latest
 * Fetch the latest drand beacon. Accepts ?chain=quicknet (default) or ?chain=default
 */
router.get("/drand/latest", async (req, res): Promise<void> => {
  const chainId = (req.query["chain"] as ChainId) || "quicknet";
  if (chainId !== "quicknet" && chainId !== "default") {
    res.status(400).json({ error: `Unknown chain "${chainId}". Valid values: quicknet, default` });
    return;
  }
  try {
    const data = await fetchLatestBeacon(chainId);
    res.json(data);
  } catch (err) {
    res.status(503).json({ error: `drand unreachable: ${String(err)}` });
  }
});

/**
 * GET /drand/round/:round
 * Fetch a specific drand beacon round.
 */
router.get("/drand/round/:round", async (req, res): Promise<void> => {
  const round = Number(req.params["round"]);
  if (!Number.isInteger(round) || round < 1) {
    res.status(400).json({ error: "round must be a positive integer" });
    return;
  }
  const chainId = (req.query["chain"] as ChainId) || "quicknet";
  if (chainId !== "quicknet" && chainId !== "default") {
    res.status(400).json({ error: `Unknown chain "${chainId}". Valid values: quicknet, default` });
    return;
  }
  try {
    const data = await fetchBeaconRound(round, chainId);
    res.json(data);
  } catch (err) {
    res.status(503).json({ error: `drand round ${round} unavailable: ${String(err)}` });
  }
});

export default router;
