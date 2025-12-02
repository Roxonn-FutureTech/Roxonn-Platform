CREATE TABLE "bounty_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_repo_id" text NOT NULL,
	"github_issue_id" text NOT NULL,
	"github_issue_number" integer NOT NULL,
	"github_issue_url" text NOT NULL,
	"requested_by" text NOT NULL,
	"suggested_amount" text,
	"suggested_currency" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"processed_by" integer
);
--> statement-breakpoint
CREATE TABLE "course_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"course" text NOT NULL,
	"assignment_link" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exo_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer,
	"wallet_address" text NOT NULL,
	"ip_address" text,
	"port" integer,
	"status" text DEFAULT 'offline' NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"contribution_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "multi_currency_bounties" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"issue_id" integer NOT NULL,
	"currency_type" text NOT NULL,
	"network" text NOT NULL,
	"amount" text NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"contributor_address" text,
	"transaction_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payout_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"usdc_amount" numeric(10, 6) NOT NULL,
	"roxn_amount" numeric(18, 8) NOT NULL,
	"wallet_address" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"admin_notes" text,
	"usdc_tx_hash" text,
	"roxn_tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"paid_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pending_wallets" (
	"id" serial PRIMARY KEY NOT NULL,
	"reference_id" text NOT NULL,
	"encrypted_private_key" text NOT NULL,
	"encrypted_mnemonic" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"expires_at" timestamp DEFAULT now(),
	CONSTRAINT "pending_wallets_reference_id_unique" UNIQUE("reference_id")
);
--> statement-breakpoint
CREATE TABLE "promotional_bounties" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_id" integer NOT NULL,
	"creator_id" integer NOT NULL,
	"type" text DEFAULT 'PROMOTIONAL' NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"promotional_channels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_deliverable" text,
	"reward_amount" numeric(18, 8) NOT NULL,
	"reward_type" text DEFAULT 'PER_SUBMISSION' NOT NULL,
	"max_submissions" integer,
	"total_reward_pool" numeric(18, 8),
	"campaign_id" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promotional_submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"bounty_id" integer NOT NULL,
	"contributor_id" integer NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"proof_links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"description" text,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" integer,
	"review_notes" text,
	"reward_distributed" boolean DEFAULT false,
	"reward_distributed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referral_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "referral_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "referral_rewards" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"referral_id" integer,
	"reward_type" text NOT NULL,
	"amount" numeric(18, 8) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"transaction_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" serial PRIMARY KEY NOT NULL,
	"referrer_id" integer NOT NULL,
	"referred_id" integer NOT NULL,
	"referral_code_id" integer,
	"subscription_id" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"usdc_reward" numeric(10, 6) DEFAULT '0',
	"roxn_reward" numeric(18, 8) DEFAULT '0',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"converted_at" timestamp with time zone,
	"rewarded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "subscription_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"subscription_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"plan" text DEFAULT 'courses_yearly' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"provider" text DEFAULT 'onramp' NOT NULL,
	"provider_order_id" text,
	"tx_hash" text,
	"amount_usdc" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "registered_repositories" ADD COLUMN "is_private" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "registered_repositories" ADD COLUMN "is_active" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "has_private_repo_access" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "github_private_access_token" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "referred_by" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "total_usdc_earned" numeric(10, 6) DEFAULT '0';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "total_roxn_earned" numeric(18, 8) DEFAULT '0';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "total_referrals" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "bounty_requests" ADD CONSTRAINT "bounty_requests_processed_by_users_id_fk" FOREIGN KEY ("processed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_assignments" ADD CONSTRAINT "course_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exo_nodes" ADD CONSTRAINT "exo_nodes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_requests" ADD CONSTRAINT "payout_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotional_bounties" ADD CONSTRAINT "promotional_bounties_repo_id_registered_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."registered_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotional_bounties" ADD CONSTRAINT "promotional_bounties_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotional_submissions" ADD CONSTRAINT "promotional_submissions_bounty_id_promotional_bounties_id_fk" FOREIGN KEY ("bounty_id") REFERENCES "public"."promotional_bounties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotional_submissions" ADD CONSTRAINT "promotional_submissions_contributor_id_users_id_fk" FOREIGN KEY ("contributor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotional_submissions" ADD CONSTRAINT "promotional_submissions_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_referral_id_referrals_id_fk" FOREIGN KEY ("referral_id") REFERENCES "public"."referrals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_id_users_id_fk" FOREIGN KEY ("referrer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referred_id_users_id_fk" FOREIGN KEY ("referred_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referral_code_id_referral_codes_id_fk" FOREIGN KEY ("referral_code_id") REFERENCES "public"."referral_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;