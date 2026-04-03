import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const vrfRequestsTable = pgTable("vrf_requests", {
  id: serial("id").primaryKey(),
  alphaSeed: text("alpha_seed").notNull(),
  requesterAddress: text("requester_address").notNull(),
  status: text("status", { enum: ["pending", "fulfilled", "failed"] }).notNull().default("pending"),
  randomOutput: text("random_output"),
  contractAddress: text("contract_address").notNull(),
  gasEstimate: integer("gas_estimate").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
});

export const insertVrfRequestSchema = createInsertSchema(vrfRequestsTable).omit({
  id: true,
  createdAt: true,
  fulfilledAt: true,
});
export type InsertVrfRequest = z.infer<typeof insertVrfRequestSchema>;
export type VrfRequest = typeof vrfRequestsTable.$inferSelect;
