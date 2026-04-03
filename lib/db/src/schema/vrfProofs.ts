import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const vrfProofsTable = pgTable("vrf_proofs", {
  id: serial("id").primaryKey(),
  requestId: integer("request_id").notNull(),
  gammaPoint: text("gamma_point").notNull(),
  challengeScalar: text("challenge_scalar").notNull(),
  responseScalar: text("response_scalar").notNull(),
  publicKey: text("public_key").notNull(),
  proofBytes: text("proof_bytes").notNull(),
  verificationStatus: text("verification_status", { enum: ["unverified", "verified", "invalid"] }).notNull().default("unverified"),
  verificationSteps: text("verification_steps"),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertVrfProofSchema = createInsertSchema(vrfProofsTable).omit({
  id: true,
  computedAt: true,
});
export type InsertVrfProof = z.infer<typeof insertVrfProofSchema>;
export type VrfProof = typeof vrfProofsTable.$inferSelect;
