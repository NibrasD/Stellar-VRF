import { Router, type IRouter } from "express";
import healthRouter from "./health";
import vrfRequestsRouter from "./vrfRequests";
import vrfProofsRouter from "./vrfProofs";
import statsRouter from "./stats";
import stellarRouter from "./stellar";
import drandRouter from "./drand";

const router: IRouter = Router();

router.use(healthRouter);
router.use(vrfRequestsRouter);
router.use(vrfProofsRouter);
router.use(statsRouter);
router.use(stellarRouter);
router.use(drandRouter);

export default router;
