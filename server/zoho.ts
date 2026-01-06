// Zoho CRM Integration Module
import axios from 'axios';
import { log } from './utils';
import { config } from './config';
import { storage } from './storage';

// Zoho API endpoints - Using India region
const ZOHO_ACCOUNTS_URL = 'https://accounts.zoho.in';
const ZOHO_API_URL = 'https://www.zohoapis.in';
const DEFAULT_ZOHO_DC = 'in'; // Data center: com, eu, in, etc.

// Store token data
let accessToken: string | null = null;
let tokenExpiry: number = 0;

/**
 * Generate the authorization URL for Zoho OAuth flow
 * @returns {string} Authorization URL to redirect the user
 */
export function getZohoAuthUrl(): string {
  // Use the exact redirect URI that was configured in Zoho API Console
  const redirectUri = encodeURIComponent(`https://api.roxonn.com/api/zoho/auth/callback`);
  const scope = encodeURIComponent('ZohoCRM.modules.ALL,ZohoCRM.settings.ALL');
  
  return `${ZOHO_ACCOUNTS_URL}/oauth/v2/auth?scope=${scope}&client_id=${config.zohoClientId}&response_type=code&access_type=offline&redirect_uri=${redirectUri}`;
}

/**
 * Exchange authorization code for refresh token
 * @param {string} code The authorization code received from Zoho
 * @returns {Promise<string>} Refresh token
 */
export async function exchangeCodeForRefreshToken(code: string): Promise<string> {
  try {
    // Use the exact redirect URI that was configured in Zoho API Console
    const redirectUri = `https://api.roxonn.com/api/zoho/auth/callback`;
    
    const response = await axios.post(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, null, {
      params: {
        grant_type: 'authorization_code',
        client_id: config.zohoClientId,
        client_secret: config.zohoClientSecret,
        code: code,
        redirect_uri: redirectUri
      }
    });
    
    if (response.data && response.data.refresh_token) {
      log(`Successfully obtained refresh token from Zoho`, 'zoho');
      return response.data.refresh_token;
    } else {
      throw new Error('Refresh token not found in response');
    }
  } catch (error: any) {
    log(`Error exchanging code for refresh token: ${error.message}`, 'zoho');
    throw error;
  }
}

/**
 * Get a valid access token for Zoho API calls
 * @returns {Promise<string>} Access token
 */
export async function getZohoAccessToken(): Promise<string> {
  // If we have a valid token, return it
  if (accessToken && tokenExpiry > Date.now()) {
    return accessToken as string;
  }
  
  try {
    if (!config.zohoRefreshToken) {
      throw new Error('Zoho refresh token not configured. Please complete the OAuth flow first.');
    }
    
    const response = await axios.post(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, null, {
      params: {
        grant_type: 'refresh_token',
        client_id: config.zohoClientId,
        client_secret: config.zohoClientSecret,
        refresh_token: config.zohoRefreshToken
      }
    });
    
    if (response.data && response.data.access_token) {
      accessToken = response.data.access_token;
      // Set expiry time (token is valid for 1 hour, subtract 5 minutes for safety margin)
      tokenExpiry = Date.now() + ((response.data.expires_in - 300) * 1000);
      log(`Successfully refreshed Zoho access token`, 'zoho');
      return accessToken as string;
    } else {
      throw new Error('Access token not found in response');
    }
  } catch (error: any) {
    log(`Error getting Zoho access token: ${error.message}`, 'zoho');
    throw error;
  }
}

/**
 * Create a new user record in Zoho CRM based on user's role
 * @param {Object} userData User data from GitHub registration
 * @returns {Promise<boolean>} Success status
 */
export async function createZohoLead(userData: any): Promise<boolean> {
  try {
    const token = await getZohoAccessToken();
    
    // Determine which module to use based on role
    const userRole = userData.role || '';
    let moduleToUse = 'ROXONN_Users'; // Default module as fallback
    
    if (userRole.toLowerCase() === 'poolmanager') {
      moduleToUse = 'ROXONN_Pool_Managers';
    } else if (userRole.toLowerCase() === 'contributor') {
      moduleToUse = 'ROXONN_Contributors';
    }
    
    // Log which module is being used
    log(`Creating Zoho record in ${moduleToUse} for user: ${userData.username}`, 'zoho');
    
    // Prepare the user data for the selected module
    const roxonnUserData = {
      data: [
        {
          // Map to the exact field names in your custom module
          Name: userData.username || 'GitHub User',
          Email: userData.email || '',
          GitHub_ID: userData.githubId || '',
          GitHub_Username: userData.username || '',
          Role: userRole,
          // Add any other custom fields you want to populate
          XDC_Wallet_Address: userData.xdcWalletAddress || ''
        }
      ]
    };
    
    // Make API call to create record in the appropriate module
    const response = await axios.post(
      `${ZOHO_API_URL}/crm/v2/${moduleToUse}`,
      roxonnUserData,
      {
        headers: {
          'Authorization': `Zoho-oauthtoken ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    if (response.data && response.data.data && response.data.data[0].status === 'success') {
      log(`Successfully created record in ${moduleToUse} module for user: ${userData.username}`, 'zoho');
      
      // For backward compatibility, also create in the main ROXONN_Users module if we used a role-specific module
      if (moduleToUse !== 'ROXONN_Users') {
        try {
          await axios.post(
            `${ZOHO_API_URL}/crm/v2/ROXONN_Users`,
            roxonnUserData,
            {
              headers: {
                'Authorization': `Zoho-oauthtoken ${token}`,
                'Content-Type': 'application/json'
              }
            }
          );
          log(`Also created record in ROXONN_Users module for compatibility`, 'zoho');
        } catch (error) {
          // Don't fail if the secondary creation fails
          const innerError = error as Error;
          log(`Warning: Failed to create record in main ROXONN_Users module: ${innerError.message}`, 'zoho');
        }
      }
      
      return true;
    } else {
      log(`Failed to create record in ${moduleToUse} module: ${JSON.stringify(response.data)}`, 'zoho');
      return false;
    }
  } catch (error: any) {
    log(`Error creating Zoho record: ${error.message}`, 'zoho');
    // Don't let Zoho errors affect the main registration process
    return false;
  }
}

/**
 * Check if Zoho integration is properly configured
 * @returns {boolean} Is Zoho configured
 */
export function isZohoConfigured(): boolean {
  return !!(config.zohoClientId && config.zohoClientSecret);
}

/**
 * Send a notification to Zoho CRM when a bounty is allocated to an issue
 * This will create a record in the Bounty_Notifications module which triggers
 * a custom function to send emails to all contributors
 *
 * @param {string} repoName Repository name
 * @param {number} issueId Issue ID
 * @param {string} issueTitle Issue title
 * @param {string} bountyAmount Amount of bounty
 * @param {string} issueUrl URL to the GitHub issue
 * @param {boolean} isRoxn Whether the bounty is in ROXN
 * @returns {Promise<boolean>} Success status
 */
export async function sendBountyNotification(
  repoName: string,
  issueId: number,
  issueTitle: string,
  bountyAmount: string, // Keep receiving as string
  issueUrl: string,
  isRoxn: boolean // New parameter
): Promise<boolean> {
  try {
    // Don't block or throw errors if Zoho is not configured
    if (!isZohoConfigured()) {
      log(`Zoho not configured, skipping bounty notification`, 'zoho');
      return false;
    }

    // Check if bounty notifications should be sent based on opt-out preferences
    const canSend = await canSendBountyNotification(repoName, bountyAmount);
    if (!canSend) {
      log(`Skipping bounty notification for ${repoName} as opt-out conditions are met`, 'zoho');
      return true; // Return success to avoid retries even though we didn't send
    }

    const token = await getZohoAccessToken();

    // Extract the actual issue number from the URL (the last segment after 'issues/')
    let displayIssueNumber = "0";
    try {
      const urlParts = issueUrl.split('/');
      displayIssueNumber = urlParts[urlParts.length - 1]; // Get the last segment
      // Validate that it's a number
      if (!/^\d+$/.test(displayIssueNumber)) {
        log(`Warning: Could not extract valid issue number from URL: ${issueUrl}`, 'zoho');
        // Fall back to the issueId if we can't extract a valid number
        displayIssueNumber = issueId.toString();
      }
    } catch (err) {
      log(`Warning: Error extracting issue number from URL: ${err}`, 'zoho');
      displayIssueNumber = issueId.toString();
    }

    // Convert bountyAmount to a float, handle potential errors
    const bountyAmountFloat = parseFloat(bountyAmount);
    if (isNaN(bountyAmountFloat)) {
        log(`Error converting bountyAmount '${bountyAmount}' to float for Zoho notification`, 'zoho');
        return false;
    }

    const currencySymbol = isRoxn ? "ROXN" : "XDC";

    // Prepare the notification data
    const notificationData = {
      data: [
        {
          // Add the Name field (mandatory in Zoho CRM)
          Name: `${repoName} - Issue #${displayIssueNumber} (${bountyAmount} ${currencySymbol})`,
          Repository_Name: repoName,
          Issue_Number: displayIssueNumber, // Use the extracted issue number
          Issue_Title: issueTitle,
          Bounty_Amount: bountyAmountFloat, // Send as float
          Currency_Symbol: currencySymbol, // Add currency symbol
          GitHub_Issue_URL: issueUrl
        }
      ]
    };

    log(`Sending bounty notification to Zoho for ${repoName}#${displayIssueNumber}`, 'zoho');
    log(`Data payload: ${JSON.stringify(notificationData.data[0])}`, 'zoho'); // Log the data being sent

    // Make API call to create record in the Bounty_Notifications module
    const response = await axios.post(
      `${ZOHO_API_URL}/crm/v2/Bounty_Notifications`,
      notificationData,
      {
        headers: {
          'Authorization': `Zoho-oauthtoken ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data && response.data.data && response.data.data[0].status === 'success') {
      log(`Successfully created bounty notification in Zoho CRM`, 'zoho');
      return true;
    } else {
      log(`Failed to create bounty notification in Zoho: ${JSON.stringify(response.data)}`, 'zoho');
      return false;
    }
  } catch (error: any) {
    log(`Error creating bounty notification in Zoho: ${error.message}`, 'zoho');
    // Don't let Zoho errors affect the main application process
    return false;
  }
}

/**
 * Check if a user has opted out of email notifications
 * This is used to prevent sending bounty notifications to opted-out users
 *
 * @param {string} email User's email address
 * @returns {Promise<boolean>} True if user has opted out of emails
 */
// This function is kept for general purpose opt-out checking, but not directly used by sendBountyNotification
// since that function creates a record that Zoho then processes for multiple recipients
export async function hasUserOptedOut(email: string): Promise<boolean> {
  try {
    if (!email) {
      // No need to log this as it's an expected case
      return false;
    }

    // Find user by email
    const user = await storage.getUserByGithubEmail(email);

    if (!user) {
      // No need to log PII - this is an expected case
      return false;
    }

    // Return true if user has opted out, false otherwise
    return user.emailOptOut === true;
  } catch (error) {
    // Log the error but avoid including email address for privacy
    log(`Error checking user email opt-out status: ${error instanceof Error ? error.message : String(error)}`, 'zoho');
    // If there's an error, we'll assume the user has NOT opted out to be safe
    return false;
  }
}

/**
 * Check if bounty notifications should be sent by verifying if there are
 * any users who would receive the notification and haven't opted out.
 *
 * This function implements comprehensive contributor opt-out checking by:
 * 1. Querying all registered contributors to the repository (via bounty attempts, claims, etc.)
 * 2. Filtering out those who have opted out of notifications
 * 3. Only allowing notifications if all interested parties have not opted out
 *
 * @param repoName Repository name to check for interested parties
 * @param bountyAmount Amount of the bounty (for logging purposes)
 * @returns boolean indicating if notifications can be sent
 */
export async function canSendBountyNotification(repoName: string, bountyAmount: string): Promise<boolean> {
  try {
    // First, check if the repository owner has opted out
    const [repoOwner] = repoName.split('/');

    if (!repoOwner) {
      log(`Could not extract repository owner from: ${repoName}`, 'zoho');
      return false;
    }

    const ownerUser = await storage.getUserByGithubUsername(repoOwner);

    // If repository owner exists and has opted out, skip notifications
    if (ownerUser && ownerUser.emailOptOut === true) {
      log(`Repository owner ${repoOwner} has opted out. Skipping bounty notification for ${bountyAmount} bounty.`, 'zoho');
      return false;
    }

    // Get all contributors who have interacted with bounties in this repository
    // This includes users who have attempted, claimed, or otherwise participated in bounties
    const allInterestedUsers = await storage.getAllBountyContributorsForRepo(repoName);

    // Check if any of these users have opted out of email notifications
    for (const user of allInterestedUsers) {
      if (user.emailOptOut === true) {
        log(`User ${user.username} (ID: ${user.id}) has opted out of emails. Skipping bounty notification for ${repoName}.`, 'zoho');
        return false; // If any interested user has opted out, don't send notification
      }
    }

    // Also check if there are registered repository contributors who might be interested
    const registeredRepo = await storage.findRepositoryByFullName(repoName);
    if (registeredRepo && registeredRepo.userId) {
      // Check if the user who registered this repository has opted out
      const regUser = await storage.getUserById(registeredRepo.userId);
      if (regUser && regUser.emailOptOut === true) {
        log(`Registered repository user ${regUser.username} has opted out. Skipping bounty notification for ${repoName}.`, 'zoho');
        return false;
      }
    }

    // If we reach here, no interested parties have opted out
    log(`Bounty notification can be sent for ${repoName} - no opted-out users found`, 'zoho');
    return true;
  } catch (error) {
    log(`Error in canSendBountyNotification: ${error instanceof Error ? error.message : String(error)}`, 'zoho');
    // If there's an error, we'll assume we should send the notification to avoid blocking functionality
    return true;
  }
}
