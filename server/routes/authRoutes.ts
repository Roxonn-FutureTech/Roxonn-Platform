import { Router, Request, Response } from 'express';
import jwt, { SignOptions } from 'jsonwebtoken';
import { requireAuth } from '../auth';
import { config } from '../config';
import { log } from '../utils';

const router = Router();

// New route for VSCode onboarding finalization
router.get('/auth/vscode/finalize-onboarding', requireAuth, (req: Request, res: Response) => {
  if (!req.user) {
    log('VSCode finalize: No user in session. Should have been caught by requireAuth.', 'auth-ERROR');
    return res.redirect(`${config.frontendUrl}/auth?error=session_expired_for_vscode_finalize`);
  }

  // Accessing session property correctly
  // Ensure SessionData in server/auth.ts includes isVscodeOnboarding
  if (!(req.session as any).isVscodeOnboarding) {
    log(`VSCode finalize: Not a VSCode onboarding flow for user ${req.user.id} or session flag missing. Redirecting to web app.`, 'auth-WARN');
    if (req.session) {
      delete (req.session as any).isVscodeOnboarding;
    }
    // It's important to save the session if a property is deleted.
    req.session.save(err => {
      if (err) { log(`Error saving session after deleting isVscodeOnboarding flag: ${err}`, 'auth-ERROR'); }
      return res.redirect(`${config.frontendUrl}/repos`);
    });
    return; // Ensure no further code execution after redirect
  }

  if (!req.user.isProfileComplete) {
    log(`VSCode finalize: User ${req.user.id} profile still not complete. Redirecting back to web onboarding.`, 'auth-ERROR');
    if (req.session) {
      delete (req.session as any).isVscodeOnboarding;
    }
    req.session.save(err => {
      if (err) { log(`Error saving session for profile incomplete redirect: ${err}`, 'auth-ERROR'); }
      return res.redirect(`${config.frontendUrl}/auth?registration=true&from_vscode=true&error=profile_incomplete_after_onboarding`);
    });
    return; // Ensure no further code execution
  }

  log(`VSCode finalize: User ${req.user.id} completed web onboarding. Generating JWT.`, 'auth');

  if (!req.user.githubAccessToken) {
    log('CRITICAL: githubAccessToken missing on req.user during VSCode JWT finalization.', 'auth-ERROR');
    if (req.session) {
      delete (req.session as any).isVscodeOnboarding;
    }
    req.session.save(err => {
      if (err) { log(`Error saving session for missing token data redirect: ${err}`, 'auth-ERROR'); }
      return res.redirect(`vscode://roxonn.roxonn-code/auth?error=missing_token_data_finalize`);
    });
    return; // Ensure no further code execution
  }

  const jwtPayload: Express.User = { // Using Express.User type
    id: req.user.id,
    githubId: req.user.githubId,
    username: req.user.username,
    githubUsername: req.user.githubUsername,
    email: req.user.email,
    avatarUrl: req.user.avatarUrl,
    role: req.user.role,
    xdcWalletAddress: req.user.xdcWalletAddress,
    promptBalance: req.user.promptBalance ?? 0,
    isProfileComplete: req.user.isProfileComplete, // Should be true
    githubAccessToken: req.user.githubAccessToken,
    name: req.user.name,
    walletReferenceId: req.user.walletReferenceId,
  };

  if (!config.sessionSecret) {
    log('CRITICAL: JWT secret (config.sessionSecret) is not defined. Cannot issue token for VSCode finalize.', 'auth-ERROR');
    if (req.session) {
      delete (req.session as any).isVscodeOnboarding;
    }
    req.session.save(err => {
      if (err) { log(`Error saving session for jwt secret missing redirect: ${err}`, 'auth-ERROR'); }
      return res.redirect(`vscode://roxonn.roxonn-code/auth?error=jwt_secret_missing_finalize`);
    });
    return; // Ensure no further code execution
  }

  const tokenOptions: SignOptions = {
    expiresIn: '30d' // Using hardcoded value that worked in auth.ts
  };
  const token = jwt.sign(jwtPayload as object, config.sessionSecret, tokenOptions);

  if (req.session) {
    delete (req.session as any).isVscodeOnboarding;
  }

  req.session.save(err => {
    if (err) {
      log(`Error saving session before final VSCode redirect: ${err}`, 'auth-ERROR');
      // Even if session save fails, attempt to redirect the user as the token is generated.
      // However, the session might not be cleaned up properly on the server.
    }
    const vscodeRedirectUrl = `vscode://roxonn.roxonn-code/auth?token=${token}`;
    log(`Redirecting fully onboarded VSCode user to: ${vscodeRedirectUrl}`, 'auth');
    return res.redirect(vscodeRedirectUrl);
  });
});

export default router;

