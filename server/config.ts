// Load environment variables
import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getParameter } from './aws';

// Get directory path in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Always use server/.env regardless of environment
const envPath = resolve(process.cwd(), 'server/.env');

// Load environment variables from server/.env
dotenv.config({ path: envPath });

// Basic configuration that doesn't require secure parameters
export const baseConfig = {
  // URLs and domains
  baseUrl: process.env.BASE_URL || 'http://localhost:5000',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  cookieDomain: process.env.COOKIE_DOMAIN || 'localhost',
  // Support / no-reply email (used for OTP)
  supportEmail: process.env.SUPPORT_EMAIL || 'connect@roxonn.com',

  // Server settings
  port: parseInt(process.env.PORT || '5000'),
  nodeEnv: process.env.NODE_ENV || 'development',

  // GitHub OAuth (non-sensitive)
  githubClientId: process.env.GITHUB_CLIENT_ID,
  githubCallbackUrl: process.env.GITHUB_CALLBACK_URL,
  githubOrg: process.env.GITHUB_ORG || 'Roxonn-FutureTech',
  githubAppId: process.env.GITHUB_APP_ID,
  githubAppName: process.env.GITHUB_APP_NAME,

  // Blockchain (non-sensitive)
  xdcNodeUrl: process.env.XDC_RPC_URL || 'https://rpc.xinfin.network',

  // Multi-network RPC URLs
  ethereumRpcUrl: process.env.ETHEREUM_RPC_URL || 'https://eth.llamarpc.com',
  polygonRpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
  bscRpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org',

  // USDT Contract Addresses
  usdtEthereumAddress: process.env.USDT_ETHEREUM_ADDRESS || '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  usdtPolygonAddress: process.env.USDT_POLYGON_ADDRESS || '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  usdtBscAddress: process.env.USDT_BSC_ADDRESS || '0x55d398326f99059fF775485246999027B3197955',

  // USDC Contract Address on XDC (USDC rewards now handled by main DualCurrencyRepoRewards contract)
  usdcXdcAddress: process.env.USDC_XDC_ADDRESS || '0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1',
  usdcTokenAddress: process.env.USDC_XDC_ADDRESS || '0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1',

  // Legacy RepoRewards contract (XDC only) - DEPRECATED
  // repoRewardsContractAddress: process.env.REPO_REWARDS_CONTRACT_ADDRESS || '',
  // repoRewardsImplAddress: process.env.REPO_REWARDS_IMPL_ADDRESS || '',

  // DualCurrencyRepoRewards contract (XDC + ROXN + USDC) - Main unified contract
  dualCurrencyRewardsContractAddress: process.env.DUAL_CURRENCY_REWARDS_CONTRACT_ADDRESS || '',
  dualCurrencyRewardsImplAddress: process.env.DUAL_CURRENCY_REWARDS_IMPL_ADDRESS || '',

  // Use dual currency contract as the main rewards contract
  repoRewardsContractAddress: process.env.DUAL_CURRENCY_REWARDS_CONTRACT_ADDRESS || process.env.REPO_REWARDS_CONTRACT_ADDRESS || '',
  repoRewardsImplAddress: process.env.DUAL_CURRENCY_REWARDS_IMPL_ADDRESS || process.env.REPO_REWARDS_IMPL_ADDRESS || '',

  forwarderContractAddress: process.env.FORWARDER_CONTRACT_ADDRESS || '0x3bF77b9192E1bc9d780fcA8eC51C2a0edc2B8aD5',
  roxnTokenAddress: process.env.ROXN_TOKEN_ADDRESS || '0xD0b99c496e7Bd6EFE62Fc4cBfB2A796B62e59c2c',
  roxnTokenImplAddress: process.env.ROXN_TOKEN_IMPL_ADDRESS || '',
  contributionCertificateAddress: process.env.CONTRIBUTOR_CERTIFICATE_ADDRESS || '',

  // New ROXN Rewards Contract (additions) - These are now obsolete due to unified contract
  // newRoxnRewardsContractAddress: process.env.NEW_ROXN_REWARDS_CONTRACT_ADDRESS || '0xYOUR_NEW_ROXN_REWARDS_PROXY_ADDRESS_HERE', 
  // newRoxnRewardsImplAddress: process.env.NEW_ROXN_REWARDS_IMPL_ADDRESS || '0xYOUR_NEW_ROXN_REWARDS_IMPL_ADDRESS_HERE', 

  feeCollectorAddress: process.env.FEE_COLLECTOR_ADDRESS || '',
  platformFeeRate: parseInt(process.env.PLATFORM_FEE_RATE || '50'), // Default 0.5%
  contributorFeeRate: parseInt(process.env.CONTRIBUTOR_FEE_RATE || '50'), // Default 0.5%

  // Database (non-sensitive parts)
  dbSchema: process.env.DB_SCHEMA || 'staging',

  // AWS
  walletKmsKeyId: process.env.WALLET_KMS_KEY_ID,
  awsRegion: process.env.AWS_REGION,

  // Zoho CRM Integration
  zohoClientId: process.env.ZOHO_CLIENT_ID,

  // Onramp.money Integration
  onrampMoneyAppId: process.env.ONRAMP_MONEY_APP_ID || '',
  onrampMoneyBaseUrl: process.env.ONRAMP_MONEY_BASE_URL || 'https://onramp.money/main/buy/',
  onrampMerchantAppId: process.env.ONRAMP_MERCHANT_APP_ID || process.env.ONRAMP_MONEY_APP_ID || '',
  onrampMerchantLogoUrl: process.env.ONRAMP_MERCHANT_LOGO_URL || '',

  // Subscription settings
  subscriptionPriceUsdc: process.env.SUBSCRIPTION_PRICE_USDC || '10',
  platformTreasuryAddressXdc: process.env.PLATFORM_TREASURY_ADDRESS_XDC || process.env.FEE_COLLECTOR_ADDRESS || '',
  platformTreasuryAddressPolygon: process.env.PLATFORM_TREASURY_ADDRESS_POLYGON || '', // Same treasury for now
  polygonUsdcAddress: process.env.POLYGON_USDC_ADDRESS || '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // USDC on Polygon PoS

  // Azure Storage (for course videos)
  azureStorageAccount: process.env.AZURE_STORAGE_ACCOUNT || 'blobvideohostcoursepage',

  // Flag to use SSM parameters or fallback to environment variables
  useParameterStore: process.env.USE_PARAMETER_STORE === 'true',

  // Azure OpenAI (non-sensitive parts)
  azureOpenaiEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
  azureOpenaiDeploymentName: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
  azureOpenaiApiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview',

  // Azure OpenAI DeepSeek-R1 (non-sensitive parts)
  azureOpenaiEndpointDeepSeek: process.env.AZURE_OPENAI_ENDPOINT_DEEPSEEK,
  azureOpenaiDeploymentNameDeepSeek: process.env.AZURE_OPENAI_DEPLOYMENT_NAME_DEEPSEEK,
  azureOpenaiApiVersionDeepSeek: process.env.AZURE_OPENAI_API_VERSION_DEEPSEEK,

  // Azure OpenAI o4-mini (non-sensitive parts)
  azureOpenaiEndpointO4Mini: process.env.AZURE_OPENAI_ENDPOINT_O4_MINI,
  azureOpenaiDeploymentNameO4Mini: process.env.AZURE_OPENAI_DEPLOYMENT_NAME_O4_MINI,
  azureOpenaiApiVersionO4Mini: process.env.AZURE_OPENAI_API_VERSION_O4_MINI,

  // Azure OpenAI o3-mini (non-sensitive parts)
  azureOpenaiEndpointO3Mini: process.env.AZURE_OPENAI_ENDPOINT_O3_MINI,
  azureOpenaiDeploymentNameO3Mini: process.env.AZURE_OPENAI_DEPLOYMENT_NAME_O3_MINI,
  azureOpenaiApiVersionO3Mini: process.env.AZURE_OPENAI_API_VERSION_O3_MINI,

  // Azure OpenAI gpt-4.1 (non-sensitive parts)
  azureOpenaiEndpointGpt41: process.env.AZURE_OPENAI_ENDPOINT_GPT_4_1,
  azureOpenaiDeploymentNameGpt41: process.env.AZURE_OPENAI_DEPLOYMENT_NAME_GPT_4_1,
  azureOpenaiApiVersionGpt41: process.env.AZURE_OPENAI_API_VERSION_GPT_4_1,

  // Azure OpenAI Ministral-3B (non-sensitive parts)
  azureOpenaiEndpointMinistral3B: process.env.AZURE_OPENAI_ENDPOINT_MINISTRAL_3B,
  azureOpenaiDeploymentNameMinistral3B: process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MINISTRAL_3B,
  azureOpenaiApiVersionMinistral3B: process.env.AZURE_OPENAI_API_VERSION_MINISTRAL_3B,

  // Azure OpenAI Grok-3 (non-sensitive parts)
  azureOpenaiEndpointGrok: process.env.AZURE_OPENAI_ENDPOINT_GROK,
  azureOpenaiDeploymentNameGrok3: process.env.AZURE_OPENAI_DEPLOYMENT_NAME_GROK_3,
  azureOpenaiApiVersionGrok: process.env.AZURE_OPENAI_API_VERSION_GROK,

  // Azure OpenAI Grok-3-Mini (non-sensitive parts)
  // Uses the same endpoint and API version as Grok-3
  azureOpenaiDeploymentNameGrok3Mini: process.env.AZURE_OPENAI_DEPLOYMENT_NAME_GROK_3_MINI,

  // New User Trial Prompts
  newUserTrialPrompts: parseInt(process.env.NEW_USER_TRIAL_PROMPTS || '5'), // Default to 5 trial prompts

  // JWT Expiration for VSCode
  jwtExpiresInVSCode: process.env.JWT_EXPIRES_IN_VSCODE || '30d',

  // Partner API key for external integrations (like Rewards Bunny)
  partnerApiKey: process.env.PARTNER_API_KEY || 'partner_dev_key',

  // Google Cloud Platform
  gcpProjectId: process.env.GCP_PROJECT_ID,
  gcpLocation: process.env.GCP_LOCATION,

  // Proof of Compute V1
  proofOfComputeContractAddress: process.env.PROOF_OF_COMPUTE_CONTRACT_ADDRESS,
  xdcRpcUrl: process.env.XDC_RPC_URL,
} as const;

// Full configuration with sensitive values that will be populated
export let config = {
  ...baseConfig,

  // Sensitive values (will be populated from Parameter Store or environment variables)
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
  githubPat: process.env.GITHUB_PAT,
  githubAppPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  githubAppWebhookSecret: process.env.GITHUB_APP_WEBHOOK_SECRET,
  sessionSecret: process.env.SESSION_SECRET,
  relayerPrivateKey: process.env.PRIVATE_KEY || '',
  encryptionKey: process.env.ENCRYPTION_KEY,
  privateKeySecret: process.env.PRIVATE_KEY_SECRET || 'roxonn-secret',
  databaseUrl: process.env.DATABASE_URL,
  tatumApiKey: process.env.TATUM_API_KEY,
  zohoClientSecret: process.env.ZOHO_CLIENT_SECRET,
  zohoRefreshToken: process.env.ZOHO_REFRESH_TOKEN,
  onrampMoneyApiKey: process.env.ONRAMP_MONEY_API_KEY,
  onrampMoneyAppSecretKey: process.env.ONRAMP_MONEY_APP_SECRET_KEY,

  // Azure OpenAI (sensitive part)
  azureOpenaiKey: process.env.AZURE_OPENAI_KEY,

  // Azure OpenAI DeepSeek-R1 (sensitive part)
  azureOpenaiKeyDeepSeek: process.env.AZURE_OPENAI_KEY_DEEPSEEK,

  // Azure OpenAI o4-mini (sensitive part)
  azureOpenaiKeyO4Mini: process.env.AZURE_OPENAI_KEY_O4_MINI,

  // Azure OpenAI o3-mini (sensitive part)
  azureOpenaiKeyO3Mini: process.env.AZURE_OPENAI_KEY_O3_MINI,

  // Azure OpenAI gpt-4.1 (sensitive part)
  azureOpenaiKeyGpt41: process.env.AZURE_OPENAI_KEY_GPT_4_1,

  // Azure OpenAI Ministral-3B (sensitive part)
  azureOpenaiKeyMinistral3B: process.env.AZURE_OPENAI_KEY_MINISTRAL_3B,

  // Azure OpenAI Grok models (sensitive part - API Key)
  azureOpenaiKeyGrok: process.env.AZURE_OPENAI_KEY_GROK,

  // Azure Storage (sensitive part)
  azureStorageKey: process.env.AZURE_STORAGE_KEY,
} as const;

// Initialize config from SSM Parameter Store
export async function initializeConfig() {
  if (!baseConfig.useParameterStore) {
    console.log('Using environment variables for sensitive configuration');
    return;
  }

  console.log('Loading sensitive configuration from Parameter Store');

  try {
    // List of parameters to load from Parameter Store
    const parameterMap: Record<string, string> = {
      'github/client-secret': 'githubClientSecret',
      'github/pat': 'githubPat',
      'github/app-private-key': 'githubAppPrivateKey',
      'github/app-webhook-secret': 'githubAppWebhookSecret',
      'auth/session-secret': 'sessionSecret',
      'blockchain/relayer-private-key': 'relayerPrivateKey',
      'crypto/encryption-key': 'encryptionKey',
      'crypto/private-key-secret': 'privateKeySecret',
      'database/url': 'databaseUrl',
      'tatum/api-key': 'tatumApiKey',
      // Add Zoho and Onramp.money secrets if they are to be fetched from SSM
      // 'zoho/client-secret': 'zohoClientSecret',
      // 'zoho/refresh-token': 'zohoRefreshToken',
      // 'onramp/api-key': 'onrampMoneyApiKey',
      // 'onramp/app-secret-key': 'onrampMoneyAppSecretKey',
      // Add Azure OpenAI Key
      'azure/openai-key': 'azureOpenaiKey',
      // Add Azure OpenAI DeepSeek-R1 Key
      'azure/openai-key-deepseek': 'azureOpenaiKeyDeepSeek',
      // Add Azure OpenAI o4-mini Key
      'azure/openai-key-o4-mini': 'azureOpenaiKeyO4Mini',
      // Add Azure OpenAI o3-mini Key
      'azure/openai-key-o3-mini': 'azureOpenaiKeyO3Mini',
      // Add Azure OpenAI gpt-4.1 Key
      'azure/openai-key-gpt-4-1': 'azureOpenaiKeyGpt41',
      // Add Azure OpenAI Ministral-3B Key
      'azure/openai-key-ministral-3b': 'azureOpenaiKeyMinistral3B',

      // Add Grok model parameters
      'azure/openai-endpoint-grok': 'azureOpenaiEndpointGrok',
      'azure/openai-deployment-name-grok-3': 'azureOpenaiDeploymentNameGrok3',
      'azure/openai-api-version-grok': 'azureOpenaiApiVersionGrok',
      'azure/openai-deployment-name-grok-3-mini': 'azureOpenaiDeploymentNameGrok3Mini',
      'azure/openai-key-grok': 'azureOpenaiKeyGrok',

      // Removed obsolete new ROXN rewards contract parameters from SSM loading
      // 'blockchain/new-roxn-rewards-contract-address': 'newRoxnRewardsContractAddress',
      // 'blockchain/new-roxn-rewards-impl-address': 'newRoxnRewardsImplAddress',
    };

    // Load parameters in parallel
    const parameterPromises = Object.entries(parameterMap).map(async ([paramName, configKey]) => {
      const value = await getParameter(paramName);
      if (value !== null) {
        // Special handling for private key to handle newlines
        if (configKey === 'githubAppPrivateKey') {
          (config as any)[configKey] = value.replace(/\\n/g, '\n');
        } else {
          (config as any)[configKey] = value;
        }
        console.log(`Loaded parameter: ${paramName}`);
      } else {
        console.log(`Parameter not found: ${paramName}, using environment variable`);
      }
    });

    await Promise.all(parameterPromises);
    console.log('Configuration initialized from Parameter Store');
  } catch (error) {
    console.error('Error initializing config from Parameter Store:', error);
    console.log('Falling back to environment variables for sensitive configuration');
  }
}

// Validate required environment variables when env vars are being used
export function validateConfig() {
  if (baseConfig.useParameterStore) {
    // Skip validation when using Parameter Store
    return;
  }

  const requiredEnvVars = [
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'SESSION_SECRET',
    'XDC_RPC_URL',
    // Change required check to use either old or new contract address
    // 'REPO_REWARDS_CONTRACT_ADDRESS', // No longer strictly required
    'FORWARDER_CONTRACT_ADDRESS',
    'PRIVATE_KEY', // Relayer key
    'DATABASE_URL',
    'ENCRYPTION_KEY',
    'BASE_URL',
    'FRONTEND_URL',
    'GITHUB_APP_ID',
    'GITHUB_APP_PRIVATE_KEY',
    'GITHUB_APP_WEBHOOK_SECRET',
    'GITHUB_APP_NAME',
    // Add Azure OpenAI variables to required list if not using Parameter Store
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_KEY',
    'AZURE_OPENAI_DEPLOYMENT_NAME',
    // AZURE_OPENAI_API_VERSION has a default, so might not be strictly required here
    // Add DeepSeek specific vars if they are always required (even if default model exists)
    // For now, let's assume if the default is set, these might be optional unless explicitly chosen
    // If DeepSeek is intended to be a primary option, uncomment these:
    // 'AZURE_OPENAI_ENDPOINT_DEEPSEEK',
    // 'AZURE_OPENAI_KEY_DEEPSEEK',
    // 'AZURE_OPENAI_DEPLOYMENT_NAME_DEEPSEEK',
    // Add Grok model vars if they are always required when not using SSM
    // 'AZURE_OPENAI_ENDPOINT_GROK',
    // 'AZURE_OPENAI_KEY_GROK',
    // 'AZURE_OPENAI_DEPLOYMENT_NAME_GROK_3',
    // 'AZURE_OPENAI_API_VERSION_GROK',
    // 'AZURE_OPENAI_DEPLOYMENT_NAME_GROK_3_MINI',

    // Removed obsolete new ROXN rewards contract env vars from validation
    // 'NEW_ROXN_REWARDS_CONTRACT_ADDRESS',
    // 'NEW_ROXN_REWARDS_IMPL_ADDRESS', 
  ] as const;

  // Check that at least one rewards contract is configured
  if (!process.env.DUAL_CURRENCY_REWARDS_CONTRACT_ADDRESS && !process.env.REPO_REWARDS_CONTRACT_ADDRESS) {
    throw new Error('Missing required environment variable: Either DUAL_CURRENCY_REWARDS_CONTRACT_ADDRESS or REPO_REWARDS_CONTRACT_ADDRESS must be set');
  }

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(`Missing required environment variable: ${envVar}`);
    }
  }
}
