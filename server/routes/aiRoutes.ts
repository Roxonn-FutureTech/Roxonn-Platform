import { Router, Request, Response } from 'express';
import passport from 'passport';
import { requireAuth, requireVSCodeAuth } from '../auth';
import { handleVSCodeAIChatCompletions } from '../vscode-ai-handler';
import { config } from '../config';
import { log } from '../utils';
import { storage } from '../storage';

const router = Router();

// Helper function for cost estimation (initial rough version)
// TODO: Refine this based on actual tokenomics and model pricing
function estimateRequestCost(requestBody: any): number {
  // Rough estimation based on input length
  const inputLength = JSON.stringify(requestBody.messages).length;
  // Assuming ~4 chars per token for input and a conservative estimate for output
  const estimatedInputTokens = Math.ceil(inputLength / 4);
  const estimatedOutputTokens = requestBody.max_tokens || 1000; // Use max_tokens if provided, else default

  // Example pricing (e.g., GPT-4o: $0.005 input, $0.015 output per 1K tokens)
  // These should come from a centralized configuration or pricing service eventually
  const inputPricePer1k = 0.005; // dollars
  const outputPricePer1k = 0.015; // dollars

  // Cost in "AI Credits" - assuming 1 credit = $0.001 (or 1000 credits = $1)
  // This conversion factor needs to be aligned with your AI credit system.
  const creditValue = 0.001; // 1 credit = $0.001

  const estimatedCostDollars = (estimatedInputTokens * inputPricePer1k / 1000) + (estimatedOutputTokens * outputPricePer1k / 1000);
  return Math.ceil(estimatedCostDollars / creditValue); // Return cost in AI Credits
}

// Helper function to calculate actual cost from usage (initial rough version)
// TODO: Refine this based on actual tokenomics and model pricing
function calculateTokenCost(inputTokens: number, outputTokens: number): number {
  // Example pricing (e.g., GPT-4o: $0.005 input, $0.015 output per 1K tokens)
  // These should come from a centralized configuration or pricing service eventually
  // Adding a small markup (e.g., 20%) as per the plan
  const inputPricePer1k = 0.005 * 1.2;
  const outputPricePer1k = 0.015 * 1.2;

  const creditValue = 0.001; // 1 credit = $0.001

  const actualCostDollars = (inputTokens * inputPricePer1k / 1000) + (outputTokens * outputPricePer1k / 1000);
  return Math.ceil(actualCostDollars / creditValue); // Return cost in AI Credits
}

// Placeholder for deductAICredits function
// TODO: Implement this to interact with your actual AI credit system in storage/db
async function deductAICredits(userId: number, amount: number): Promise<void> {
  log(`Deducting ${amount} AI credits from user ${userId}`, 'vscode-ai');

  const user = await storage.getUserById(userId);
  if (user) {
    const currentPromptBalance = user.aiCredits || 0;
    if (currentPromptBalance < amount) {
      // This check should ideally happen before calling the AI model,
      // but also good to have a safeguard here.
      log(`User ${userId} has insufficient credits (${currentPromptBalance}) for deduction of ${amount}`, 'vscode-ai');
      throw new Error('Insufficient AI credits for deduction.');
    }
    const newCredits = currentPromptBalance - amount;
    // Assuming 'aiCredits' is a valid field in your users table for updateProfile
    await storage.updateProfile(userId, { aiCredits: newCredits });
    log(`User ${userId} new AI credit balance: ${newCredits}`, 'vscode-ai');
  } else {
    log(`User ${userId} not found for AI credit deduction.`, 'vscode-ai');
    throw new Error(`User ${userId} not found for AI credit deduction.`);
  }
}

// Placeholder for logAIUsage function
// TODO: Implement this to log AI usage to your analytics or database
async function logAIUsage(userId: number, usageData: any): Promise<void> {
  log(`Logging AI usage for user ${userId}: ${JSON.stringify(usageData)}`, 'vscode-ai');
  // This would typically involve saving usage details to a database table.
  // Example: await db.insert(aiUsageLogs).values({ userId, ...usageData, timestamp: new Date() });
}

// Special exemption for VSCode API endpoints - disable CSRF to allow token-based auth
// VSCode extension will include JWT token in Authorization header but not CSRF token
router.post('/api/vscode/ai/completions', requireAuth, async (req: Request, res: Response) => {
  log('VSCode AI Completions request received', 'vscode-ai');
  try {
    const user = req.user;
    if (!user) {
      // requireAuth should handle this, but as a safeguard
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // 1. Estimate cost and check AI credits
    // Note: The plan suggests estimating before calling, but actual deduction after.
    // For simplicity in this stub, we'll do a preliminary check.
    // A more robust implementation might pre-authorize/hold credits.
    const estimatedCost = estimateRequestCost(req.body);
    log(`Estimated AI cost for user ${user.id}: ${estimatedCost} credits`, 'vscode-ai');

    // Fetch full user profile to get aiCredits, as req.user might be a partial object
    // However, requireAuth should populate req.user fully if deserializeUser does.
    // req.user type in auth.ts now includes aiCredits.
    // Using the narrowed 'user' variable which is guaranteed to be defined here.
    const currentPromptBalance = user.promptBalance || 0;
    if (currentPromptBalance < estimatedCost) {
      log(`User ${user.id} has insufficient AI credits (${currentPromptBalance}) for estimated cost (${estimatedCost})`, 'vscode-ai');
      return res.status(402).json({ // 402 Payment Required
        error: "Insufficient AI credits",
        message: "Please top up your AI credits to continue.",
        currentBalance: currentPromptBalance,
        requiredEstimate: estimatedCost
      });
    }

    // 2. Call Azure OpenAI (or other configured cloud AI provider)
    // TODO: Replace with actual call to your AI service/proxy layer
    // This service should use config.azureOpenaiEndpoint, config.azureOpenaiKey etc.
    log(`Proxying AI request for user ${user.id} to Azure OpenAI`, 'vscode-ai');

    // Ensure environment variables are loaded and available in config
    if (!config.azureOpenaiEndpoint || !config.azureOpenaiKey || !config.azureOpenaiDeploymentName || !config.azureOpenaiApiVersion) {
      log('Azure OpenAI configuration (endpoint, key, deploymentName, apiVersion) is missing or incomplete on the backend.', 'vscode-ai');
      console.error('Azure OpenAI configuration is missing. Please check .env and server/config.ts');
      return res.status(500).json({ error: 'AI service backend not configured properly. Missing Azure OpenAI details.' });
    }

    const azureRequestBody = { ...req.body };
    // Ensure model is not passed if your endpoint implies a specific deployment
    // Or, map req.body.model to your Azure deployment names if you support multiple
    // For now, assuming req.body is directly compatible or your Azure endpoint handles it.

    const azureUrl = `${config.azureOpenaiEndpoint}/openai/deployments/${config.azureOpenaiDeploymentName}/chat/completions?api-version=${config.azureOpenaiApiVersion}`;
    log(`Azure request URL: ${azureUrl}`, 'vscode-ai');

    const aiServiceResponse = await fetch(azureUrl, {
      method: 'POST',
      headers: {
        'api-key': config.azureOpenaiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(azureRequestBody) // Send the original request body from VSCode
    });

    if (!aiServiceResponse.ok) {
      const errorBody = await aiServiceResponse.text();
      log(`Azure OpenAI request failed with status ${aiServiceResponse.status}: ${errorBody}`, 'vscode-ai');
      return res.status(aiServiceResponse.status).json({
        error: 'AI service request failed',
        message: `Underlying AI service error: ${aiServiceResponse.statusText}`,
        details: errorBody
      });
    }

    const responseData = await aiServiceResponse.json();

    // 3. Calculate actual cost from usage and deduct credits
    if (responseData.usage && responseData.usage.prompt_tokens !== undefined && responseData.usage.completion_tokens !== undefined) {
      const actualCost = calculateTokenCost(
        responseData.usage.prompt_tokens,
        responseData.usage.completion_tokens
      );
      log(`Actual AI cost for user ${user.id}: ${actualCost} credits`, 'vscode-ai');
      try {
        await deductAICredits(user.id, actualCost);
      } catch (deductionError: any) {
        log(`Error deducting AI credits for user ${user.id}: ${deductionError.message}`, 'vscode-ai');
        // Fail the request to prevent free AI usage when deduction fails
        // This ensures users are charged for AI services or the request fails
        return res.status(500).json({ 
          error: 'Failed to process AI request',
          details: 'Credit deduction failed. Please try again or contact support.'
        });
      }

      // 4. Log usage for analytics
      await logAIUsage(user.id, {
        service: 'vscode-ai',
        model: azureRequestBody.model || config.azureOpenaiDeploymentName,
        inputTokens: responseData.usage.prompt_tokens,
        outputTokens: responseData.usage.completion_tokens,
        costInCredits: actualCost
      });
    } else {
      log(`Could not determine token usage from AI response for user ${user.id}. Credits not deducted. Response keys: ${Object.keys(responseData).join(', ')}`, 'vscode-ai');
    }

    // 5. Return response to VSCode extension
    log(`Successfully processed AI request for user ${user.id}`, 'vscode-ai');
    res.json(responseData);

  } catch (error: any) {
    log(`VSCode AI request processing error: ${error.message}`, 'vscode-ai');
    console.error('VSCode AI request failed:', error); // Keep console.error for more detailed stack trace if needed
    if (!res.headersSent) {
      res.status(500).json({
        error: 'AI service temporarily unavailable',
        message: error.message
      });
    }
  }
});

// Route without /api prefix for VSCode direct requests
router.post('/vscode/ai/chat/completions', passport.authenticate('jwt', { session: false, failWithError: false }), requireVSCodeAuth, (req: Request, res: Response) => {
  log('VSCode AI Chat Completions request received (no /api prefix)', 'vscode-ai');
  // Use the new handler that supports streaming responses
  return handleVSCodeAIChatCompletions(req, res);
});

// Additional endpoint for OpenAI client which appends /chat/completions to the base URL
// This matches the endpoint format that the OpenAI client expects
router.post('/api/vscode/ai/chat/completions', passport.authenticate('jwt', { session: false, failWithError: false }), requireVSCodeAuth, (req: Request, res: Response) => {
  log('VSCode AI Chat Completions request received', 'vscode-ai');
  // Use the new handler that supports streaming responses
  return handleVSCodeAIChatCompletions(req, res);
});

// --- VSCode Profile & Balance Endpoints ---
router.get('/api/vscode/profile', passport.authenticate('jwt', { session: false, failWithError: false }), requireVSCodeAuth, (req: Request, res: Response) => {
  log('VSCode Profile request received', 'vscode-profile');
  if (!req.user) {
    // This should ideally be caught by requireVSCodeAuth, but as a safeguard
    return res.status(401).json({ error: 'User not authenticated' });
  }
  // Construct the profile data expected by the VSCode extension
  const userProfileData = {
    id: req.user.id,
    username: req.user.username, // GitHub username
    name: req.user.name,         // Full name from GitHub
    email: req.user.email,
    avatarUrl: req.user.avatarUrl,
    promptBalance: req.user.promptBalance ?? 0, // Use promptBalance
    // Include other fields if the VSCode extension expects them from this endpoint
  };
  res.json({ user: userProfileData }); // Nest under 'user' key
});

router.get('/api/vscode/profile/balance', passport.authenticate('jwt', { session: false, failWithError: false }), requireVSCodeAuth, (req: Request, res: Response) => {
  log('VSCode Profile Balance request received', 'vscode-profile');
  if (!req.user) {
    return res.status(401).json({ error: 'User not authenticated' });
  }
  res.json({
    balance: req.user.promptBalance ?? 0, // Use promptBalance, key is 'balance'
    // Optionally, if ROXN token balance or XDC balance is also needed here:
    // roxnBalance: (await blockchain.getTokenBalance(req.user.xdcWalletAddress!)).toString(), // Example
    // xdcBalance: (await blockchain.getWalletInfo(req.user.id)).balance.toString(), // Example
  });
});

export default router;

