import { Router, type IRouter } from "express";
import healthRouter from "./health";
import vrfRequestsRouter from "./vrfRequests";
import vrfProofsRouter from "./vrfProofs";
import statsRouter from "./stats";

const router: IRouter = Router();

router.use(healthRouter);
router.use(vrfRequestsRouter);
router.use(vrfProofsRouter);
router.use(statsRouter);

export default router;
