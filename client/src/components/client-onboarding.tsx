// Client/Pool Manager Onboarding Tutorial Component
import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useOnboarding } from '@/hooks/use-onboarding';
import { useAuth } from '@/hooks/use-auth';
import {
  Coins,
  Github,
  ExternalLink,
  CheckCircle2,
  ArrowRight,
  ArrowLeft,
  Zap,
  Users,
  DollarSign,
  FileCode,
  HelpCircle,
  MessageSquare,
  Wallet
} from 'lucide-react';
import { Progress } from '@/components/ui/progress';

// Create a function to manually show the client onboarding
export const showClientOnboarding = () => {
  localStorage.setItem('roxonn-onboarding-hasSeenClientOnboarding', 'false');
  window.dispatchEvent(new Event('storage'));
};

interface OnboardingStep {
  id: number;
  title: string;
  description: string;
}

const ONBOARDING_STEPS: OnboardingStep[] = [
  { id: 1, title: 'Welcome', description: 'Learn what you can do as a client' },
  { id: 2, title: 'How It Works', description: 'Understand the bounty lifecycle' },
  { id: 3, title: 'Add Funds', description: 'Buy USDC to fund bounties' },
  { id: 4, title: 'GitHub App', description: 'Install the GitHub App' },
  { id: 5, title: 'Try It Out', description: 'Create your first bounty' },
  { id: 6, title: 'Complete', description: 'You\'re ready to go!' },
];

export function ClientOnboarding() {
  const { hasSeenGuide, setHasSeen } = useOnboarding('hasSeenClientOnboarding', false);
  const [isOpen, setIsOpen] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const { user } = useAuth();

  // Only show for pool managers (clients)
  const isClient = user?.role === "poolmanager";

  const handleClose = () => {
    setIsOpen(false);
    setHasSeen(true);
  };

  const handleNext = () => {
    if (currentStep < ONBOARDING_STEPS.length) {
      setCurrentStep(currentStep + 1);
    } else {
      handleClose();
    }
  };

  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleSkip = () => {
    handleClose();
  };

  // Initialization and open/close logic
  useEffect(() => {
    setIsInitialized(true);
    const handleStorageChange = () => {
      const value = localStorage.getItem('roxonn-onboarding-hasSeenClientOnboarding');
      if (value === 'false') {
        setCurrentStep(1);
        setIsOpen(true);
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  // Check if we should show the dialog
  useEffect(() => {
    if (isInitialized && !hasSeenGuide && isClient) {
      setIsOpen(true);
    }
  }, [hasSeenGuide, isInitialized, isClient]);

  // Only render when initialized and for clients
  if (!isInitialized || !isClient) {
    return null;
  }

  const progressPercent = ((currentStep - 1) / (ONBOARDING_STEPS.length - 1)) * 100;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => {
      setIsOpen(open);
      if (!open) setHasSeen(true);
    }}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        {/* Progress indicator */}
        <div className="mb-4">
          <Progress value={progressPercent} className="h-2" />
          <div className="flex justify-between mt-2 text-xs text-muted-foreground">
            {ONBOARDING_STEPS.map((step) => (
              <span
                key={step.id}
                className={currentStep >= step.id ? 'text-primary font-medium' : ''}
              >
                {step.title}
              </span>
            ))}
          </div>
        </div>

        {/* Step 1: Welcome */}
        {currentStep === 1 && (
          <>
            <DialogHeader>
              <div className="flex justify-center mb-4">
                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                  <span className="text-4xl">👋</span>
                </div>
              </div>
              <DialogTitle className="text-2xl text-center">Welcome to Roxonn!</DialogTitle>
              <DialogDescription className="text-center">
                You're registered as a <span className="font-semibold text-foreground">Client (Pool Manager)</span>
              </DialogDescription>
            </DialogHeader>

            <div className="py-6">
              <div className="bg-blue-50 dark:bg-blue-950/50 p-6 rounded-lg border border-blue-200 dark:border-blue-800">
                <h3 className="font-semibold mb-4 text-blue-800 dark:text-blue-300">As a client, you can:</h3>
                <ul className="space-y-3">
                  <li className="flex items-start gap-3">
                    <CheckCircle2 className="h-5 w-5 text-green-500 mt-0.5 flex-shrink-0" />
                    <span className="text-sm">Create bounties on any GitHub issue</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <CheckCircle2 className="h-5 w-5 text-green-500 mt-0.5 flex-shrink-0" />
                    <span className="text-sm">Attract top developers to your projects</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <CheckCircle2 className="h-5 w-5 text-green-500 mt-0.5 flex-shrink-0" />
                    <span className="text-sm">Pay only when work is merged</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <CheckCircle2 className="h-5 w-5 text-green-500 mt-0.5 flex-shrink-0" />
                    <span className="text-sm">Lowest fees in the industry (5% total)</span>
                  </li>
                </ul>
              </div>

              <p className="text-center text-muted-foreground mt-6">
                Let's get you started in 5 quick steps!
              </p>
            </div>

            <DialogFooter className="flex justify-between sm:justify-between">
              <Button variant="ghost" onClick={handleSkip}>
                Skip Tutorial
              </Button>
              <Button onClick={handleNext}>
                Let's Go! <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </DialogFooter>
          </>
        )}

        {/* Step 2: How It Works */}
        {currentStep === 2 && (
          <>
            <DialogHeader>
              <div className="flex justify-center mb-4">
                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                  <Coins className="h-8 w-8 text-primary" />
                </div>
              </div>
              <DialogTitle className="text-2xl text-center">How Bounties Work</DialogTitle>
            </DialogHeader>

            <div className="py-6 space-y-6">
              <div className="space-y-4">
                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 rounded-full bg-purple-600 text-white flex items-center justify-center font-bold flex-shrink-0">
                    1
                  </div>
                  <div>
                    <h4 className="font-semibold">Find a GitHub issue you want solved</h4>
                    <p className="text-sm text-muted-foreground">In your own repos or any public repository</p>
                  </div>
                </div>

                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 rounded-full bg-purple-600 text-white flex items-center justify-center font-bold flex-shrink-0">
                    2
                  </div>
                  <div>
                    <h4 className="font-semibold">Comment to create a bounty</h4>
                    <p className="text-sm text-muted-foreground">Use <code className="bg-muted px-2 py-0.5 rounded">/bounty 100 USDC</code> on any issue</p>
                  </div>
                </div>

                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 rounded-full bg-purple-600 text-white flex items-center justify-center font-bold flex-shrink-0">
                    3
                  </div>
                  <div>
                    <h4 className="font-semibold">Funds held in escrow</h4>
                    <p className="text-sm text-muted-foreground">USDC from your wallet is securely locked until work is done</p>
                  </div>
                </div>

                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 rounded-full bg-purple-600 text-white flex items-center justify-center font-bold flex-shrink-0">
                    4
                  </div>
                  <div>
                    <h4 className="font-semibold flex items-center gap-2">
                      Developer submits PR → Auto-paid on merge!
                      <Zap className="h-4 w-4 text-yellow-500" />
                    </h4>
                    <p className="text-sm text-muted-foreground">Fully automatic. No manual approval needed.</p>
                  </div>
                </div>
              </div>

              <div className="bg-green-50 dark:bg-green-950/50 p-4 rounded-lg border border-green-200 dark:border-green-800">
                <p className="text-sm">
                  <span className="font-semibold">Fees:</span> 5% total (2.5% from you, 2.5% from contributor)
                  <br />
                  <span className="italic text-muted-foreground">Lowest in the industry - competitors charge 10-23%!</span>
                </p>
              </div>
            </div>

            <DialogFooter className="flex justify-between sm:justify-between">
              <Button variant="outline" onClick={handleBack}>
                <ArrowLeft className="mr-2 h-4 w-4" /> Back
              </Button>
              <Button onClick={handleNext}>
                Next <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </DialogFooter>
          </>
        )}

        {/* Step 3: Add Funds */}
        {currentStep === 3 && (
          <>
            <DialogHeader>
              <div className="flex justify-center mb-4">
                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                  <Wallet className="h-8 w-8 text-primary" />
                </div>
              </div>
              <DialogTitle className="text-2xl text-center">Add Funds to Your Wallet</DialogTitle>
              <DialogDescription className="text-center">
                Buy USDC to start funding bounties
              </DialogDescription>
            </DialogHeader>

            <div className="py-6 space-y-6">
              <div className="bg-blue-50 dark:bg-blue-950/50 p-6 rounded-lg border border-blue-200 dark:border-blue-800">
                <h3 className="font-semibold mb-4 text-blue-800 dark:text-blue-300">How to Add USDC:</h3>

                <div className="space-y-4">
                  <div className="flex items-start gap-4">
                    <div className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center font-bold flex-shrink-0">
                      1
                    </div>
                    <div>
                      <h4 className="font-semibold">Go to your Wallet page</h4>
                      <p className="text-sm text-muted-foreground">
                        Click "Wallet" in the navigation menu or <a href="/wallet" className="text-primary underline">click here</a>
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-4">
                    <div className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center font-bold flex-shrink-0">
                      2
                    </div>
                    <div>
                      <h4 className="font-semibold">Click "Buy USDC"</h4>
                      <p className="text-sm text-muted-foreground">
                        Opens secure payment window via Onramp.money
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-4">
                    <div className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center font-bold flex-shrink-0">
                      3
                    </div>
                    <div>
                      <h4 className="font-semibold">Pay with card or bank transfer</h4>
                      <p className="text-sm text-muted-foreground">
                        Supports EUR, USD, GBP, INR, and 50+ other currencies
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-4">
                    <div className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center font-bold flex-shrink-0">
                      4
                    </div>
                    <div>
                      <h4 className="font-semibold flex items-center gap-2">
                        Receive USDC in your Roxonn wallet
                        <Zap className="h-4 w-4 text-yellow-500" />
                      </h4>
                      <p className="text-sm text-muted-foreground">
                        Usually instant - you'll see the balance update within seconds
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="bg-green-50 dark:bg-green-950/50 p-4 rounded-lg border border-green-200 dark:border-green-800">
                <p className="text-sm">
                  <span className="font-semibold text-green-800 dark:text-green-300">Why USDC?</span><br />
                  <span className="text-muted-foreground">
                    USDC is a stablecoin pegged to the US Dollar (1 USDC = $1). It's the easiest way to fund bounties without crypto price volatility. You can also use XDC or ROXN tokens.
                  </span>
                </p>
              </div>

              <div className="bg-yellow-50 dark:bg-yellow-950/50 p-4 rounded-lg border border-yellow-200 dark:border-yellow-800">
                <p className="text-sm">
                  <span className="font-semibold">Already have USDC on XDC Network?</span><br />
                  You can also send USDC directly to your Roxonn wallet address from any XDC-compatible wallet.
                </p>
              </div>
            </div>

            <DialogFooter className="flex justify-between sm:justify-between">
              <Button variant="outline" onClick={handleBack}>
                <ArrowLeft className="mr-2 h-4 w-4" /> Back
              </Button>
              <Button onClick={handleNext}>
                Got It! <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </DialogFooter>
          </>
        )}

        {/* Step 4: Install GitHub App */}
        {currentStep === 4 && (
          <>
            <DialogHeader>
              <div className="flex justify-center mb-4">
                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                  <Github className="h-8 w-8 text-primary" />
                </div>
              </div>
              <DialogTitle className="text-2xl text-center">Install Roxonn GitHub App</DialogTitle>
              <DialogDescription className="text-center">
                Enable bounty creation on your repositories
              </DialogDescription>
            </DialogHeader>

            <div className="py-6">
              <div className="bg-white dark:bg-gray-900 border-2 border-purple-200 dark:border-purple-800 rounded-lg p-6 mb-6">
                <h3 className="font-semibold mb-4 text-lg">Installation Steps:</h3>

                <div className="space-y-6">
                  <div className="flex items-start gap-4">
                    <div className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center font-bold flex-shrink-0">
                      1
                    </div>
                    <div className="flex-1">
                      <h4 className="font-semibold mb-2">Click "Install GitHub App"</h4>
                      <p className="text-sm text-muted-foreground mb-3">Opens GitHub's app installation page</p>
                      <a
                        href="https://github.com/apps/roxonn-contribution-rewards/installations/new"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-sm font-medium"
                      >
                        <Github className="h-4 w-4" />
                        Install Roxonn Contribution Rewards App
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  </div>

                  <div className="flex items-start gap-4">
                    <div className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center font-bold flex-shrink-0">
                      2
                    </div>
                    <div className="flex-1">
                      <h4 className="font-semibold mb-2">Select repositories</h4>
                      <p className="text-sm text-muted-foreground">
                        Choose which repositories can have Roxonn bounties (you can select all or specific repos)
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-4">
                    <div className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center font-bold flex-shrink-0">
                      3
                    </div>
                    <div className="flex-1">
                      <h4 className="font-semibold mb-2">Authorize the app</h4>
                      <p className="text-sm text-muted-foreground">
                        Grant permissions - the app needs to post comments and read issues
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-4">
                    <div className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center font-bold flex-shrink-0">
                      4
                    </div>
                    <div className="flex-1">
                      <h4 className="font-semibold mb-2">Return to Roxonn</h4>
                      <p className="text-sm text-muted-foreground">
                        You'll be redirected back - your repos will now support bounties!
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="bg-blue-50 dark:bg-blue-950/50 p-4 rounded-lg border border-blue-200 dark:border-blue-800">
                <p className="text-sm">
                  <span className="font-semibold text-blue-800 dark:text-blue-300">What can you do after installing?</span><br />
                  <span className="text-muted-foreground">
                    Comment <code className="bg-white dark:bg-gray-800 px-2 py-1 rounded">/bounty 100 USDC</code> on any issue in your repos. The Roxonn bot will automatically create and track the bounty!
                  </span>
                </p>
              </div>
            </div>

            <DialogFooter className="flex justify-between sm:justify-between">
              <Button variant="outline" onClick={handleBack}>
                <ArrowLeft className="mr-2 h-4 w-4" /> Back
              </Button>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={handleNext}>
                  Skip (I'll install later)
                </Button>
                <Button onClick={handleNext}>
                  I've Installed It <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </DialogFooter>
          </>
        )}

        {/* Step 5: Try It Out */}
        {currentStep === 5 && (
          <>
            <DialogHeader>
              <div className="flex justify-center mb-4">
                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                  <FileCode className="h-8 w-8 text-primary" />
                </div>
              </div>
              <DialogTitle className="text-2xl text-center">Try Creating Your First Bounty</DialogTitle>
              <DialogDescription className="text-center">
                Let's create a bounty using the GitHub command!
              </DialogDescription>
            </DialogHeader>

            <div className="py-6">
              <div className="bg-blue-50 dark:bg-blue-950/50 p-6 rounded-lg border border-blue-200 dark:border-blue-800 mb-6">
                <ol className="space-y-4">
                  <li className="flex items-start gap-3">
                    <span className="w-6 h-6 rounded-full bg-blue-500 text-white flex items-center justify-center font-bold flex-shrink-0 text-sm">1</span>
                    <div>
                      <span className="font-semibold">Go to any GitHub issue in your repository</span>
                      <p className="text-sm text-muted-foreground mt-1">
                        Make sure the Roxonn GitHub App is installed on that repo
                      </p>
                    </div>
                  </li>
                  <li className="flex items-start gap-3">
                    <span className="w-6 h-6 rounded-full bg-blue-500 text-white flex items-center justify-center font-bold flex-shrink-0 text-sm">2</span>
                    <div>
                      <span className="font-semibold">Comment on the issue:</span>
                      <p className="mt-2">
                        <code className="bg-white dark:bg-gray-800 px-3 py-2 rounded text-sm block">/bounty 10 USDC</code>
                      </p>
                    </div>
                  </li>
                  <li className="flex items-start gap-3">
                    <span className="w-6 h-6 rounded-full bg-blue-500 text-white flex items-center justify-center font-bold flex-shrink-0 text-sm">3</span>
                    <div>
                      <span className="font-semibold">Watch the Roxonn bot respond!</span>
                      <p className="text-sm text-muted-foreground mt-1">It will post a comment confirming the bounty is active</p>
                    </div>
                  </li>
                </ol>
              </div>

              <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded-lg border">
                <h4 className="font-semibold mb-2 flex items-center gap-2">
                  <HelpCircle className="h-4 w-4" />
                  Having trouble?
                </h4>
                <ul className="text-sm space-y-1 text-muted-foreground">
                  <li>• Make sure the GitHub App is installed on your repository</li>
                  <li>• Check that you have USDC in your wallet</li>
                  <li>• Ensure you're commenting on an <strong>issue</strong> (not a PR)</li>
                  <li>• <a href="https://discord.gg/roxonn" target="_blank" className="text-blue-600 underline">Get help on Discord</a></li>
                </ul>
              </div>
            </div>

            <DialogFooter className="flex justify-between sm:justify-between">
              <Button variant="outline" onClick={handleBack}>
                <ArrowLeft className="mr-2 h-4 w-4" /> Back
              </Button>
              <Button onClick={handleNext}>
                Done - Let's Finish! <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </DialogFooter>
          </>
        )}

        {/* Step 6: Complete */}
        {currentStep === 6 && (
          <>
            <DialogHeader>
              <div className="flex justify-center mb-4">
                <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/50 flex items-center justify-center">
                  <span className="text-4xl">🎉</span>
                </div>
              </div>
              <DialogTitle className="text-2xl text-center">You're All Set!</DialogTitle>
              <DialogDescription className="text-center">
                You're ready to create bounties and grow your project!
              </DialogDescription>
            </DialogHeader>

            <div className="py-6">
              <div className="grid grid-cols-3 gap-4 mb-6">
                <a
                  href="/wallet"
                  className="bg-purple-50 dark:bg-purple-950/50 p-4 rounded-lg text-center hover:bg-purple-100 dark:hover:bg-purple-900/50 transition-colors"
                >
                  <Wallet className="h-8 w-8 mx-auto mb-2 text-purple-600" />
                  <h4 className="font-semibold text-sm mb-1">Add Funds</h4>
                  <span className="text-xs text-purple-600">Buy USDC</span>
                </a>

                <a
                  href="https://github.com/apps/roxonn-contribution-rewards/installations/new"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="bg-purple-50 dark:bg-purple-950/50 p-4 rounded-lg text-center hover:bg-purple-100 dark:hover:bg-purple-900/50 transition-colors"
                >
                  <Github className="h-8 w-8 mx-auto mb-2 text-purple-600" />
                  <h4 className="font-semibold text-sm mb-1">GitHub App</h4>
                  <span className="text-xs text-purple-600">Install/Manage</span>
                </a>

                <a
                  href="https://discord.gg/roxonn"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="bg-purple-50 dark:bg-purple-950/50 p-4 rounded-lg text-center hover:bg-purple-100 dark:hover:bg-purple-900/50 transition-colors"
                >
                  <MessageSquare className="h-8 w-8 mx-auto mb-2 text-purple-600" />
                  <h4 className="font-semibold text-sm mb-1">Get Help</h4>
                  <span className="text-xs text-purple-600">Join Discord</span>
                </a>
              </div>

              <div className="bg-blue-50 dark:bg-blue-950/50 p-6 rounded-lg border border-blue-200 dark:border-blue-800 mb-6">
                <h4 className="font-semibold mb-3">Quick Reference:</h4>
                <div className="text-sm space-y-2">
                  <p>• <strong>Create bounty:</strong> Comment <code className="bg-white dark:bg-gray-800 px-2 py-1 rounded">/bounty 100 USDC</code> on any issue</p>
                  <p>• <strong>Check status:</strong> Comment <code className="bg-white dark:bg-gray-800 px-2 py-1 rounded">@roxonn status</code></p>
                  <p>• <strong>Supported currencies:</strong> USDC, XDC, ROXN</p>
                </div>
              </div>

              <p className="text-sm text-center text-muted-foreground">
                You can re-watch this tutorial anytime from <strong>Help → Getting Started</strong>
              </p>
            </div>

            <DialogFooter className="flex justify-between sm:justify-between">
              <Button variant="outline" onClick={handleBack}>
                <ArrowLeft className="mr-2 h-4 w-4" /> Back
              </Button>
              <Button onClick={handleClose} className="bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700">
                Start Using Roxonn! 🚀
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
