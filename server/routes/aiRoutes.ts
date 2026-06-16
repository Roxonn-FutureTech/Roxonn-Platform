import { Router, Request, Response } from 'express';
import passport from 'passport';
import { requireVSCodeAuth } from '../auth';
import { handleVSCodeAIChatCompletions } from '../vscode-ai-handler';
import { log } from '../utils';

const router = Router();

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
