CREATE TABLE "vrf_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"alpha_seed" text NOT NULL,
	"requester_address" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"random_output" text,
	"contract_address" text NOT NULL,
	"gas_estimate" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fulfilled_at" timestamp with time zone,
	"contract_request_id" integer,
	"request_tx_hash" text
);
--> statement-breakpoint
CREATE TABLE "vrf_proofs" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" integer NOT NULL,
	"gamma_point" text NOT NULL,
	"challenge_scalar" text NOT NULL,
	"response_scalar" text NOT NULL,
	"public_key" text NOT NULL,
	"proof_bytes" text NOT NULL,
	"verification_status" text DEFAULT 'unverified' NOT NULL,
	"verification_steps" text,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fulfill_tx_hash" text,
	"on_chain_explorer_url" text
);
--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"description" text NOT NULL,
	"request_id" integer,
	"proof_id" integer,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL
);
