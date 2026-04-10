import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (_req, res) => {
  res.send(`
    <div style="font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background: #0f172a; color: #38bdf8; text-align: center; padding: 20px;">
      <h1 style="margin: 0; font-size: 2.5rem;">🚀 Soroban VRF API is Live</h1>
      <p style="color: #94a3b8; font-size: 1.2rem; margin: 20px 0;">This is the <b>Backend (API)</b> service.</p>
      <div style="background: #1e293b; padding: 20px; border-radius: 12px; border: 1px solid #334155; margin-bottom: 30px;">
        <p style="margin: 0 0 10px 0;">To view the <b>Interactive Dashboard</b>, please visit your:</p>
        <code style="background: #000; padding: 5px 10px; border-radius: 4px; color: #fbbf24;">soroban-vrf-frontend.onrender.com</code>
      </div>
      <a href="/api/healthz" style="color: #38bdf8; text-decoration: none; border: 1px solid #38bdf8; padding: 0.8rem 1.5rem; border-radius: 0.5rem; transition: all 0.2s;">Check API Health Status</a>
    </div>
  `);
});

app.use("/api", router);

export default app;
