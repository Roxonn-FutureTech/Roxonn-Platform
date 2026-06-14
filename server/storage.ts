import { users, registeredRepositories, bountyRequests, communityBounties, webhookDeliveries, payouts, bountyAttempts, issueComments, platformFlags } from "../shared/schema";
import type { NewPayout, Payout } from "../shared/schema";
import { eq, and, sql, inArray, desc } from "drizzle-orm";
import { db } from "./db";
import session from "express-session";
import connectPg from "connect-pg-simple";
import pkg from 'pg';
import { blockchain } from './blockchain';
import { log } from './utils';
import { getWalletMnemonic, getWalletPrivateKey } from './tatum';
import { storeWalletSecret } from './aws';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { pipeline } from 'stream/promises';
import fs from 'fs';
import { sendLedgerFailureAlert } from './email';
const { Pool } = pkg;

// Create a separate pool for session store
const sessionPool = new Pool({
  connectionString: config.databaseUrl,
  ssl: {
    // For AWS RDS connections, we need to disable certificate verification
    // while still maintaining encryption. AWS RDS certificates often have
    // self-signed certificates in their chain, causing connection issues.
    rejectUnauthorized: false
  }
});

const PostgresSessionStore = connectPg(session);

const LOG_INTERVAL = 5000; // 5 seconds

export interface IStorage {
  getUser(id: number): Promise<any | undefined>;
  getUserByUsername(username: string): Promise<any | undefined>;
  getUserByGithubId(githubId: string): Promise<any | undefined>;
  createUser(user: any): Promise<any>;
  updateUser(id: number, data: any): Promise<any>;
  updateProfile(userId: number, profile: any): Promise<any>;
  getWallet(userId: string): Promise<{ address: string; walletReferenceId: string } | null>;
  sessionStore: session.Store;
  getUserById(userId: number): Promise<any>;
  updateUserTokenBalance(userId: number, amount: number): Promise<any>;
  findRegisteredRepository(userId: number, githubRepoId: string): Promise<any | null>;
  getRegisteredRepositoriesByUser(userId: number): Promise<any[]>;
  getAllPublicRepositories(): Promise<any[]>;
  getAllRegisteredRepositories(): Promise<any[]>;
  findRegisteredRepositoryByGithubId(githubRepoId: string): Promise<any | null>;
  getPublicRepositoryById(repoId: number): Promise<any | null>;
  findRepositoryByFullName(fullName: string): Promise<any | null>;
  addOrUpdateInstallationRepo(installationId: string, githubRepoId: string, githubRepoFullName: string): Promise<any>;
  associateUserToInstallationRepo(userId: number, githubRepoId: string, installationId: string): Promise<any>;
  removeRegistrationFromWebhook(installationId: string, githubRepoIds: string[]): Promise<void>;
  registerRepositoryDirectly(userId: number, githubRepoId: string, githubRepoFullName: string, installationId?: string, isPrivate?: boolean): Promise<any>;
  adjustUserPromptBalance(drizzleTx: any, userId: number, promptsToChange: number, type: string, notes?: string, onrampOrderId?: string): Promise<{ success: boolean; newBalance?: number; error?: string }>;
  getUserPromptBalance(userId: number): Promise<number>;
  updateRepositoryVisibility(githubRepoId: string, isPrivate: boolean): Promise<boolean>;
  updateRepositoryActiveStatus(githubRepoId: string, isActive: boolean): Promise<boolean>;
}

// Define PromptTransactionType enum locally if not imported from a shared types file
type PromptTransactionType = 'purchase' | 'usage_vscode_ai' | 'admin_adjustment' | 'initial_grant';


export class DatabaseStorage implements IStorage {
  sessionStore: session.Store;

  constructor() {
    this.sessionStore = new PostgresSessionStore({
      pool: sessionPool,
      createTableIfMissing: true,
      tableName: 'session',
      pruneSessionInterval: 60 * 15, // Prune expired sessions every 15 minutes
    });
  }

  async getUser(id: number): Promise<any | undefined> {
    try {
      const user = await db.query.users.findFirst({
        where: eq(users.id, id),
      });
      return user;
    } catch (error) {
      console.error(`Error getting user by ID ${id}:`, error);
      throw error;
    }
  }

  async getUserByUsername(username: string): Promise<any | undefined> {
    try {
      const user = await db.query.users.findFirst({
        where: eq(users.username, username),
      });
      return user;
    } catch (error) {
      console.error("Error getting user by username: %s", username, error);
      throw error;
    }
  }

  async getUserByGithubId(githubId: string): Promise<any | undefined> {
    try {
      const user = await db.query.users.findFirst({
        where: eq(users.githubId, githubId),
      });
      return user;
    } catch (error) {
      console.error("Error getting user by GitHub ID: %s", githubId, error);
      throw error;
    }
  }

  async getUserByWalletAddress(walletAddress: string): Promise<any | undefined> {
    try {
      const user = await db.query.users.findFirst({
        where: eq(users.xdcWalletAddress, walletAddress),
      });
      return user;
    } catch (error) {
      console.error("Error getting user by wallet address:", error);
      throw error;
    }
  }

  async createUser(
    userData: any,
  ): Promise<any> {
    try {
      
      const [user] = await db
        .insert(users)
        .values({
          ...userData,
          isProfileComplete: false,
        })
        .returning();

      
      return user;
    } catch (error) {
      console.error("Error creating user:", error);
      throw error;
    }
  }

  async updateUser(id: number, data: any): Promise<any> {
    try {
      log(`Updating user: ${id}`, 'storage');
      
      // Create a copy of data that we'll update
      const updatedData = { ...data };
      
      // Handle wallet data with KMS if present
      if (data.xdcWalletMnemonic || data.xdcPrivateKey) {
        // Generate a wallet reference ID if one doesn't exist
        if (!updatedData.walletReferenceId) {
          updatedData.walletReferenceId = uuidv4();
        }
        
        // Store sensitive data with KMS
        if (data.xdcWalletMnemonic && data.xdcPrivateKey) {
          await storeWalletSecret(updatedData.walletReferenceId, {
            mnemonic: data.xdcWalletMnemonic,
            privateKey: data.xdcPrivateKey
          });
          
          // Remove sensitive data from the database update
          delete updatedData.xdcWalletMnemonic;
          delete updatedData.xdcPrivateKey;
          
          log(`Stored wallet data securely with KMS for user: ${id}`, 'storage');
        }
      }

      const [user] = await db
        .update(users)
        .set(updatedData)
        .where(eq(users.id, id))
        .returning();

      log(`User updated successfully: ${user.id}`, 'storage');
      return user;
    } catch (error) {
      log(`Error updating user: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      throw error;
    }
  }

  async updateProfile(userId: number, profile: any): Promise<any> {
    try {
      
      const [user] = await db
        .update(users)
        .set({
          ...profile,
          isProfileComplete: true,
        })
        .where(eq(users.id, userId))
        .returning();

      
      return user;
    } catch (error) {
      console.error("Error updating profile:", error);
      throw error;
    }
  }

  async getWallet(userId: string): Promise<{ address: string; walletReferenceId: string } | null> {
    try {
      log(`Getting wallet for user: ${userId}`, 'storage');
      const user = await db.query.users.findFirst({
        where: eq(users.id, parseInt(userId, 10)),
        columns: {
          xdcWalletAddress: true,
          walletReferenceId: true
        }
      });

      if (!user || !user.xdcWalletAddress || !user.walletReferenceId) {
        log(`No wallet found for user: ${userId}`, 'storage');
        return null;
      }

      log(`Wallet found for user: ${userId}`, 'storage');
      return {
        address: user.xdcWalletAddress,
        walletReferenceId: user.walletReferenceId
      };
    } catch (error) {
      log(`Error getting wallet: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      throw error;
    }
  }

  async getUserByGithubUsername(username: string) {
    try {
      
      const user = await db.query.users.findFirst({
        where: eq(users.githubUsername, username)
      });
      
      return user || null;
    } catch (error) {
      console.error("Error getting user by GitHub username:", error);
      throw error;
    }
  }

  async getRepositoryPoolManager(repoId: number) {
    try {
      // Get pool managers from blockchain
      const repo = await blockchain.getRepository(repoId); // repo is UnifiedPoolInfo | null
      
      // Safely check if repo and repo.poolManagers exist and if the array is not empty
      if (repo && repo.poolManagers && repo.poolManagers.length > 0) {
        // Get the first pool manager's address
        const managerAddress = repo.poolManagers[0];
        log(`Looking for pool manager with address: ${managerAddress} for repoId ${repoId}`, 'storage');
        
        // Convert ETH address (0x) to XDC format for comparison
        const xdcAddress = 'xdc' + managerAddress.slice(2).toLowerCase();
        log(`Converted to XDC address for comparison: ${xdcAddress} for repoId ${repoId}`, 'storage');
        
        // Find this manager in our database
        const user = await db.query.users.findFirst({
          where: eq(users.xdcWalletAddress, xdcAddress) // Ensure this matches the exact stored format
        });
        
        if (user) {
          log(`Found pool manager in DB: User ID ${user.id}, Address: ${user.xdcWalletAddress}, Role: ${user.role} for repoId ${repoId}`, 'storage');
          return user; // Return the found user
        } else {
          log(`No user found in DB matching on-chain pool manager address ${managerAddress} (XDC: ${xdcAddress}) for repoId ${repoId}.`, 'storage');
          // Optionally, log all DB pool managers for debugging if needed, but be mindful of log size.
          // const allDbPoolManagers = await db.query.users.findMany({ where: eq(users.role, 'poolmanager'), columns: { id: true, xdcWalletAddress: true, role: true } });
          // log(`All pool managers in DB: ${JSON.stringify(allDbPoolManagers)}`, 'storage-debug');
          return null;
        }
      }
      log(`No pool managers found on-chain for repoId ${repoId}, or repo data from blockchain was incomplete (repo.poolManagers was ${repo?.poolManagers}).`, 'storage');
      return null;
    } catch (error) {
      console.error('Error getting repository pool manager for repoId:', String(repoId), error);
      throw error;
    }
  }

  async getUserById(userId: number): Promise<any> {
    try {
      log(`Getting user by ID: ${userId}`, 'storage');
      const user = await db.query.users.findFirst({
        where: eq(users.id, userId),
      });

      if (!user) {
        log(`No user found with ID: ${userId}`, 'storage');
        return null;
      }

      log(`User found with ID: ${userId}`, 'storage');
      return user;
    } catch (error) {
      log(`Error getting user by ID: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      throw error;
    }
  }

  async updateUserTokenBalance(userId: number, amount: number): Promise<any> {
    try {
      log(`Updating token balance for user ID: ${userId} by ${amount}`, 'storage');
      
      // Get current user
      const user = await this.getUserById(userId);
      if (!user) {
        throw new Error(`User with ID ${userId} not found`);
      }
      
      // Calculate new balance
      const currentBalance = user.tokenBalance || 0;
      const newBalance = currentBalance + amount;
      
      if (newBalance < 0) {
        throw new Error(`Insufficient token balance. Current: ${currentBalance}, Requested: ${Math.abs(amount)}`);
      }
      
      // Update user with new balance
      const updatedUser = await this.updateUser(userId, {
        tokenBalance: newBalance
      });
      
      log(`Token balance updated for user ID: ${userId}. New balance: ${newBalance}`, 'storage');
      return updatedUser;
    } catch (error) {
      log(`Error updating user token balance: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      throw error;
    }
  }

  async findRegisteredRepository(userId: number, githubRepoId: string): Promise<any | null> {
    try {
      log(`Checking registration for repo ${githubRepoId} and user ${userId}`, 'storage');
      const registration = await db.query.registeredRepositories.findFirst({
        where: and(
          eq(registeredRepositories.userId, userId),
          eq(registeredRepositories.githubRepoId, githubRepoId)
        ),
      });
      log(`Registration check result: ${registration ? 'Found' : 'Not Found'}`, 'storage');
      return registration || null;
    } catch (error) {
      log(`Error finding registered repository: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      throw error;
    }
  }

  async getRegisteredRepositoriesByUser(userId: number): Promise<any[]> {
    try {
      log(`Fetching registered repositories for user ${userId}`, 'storage');
      const registrations = await db.query.registeredRepositories.findMany({
        where: eq(registeredRepositories.userId, userId),
        orderBy: (repo, { desc }) => [desc(repo.registeredAt)], // Optional: order by most recent
      });
      log(`Found ${registrations.length} registered repositories for user ${userId}`, 'storage');
      return registrations;
    } catch (error) {
      log(`Error fetching registered repositories: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      throw error;
    }
  }

  async getAllPublicRepositories(): Promise<any[]> {
    try {
      log('Fetching all public registered repositories', 'storage');
      const registrations = await db.query.registeredRepositories.findMany({
        where: (repo, { eq, or }) => or(
          eq(repo.isPrivate, false),
          sql`${repo.isPrivate} IS NULL` // Handle legacy repos without isPrivate flag
        ),
        orderBy: (repo, { desc }) => [desc(repo.registeredAt)], // Optional ordering
        // Consider adding columns needed for public display, e.g., joining with users for PM username?
        columns: {
            id: true,
            githubRepoId: true,
            githubRepoFullName: true,
            registeredAt: true,
            isActive: true,
            // Explicitly exclude userId if not needed for public view
        }
      });
      log(`Found ${registrations.length} public registered repositories`, 'storage');
      return registrations;
    } catch (error) {
      log(`Error fetching public registered repositories: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      throw error;
    }
  }

  async getAllRegisteredRepositories(): Promise<any[]> {
    try {
      log('Fetching all registered repositories (public and private)', 'storage');
      const registrations = await db.query.registeredRepositories.findMany({
        orderBy: (repo, { desc }) => [desc(repo.registeredAt)],
        columns: {
            id: true,
            githubRepoId: true,
            githubRepoFullName: true,
            registeredAt: true,
            isPrivate: true,
            isActive: true,
            installationId: true,
        }
      });
      log(`Found ${registrations.length} total registered repositories`, 'storage');
      return registrations;
    } catch (error) {
      log(`Error fetching all registered repositories: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      throw error;
    }
  }

  async findRegisteredRepositoryByGithubId(githubRepoId: string): Promise<any | null> {
    try {
      log(`Checking registration for repo ID ${githubRepoId}`, 'storage');
      const registration = await db.query.registeredRepositories.findFirst({
        where: eq(registeredRepositories.githubRepoId, githubRepoId)
      });
      log(`Registration check by ID result: ${registration ? 'Found' : 'Not Found'}`, 'storage');
      return registration || null;
    } catch (error) {
      log(`Error finding registered repository by ID: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      throw error;
    }
  }

  /**
   * Update repository visibility (public/private)
   * Called when GitHub sends repository visibility change webhook
   */
  async updateRepositoryVisibility(githubRepoId: string, isPrivate: boolean): Promise<boolean> {
    try {
      log(`Updating visibility for repo ${githubRepoId} to isPrivate=${isPrivate}`, 'storage');
      const result = await db.update(registeredRepositories)
        .set({ isPrivate })
        .where(eq(registeredRepositories.githubRepoId, githubRepoId))
        .returning({ id: registeredRepositories.id });

      const updated = result.length > 0;
      log(`Repository visibility update result: ${updated ? 'Updated' : 'Not found'}`, 'storage');
      return updated;
    } catch (error) {
      log(`Error updating repository visibility: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      throw error;
    }
  }

  /**
   * Update repository active status
   * Used by pool managers to mark repos they're actively working on
   */
  async updateRepositoryActiveStatus(githubRepoId: string, isActive: boolean): Promise<boolean> {
    try {
      log(`Updating active status for repo ${githubRepoId} to isActive=${isActive}`, 'storage');
      const result = await db.update(registeredRepositories)
        .set({ isActive })
        .where(eq(registeredRepositories.githubRepoId, githubRepoId))
        .returning({ id: registeredRepositories.id });

      const updated = result.length > 0;
      log(`Repository active status update result: ${updated ? 'Updated' : 'Not found'}`, 'storage');
      return updated;
    } catch (error) {
      log(`Error updating repository active status: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      throw error;
    }
  }

  /**
   * Get a repository by ID for public access
   * This is used for public API endpoints that don't require authentication
   */
  async getPublicRepositoryById(repoId: number): Promise<any | null> {
    try {
      log(`Fetching public repository data for ID ${repoId}`, 'storage');
      const registration = await db.query.registeredRepositories.findFirst({
        where: (repo, { and, eq, or }) => and(
          eq(repo.githubRepoId, repoId.toString()),
          or(
            eq(repo.isPrivate, false),
            sql`${repo.isPrivate} IS NULL` // Handle legacy repos
          )
        ),
        columns: {
          id: true,
          githubRepoId: true,
          githubRepoFullName: true,
          registeredAt: true,
          installationId: true,
          isActive: true
        }
      });
      log(`Public repository fetch result: ${registration ? 'Found' : 'Not Found'}`, 'storage');
      return registration || null;
    } catch (error) {
      log(`Error fetching public repository by ID: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      throw error;
    }
  }
  
  /**
   * Find a repository by its full name (owner/repo format)
   * This is used for public API endpoints that access GitHub issues
   */
  async findRepositoryByFullName(fullName: string): Promise<any | null> {
    try {
      log(`Finding repository by full name: ${fullName}`, 'storage');
      const registration = await db.query.registeredRepositories.findFirst({
        where: eq(registeredRepositories.githubRepoFullName, fullName),
        columns: {
          id: true,
          githubRepoId: true,
          githubRepoFullName: true,
          installationId: true,
          isPrivate: true
        }
      });
      log(`Repository by full name result: ${registration ? 'Found' : 'Not Found'}`, 'storage');
      return registration || null;
    } catch (error) {
      log(`Error finding repository by full name: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      throw error;
    }
  }

  // Simplified function called by webhook - inserts or updates installId
  async addOrUpdateInstallationRepo(installationId: string, githubRepoId: string, githubRepoFullName: string): Promise<any> {
      try {
          log(`Webhook: Recording installationId ${installationId} for repo ${githubRepoFullName} (${githubRepoId})`, 'storage');
          
          // Check if the repository already exists
          const existingRepo = await this.findRegisteredRepositoryByGithubId(githubRepoId);
          
          if (existingRepo) {
              // Update existing repository record with new installation ID
              const [updatedRow] = await db.update(registeredRepositories)
                  .set({ installationId: installationId })
                  .where(eq(registeredRepositories.githubRepoId, githubRepoId))
                  .returning();
              
              log(`Webhook: Updated existing repository record for ${githubRepoFullName}`, 'storage');
              return updatedRow;
          } else {
              // Insert new repository record - without specifying userId at all
              // This will only work if userId is optional in the schema
              const [resultRow] = await db.insert(registeredRepositories)
                  .values({
                      githubRepoId: githubRepoId,
                      githubRepoFullName: githubRepoFullName,
                      installationId: installationId,
                      registeredAt: new Date()
                  })
                  .returning();
              
              log(`Webhook: Inserted new repository record for ${githubRepoFullName}`, 'storage');
              return resultRow;
          }
      } catch (error) {
          log(`Error inserting installation repo: ${error instanceof Error ? error.message : String(error)}`, 'storage');
          throw error;
      }
  }
  
  async associateUserToInstallationRepo(userId: number, githubRepoId: string, installationId: string): Promise<any> {
    try {
      log(`Associating userId ${userId} to repoId ${githubRepoId} for installId ${installationId}`, 'storage');
      
      const updateResult = await db.update(registeredRepositories)
        .set({ 
          userId: userId, // Set the user ID
          installationId: installationId // Ensure installation ID is also set/updated
        })
        .where(eq(registeredRepositories.githubRepoId, githubRepoId))
        .returning();
        
      if (!updateResult || updateResult.length === 0) {
        // This should ideally not happen if the webhook created the record first
        log(`Warning/Error: No record found for githubRepoId ${githubRepoId} during user association.`, 'storage');
        // Optionally insert here if we want to handle the case where webhook failed?
        // For now, throw error or return null
        throw new Error(`Repository with GitHub ID ${githubRepoId} not found for association.`);
      }
      
      const resultRow = updateResult[0];
      log(`Association successful for repoId ${githubRepoId}, record ID ${resultRow.id}`, 'storage');
      return resultRow;
    } catch (error) {
      log(`Error associating user to installation repo: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      throw error;
    }
  }

  async removeRegistrationFromWebhook(installationId: string, githubRepoIds: string[]): Promise<void> {
    try {
      if (!githubRepoIds || githubRepoIds.length === 0) {
        log('Webhook remove: No repo IDs provided, nothing to remove.', 'storage');
        return;
      }
      log(`Webhook remove: Removing registrations for installId=${installationId}, repoIds=${githubRepoIds.join(', ')}`, 'storage');
      
      await db.delete(registeredRepositories)
        .where(and(
          eq(registeredRepositories.installationId, installationId),
          inArray(registeredRepositories.githubRepoId, githubRepoIds)
        ));
      
      log(`Webhook remove: Delete operation attempted for installId=${installationId}, repoIds=${githubRepoIds.join(', ')}`, 'storage');
    } catch (error) {
      log(`Error removing registration from webhook: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      throw error;
    }
  }

  // NEW FUNCTION: Register repository with user ID in a single step
  async registerRepositoryDirectly(
    userId: number,
    githubRepoId: string,
    githubRepoFullName: string,
    installationId: string = "direct-registration", // Default for backward compatibility
    isPrivate: boolean = false // Default to false for backward compatibility
  ): Promise<any> {
      try {
          log(`Directly registering repository ${githubRepoFullName} (${githubRepoId}) for user ${userId} with installation ${installationId}, private: ${isPrivate}`, 'storage');

          // Insert with both installation ID and user ID immediately
          const [resultRow] = await db.insert(registeredRepositories)
              .values({
                  userId: userId,
                  githubRepoId: githubRepoId,
                  githubRepoFullName: githubRepoFullName,
                  installationId: installationId, // Use the provided installation ID
                  isPrivate: isPrivate, // Store private flag
                  registeredAt: new Date()
              })
              .returning();

          log(`Successfully registered repository ${githubRepoFullName} for user ${userId}`, 'storage');
          return resultRow;
      } catch (error) {
          log(`Error directly registering repository: ${error instanceof Error ? error.message : String(error)}`, 'storage');
          throw error;
      }
  }

  async adjustUserPromptBalance(
    drizzleTx: any, // Should be: NodePgDatabase<typeof import('../shared/schema')> or similar Drizzle transaction type
    userId: number,
    promptsToChange: number,
    type: PromptTransactionType,
    notes?: string,
    onrampOrderId?: string
  ): Promise<{ success: boolean; newBalance?: number; error?: string }> {
    // Import promptTransactions schema if not already available
    const schema = await import("../shared/schema"); // Import all schemas

    const userRecord = await drizzleTx.query.users.findFirst({ // Use original 'users' from schema
      where: eq(schema.users.id, userId), // Qualify with schema.users
      columns: { promptBalance: true }
    });

    if (!userRecord) {
      log(`adjustUserPromptBalance: User ${userId} not found.`, 'prompt-storage-ERROR');
      return { success: false, error: 'User not found' };
    }
    
    const currentBalance = userRecord.promptBalance ?? 0;
    const newBalance = currentBalance + promptsToChange;

    if (newBalance < 0) {
      log(`adjustUserPromptBalance: Insufficient prompts for user ${userId}. Current: ${currentBalance}, Change: ${promptsToChange}`, 'prompt-storage-ERROR');
      return { success: false, error: 'Insufficient prompts for deduction' };
    }

    // Update user's promptBalance
    await drizzleTx.update(schema.users) // Use original 'users' from schema
      .set({ promptBalance: newBalance })
      .where(eq(schema.users.id, userId));

    // Insert into promptTransactions ledger
    await drizzleTx.insert(schema.promptTransactions).values({ // Use original 'promptTransactions' from schema
      userId,
      transactionType: type,
      promptsChanged: promptsToChange, // Corrected variable name
      balanceAfterTx: newBalance,
      notes,
      onrampOrderId,
      // createdAt will be set by default by the DB
    });
    
    log(`User ${userId} prompt balance adjusted by ${promptsToChange} for ${type}. New balance: ${newBalance}`, 'prompt-storage');
    return { success: true, newBalance };
  }

  async getUserPromptBalance(userId: number): Promise<number> {
    // No need to re-import schema here if it's already available via 'this' or module scope
    // Assuming 'users' is available from the top-level import of this file
    const user = await db.query.users.findFirst({ // Use original 'users'
      where: eq(users.id, userId), // Use original 'users'
      columns: { promptBalance: true }
    });
    const balance = user?.promptBalance ?? 0;
    log(`Fetched prompt balance for user ${userId}: ${balance}`, 'prompt-storage');
    return balance;
  }

  // Bounty request methods
  async createBountyRequest(data: {
    githubRepoId: string;
    githubIssueId: string;
    githubIssueNumber: number;
    githubIssueUrl: string;
    requestedBy: string;
    suggestedAmount?: string | null;
    suggestedCurrency?: string | null;
  }): Promise<any> {
    try {
      log(`Creating bounty request for issue ${data.githubIssueNumber} in repo ${data.githubRepoId}`, 'storage');
      const [request] = await db.insert(bountyRequests).values({
        githubRepoId: data.githubRepoId,
        githubIssueId: data.githubIssueId,
        githubIssueNumber: data.githubIssueNumber,
        githubIssueUrl: data.githubIssueUrl,
        requestedBy: data.requestedBy,
        suggestedAmount: data.suggestedAmount || null,
        suggestedCurrency: data.suggestedCurrency || null,
        status: 'pending',
      }).returning();
      log(`Bounty request created with ID ${request.id}`, 'storage');
      return request;
    } catch (error) {
      log(`Error creating bounty request: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      throw error;
    }
  }

  async getBountyRequestsByIssue(githubRepoId: string, githubIssueId: string): Promise<any[]> {
    try {
      const requests = await db.select()
        .from(bountyRequests)
        .where(and(
          eq(bountyRequests.githubRepoId, githubRepoId),
          eq(bountyRequests.githubIssueId, githubIssueId)
        ))
        .orderBy(desc(bountyRequests.createdAt));
      return requests;
    } catch (error) {
      log(`Error fetching bounty requests: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      return [];
    }
  }

  async getBountyRequest(id: number): Promise<any | null> {
    try {
      const [request] = await db.select()
        .from(bountyRequests)
        .where(eq(bountyRequests.id, id))
        .limit(1);
      return request || null;
    } catch (error) {
      log(`Error fetching bounty request: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      return null;
    }
  }

  async updateBountyRequest(id: number, data: {
    status?: string;
    processedBy?: number;
    processedAt?: Date;
  }): Promise<any | null> {
    try {
      const [updated] = await db.update(bountyRequests)
        .set({
          ...data,
          processedAt: data.processedAt || new Date(),
        })
        .where(eq(bountyRequests.id, id))
        .returning();
      return updated || null;
    } catch (error) {
      log(`Error updating bounty request: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      throw error;
    }
  }

  /*
   * ============================================================================
   * COMMUNITY BOUNTIES STORAGE METHODS
   * ============================================================================
   *
   * WHY THESE METHODS EXIST:
   * - Encapsulate all database operations for community bounties
   * - Provide type-safe interface between business logic and database
   * - Enable consistent error handling and logging
   * - Support both pool-based and community bounty models without conflicts
   */

  /**
   * Create a new community bounty
   *
   * WHY: Initial creation when user initiates bounty via GitHub comment or UI
   * WHEN: Called from webhook handler or API endpoint
   * STATES: Creates bounty in 'pending_payment' status
   */
  async createCommunityBounty(data: {
    githubRepoOwner: string;
    githubRepoName: string;
    githubIssueNumber: number;
    githubIssueId: string;
    githubIssueUrl: string;
    creatorUserId?: number;
    createdByGithubUsername: string;
    title: string;
    description?: string;
    amount: string;
    currency: string;
    expiresAt?: Date;
  }): Promise<any> {
    try {
      log(`Creating community bounty for issue #${data.githubIssueNumber} in ${data.githubRepoOwner}/${data.githubRepoName}`, 'storage');

      // Calculate fees for the bounty (1% split fee model: 0.5% client + 0.5% contributor)
      const fees = this.calculateBountyFees(parseFloat(data.amount));

      const [bounty] = await db.insert(communityBounties).values({
        githubRepoOwner: data.githubRepoOwner,
        githubRepoName: data.githubRepoName,
        githubIssueNumber: data.githubIssueNumber,
        githubIssueId: data.githubIssueId,
        githubIssueUrl: data.githubIssueUrl,
        creatorUserId: data.creatorUserId || null,
        createdByGithubUsername: data.createdByGithubUsername,
        title: data.title,
        description: data.description || null,
        amount: data.amount,
        currency: data.currency,
        expiresAt: data.expiresAt || null,
        status: 'pending_payment',
        paymentStatus: 'pending',
        // Add fee breakdown fields
        baseBountyAmount: fees.baseBountyAmount.toString(),
        clientFeeAmount: fees.clientFeeAmount.toString(),
        contributorFeeAmount: fees.contributorFeeAmount.toString(),
        totalPlatformFee: fees.totalPlatformFee.toString(),
        totalPaidByClient: fees.totalPaidByClient.toString(),
      }).returning();

      log(`Community bounty created with ID ${bounty.id}`, 'storage');
      return bounty;
    } catch (error) {
      log(`Error creating community bounty: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      throw error;
    }
  }

  /**
   * Get community bounty by ID
   *
   * WHY: Retrieve specific bounty for display or processing
   * USED BY: Payment confirmation, claim processing, API endpoints
   */
  async getCommunityBounty(id: number): Promise<any | null> {
    try {
      const [bounty] = await db.select()
        .from(communityBounties)
        .where(eq(communityBounties.id, id))
        .limit(1);
      return bounty || null;
    } catch (error) {
      log(`Error fetching community bounty: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      return null;
    }
  }

  /**
   * Get community bounty by repo and issue
   *
   * WHY: Check if bounty already exists for an issue (prevent duplicates)
   * WHY unique index allows multiple bounties after refund/expiry
   * USED BY: Webhook handlers, bounty creation validation
   */
  async getCommunityBountyByIssue(
    githubRepoOwner: string,
    githubRepoName: string,
    githubIssueNumber: number
  ): Promise<any | null> {
    try {
      // Only return active bounties (not refunded or expired)
      // WHY: Unique index allows re-creation after refund, so we filter by status
      const [bounty] = await db.select()
        .from(communityBounties)
        .where(and(
          eq(communityBounties.githubRepoOwner, githubRepoOwner),
          eq(communityBounties.githubRepoName, githubRepoName),
          eq(communityBounties.githubIssueNumber, githubIssueNumber),
          sql`${communityBounties.status} NOT IN ('refunded', 'expired')`
        ))
        .limit(1);
      return bounty || null;
    } catch (error) {
      log(`Error fetching community bounty by issue: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      return null;
    }
  }

  /**
   * Get all community bounties for a repository
   *
   * WHY: Display all bounties on repo page, sort by newest first
   * USED BY: Repo detail page, bounty explorer
   */
  async getCommunityBountiesByRepo(
    githubRepoOwner: string,
    githubRepoName: string,
    status?: string
  ): Promise<any[]> {
    try {
      const conditions = [
        eq(communityBounties.githubRepoOwner, githubRepoOwner),
        eq(communityBounties.githubRepoName, githubRepoName),
      ];

      if (status) {
        conditions.push(eq(communityBounties.status, status));
      }

      const bounties = await db.select()
        .from(communityBounties)
        .where(and(...conditions))
        .orderBy(desc(communityBounties.createdAt));

      return bounties;
    } catch (error) {
      log(`Error fetching community bounties by repo: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      return [];
    }
  }

  /**
   * Get all active community bounties (for explorer page)
   *
   * WHY: Main bounty discovery interface, paginated for performance
   * WHY only 'funded' status: These are actively claimable bounties
   */
  async getActiveCommunityBounties(limit: number = 50, offset: number = 0): Promise<any[]> {
    try {
      const bounties = await db.select()
        .from(communityBounties)
        .where(eq(communityBounties.status, 'funded'))
        .orderBy(desc(communityBounties.createdAt))
        .limit(limit)
        .offset(offset);

      return bounties;
    } catch (error) {
      log(`Error fetching active community bounties: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      return [];
    }
  }

  /**
   * Get community bounties created by a user
   *
   * WHY: User dashboard "My Bounties" page
   * INCLUDES: All statuses for complete history
   */
  async getCommunityBountiesByCreator(userId: number): Promise<any[]> {
    try {
      const bounties = await db.select()
        .from(communityBounties)
        .where(eq(communityBounties.creatorUserId, userId))
        .orderBy(desc(communityBounties.createdAt));

      return bounties;
    } catch (error) {
      log(`Error fetching community bounties by creator: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      return [];
    }
  }

  /**
   * Get community bounties claimed by a user
   *
   * WHY: Contributor earnings page, leaderboard calculation
   * FILTER: Only completed bounties count toward earnings
   */
  async getCommunityBountiesByClaimer(userId: number): Promise<any[]> {
    try {
      const bounties = await db.select()
        .from(communityBounties)
        .where(and(
          eq(communityBounties.claimedByUserId, userId),
          eq(communityBounties.status, 'completed')
        ))
        .orderBy(desc(communityBounties.payoutExecutedAt));

      return bounties;
    } catch (error) {
      log(`Error fetching community bounties by claimer: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      return [];
    }
  }

  /**
   * Update community bounty
   *
   * WHY: Central update method for all state transitions
   * USED BY: Payment confirmation, claim processing, payout execution, refunds
   *
   * WHY partial updates: Different operations update different fields
   * - Payment: escrowTxHash, escrowBlockNumber, status='funded'
   * - Claim: claimedByUserId, claimedAt, status='claimed'
   * - Payout: payoutTxHash, payoutExecutedAt, status='completed'
   */
  async updateCommunityBounty(id: number, data: Partial<{
    status: string;
    paymentStatus: string;
    paymentMethod: string;
    escrowTxHash: string;
    escrowBlockNumber: number;
    escrowDepositedAt: Date;
    blockchainBountyId: number;
    githubInstallationId: string;
    onrampTransactionId: number;
    claimedByUserId: number;
    claimedByGithubUsername: string;
    claimedPrNumber: number;
    claimedPrUrl: string;
    claimedAt: Date;
    payoutTxHash: string;
    payoutExecutedAt: Date;
    payoutRecipientAddress: string;
    refundTxHash: string;
    refundedAt: Date;
  }>): Promise<any | null> {
    try {
      const [updated] = await db.update(communityBounties)
        .set({
          ...data,
          updatedAt: new Date(),
        })
        .where(eq(communityBounties.id, id))
        .returning();

      log(`Community bounty ${id} updated: ${Object.keys(data).join(', ')}`, 'storage');
      return updated || null;
    } catch (error) {
      log(`Error updating community bounty: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      throw error;
    }
  }

  /**
   * Get expired community bounties (for cleanup job)
   *
   * WHY: Background job to automatically refund expired bounties
   * WHY this query: Indexed on expires_at for fast retrieval
   * RETURNS: Only 'funded' bounties past expiry date
   */
  async getExpiredCommunityBounties(): Promise<any[]> {
    try {
      const now = new Date();
      const bounties = await db.select()
        .from(communityBounties)
        .where(and(
          eq(communityBounties.status, 'funded'),
          sql`${communityBounties.expiresAt} IS NOT NULL`,
          sql`${communityBounties.expiresAt} < ${now}`
        ))
        .orderBy(communityBounties.expiresAt);

      return bounties;
    } catch (error) {
      log(`Error fetching expired community bounties: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      return [];
    }
  }

  /**
   * Get claimed community bounties awaiting payout (for relayer)
   *
   * WHY: Relayer scans for claimed bounties to process payouts
   * WHY this query: Indexed on claimed_at + status for fast retrieval
   * RETURNS: Bounties in 'claimed' status, oldest first (FIFO)
   */
  async getClaimedCommunityBounties(): Promise<any[]> {
    try {
      const bounties = await db.select()
        .from(communityBounties)
        .where(eq(communityBounties.status, 'claimed'))
        .orderBy(communityBounties.claimedAt);

      return bounties;
    } catch (error) {
      log(`Error fetching claimed community bounties: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      return [];
    }
  }

  /**
   * Get community bounties stuck awaiting GitHub App installation resolution (FUND-03)
   *
   * WHY: Recovery sweep re-attempts installation-id resolution for bounties that could not be
   *      verified because no installation id was available. Mirrors getClaimedCommunityBounties.
   * RETURNS: Bounties in 'pending_installation' status, oldest claim first (FIFO)
   */
  async getBountiesPendingInstallation(): Promise<any[]> {
    try {
      const bounties = await db.select()
        .from(communityBounties)
        .where(eq(communityBounties.status, 'pending_installation'))
        .orderBy(communityBounties.claimedAt);

      return bounties;
    } catch (error) {
      log(`Error fetching pending-installation community bounties: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      return [];
    }
  }

  /**
   * Get community bounty by onramp transaction ID
   *
   * WHY: Link Onramp webhook to bounty for activation
   * USED BY: Onramp webhook handler
   */
  async getCommunityBountyByOnrampTransaction(onrampTransactionId: number): Promise<any | null> {
    try {
      const [bounty] = await db.select()
        .from(communityBounties)
        .where(eq(communityBounties.onrampTransactionId, onrampTransactionId))
        .limit(1);
      return bounty || null;
    } catch (error) {
      log(`Error fetching community bounty by onramp transaction: ${error instanceof Error ? error.message : String(error)}`, 'storage');
      return null;
    }
  }

  // ========================================
  // CRITICAL-1: Webhook Delivery Idempotency
  // ========================================

  /**
   * Record webhook delivery (atomic check-and-insert)
   * Returns true if this is first time seeing this delivery
   * Returns false if delivery already processed (duplicate)
   *
   * SECURITY: Prevents duplicate webhook processing
   * USAGE: Call at start of webhook handler, before any processing
   */
  async recordWebhookDelivery(
    deliveryId: string,
    eventType: string,
    eventAction: string | null,
    repositoryId: string | null,
    installationId: string | null
  ): Promise<boolean> {
    try {
      const result = await db.insert(webhookDeliveries)
        .values({
          deliveryId,
          eventType,
          eventAction,
          repositoryId,
          repositoryName: null,
          installationId,
          status: 'processing',
        })
        .onConflictDoNothing({ target: webhookDeliveries.deliveryId })
        .returning({ id: webhookDeliveries.id });

      const isFirstTime = result.length > 0;

      if (!isFirstTime) {
        log(`Duplicate webhook delivery detected: ${deliveryId}`, 'webhook-idempotency');
      }

      return isFirstTime;
    } catch (error) {
      log(`Error recording webhook delivery: ${error instanceof Error ? error.message : String(error)}`, 'storage-ERROR');
      return true;
    }
  }

  /**
   * Mark webhook delivery as completed
   */
  async markWebhookDeliveryCompleted(deliveryId: string): Promise<void> {
    try {
      await db.update(webhookDeliveries)
        .set({
          status: 'completed',
          processedAt: new Date(),
        })
        .where(eq(webhookDeliveries.deliveryId, deliveryId));
    } catch (error) {
      log(`Error marking webhook delivery completed: ${error instanceof Error ? error.message : String(error)}`, 'storage-ERROR');
    }
  }

  /**
   * Mark webhook delivery as failed with error
   */
  async markWebhookDeliveryFailed(deliveryId: string, errorMessage: string): Promise<void> {
    try {
      await db.update(webhookDeliveries)
        .set({
          status: 'failed',
          processedAt: new Date(),
          errorMessage,
        })
        .where(eq(webhookDeliveries.deliveryId, deliveryId));
    } catch (error) {
      log(`Error marking webhook delivery failed: ${error instanceof Error ? error.message : String(error)}`, 'storage-ERROR');
    }
  }

  // ========================================
  // CRITICAL-2: Payout Idempotency
  // ========================================

  /**
   * Check if payout already exists for this repo+issue
   * Returns existing payout if found, null otherwise
   *
   * SECURITY: Prevents double payouts
   * USAGE: Call before blockchain.distributeReward()
   */
  async getPayoutByRepoAndIssue(
    repositoryGithubId: string,
    issueNumber: number
  ): Promise<any | null> {
    try {
      const [payout] = await db.select()
        .from(payouts)
        .where(and(
          eq(payouts.repositoryGithubId, repositoryGithubId),
          eq(payouts.issueNumber, issueNumber)
        ))
        .limit(1);

      return payout || null;
    } catch (error) {
      log(`Error fetching payout: ${error instanceof Error ? error.message : String(error)}`, 'storage-ERROR');
      return null;
    }
  }

  /**
   * Record completed payout
   *
   * SECURITY: Atomic insert with unique constraint
   * If payout already exists, INSERT will fail (idempotency guarantee)
   */
  async recordPayout(payout: NewPayout): Promise<Payout> {
    try {
      const [result] = await db.insert(payouts)
        .values(payout)
        .returning();

      log(`Payout recorded: repo=${payout.repositoryGithubId}, issue=${payout.issueNumber}, tx=${payout.txHash}`, 'payout');
      return result;
    } catch (error: any) {
      // Distinguish WHICH unique constraint fired so the caller can tell a benign retry
      // (same tx_hash already recorded) from a potential double-pay (same repo/issue paid
      // under a DIFFERENT tx). The raw Postgres message names the constraint; postgres.js
      // also sets error.code='23505' and error.constraint_name.
      const isUnique = error?.code === '23505' ||
        (error instanceof Error && error.message.includes('unique constraint'));
      if (isUnique) {
        const detail = `${error?.constraint_name || ''} ${error instanceof Error ? error.message : ''}`;
        if (/tx_hash/.test(detail)) {
          log(`Payout already exists (tx_hash idempotency): repo=${payout.repositoryGithubId}, issue=${payout.issueNumber}`, 'payout');
          throw new Error('Payout already recorded (tx_hash idempotency)');
        }
        // Non-tx_hash unique conflict (e.g. uq_payouts_repo_issue): the same issue was already
        // paid under a different tx — surface as a possible double-pay, do NOT mask as idempotency.
        log(`Payout conflict on non-tx_hash unique constraint (possible double-pay): repo=${payout.repositoryGithubId}, issue=${payout.issueNumber}, tx=${payout.txHash}`, 'storage-ERROR');
        throw new Error('Payout conflict: repo/issue already recorded under a different tx (possible double-pay)');
      }
      log(`Error recording payout: ${error instanceof Error ? error.message : String(error)}`, 'storage-ERROR');
      throw error;
    }
  }

  /**
   * OPS-01: Query community relayer kill-switch from platform_flags table.
   * Returns false on missing row OR DB error (fail-safe: disabled by default).
   */
  async getRelayerEnabled(): Promise<boolean> {
    try {
      const [row] = await db.select()
        .from(platformFlags)
        .where(eq(platformFlags.key, 'community_relayer_enabled'))
        .limit(1);
      return row?.value ?? false; // default OFF if row missing
    } catch (error) {
      log(`Error reading relayer kill-switch flag: ${error instanceof Error ? error.message : String(error)}`, 'storage-ERROR');
      return false; // fail-safe: disable on DB error
    }
  }

  // ========================================
  // CRITICAL-3: Atomic Bounty Claim
  // ========================================

  /**
   * Claim bounty atomically with SELECT FOR UPDATE
   * Prevents race condition where multiple users claim same bounty
   *
   * SECURITY: Transaction with row-level lock
   * Returns updated bounty if claim succeeded
   * Throws error if bounty not claimable
   */
  async claimCommunityBountyAtomic(
    bountyId: number,
    userId: number,
    githubUsername: string,
    prNumber: number,
    prUrl: string
  ): Promise<any> {
    return await db.transaction(async (tx) => {
      const [bounty] = await tx.select()
        .from(communityBounties)
        .where(eq(communityBounties.id, bountyId))
        .for('update')
        .limit(1);

      if (!bounty) {
        throw new Error('Bounty not found');
      }

      if (bounty.status !== 'funded') {
        throw new Error(`Bounty is not claimable (status: ${bounty.status})`);
      }

      const [updatedBounty] = await tx.update(communityBounties)
        .set({
          status: 'claimed',
          claimedByUserId: userId,
          claimedByGithubUsername: githubUsername,
          claimedPrNumber: prNumber,
          claimedPrUrl: prUrl,
          claimedAt: new Date(),
        })
        .where(eq(communityBounties.id, bountyId))
        .returning();

      log(`Bounty ${bountyId} claimed atomically by ${githubUsername} via PR #${prNumber}`, 'claim-atomic');
      return updatedBounty;
    });
  }

  // ========================================
  // Fee Calculation Utilities
  // ========================================

  /**
   * Calculate fee breakdown for bounty amount
   * Returns base amount + all fee components
   *
   * Fee Model: on-chain-aligned 1% total (0.5% client + 0.5% contributor).
   * The rate is sourced from config (PLATFORM_FEE_RATE / CONTRIBUTOR_FEE_RATE,
   * default 50 bps each) so it matches the live CommunityBountyEscrow on-chain
   * rate (platformFeeRate=50 + contributorFeeRate=50 bps). D-14 / Phase-3 D-08.
   */
  calculateBountyFees(baseBountyAmount: number): {
    baseBountyAmount: number;
    clientFeeAmount: number;
    contributorFeeAmount: number;
    totalPlatformFee: number;
    totalPaidByClient: number;
    contributorPayout: number;
  } {
    const roundTo8 = (num: number) => Math.round(num * 100000000) / 100000000;

    const clientFee = roundTo8(baseBountyAmount * (config.platformFeeRate / 10000));
    const contributorFee = roundTo8(baseBountyAmount * (config.contributorFeeRate / 10000));
    const totalFee = roundTo8(clientFee + contributorFee);
    const totalPaid = roundTo8(baseBountyAmount + clientFee);
    const payout = roundTo8(baseBountyAmount - contributorFee);

    return {
      baseBountyAmount: roundTo8(baseBountyAmount),
      clientFeeAmount: clientFee,
      contributorFeeAmount: contributorFee,
      totalPlatformFee: totalFee,
      totalPaidByClient: totalPaid,
      contributorPayout: payout,
    };
  }

  // ========================================
  // Bounty Attempts (Track who's working on issues)
  // ========================================

  /**
   * Create a new bounty attempt (when user comments /attempt)
   */
  async createBountyAttempt(attempt: {
    bountyId?: number;
    userId?: number;
    githubUsername: string;
    githubRepoOwner: string;
    githubRepoName: string;
    githubIssueNumber: number;
  }): Promise<any> {
    try {
      const [result] = await db.insert(bountyAttempts)
        .values({
          bountyId: attempt.bountyId || null,
          userId: attempt.userId || null,
          githubUsername: attempt.githubUsername,
          githubRepoOwner: attempt.githubRepoOwner,
          githubRepoName: attempt.githubRepoName,
          githubIssueNumber: attempt.githubIssueNumber,
          status: 'active',
          startedAt: new Date(),
        })
        .returning();

      log(`Bounty attempt created: ${attempt.githubUsername} on ${attempt.githubRepoOwner}/${attempt.githubRepoName}#${attempt.githubIssueNumber}`, 'attempt');
      return result;
    } catch (error) {
      if (error instanceof Error && error.message.includes('unique')) {
        log(`Attempt already exists for ${attempt.githubUsername} on issue #${attempt.githubIssueNumber}`, 'attempt');
        throw new Error('You already have an active attempt on this issue');
      }
      log(`Error creating bounty attempt: ${error instanceof Error ? error.message : String(error)}`, 'storage-ERROR');
      throw error;
    }
  }

  /**
   * Get active attempt by user and issue
   */
  async getActiveAttemptByUserAndIssue(
    githubUsername: string,
    githubRepoOwner: string,
    githubRepoName: string,
    githubIssueNumber: number
  ): Promise<any | null> {
    try {
      const [attempt] = await db.select()
        .from(bountyAttempts)
        .where(and(
          eq(bountyAttempts.githubUsername, githubUsername),
          eq(bountyAttempts.githubRepoOwner, githubRepoOwner),
          eq(bountyAttempts.githubRepoName, githubRepoName),
          eq(bountyAttempts.githubIssueNumber, githubIssueNumber),
          eq(bountyAttempts.status, 'active')
        ))
        .limit(1);

      return attempt || null;
    } catch (error) {
      log(`Error fetching active attempt: ${error instanceof Error ? error.message : String(error)}`, 'storage-ERROR');
      return null;
    }
  }

  /**
   * Get all active attempts for an issue
   */
  async getActiveAttemptsByIssue(
    githubRepoOwner: string,
    githubRepoName: string,
    githubIssueNumber: number
  ): Promise<any[]> {
    try {
      const attempts = await db.select()
        .from(bountyAttempts)
        .where(and(
          eq(bountyAttempts.githubRepoOwner, githubRepoOwner),
          eq(bountyAttempts.githubRepoName, githubRepoName),
          eq(bountyAttempts.githubIssueNumber, githubIssueNumber),
          eq(bountyAttempts.status, 'active')
        ))
        .orderBy(bountyAttempts.startedAt);

      return attempts;
    } catch (error) {
      log(`Error fetching active attempts: ${error instanceof Error ? error.message : String(error)}`, 'storage-ERROR');
      return [];
    }
  }

  /**
   * Update attempt status (completed when PR merged, abandoned when user gives up)
   */
  async updateBountyAttemptStatus(
    attemptId: number,
    status: 'active' | 'completed' | 'abandoned',
    prNumber?: number,
    prUrl?: string
  ): Promise<any> {
    try {
      const [updated] = await db.update(bountyAttempts)
        .set({
          status,
          prNumber: prNumber || null,
          prUrl: prUrl || null,
          updatedAt: new Date(),
        })
        .where(eq(bountyAttempts.id, attemptId))
        .returning();

      log(`Bounty attempt ${attemptId} updated to ${status}`, 'attempt');
      return updated;
    } catch (error) {
      log(`Error updating bounty attempt: ${error instanceof Error ? error.message : String(error)}`, 'storage-ERROR');
      throw error;
    }
  }

  /**
   * Mark attempt as completed when PR merges
   */
  async completeAttemptByPR(
    githubUsername: string,
    githubRepoOwner: string,
    githubRepoName: string,
    githubIssueNumber: number,
    prNumber: number,
    prUrl: string
  ): Promise<any | null> {
    try {
      const [updated] = await db.update(bountyAttempts)
        .set({
          status: 'completed',
          prNumber,
          prUrl,
          updatedAt: new Date(),
        })
        .where(and(
          eq(bountyAttempts.githubUsername, githubUsername),
          eq(bountyAttempts.githubRepoOwner, githubRepoOwner),
          eq(bountyAttempts.githubRepoName, githubRepoName),
          eq(bountyAttempts.githubIssueNumber, githubIssueNumber),
          eq(bountyAttempts.status, 'active')
        ))
        .returning();

      if (updated) {
        log(`Attempt completed for ${githubUsername} via PR #${prNumber}`, 'attempt');
      }
      return updated || null;
    } catch (error) {
      log(`Error completing attempt: ${error instanceof Error ? error.message : String(error)}`, 'storage-ERROR');
      return null;
    }
  }

  // ========================================
  // Issue Comments (Track bot comments for updates)
  // ========================================

  /**
   * Store a comment reference for later updates
   */
  async createIssueComment(comment: {
    githubRepoOwner: string;
    githubRepoName: string;
    githubIssueNumber: number;
    githubCommentId: string;
    commentType: 'welcome' | 'status' | 'payout';
    installationId: string;
  }): Promise<any> {
    try {
      const [result] = await db.insert(issueComments)
        .values({
          githubRepoOwner: comment.githubRepoOwner,
          githubRepoName: comment.githubRepoName,
          githubIssueNumber: comment.githubIssueNumber,
          githubCommentId: comment.githubCommentId,
          commentType: comment.commentType,
          installationId: comment.installationId,
        })
        .returning();

      log(`Issue comment stored: ${comment.commentType} on ${comment.githubRepoOwner}/${comment.githubRepoName}#${comment.githubIssueNumber}`, 'comment');
      return result;
    } catch (error) {
      if (error instanceof Error && error.message.includes('unique')) {
        log(`Comment of type ${comment.commentType} already exists for issue #${comment.githubIssueNumber}`, 'comment');
        // Update existing comment reference
        const [updated] = await db.update(issueComments)
          .set({
            githubCommentId: comment.githubCommentId,
            updatedAt: new Date(),
          })
          .where(and(
            eq(issueComments.githubRepoOwner, comment.githubRepoOwner),
            eq(issueComments.githubRepoName, comment.githubRepoName),
            eq(issueComments.githubIssueNumber, comment.githubIssueNumber),
            eq(issueComments.commentType, comment.commentType)
          ))
          .returning();
        return updated;
      }
      log(`Error creating issue comment: ${error instanceof Error ? error.message : String(error)}`, 'storage-ERROR');
      throw error;
    }
  }

  /**
   * Get welcome comment for an issue (used to update attempt tracker)
   */
  async getWelcomeComment(
    githubRepoOwner: string,
    githubRepoName: string,
    githubIssueNumber: number
  ): Promise<any | null> {
    try {
      const [comment] = await db.select()
        .from(issueComments)
        .where(and(
          eq(issueComments.githubRepoOwner, githubRepoOwner),
          eq(issueComments.githubRepoName, githubRepoName),
          eq(issueComments.githubIssueNumber, githubIssueNumber),
          eq(issueComments.commentType, 'welcome')
        ))
        .limit(1);

      return comment || null;
    } catch (error) {
      log(`Error fetching welcome comment: ${error instanceof Error ? error.message : String(error)}`, 'storage-ERROR');
      return null;
    }
  }

  /**
   * Get comment by type for an issue
   */
  async getIssueCommentByType(
    githubRepoOwner: string,
    githubRepoName: string,
    githubIssueNumber: number,
    commentType: 'welcome' | 'status' | 'payout'
  ): Promise<any | null> {
    try {
      const [comment] = await db.select()
        .from(issueComments)
        .where(and(
          eq(issueComments.githubRepoOwner, githubRepoOwner),
          eq(issueComments.githubRepoName, githubRepoName),
          eq(issueComments.githubIssueNumber, githubIssueNumber),
          eq(issueComments.commentType, commentType)
        ))
        .limit(1);

      return comment || null;
    } catch (error) {
      log(`Error fetching issue comment: ${error instanceof Error ? error.message : String(error)}`, 'storage-ERROR');
      return null;
    }
  }

}

export const storage = new DatabaseStorage();

/**
 * FUND-04: Retry ledger insert with backoff; never re-throws (blockchain tx already succeeded).
 * - On unique-constraint / "Payout already recorded": treats as idempotency success (no re-send).
 * - On DB error: retries up to maxAttempts with 200ms/400ms backoff.
 * - On exhaustion: fires sendLedgerFailureAlert + [PAYOUT-LEDGER-FAILURE] structured log.
 *   Does NOT re-throw — FUND-05 reconciliation is the backstop (D-10).
 */
export async function recordPayoutWithRetry(payoutData: NewPayout, maxAttempts = 3): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await storage.recordPayout(payoutData);
      return;
    } catch (err: any) {
      const msg = err?.message || '';
      // True idempotency — this exact on-chain tx is already in the ledger (a retried webhook
      // or a reconciliation re-run). Expected and benign; never re-send. (Logged under a benign
      // tag so it does NOT trip [PAYOUT-LEDGER-FAILURE]-keyed alerting.)
      if (msg.includes('tx_hash idempotency')) {
        log(`[PAYOUT-IDEMPOTENT] tx already recorded — skipping (no re-send) tx=${payoutData.txHash}`, 'payout');
        return;
      }
      // Possible DOUBLE-PAY — a non-tx_hash unique constraint blocked the row (the same repo/issue
      // is already paid under a different tx). Funds may have moved twice. Alert loudly; do NOT
      // re-throw (the blockchain tx already succeeded — re-throwing cannot un-send it).
      if (msg.includes('possible double-pay')) {
        log(`[PAYOUT-DOUBLE-PAY?] non-tx_hash unique conflict repo=${payoutData.repositoryGithubId} issue=#${payoutData.issueNumber} tx=${payoutData.txHash}`, 'payout-ERROR');
        await sendLedgerFailureAlert({
          txHash: payoutData.txHash ?? 'unknown',
          repoId: payoutData.repositoryGithubId,
          issueNumber: payoutData.issueNumber,
          error: 'Possible double-pay: repo/issue already recorded under a different tx_hash. Manual review required.',
        }).catch((alertErr: any) => log(`SES alert also failed: ${alertErr.message}`, 'payout-ERROR'));
        return;
      }
      if (attempt < maxAttempts) {
        const delay = attempt * 200; // 200ms then 400ms
        log(`[PAYOUT-LEDGER-RETRY] Attempt ${attempt} failed: ${err.message}. Retrying in ${delay}ms`, 'payout');
        await new Promise(r => setTimeout(r, delay));
      } else {
        // Exhausted retries — alert + structured log, do NOT re-throw
        log(`[PAYOUT-LEDGER-FAILURE] All ${maxAttempts} attempts failed for tx=${payoutData.txHash} repo=${payoutData.repositoryGithubId} issue=#${payoutData.issueNumber}: ${err.message}`, 'payout-ERROR');
        await sendLedgerFailureAlert({
          txHash: payoutData.txHash ?? 'unknown',
          repoId: payoutData.repositoryGithubId,
          issueNumber: payoutData.issueNumber,
          error: err.message,
        }).catch((alertErr: any) => log(`SES alert also failed: ${alertErr.message}`, 'payout-ERROR'));
        // Do NOT re-throw: blockchain tx succeeded; FUND-05 reconciliation recovers the row (D-10)
      }
    }
  }
}
