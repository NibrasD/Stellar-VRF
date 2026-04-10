import { Router, type IRouter } from "express";
import healthRouter from "./health";
import vrfRequestsRouter from "./vrfRequests";
import vrfProofsRouter from "./vrfProofs";
import statsRouter from "./stats";
import stellarRouter from "./stellar";
import drandRouter from "./drand";

const router: IRouter = Router();

router.use(healthRouter);

router.get("/", (_req, res) => {
  res.send(`
    <div style="font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background: #0f172a; color: #38bdf8;">
      <h1 style="margin: 0;">🚀 Soroban VRF API is Live</h1>
      <p style="color: #94a3b8;">This is the backend service. Access the dashboard via the frontend URL.</p>
      <a href="/api/healthz" style="color: #38bdf8; text-decoration: none; border: 1px solid #38bdf8; padding: 0.5rem 1rem; border-radius: 0.5rem; margin-top: 1rem;">Check Health Status</a>
    </div>
  `);
});

router.use(vrfRequestsRouter);
router.use(vrfProofsRouter);
router.use(statsRouter);
router.use(stellarRouter);
router.use(drandRouter);

export default router;
