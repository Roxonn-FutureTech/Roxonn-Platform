import { db } from '../db';
import { users, pendingWallets } from '../../shared/schema';
import { generateWallet } from '../tatum';
import { blockchain } from '../blockchain';
import { log } from '../utils';
import { eq } from 'drizzle-orm';
import { FEATURE_FLAGS } from '../config';

export interface AutoRegistrationResult {
  success: boolean;
  userId?: number;
  walletAddress?: string;
  error?: string;
  action: 'created' | 'existing' | 'failed';
}

/**
 * Automatically register a GitHub contributor with wallet creation
 * This is called when a PR merges and the contributor doesn't have a Roxonn account
 *
 * @param githubUsername GitHub username
 * @param githubId GitHub user ID (as string)
 * @returns Result indicating success, userId, walletAddress, and action taken
 */
export async function autoRegisterContributor(
  githubUsername: string,
  githubId: string
): Promise<AutoRegistrationResult> {
  if (!FEATURE_FLAGS.AUTO_REGISTRATION_ENABLED) {
    return { success: false, action: 'failed', error: 'auto-registration disabled' };
  }

  try {
    log(`Auto-registration initiated for ${githubUsername} (GitHub ID: ${githubId})`, 'auth');

    // Step 1: Check if user already exists
    const existingUsers = await db
      .select()
      .from(users)
      .where(eq(users.githubId, githubId))
      .limit(1);

    if (existingUsers.length > 0) {
      const user = existingUsers[0];

      // User exists with wallet - return existing
      if (user.xdcWalletAddress) {
        log(`User ${githubUsername} already registered with wallet: ${user.xdcWalletAddress}`, 'auth');
        return {
          success: true,
          userId: user.id,
          walletAddress: user.xdcWalletAddress,
          action: 'existing'
        };
      }

      // User exists but no wallet - fall through to wallet creation
      log(`User ${githubUsername} exists but missing wallet, creating...`, 'auth');
    }

    // Step 2: Generate new wallet via Tatum
    log(`Generating wallet for ${githubUsername}...`, 'blockchain');
    const walletData = await generateWallet();
    log(`Wallet generated: ${walletData.address}`, 'blockchain');

    // Step 3: Register on blockchain
    log(`Registering ${githubUsername} on blockchain...`, 'blockchain');
    await blockchain.registerUser(
      githubUsername,
      parseInt(githubId, 10),
      'contributor', // Auto-registered users are contributors
      walletData.address
    );
    log(`Blockchain registration successful for ${githubUsername}`, 'blockchain');

    // Step 4: Create or update user in database
    let userId: number;

    if (existingUsers.length > 0) {
      // Update existing user with wallet info
      const user = existingUsers[0];

      await db
        .update(users)
        .set({
          xdcWalletAddress: walletData.address,
          walletReferenceId: walletData.referenceId,
          isProfileComplete: true,
          role: 'contributor',
          updatedAt: new Date()
        })
        .where(eq(users.id, user.id));

      userId = user.id;
      log(`Updated user ${githubUsername} (ID: ${userId}) with wallet`, 'auth');

    } else {
      // Create new user
      const newUsers = await db
        .insert(users)
        .values({
          githubUsername,
          username: githubUsername, // Use GitHub username as display name
          githubId,
          xdcWalletAddress: walletData.address,
          walletReferenceId: walletData.referenceId,
          isProfileComplete: true,
          role: 'contributor',
          // Optional fields that will be null
          name: null,
          email: null,
          avatarUrl: null,
          githubAccessToken: null,
          createdAt: new Date(),
          updatedAt: new Date()
        })
        .returning({ id: users.id });

      userId = newUsers[0].id;
      log(`Created new user ${githubUsername} (ID: ${userId}) via auto-registration`, 'auth');
    }

    // Step 5: FUND-02 — promote the encrypted key from pending_wallets onto the user row
    // and remove the orphan, atomically and idempotently.
    // generateWallet() stores the encrypted key in pending_wallets (no user row exists yet at
    // that point). Now that the user row exists, copy the ciphertext across and delete the
    // staging row in a single transaction. Ciphertext only — plaintext is never in scope here.
    await db.transaction(async (tx) => {
      const [pending] = await tx.select()
        .from(pendingWallets)
        .where(eq(pendingWallets.referenceId, walletData.referenceId))
        .limit(1);

      if (pending) {
        await tx.update(users)
          .set({
            encryptedPrivateKey: pending.encryptedPrivateKey,
            encryptedMnemonic: pending.encryptedMnemonic,
          })
          .where(eq(users.id, userId));

        await tx.delete(pendingWallets)
          .where(eq(pendingWallets.referenceId, walletData.referenceId));
      }
      // No pending row (already promoted, or storeWalletSecret hit the user-branch
      // directly for a pre-existing user) → no-op. Idempotent: re-running finds
      // nothing to promote and leaves the durable user-row key intact.
    });

    log(`Auto-registration completed successfully for ${githubUsername}`, 'auth');

    return {
      success: true,
      userId,
      walletAddress: walletData.address,
      action: 'created'
    };

  } catch (error: any) {
    log(`Auto-registration failed for ${githubUsername}: ${error.message}`, 'auth');
    return {
      success: false,
      error: error.message,
      action: 'failed'
    };
  }
}

/**
 * Ensure a GitHub user has a wallet, creating one if needed
 * Wrapper function that returns user data or null on failure
 *
 * @param githubUsername GitHub username
 * @param githubId GitHub user ID (as string)
 * @returns User ID and wallet address, or null if failed
 */
export async function ensureUserWallet(
  githubUsername: string,
  githubId: string
): Promise<{ userId: number; walletAddress: string } | null> {
  const result = await autoRegisterContributor(githubUsername, githubId);

  if (result.success && result.userId && result.walletAddress) {
    return {
      userId: result.userId,
      walletAddress: result.walletAddress
    };
  }

  return null;
}
