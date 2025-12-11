import { Express } from 'express';
import blockchainRoutes from './blockchainRoutes';
import subscriptionRoutes from './subscriptionRoutes';
import repositoryRoutes from './repositoryRoutes';
import aiRoutes from './aiRoutes';
import webhookRoutes from './webhookRoutes';
import adminRoutes from './adminRoutes';
import nodeRoutes from './nodeRoutes';
import authRoutes from './authRoutes';
import miscRoutes from './miscRoutes';
import referralRoutes from './referralRoutes';
import promotionalBountiesRoutes from './promotionalBounties';
import walletRoutes from './walletRoutes';
import multiCurrencyWalletRoutes from './multiCurrencyWallet';
import aiScopingAgentRouter from './aiScopingAgent';

/**
 * Register all modular route handlers
 * This centralizes route registration for better organization
 */
export function registerModularRoutes(app: Express) {
  // Blockchain routes
  app.use('/api/blockchain', blockchainRoutes);

  // Subscription routes
  app.use('/api/subscription', subscriptionRoutes);

  // Repository and GitHub routes
  app.use('/api', repositoryRoutes);

  // VSCode AI and Profile routes
  app.use('/', aiRoutes); // Routes are already prefixed with /api/vscode or /vscode

  // Webhook routes
  app.use('/', webhookRoutes); // Routes are already prefixed with /api/webhook or /webhook

  // Admin routes
  app.use('/api', adminRoutes); // Routes are prefixed with /admin/*

  // Node routes
  app.use('/api', nodeRoutes); // Routes are prefixed with /node/* or /nodes/*

  // Auth routes
  app.use('/api', authRoutes); // Routes are prefixed with /auth/*

  // Miscellaneous routes (health, zoho, courses, token, user, submit-assignment)
  app.use('/', miscRoutes); // Routes are prefixed with /health, /api/zoho, /api/courses, etc.

  // Wallet routes (main wallet operations)
  app.use('/api/wallet', walletRoutes);
  
  // Multi-currency wallet routes (additional wallet features)
  app.use('/api/wallet', multiCurrencyWalletRoutes);

  // Referral routes (already modular)
  app.use('/api/referral', referralRoutes);

  // Promotional Bounties routes (already modular)
  app.use('/api/promotional', promotionalBountiesRoutes);

  // AI Scoping Agent routes (already modular)
  app.use('/api/ai-scoping', aiScopingAgentRouter);
}

