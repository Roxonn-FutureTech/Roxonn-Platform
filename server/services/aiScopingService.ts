import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { PredictionServiceClient } from '@google-cloud/aiplatform';
import { config } from '../config'; // Assuming config will hold GCP details

// Allowed upload directories for security
const ALLOWED_UPLOAD_DIRS = [
  path.join(os.tmpdir()),
  path.join(process.cwd(), 'uploads'),
];

/**
 * Validates and sanitizes a file path to prevent path traversal attacks.
 * Returns a safe path constructed from a known-safe base directory and validated filename.
 * @param filePath The file path to validate
 * @returns A safe path string or null if validation fails
 */
function getSafeFilePath(filePath: string): string | null {
  if (!filePath || typeof filePath !== 'string') {
    return null;
  }

  // Normalize and resolve the path first
  const normalizedPath = path.resolve(path.normalize(filePath));

  // Check if the path is within any of the allowed directories
  const isInAllowedDir = ALLOWED_UPLOAD_DIRS.some(allowedDir => {
    const normalizedAllowedDir = path.resolve(path.normalize(allowedDir));
    return normalizedPath.startsWith(normalizedAllowedDir + path.sep);
  });

  if (!isInAllowedDir) {
    return null;
  }

  // Extract just the filename and validate it
  const filename = path.basename(normalizedPath);

  // Validate filename doesn't contain path traversal characters
  // Check for any forbidden sequences (.., /, \) in filename using a single regex
  if (!filename || /(\.\.|[\/\\])/.test(filename)) {
    return null;
  }

  // Only allow alphanumeric, dots, hyphens, underscores in filename
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
    return null;
  }

  // Find which allowed directory this file is in
  for (const allowedDir of ALLOWED_UPLOAD_DIRS) {
    const normalizedAllowedDir = path.resolve(path.normalize(allowedDir));
    if (normalizedPath.startsWith(normalizedAllowedDir + path.sep)) {
      // Construct safe path from known-safe base + validated filename
      // This ensures the scanner sees we're not using user input directly
      return path.join(normalizedAllowedDir, filename);
    }
  }

  return null;
}

// Initialize the Vertex AI Prediction Service Client
const clientOptions = {
  apiEndpoint: 'us-central1-aiplatform.googleapis.com',
};
const predictionServiceClient = new PredictionServiceClient(clientOptions);

/**
 * Processes the uploaded document using Google Cloud Vertex AI's Gemini model.
 *
 * @param filePath The path to the uploaded document.
 * @returns A structured project plan.
 */
export async function processDocument(filePath: string): Promise<any> {
  console.log('[AI Scoping Service] Starting REAL processing for uploaded file');

  // Validate and get safe file path to prevent path traversal attacks
  const safePath = getSafeFilePath(filePath);
  if (!safePath) {
    console.error('[AI Scoping Service] Rejected unsafe file path');
    throw new Error('Invalid file path: path traversal detected or path outside allowed directories.');
  }

  console.log('[AI Scoping Service] File path validated successfully');

  try {
    const documentContent = await fs.readFile(safePath, 'utf-8');

    // These would be loaded from config, which gets them from .env
    if (!config.gcpProjectId) {
      throw new Error('Missing required configuration: GCP Project ID (config.gcpProjectId)');
    }
    const project = config.gcpProjectId;
    if (!config.gcpLocation) {
      throw new Error('Missing required configuration: GCP Location (config.gcpLocation)');
    }
    const location = config.gcpLocation;
    const publisher = 'google';
    const model = 'gemini-1.5-flash-001';

    // The model path for the generateContent method
    const modelPath = `projects/${project}/locations/${location}/publishers/${publisher}/models/${model}`;

    const systemPrompt = `You are an expert software project manager. Your task is to analyze the following document and break it down into a comprehensive project plan. The output MUST be a valid JSON object with the following structure: { "projectName": string, "summary": string, "tasks": [{ "id": number, "title": string, "description": string, "dependencies": number[], "estimatedComplexity": "low"|"medium"|"high" }] }. For each task, provide a clear title and a detailed description suitable for a developer to begin work. Identify any dependencies between tasks.`;

    const fullPrompt = `${systemPrompt}\n\n--- DOCUMENT START ---\n\n${documentContent}\n\n--- DOCUMENT END ---`;

    const request = {
      model: modelPath,
      contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
      generationConfig: {
        temperature: 0.2,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 8192,
      },
    };

    console.log(`[AI Scoping Service] Sending request to Vertex AI with model: ${modelPath}`);
    
    // Use the generateContent method
    const [response] = await predictionServiceClient.generateContent(request);
    
    if (!response.candidates || response.candidates.length === 0) {
      throw new Error('Received no candidates from Vertex AI.');
    }

    const candidate = response.candidates[0];
    
    if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
        throw new Error('Could not extract content parts from Vertex AI response.');
    }

    const rawJsonText = candidate.content.parts[0].text
      ?.replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();

    if (!rawJsonText) {
        throw new Error('Extracted text from AI response is empty.');
    }

    console.log('[AI Scoping Service] Received raw JSON text from AI:', rawJsonText);
    
    // Parse the cleaned text to get the final JSON object
    const plan = JSON.parse(rawJsonText);

    console.log('[AI Scoping Service] Plan generated successfully');
    return plan;

  } catch (error) {
    console.error('[AI Scoping Service] Error interacting with Vertex AI:', error);
    throw new Error('Failed to generate project plan from document.');
  } finally {
    // Clean up the uploaded file after processing (using validated safe path)
    try {
      await fs.unlink(safePath);
      console.log('[AI Scoping Service] Cleaned up temporary file successfully');
    } catch (unlinkError) {
      console.error('[AI Scoping Service] Failed to clean up temporary file:', unlinkError);
    }
  }
}
