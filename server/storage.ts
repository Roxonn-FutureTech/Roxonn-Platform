import { users, registeredRepositories } from "../shared/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
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
          installationId: true
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

}

export const storage = new DatabaseStorage();
