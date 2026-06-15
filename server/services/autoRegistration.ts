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
        // T-05-04 recovery: a pre-fix crash could have left a wallet address but a
        // NULL encrypted key, with the ciphertext still staged in pending_wallets.
        // Resume the promotion before returning so the user is not left key-less.
        if (!user.encryptedPrivateKey && user.walletReferenceId) {
          const ref = user.walletReferenceId;
          await db.transaction(async (tx) => {
            const [pending] = await tx.select()
              .from(pendingWallets)
              .where(eq(pendingWallets.referenceId, ref))
              .limit(1);
            if (pending) {
              await tx.update(users)
                .set({
                  encryptedPrivateKey: pending.encryptedPrivateKey,
                  encryptedMnemonic: pending.encryptedMnemonic,
                })
                .where(eq(users.id, user.id));
              await tx.delete(pendingWallets).where(eq(pendingWallets.referenceId, ref));
              log(`Recovered staged wallet key for existing user ${githubUsername} (ID: ${user.id})`, 'auth');
            } else {
              log(`WARNING: user ${githubUsername} (ID: ${user.id}) has a wallet address but no encrypted key and no recoverable pending row`, 'auth');
            }
          });
        }
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

    // Step 4 + 5 (FUND-02, T-05-04): create/update the user row AND promote the
    // encrypted key from pending_wallets in a SINGLE transaction. generateWallet()
    // stages the ciphertext in pending_wallets (no user row exists yet). Doing the
    // user-row write and the key promotion atomically means a crash can never leave
    // a committed user row with a NULL key: either the user lands WITH its key, or
    // nothing commits and the pending row TTL-expires harmlessly (no key-less user,
    // no orphan-loss). Ciphertext only — plaintext is never in scope here.
    const userId = await db.transaction(async (tx): Promise<number> => {
      const [pending] = await tx.select()
        .from(pendingWallets)
        .where(eq(pendingWallets.referenceId, walletData.referenceId))
        .limit(1);

      let uid: number;
      if (existingUsers.length > 0) {
        // Update existing user with wallet info + key in the same transaction.
        const user = existingUsers[0];
        await tx
          .update(users)
          .set({
            xdcWalletAddress: walletData.address,
            walletReferenceId: walletData.referenceId,
            isProfileComplete: true,
            role: 'contributor',
            ...(pending
              ? { encryptedPrivateKey: pending.encryptedPrivateKey, encryptedMnemonic: pending.encryptedMnemonic }
              : {}),
            updatedAt: new Date()
          })
          .where(eq(users.id, user.id));
        uid = user.id;
        log(`Updated user ${githubUsername} (ID: ${uid}) with wallet`, 'auth');
      } else {
        // Create new user with wallet + key set atomically.
        const newUsers = await tx
          .insert(users)
          .values({
            githubUsername,
            username: githubUsername, // Use GitHub username as display name
            githubId,
            xdcWalletAddress: walletData.address,
            walletReferenceId: walletData.referenceId,
            isProfileComplete: true,
            role: 'contributor',
            encryptedPrivateKey: pending ? pending.encryptedPrivateKey : null,
            encryptedMnemonic: pending ? pending.encryptedMnemonic : null,
            // Optional fields that will be null
            name: null,
            email: null,
            avatarUrl: null,
            githubAccessToken: null,
            createdAt: new Date(),
            updatedAt: new Date()
          })
          .returning({ id: users.id });
        uid = newUsers[0].id;
        log(`Created new user ${githubUsername} (ID: ${uid}) via auto-registration`, 'auth');
      }

      // Remove the staging row once its ciphertext is on the durable user row.
      // No pending row (already promoted, or storeWalletSecret hit the user-branch
      // directly) → no-op. Idempotent.
      if (pending) {
        await tx.delete(pendingWallets)
          .where(eq(pendingWallets.referenceId, walletData.referenceId));
      }

      return uid;
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
