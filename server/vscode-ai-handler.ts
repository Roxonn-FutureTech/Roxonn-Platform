// Special handler for VSCode AI requests with support for streaming responses
import { Request, Response } from 'express';
import fetch from 'node-fetch';
import { log } from './utils';
import { config } from './config';
import { handleOpenAIStream } from './openai-stream';
import { db } from './db'; // Import db for transactions
import { storage } from './storage'; // Import storage for new prompt functions

// Helper function for delay
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to safely extract a note string from messages
function getNoteFromMessages(messages: Array<{ role: string, content: string | any[] }>): string {
  const lastUserMessage = messages.filter(m => m.role === 'user').pop();
  if (lastUserMessage) {
    if (typeof lastUserMessage.content === 'string') {
      return lastUserMessage.content.substring(0, 70);
    } else if (Array.isArray(lastUserMessage.content)) {
      const textPart = lastUserMessage.content.find(part => part.type === 'text');
      return textPart ? textPart.text.substring(0, 70) : 'Multimodal User Prompt';
    }
  }
  return 'User Prompt';
}

async function logInternalTokenUsage(userId: number, usageData: {
  service: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  log(`Internal Token Usage for user ${userId}: ${JSON.stringify(usageData)}`, 'vscode-ai-token-log');
}

export interface AzureOpenAIRequestBody {
  messages: Array<{ role: string, content: string | Array<{ type: string, text?: string, image_url?: { url: string, detail?: string } }> }>;
  modelId?: string;
  model?: string;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  n?: number;
  [key: string]: any;
}

export async function handleVSCodeAIChatCompletions(req: Request, res: Response) {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const currentPromptBalance = await storage.getUserPromptBalance(user.id);
    if (currentPromptBalance <= 0) {
      log(`User ${user.id} has insufficient prompts. Balance: ${currentPromptBalance}`, 'vscode-ai');
      return res.status(402).json({
        error: "Insufficient prompts",
        message: "You have no prompts remaining. Please purchase a prompt pack to continue.",
        currentBalance: currentPromptBalance
      });
    }
    log(`User ${user.id} has ${currentPromptBalance} prompts. Proceeding with AI request.`, 'vscode-ai');

    const azureRequestBody = { ...req.body } as AzureOpenAIRequestBody;
    // Prioritize `model` field from request body, then `modelId`, then default.
    // Client's OpenAIHandler sends the identifier in the `model` field.
    const requestedModelId = azureRequestBody.model || azureRequestBody.modelId || 'default';
    let selectedEndpoint: string | undefined;
    let selectedApiKey: string | undefined;
    let selectedDeploymentName: string | undefined;
    let selectedApiVersion: string | undefined;
    let actualModelNameForLog: string;

    log(`User ${user.id} requested modelId: '${requestedModelId}'`, 'vscode-ai');

    if (requestedModelId === 'deepseek-r1') {
      selectedEndpoint = config.azureOpenaiEndpointDeepSeek;
      selectedApiKey = config.azureOpenaiKeyDeepSeek;
      selectedDeploymentName = config.azureOpenaiDeploymentNameDeepSeek;
      selectedApiVersion = config.azureOpenaiApiVersionDeepSeek;
      actualModelNameForLog = azureRequestBody.model || selectedDeploymentName || 'DeepSeek-R1';
      log(`Using DeepSeek-R1 configuration for user ${user.id}`, 'vscode-ai');
    } else if (requestedModelId === 'gpt-4o-mini') {
      selectedEndpoint = config.azureOpenaiEndpointO4Mini;
      selectedApiKey = config.azureOpenaiKeyO4Mini;
      selectedDeploymentName = config.azureOpenaiDeploymentNameO4Mini;
      selectedApiVersion = config.azureOpenaiApiVersionO4Mini;
      actualModelNameForLog = azureRequestBody.model || selectedDeploymentName || 'gpt-4o-mini';
      log(`Using o4-mini (gpt-4o-mini) configuration for user ${user.id}`, 'vscode-ai');
    } else if (requestedModelId === 'o3-mini') { // Client will send 'o3-mini'
      selectedEndpoint = config.azureOpenaiEndpointO3Mini;
      selectedApiKey = config.azureOpenaiKeyO3Mini;
      selectedDeploymentName = config.azureOpenaiDeploymentNameO3Mini;
      selectedApiVersion = config.azureOpenaiApiVersionO3Mini;
      actualModelNameForLog = azureRequestBody.model || selectedDeploymentName || 'o3-mini';
      log(`Using o3-mini configuration for user ${user.id}`, 'vscode-ai');
    } else if (requestedModelId === 'gpt-4.1') { // Client will send 'gpt-4.1'
      selectedEndpoint = config.azureOpenaiEndpointGpt41;
      selectedApiKey = config.azureOpenaiKeyGpt41;
      selectedDeploymentName = config.azureOpenaiDeploymentNameGpt41;
      selectedApiVersion = config.azureOpenaiApiVersionGpt41;
      actualModelNameForLog = azureRequestBody.model || selectedDeploymentName || 'gpt-4.1';
      log(`Using gpt-4.1 configuration for user ${user.id}`, 'vscode-ai');
    } else if (requestedModelId === 'ministral-3b') {
      selectedEndpoint = config.azureOpenaiEndpointMinistral3B;
      selectedApiKey = config.azureOpenaiKeyMinistral3B;
      selectedDeploymentName = config.azureOpenaiDeploymentNameMinistral3B;
      selectedApiVersion = config.azureOpenaiApiVersionMinistral3B;
      actualModelNameForLog = azureRequestBody.model || selectedDeploymentName || 'Ministral-3B';
      log(`Using Ministral-3B configuration for user ${user.id}`, 'vscode-ai');
    } else if (requestedModelId === 'grok-3') {
      selectedEndpoint = config.azureOpenaiEndpointGrok;
      selectedApiKey = config.azureOpenaiKeyGrok;
      selectedDeploymentName = config.azureOpenaiDeploymentNameGrok3;
      selectedApiVersion = config.azureOpenaiApiVersionGrok;
      actualModelNameForLog = azureRequestBody.model || selectedDeploymentName || 'grok-3';
      log(`Using grok-3 configuration for user ${user.id}`, 'vscode-ai');
    } else if (requestedModelId === 'grok-3-mini') {
      selectedEndpoint = config.azureOpenaiEndpointGrok; // Uses same endpoint as grok-3
      selectedApiKey = config.azureOpenaiKeyGrok; // Uses same key as grok-3
      selectedDeploymentName = config.azureOpenaiDeploymentNameGrok3Mini;
      selectedApiVersion = config.azureOpenaiApiVersionGrok; // Uses same api version as grok-3
      actualModelNameForLog = azureRequestBody.model || selectedDeploymentName || 'grok-3-mini';
      log(`Using grok-3-mini configuration for user ${user.id}`, 'vscode-ai');
    } else {
      selectedEndpoint = config.azureOpenaiEndpoint;
      selectedApiKey = config.azureOpenaiKey;
      selectedDeploymentName = config.azureOpenaiDeploymentName;
      selectedApiVersion = config.azureOpenaiApiVersion;
      actualModelNameForLog = azureRequestBody.model || selectedDeploymentName || 'DefaultAzureOpenAI';
      if (requestedModelId !== 'default') {
        log(`Requested modelId '${requestedModelId}' not recognized, defaulting to original Azure OpenAI config for user ${user.id}`, 'vscode-ai-WARN');
      } else {
        log(`Using default Azure OpenAI configuration for user ${user.id}`, 'vscode-ai');
      }
    }

    if (!selectedEndpoint || !selectedApiKey || !selectedDeploymentName || !selectedApiVersion) {
      log(`Selected AI model configuration for '${requestedModelId}' is missing or incomplete on the backend.`, 'vscode-ai-ERROR');
      return res.status(500).json({ error: `AI service backend not configured properly for model '${requestedModelId}'.` });
    }

    log(`Proxying AI request for user ${user.id} to ${selectedDeploymentName}`, 'vscode-ai');
    const isStreamingRequest = azureRequestBody.stream === true;
    log(`Request is${isStreamingRequest ? '' : ' not'} using streaming mode`, 'vscode-ai');

    let azureUrl: string;
    // Add grok models to this list as they also use the /models/chat/completions path
    const modelsUsingCustomPath = ['deepseek-r1', 'ministral-3b', 'grok-3', 'grok-3-mini'];

    if (modelsUsingCustomPath.includes(requestedModelId)) {
      // Use the specific path structure for these models
      azureUrl = `${selectedEndpoint}/models/chat/completions?api-version=${selectedApiVersion}`;
    } else {
      // Standard Azure OpenAI path structure
      azureUrl = `${selectedEndpoint}/openai/deployments/${selectedDeploymentName}/chat/completions?api-version=${selectedApiVersion}`;
    }
    log(`Azure request URL: ${azureUrl}`, 'vscode-ai');

    const { modelId: internalModelId, ...payloadBase } = azureRequestBody;
    let finalPayloadForAzure = { ...payloadBase };

    if (modelsUsingCustomPath.includes(requestedModelId)) {
      // For these models, Azure expects the specific model/deployment name in the 'model' field of the payload.
      // selectedDeploymentName holds the correct value (e.g., "DeepSeek-R1", "Ministral-3B", "grok-3", "grok-3-mini").
      finalPayloadForAzure.model = selectedDeploymentName;
      log(`Ensured payload model for ${requestedModelId} is set to: ${selectedDeploymentName}`, 'vscode-ai-DEBUG');
    }
    // For standard Azure OpenAI deployments, the 'model' field in the payload is often optional
    // or can be the base model name, as the deployment name in the URL path specifies the exact model.
    // We pass through what the client sent in `azureRequestBody.model` if it's not a custom path model.

    let aiServiceResponse: import('node-fetch').Response | undefined;
    let lastError: any;
    const maxRetries = 3; // Max 3 retries (total 4 attempts)
    let currentDelay = 1000; // Initial delay 1 second

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        log(`Attempt ${attempt + 1}/${maxRetries + 1} to call Azure OpenAI for user ${user.id}, model ${selectedDeploymentName}`, 'vscode-ai-DEBUG');
        const response = await fetch(azureUrl, {
          method: 'POST',
          headers: { 'api-key': selectedApiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(finalPayloadForAzure)
        });

        if (response.status === 429 && attempt < maxRetries) {
          const retryAfterHeader = response.headers.get('retry-after');
          let waitTime = currentDelay;
          if (retryAfterHeader) {
            const retryAfterSeconds = parseInt(retryAfterHeader, 10);
            if (!isNaN(retryAfterSeconds)) {
              waitTime = retryAfterSeconds * 1000; // Convert seconds to ms
            }
          }

          lastError = `Status 429: Rate limited. Retry-After: ${retryAfterHeader || 'N/A'}.`;
          log(`Azure OpenAI request to ${selectedDeploymentName} was rate limited (attempt ${attempt + 1}). Waiting ${waitTime}ms. ${lastError}`, 'vscode-ai-WARN');
          await delay(waitTime);
          currentDelay = Math.min(currentDelay * 2, 30000); // Exponential backoff, cap at 30s
          continue;
        }

        aiServiceResponse = response;
        break;
      } catch (fetchError: any) {
        lastError = fetchError.message || fetchError;
        log(`Fetch error during Azure OpenAI request (attempt ${attempt + 1}): ${lastError}`, 'vscode-ai-ERROR');
        if (attempt < maxRetries) {
          await delay(currentDelay);
          currentDelay = Math.min(currentDelay * 2, 30000);
        }
      }
    }

    if (!aiServiceResponse) {
      log(`Azure OpenAI request to ${selectedDeploymentName} failed after ${maxRetries + 1} attempts. Last error: ${JSON.stringify(lastError)}`, 'vscode-ai-ERROR');
      return res.status(503).json({ // Service Unavailable after retries
        error: 'AI service request failed after multiple retries',
        message: 'The AI service is currently experiencing high load or an issue. Please try again later.',
        details: lastError
      });
    }

    if (!aiServiceResponse.ok) {
      // This handles non-429 errors that are not retried, or the final error after retries if it's still not .ok
      const errorBody = await aiServiceResponse.text();
      log(`Azure OpenAI request to ${selectedDeploymentName} failed with status ${aiServiceResponse.status}: ${errorBody}`, 'vscode-ai-ERROR');
      return res.status(aiServiceResponse.status).json({
        error: 'AI service request failed',
        message: `Underlying AI service error: ${aiServiceResponse.statusText || `Status Code: ${aiServiceResponse.status}`}`,
        details: errorBody
      });
    }

    if (isStreamingRequest) {
      log(`Handling streaming response for user ${user.id}`, 'vscode-ai');
      try {
        const usageData = await handleOpenAIStream(aiServiceResponse, res, user.id, azureRequestBody);
        if (usageData.promptTokens !== undefined && usageData.completionTokens !== undefined) {
          await logInternalTokenUsage(user.id, {
            service: 'vscode-ai-chat-stream', model: actualModelNameForLog,
            inputTokens: usageData.promptTokens, outputTokens: usageData.completionTokens,
          });
          try {
            await db.transaction(async (tx) => {
              const deductionResult = await storage.adjustUserPromptBalance(
                tx, user.id, -1, 'usage_vscode_ai',
                `VSCode AI Stream (${actualModelNameForLog}): ${getNoteFromMessages(azureRequestBody.messages)}`
              );
              if (!deductionResult.success) {
                log(`CRITICAL: Prompt deduction FAILED for user ${user.id} (model: ${actualModelNameForLog}) after AI stream: ${deductionResult.error}. Balance might be incorrect.`, 'vscode-ai-ERROR');
              } else {
                log(`Successfully deducted 1 prompt for user ${user.id} after AI stream. New balance: ${deductionResult.newBalance}`, 'vscode-ai');
              }
            });
          } catch (dbError: any) {
            log(`CRITICAL: DB transaction error during prompt deduction for user ${user.id} after AI stream: ${dbError.message}. Balance might be incorrect.`, 'vscode-ai-ERROR');
          }
        } else {
          log(`No token usage data from stream for user ${user.id}. Prompt not deducted for this stream.`, 'vscode-ai');
        }
        return;
      } catch (streamingError: any) {
        log(`Error in streaming handler for user ${user.id}: ${streamingError.message || streamingError}`, 'vscode-ai');
        if (!res.headersSent) {
          return res.status(500).json({ error: 'Streaming error', message: streamingError.message || 'Unknown error' });
        }
        return;
      }
    }

    const responseData: any = await aiServiceResponse.json();
    if (responseData.usage && responseData.usage.prompt_tokens !== undefined && responseData.usage.completion_tokens !== undefined) {
      await logInternalTokenUsage(user.id, {
        service: 'vscode-ai-chat-nonstream', model: actualModelNameForLog,
        inputTokens: responseData.usage.prompt_tokens, outputTokens: responseData.usage.completion_tokens,
      });
      try {
        await db.transaction(async (tx) => {
          const deductionResult = await storage.adjustUserPromptBalance(
            tx, user.id, -1, 'usage_vscode_ai',
            `VSCode AI Non-Stream (${actualModelNameForLog}): ${getNoteFromMessages(azureRequestBody.messages)}`
          );
          if (!deductionResult.success) {
            log(`CRITICAL: Prompt deduction FAILED for user ${user.id} (model: ${actualModelNameForLog}) after AI non-stream: ${deductionResult.error}. Balance might be incorrect.`, 'vscode-ai-ERROR');
          } else {
            log(`Successfully deducted 1 prompt for user ${user.id} after AI non-stream. New balance: ${deductionResult.newBalance}`, 'vscode-ai');
          }
        });
      } catch (dbError: any) {
        log(`CRITICAL: DB transaction error during prompt deduction for user ${user.id} after AI non-stream: ${dbError.message}. Balance might be incorrect.`, 'vscode-ai-ERROR');
      }
    } else {
      log(`No token usage data from non-streaming AI response for user ${user.id}. Prompt not deducted.`, 'vscode-ai');
    }

    log(`Successfully processed non-streaming AI chat request for user ${user.id}`, 'vscode-ai');
    return res.json(responseData);
  } catch (error: any) {
    log(`VSCode AI chat request processing error for user ${req.user?.id || 'unknown'}: ${error.message || error}`, 'vscode-ai-ERROR');
    console.error('VSCode AI chat request failed:', error);
    if (!res.headersSent) {
      return res.status(500).json({
        error: 'AI service temporarily unavailable',
        message: error.message || 'Unknown error'
      });
    }
  }
}
