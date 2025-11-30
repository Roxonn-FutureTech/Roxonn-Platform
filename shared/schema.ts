import { pgTable, text, serial, boolean, timestamp, jsonb, integer, decimal } from "drizzle-orm/pg-core"; // Added integer, decimal
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  githubId: text("github_id").notNull().unique(),
  username: text("username").notNull().unique(),
  name: text("name"),
  email: text("email"),
  avatarUrl: text("avatar_url"),
  bio: text("bio"),
  location: text("location"),
  website: text("website"),
  githubUsername: text("github_username").notNull(),
  githubAccessToken: text("github_access_token").notNull(),
  isProfileComplete: boolean("is_profile_complete").default(false),
  role: text("role", { enum: ["contributor", "poolmanager"] }),
  
  // Single XDC wallet address
  xdcWalletAddress: text("xdc_wallet_address"),
  
  // Wallet security and reference
  walletReferenceId: text("wallet_reference_id"),
  encryptedPrivateKey: text("encrypted_private_key"),
  encryptedMnemonic: text("encrypted_mnemonic"),
  
  promptBalance: integer('prompt_balance').default(0).notNull(), // Changed from aiCredits

  // Private repository access support
  hasPrivateRepoAccess: boolean("has_private_repo_access").default(false),
  githubPrivateAccessToken: text("github_private_access_token"),

  // Referral system fields
  referredBy: integer("referred_by"), // User ID who referred this user
  totalUsdcEarned: decimal("total_usdc_earned", { precision: 10, scale: 6 }).default("0"),
  totalRoxnEarned: decimal("total_roxn_earned", { precision: 18, scale: 8 }).default("0"),
  totalReferrals: integer("total_referrals").default(0),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// New table for registered repositories
export const registeredRepositories = pgTable("registered_repositories", {
  id: serial("id").primaryKey(),
  // userId should be an integer if it's a foreign key to users.id (which is serial/integer)
  // Making it notNull as well, if a repository must always be associated with a user.
  // If it can be unassociated initially, then .notNull() can be removed.
  // Given the previous comment, let's assume it can be null initially.
  userId: integer("user_id").references(() => users.id, { onDelete: 'cascade' }),
  githubRepoId: text("github_repo_id").notNull().unique(), // Add unique constraint on githubRepoId
  githubRepoFullName: text("github_repo_full_name").notNull(),
  installationId: text("installation_id"), // Store the GitHub App Installation ID (nullable)
  isPrivate: boolean("is_private").default(false), // Track if repository is private
  isActive: boolean("is_active").default(false), // Track if repository is actively maintained
  registeredAt: timestamp("registered_at").defaultNow(),
});

// Create a schema for updating profile information
export const updateProfileSchema = z.object({
  bio: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
});
// .partial() is effectively applied by making each field .optional() above.
// If we wanted all fields from .pick to be present but their values partial (e.g. for a PATCH)
// then .partial() on the z.object would be: z.object({ bio: z.string().nullable(), ... }).partial();
// But since updateProfileSchema is for PATCH-like updates, making fields optional is correct.

export type UpdateProfile = z.infer<typeof updateProfileSchema>;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

// Blockchain Types
export interface IssueReward {
    issueId: string;
    rewardAmount: string;
    status: string;
    rewardInEther?: string;
}

export interface Repository {
    poolManagers: string[];
    contributors: string[];
    poolRewards: string;
    issues: IssueReward[];
}

export interface BlockchainError {
    error: string;
    details?: string;
}

export interface AllocateRewardResponse {
    transactionHash: string;
    blockNumber: number;
}

export interface IssueRewardResponse {
    reward: string;
}

// Validation schemas
export const allocateRewardSchema = z.object({
    reward: z.string()
        .min(1)
        .refine(
            (val) => {
                try {
                    // Parse the string to a number and check if it's at least 1
                    return parseFloat(val) >= 1;
                } catch (e) {
                    return false;
                }
            },
            { message: "Minimum bounty amount must be at least 1 XDC" }
        )
});

export type AllocateRewardInput = z.infer<typeof allocateRewardSchema>;

// --- Schemas and Types for the Unified Dual Currency Rewards System ---

// Zod Schema for funding a repository with ROXN
export const fundRoxnRepoSchema = z.object({ // Renamed
  roxnAmount: z.string().min(1, "ROXN amount must be provided")
    .refine(val => {
      try {
        return parseFloat(val) > 0; 
      } catch (e) { return false; }
    }, { message: "ROXN amount must be a positive number" }),
});
export type FundRoxnRepoInput = z.infer<typeof fundRoxnRepoSchema>; // Renamed type

// Zod Schema for funding repositories with USDC
export const fundUsdcRepoSchema = z.object({
  usdcAmount: z.string().min(1, "USDC amount must be provided")
    .refine(val => {
      try {
        return parseFloat(val) > 0; 
      } catch (e) { return false; }
    }, { message: "USDC amount must be a positive number" }),
});
export type FundUsdcRepoInput = z.infer<typeof fundUsdcRepoSchema>;

// Zod Schema for allocating a bounty (unified, currency type specified by boolean)
export const allocateUnifiedBountySchema = z.object({ // Renamed
  bountyAmount: z.string().min(1, "Bounty amount must be provided") // Generic name
    .refine(val => {
      try {
        return parseFloat(val) > 0; 
      } catch (e) { return false; }
    }, { message: "Bounty amount must be a positive number" }),
  currencyType: z.enum(['XDC', 'ROXN', 'USDC']), // Currency type: XDC, ROXN, or USDC
  // Optional fields for notifications, consistent with original allocateRewardSchema
  githubRepoFullName: z.string().optional(),
  issueTitle: z.string().optional(),
  issueUrl: z.string().url().optional(),
});
export type AllocateUnifiedBountyInput = z.infer<typeof allocateUnifiedBountySchema>; // Renamed type

// Unified schema for details of a single issue bounty (can be XDC or ROXN)
export const IssueBountyDetailsSchema = z.object({
    issueId: z.string(),
    // rewardAmountFormatted: z.string(), // Formatted amount (either XDC or ROXN) - Replaced by specific amounts
    status: z.string(),
    isRoxn: z.boolean(),             // True if ROXN, false if XDC
    xdcAmount: z.string().optional(), // Formatted XDC amount, optional if ROXN/USDC or no bounty
    roxnAmount: z.string().optional(), // Formatted ROXN amount, optional if XDC/USDC or no bounty
    usdcAmount: z.string().optional(), // Formatted USDC amount, optional if XDC/ROXN or no bounty
});
export type IssueBountyDetails = z.infer<typeof IssueBountyDetailsSchema>;

// TypeScript type for a repository's reward pool information (Unified: XDC and ROXN)
export interface UnifiedPoolInfo { 
  roxnPoolRewards: string;    // Total ROXN available, formatted (matches blockchain.ts)
  xdcPoolRewards: string;     // Total XDC available, formatted (matches blockchain.ts)
  usdcPoolRewards: string;    // Total USDC available, formatted (matches blockchain.ts)
  // issueCount: number;      // This was in the old schema, blockchain.ts doesn't explicitly return it, can be derived from issues.length
  issues: IssueBountyDetails[]; // Renamed from activeBounties, matches blockchain.ts
  poolManagers?: string[];    // Optional pool managers array
  contributors?: string[];    // Optional contributors array
}

// Response type for allocating a bounty (can reuse or adapt existing)
export interface AllocateNewRoxnBountyResponse {
    transactionHash: string;
    blockNumber: number;
}

// Social verifications feature has been removed

// Onramp.money Integration

// Define transaction statuses as an enum for type safety
export const TransactionStatus = {
  INITIATED: 'initiated',
  PENDING: 'pending',
  PROCESSING: 'processing',
  SUCCESS: 'success',
  FAILED: 'failed'
} as const;

// Define the onrampTransactions table
export const onrampTransactions = pgTable("onramp_transactions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }), // Corrected from serial to integer
  walletAddress: text("wallet_address").notNull(),
  merchantRecognitionId: text("merchant_recognition_id").notNull().unique(),
  orderId: text("order_id").unique(),
  amount: text("amount"),
  fiatAmount: text("fiat_amount"),
  fiatCurrency: text("fiat_currency").default("INR"),
  status: text("status").default(TransactionStatus.INITIATED),
  statusCode: text("status_code"),
  statusMessage: text("status_message"),
  txHash: text("tx_hash"),
  metadata: jsonb("metadata").default({}), // For storing additional data from webhook
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Export types for the transaction table
export type OnrampTransaction = typeof onrampTransactions.$inferSelect;
export type NewOnrampTransaction = typeof onrampTransactions.$inferInsert;

// Pending wallets table for secure temporary storage (replaces in-memory cache)
export const pendingWallets = pgTable("pending_wallets", {
  id: serial("id").primaryKey(),
  referenceId: text("reference_id").notNull().unique(),
  encryptedPrivateKey: text("encrypted_private_key").notNull(),
  encryptedMnemonic: text("encrypted_mnemonic").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  expiresAt: timestamp("expires_at").defaultNow(), // Will be set to NOW() + 1 hour in application logic
});

export type PendingWallet = typeof pendingWallets.$inferSelect;
export type NewPendingWallet = typeof pendingWallets.$inferInsert;

// Ledger table for prompt transactions
export const promptTransactions = pgTable('prompt_transactions', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  transactionType: text('transaction_type', { enum: ['purchase', 'usage_vscode_ai', 'admin_adjustment', 'initial_grant'] }).notNull(),
  promptsChanged: integer('prompts_changed').notNull(), // Positive for additions, negative for deductions
  balanceAfterTx: integer('balance_after_tx').notNull(), // User's prompt balance after this transaction
  notes: text('notes'), 
  onrampOrderId: text('onramp_order_id'), // Optional, for linking to Onramp.money orders if applicable
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
});

export type PromptTransaction = typeof promptTransactions.$inferSelect;
export type NewPromptTransaction = typeof promptTransactions.$inferInsert;

// Optional table for defining purchasable prompt packs
export const promptPacks = pgTable('prompt_packs', {
  id: text('id').primaryKey(), // e.g., 'pack_100_prompts_usd_499'
  name: text('name').notNull(), // e.g., "100 Prompts Pack"
  promptAmount: integer('prompt_amount').notNull(),
  priceMicros: integer('price_micros').notNull(), // Price in smallest currency unit (e.g., $4.99 USD = 4990000)
  currencyCode: text('currency_code').notNull().default('USD'), // e.g., 'USD', 'INR'
  isActive: boolean('is_active').default(true).notNull(),
  description: text('description'),
});

export type PromptPack = typeof promptPacks.$inferSelect;
export type NewPromptPack = typeof promptPacks.$inferInsert;

// Table for connect-pg-simple session store
// Based on standard schema: https://github.com/voxpelli/node-connect-pg-simple/blob/master/table.sql
export const session = pgTable("session", {
  sid: text("sid").primaryKey().notNull(),
  sess: jsonb("sess").notNull(),
  expire: timestamp("expire", { mode: 'date', withTimezone: true }).notNull()
});
// Note: The original SQL has an index: CREATE INDEX "IDX_session_expire" ON "session" ("expire");
// Drizzle can create indexes separately if needed, or often handles them via ORM queries.
// For now, defining the table structure is the priority to prevent deletion.

export type Session = typeof session.$inferSelect;
export type NewSession = typeof session.$inferInsert;

// Table for social verifications
// Based on migrations/social_rewards/0001_create_social_verifications.sql
export const socialVerifications = pgTable("social_verifications", {
  id: serial("id").primaryKey().notNull(),
  userId: integer("user_id").notNull().unique().references(() => users.id, { onDelete: 'cascade' }), // Added .unique() based on SQL constraint
  youtubeClicked: boolean("youtube_clicked").default(false),
  twitterClicked: boolean("twitter_clicked").default(false),
  discordClicked: boolean("discord_clicked").default(false),
  telegramClicked: boolean("telegram_clicked").default(false),
  allClicked: boolean("all_clicked").default(false),
  rewardSent: boolean("reward_sent").default(false),
  transactionHash: text("transaction_hash"),
  createdAt: timestamp("created_at", { mode: 'date', withTimezone: true }).defaultNow(),
  verifiedAt: timestamp("verified_at", { mode: 'date', withTimezone: true }),
});
// Note: The SQL also has CREATE INDEX IF NOT EXISTS "social_verifications_user_id_idx" ON "social_verifications"("user_id");
// Drizzle can create indexes with .index() modifier on columns or separately.
// The .unique() on userId effectively creates an index.

export type SocialVerification = typeof socialVerifications.$inferSelect;
export type NewSocialVerification = typeof socialVerifications.$inferInsert;

// Table for tracking exo nodes
export const exoNodes = pgTable("exo_nodes", {
  id: text("id").primaryKey(), // The node's own unique ID
  userId: integer("user_id").references(() => users.id, { onDelete: 'set null' }), // User who runs the node
  walletAddress: text("wallet_address").notNull(),
  ipAddress: text("ip_address"),
  port: integer("port"),
  status: text("status", { enum: ["online", "offline"] }).default("offline").notNull(),
  lastSeen: timestamp("last_seen", { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  contributionCount: integer("contribution_count").default(0).notNull(),
});

export type ExoNode = typeof exoNodes.$inferSelect;
export type NewExoNode = typeof exoNodes.$inferInsert;

// Multi-currency bounties table for USDC support
export const multiCurrencyBounties = pgTable("multi_currency_bounties", {
  id: serial("id").primaryKey(),
  repoId: text("repo_id").notNull(),
  issueId: integer("issue_id").notNull(),
  currencyType: text("currency_type", { enum: ["XDC", "ROXN", "USDC"] }).notNull(), // Changed from USDT to USDC
  network: text("network", { enum: ["xdc", "ethereum", "polygon", "bsc"] }).notNull(),
  amount: text("amount").notNull(),
  status: text("status", { enum: ["created", "allocated", "distributed", "cancelled"] }).default("created").notNull(),
  contributorAddress: text("contributor_address"),
  transactionHash: text("transaction_hash"),
  createdAt: timestamp("created_at", { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: 'date', withTimezone: true }).defaultNow().notNull(),
});

export type MultiCurrencyBounty = typeof multiCurrencyBounties.$inferSelect;
export type NewMultiCurrencyBounty = typeof multiCurrencyBounties.$inferInsert;

// Table for course assignments
export const courseAssignments = pgTable("course_assignments", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  course: text("course").notNull(), // e.g., "bolt.new", "v0-dev"
  assignmentLink: text("assignment_link").notNull(),
  submittedAt: timestamp("submitted_at", { mode: 'date', withTimezone: true }).defaultNow().notNull(),
});

export type CourseAssignment = typeof courseAssignments.$inferSelect;
export type NewCourseAssignment = typeof courseAssignments.$inferInsert;

// Validation schema for course assignment submission
export const submitAssignmentSchema = z.object({
  course: z.enum(["bolt.new", "v0-dev"], {
    errorMap: () => ({ message: "Course must be either 'bolt.new' or 'v0-dev'" }),
  }),
  link: z.string().url("Assignment link must be a valid URL").min(1, "Assignment link is required"),
});

export type SubmitAssignment = z.infer<typeof submitAssignmentSchema>;

// Table for subscriptions (yearly course access)
export const subscriptions = pgTable("subscriptions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  plan: text("plan", { enum: ["courses_yearly"] }).notNull().default("courses_yearly"),
  status: text("status", { enum: ["active", "expired", "canceled", "pending"] }).notNull().default("pending"),
  currentPeriodStart: timestamp("current_period_start", { mode: 'date', withTimezone: true }),
  currentPeriodEnd: timestamp("current_period_end", { mode: 'date', withTimezone: true }),
  provider: text("provider", { enum: ["onramp", "wallet"] }).notNull().default("onramp"),
  providerOrderId: text("provider_order_id"),
  txHash: text("tx_hash"),
  amountUsdc: text("amount_usdc"),
  metadata: jsonb("metadata").default({}),
  createdAt: timestamp("created_at", { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: 'date', withTimezone: true }).defaultNow().notNull(),
});

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;

// Table for subscription events (audit log)
export const subscriptionEvents = pgTable("subscription_events", {
  id: serial("id").primaryKey(),
  subscriptionId: integer("subscription_id").notNull().references(() => subscriptions.id, { onDelete: 'cascade' }),
  eventType: text("event_type", { enum: ["created", "renewed", "canceled", "expired"] }).notNull(),
  metadata: jsonb("metadata").default({}),
  createdAt: timestamp("created_at", { mode: 'date', withTimezone: true }).defaultNow().notNull(),
});

export type SubscriptionEvent = typeof subscriptionEvents.$inferSelect;
export type NewSubscriptionEvent = typeof subscriptionEvents.$inferInsert;

// =====================================================
// REFERRAL SYSTEM TABLES
// =====================================================

// Referral codes table
export const referralCodes = pgTable("referral_codes", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  code: text("code").notNull().unique(), // e.g., "DINESH2025"
  createdAt: timestamp("created_at", { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  isActive: boolean("is_active").default(true).notNull(),
});

export type ReferralCode = typeof referralCodes.$inferSelect;
export type NewReferralCode = typeof referralCodes.$inferInsert;

// Referral status enum
export const ReferralStatus = {
  PENDING: 'pending',       // User signed up but hasn't subscribed
  CONVERTED: 'converted',   // User subscribed, rewards calculated
  REWARDED: 'rewarded',     // Rewards distributed to referrer
} as const;

// Referrals tracking table
export const referrals = pgTable("referrals", {
  id: serial("id").primaryKey(),
  referrerId: integer("referrer_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  referredId: integer("referred_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  referralCodeId: integer("referral_code_id").references(() => referralCodes.id),
  subscriptionId: integer("subscription_id").references(() => subscriptions.id),
  status: text("status", { enum: ["pending", "converted", "rewarded"] }).default("pending").notNull(),
  usdcReward: decimal("usdc_reward", { precision: 10, scale: 6 }).default("0"),
  roxnReward: decimal("roxn_reward", { precision: 18, scale: 8 }).default("0"),
  createdAt: timestamp("created_at", { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  convertedAt: timestamp("converted_at", { mode: 'date', withTimezone: true }),
  rewardedAt: timestamp("rewarded_at", { mode: 'date', withTimezone: true }),
});

export type Referral = typeof referrals.$inferSelect;
export type NewReferral = typeof referrals.$inferInsert;

// Referral rewards ledger (for tracking individual reward payments)
export const referralRewards = pgTable("referral_rewards", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  referralId: integer("referral_id").references(() => referrals.id),
  rewardType: text("reward_type", { enum: ["usdc", "roxn"] }).notNull(),
  amount: decimal("amount", { precision: 18, scale: 8 }).notNull(),
  status: text("status", { enum: ["pending", "processing", "paid", "failed"] }).default("pending").notNull(),
  transactionHash: text("transaction_hash"),
  createdAt: timestamp("created_at", { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  paidAt: timestamp("paid_at", { mode: 'date', withTimezone: true }),
});

export type ReferralReward = typeof referralRewards.$inferSelect;
export type NewReferralReward = typeof referralRewards.$inferInsert;

// Referral validation schemas
export const createReferralCodeSchema = z.object({
  code: z.string()
    .min(3, "Code must be at least 3 characters")
    .max(20, "Code must be at most 20 characters")
    .regex(/^[A-Z0-9_-]+$/i, "Code can only contain letters, numbers, underscores, and hyphens"),
});

export type CreateReferralCode = z.infer<typeof createReferralCodeSchema>;

export const applyReferralCodeSchema = z.object({
  code: z.string().min(1, "Referral code is required"),
});

export type ApplyReferralCode = z.infer<typeof applyReferralCodeSchema>;

// Referral stats interface (for API responses)
export interface ReferralStats {
  totalReferrals: number;
  pendingReferrals: number;
  convertedReferrals: number;
  totalUsdcEarned: string;
  totalRoxnEarned: string;
  pendingUsdcReward: string;
  pendingRoxnReward: string;
}

// Leaderboard entry interface
export interface LeaderboardEntry {
  rank: number;
  username: string;  // Masked for privacy
  referrals: number;
  earned: string;
}

// =====================================================
// PAYOUT REQUESTS TABLE (Manual Admin Review)
// =====================================================

// Payout request status enum
export const PayoutRequestStatus = {
  PENDING: 'pending',     // User requested payout
  APPROVED: 'approved',   // Admin approved
  REJECTED: 'rejected',   // Admin rejected
  PAID: 'paid',           // Admin sent payment
} as const;

// Payout requests table
export const payoutRequests = pgTable("payout_requests", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  usdcAmount: decimal("usdc_amount", { precision: 10, scale: 6 }).notNull(),
  roxnAmount: decimal("roxn_amount", { precision: 18, scale: 8 }).notNull(),
  walletAddress: text("wallet_address").notNull(),
  status: text("status", { enum: ["pending", "approved", "rejected", "paid"] }).default("pending").notNull(),
  adminNotes: text("admin_notes"),
  usdcTxHash: text("usdc_tx_hash"),
  roxnTxHash: text("roxn_tx_hash"),
  createdAt: timestamp("created_at", { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  reviewedAt: timestamp("reviewed_at", { mode: 'date', withTimezone: true }),
  paidAt: timestamp("paid_at", { mode: 'date', withTimezone: true }),
});

export type PayoutRequest = typeof payoutRequests.$inferSelect;
export type NewPayoutRequest = typeof payoutRequests.$inferInsert;

// Payout request interface for API responses
export interface PayoutRequestInfo {
  id: number;
  usdcAmount: string;
  roxnAmount: string;
  status: string;
  createdAt: Date;
  paidAt?: Date;
  usdcTxHash?: string;
  roxnTxHash?: string;
}

// Promotional bounties - linked to registered repos
export const promotionalBounties = pgTable("promotional_bounties", {
  id: serial("id").primaryKey(),
  repoId: integer("repo_id").notNull().references(() => registeredRepositories.id, { onDelete: 'cascade' }),
  creatorId: integer("creator_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text("type", { enum: ["CODE", "PROMOTIONAL"] }).notNull().default("PROMOTIONAL"),
  status: text("status", { enum: ["DRAFT", "ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"] }).notNull().default("DRAFT"),
  title: text("title").notNull(),
  description: text("description").notNull(),
  promotionalChannels: jsonb("promotional_channels").notNull().default([]),
  requiredDeliverable: text("required_deliverable"),
  rewardAmount: decimal("reward_amount", { precision: 18, scale: 8 }).notNull(),
  rewardType: text("reward_type", { enum: ["PER_SUBMISSION", "POOL", "TIERED"] }).notNull().default("PER_SUBMISSION"),
  maxSubmissions: integer("max_submissions"),
  totalRewardPool: decimal("total_reward_pool", { precision: 18, scale: 8 }),
  campaignId: text("campaign_id"),
  expiresAt: timestamp("expires_at", { mode: 'date', withTimezone: true }),
  createdAt: timestamp("created_at", { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: 'date', withTimezone: true }).defaultNow().notNull(),
});

export type PromotionalBounty = typeof promotionalBounties.$inferSelect;
export type NewPromotionalBounty = typeof promotionalBounties.$inferInsert;

export const promotionalSubmissions = pgTable("promotional_submissions", {
  id: serial("id").primaryKey(),
  bountyId: integer("bounty_id").notNull().references(() => promotionalBounties.id, { onDelete: 'cascade' }),
  contributorId: integer("contributor_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: text("status", { enum: ["PENDING", "APPROVED", "REJECTED"] }).notNull().default("PENDING"),
  proofLinks: jsonb("proof_links").notNull().default([]),
  description: text("description"),
  reviewedAt: timestamp("reviewed_at", { mode: 'date', withTimezone: true }),
  reviewedBy: integer("reviewed_by").references(() => users.id),
  reviewNotes: text("review_notes"),
  createdAt: timestamp("created_at", { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: 'date', withTimezone: true }).defaultNow().notNull(),
});

export type PromotionalSubmission = typeof promotionalSubmissions.$inferSelect;
export type NewPromotionalSubmission = typeof promotionalSubmissions.$inferInsert;

export const createPromotionalBountySchema = z.object({
  repoId: z.number().int().positive(),
  type: z.enum(["CODE", "PROMOTIONAL"]).default("PROMOTIONAL"),
  title: z.string().min(1, "Title is required"),
  description: z.string().min(10, "Description must be at least 10 characters"),
  promotionalChannels: z.array(z.string()).min(1, "Select at least one channel"),
  requiredDeliverable: z.string().min(1, "Required deliverable is required"),
  rewardAmount: z.string().min(1, "Reward amount is required"),
  rewardType: z.enum(["PER_SUBMISSION", "POOL", "TIERED"]).default("PER_SUBMISSION"),
  maxSubmissions: z.number().int().positive().optional(),
  totalRewardPool: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
});

export type CreatePromotionalBountyInput = z.infer<typeof createPromotionalBountySchema>;

export const createPromotionalSubmissionSchema = z.object({
  bountyId: z.number().int().positive(),
  proofLinks: z.array(z.string().url("Must be a valid URL")).min(1, "At least one proof link is required").max(10, "Maximum 10 proof links allowed"),
  description: z.string().optional(),
});

export type CreatePromotionalSubmissionInput = z.infer<typeof createPromotionalSubmissionSchema>;

// Bounty requests table for GitHub issue comments
export const bountyRequests = pgTable("bounty_requests", {
  id: serial("id").primaryKey(),
  githubRepoId: text("github_repo_id").notNull(),
  githubIssueId: text("github_issue_id").notNull(),
  githubIssueNumber: integer("github_issue_number").notNull(),
  githubIssueUrl: text("github_issue_url").notNull(),
  requestedBy: text("requested_by").notNull(), // GitHub username
  suggestedAmount: text("suggested_amount"), // Optional
  suggestedCurrency: text("suggested_currency"), // XDC, ROXN, USDC
  status: text("status").default("pending").notNull(), // pending, approved, rejected
  createdAt: timestamp("created_at", { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  processedAt: timestamp("processed_at", { mode: 'date', withTimezone: true }),
  processedBy: integer("processed_by").references(() => users.id),
});

export type BountyRequest = typeof bountyRequests.$inferSelect;
export type NewBountyRequest = typeof bountyRequests.$inferInsert;
