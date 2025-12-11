import React, { lazy, Suspense } from "react";
import { Switch, Route, Redirect, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { AuthProvider, useAuth } from "./hooks/use-auth";
import { NotificationProvider } from "@/components/ui/notification";
import { NavigationBar } from "@/components/navigation-bar";
import { ThemeProvider } from "@/components/theme-provider";
import NotFound from "@/pages/not-found";
import AuthPage from "@/pages/auth-page";
import RepoDetailsPage from "@/pages/repo-details-page";
import AiScopingAgentPage from "@/pages/ai-scoping-agent-page";
import ProfilePage from "@/pages/profile-page";
import ProviderHubPage from "@/pages/provider-hub-page";
import DecentralizedChatPage from "@/pages/decentralized-chat-page";
import FAQPage from "@/pages/faq-page";
import RepoRoxonnPage from "@/pages/RepoRoxonnPage";
import CoursesPage from "@/pages/courses-page";
import BoltNewCoursePage from "@/pages/bolt-new";
import V0DevCoursePage from "@/pages/v0-dev";
import ReferralsPage from "@/pages/referrals-page";
// Crypto Noir UI Pages
import LandingPage from "@/pages/landing-page";
import DashboardPage from "@/pages/dashboard-page";
import ReposExplorerPage from "@/pages/repos-explorer-page";
import WalletNewPage from "@/pages/wallet-new-page";
import ContributionsPage from "@/pages/contributions-page";
import MembershipNewPage from "@/pages/membership-new-page";
import PromotionalBountiesPage from "@/pages/promotional-bounties-page";
import PromotionalBountiesCreatePage from "@/pages/promotional-bounties-create-page";
import PromotionalBountiesDetailPage from "@/pages/promotional-bounties-detail-page";
import PromotionalBountiesReviewPage from "@/pages/promotional-bounties-review-page";
import { ContributionDemo } from "@/components/contribution-demo";
import { ChatWidget } from "@/components/chat-widget";
import { PoolManagerWelcomeGuide } from "@/components/pool-manager-guide";
import { FundingDemo } from "@/components/funding-demo";
import { MyRepositories } from "@/components/my-repositories";
import { Loader2 } from "lucide-react";

function Router() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-16 w-16 animate-spin text-primary/70" />
      </div>
    );
  }

  // Show guide components based on user role
  const showGuides = !loading && user;

  console.log('[Router Render] Loading finished. User Role:', user?.role);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Main content */}
      <div className="relative z-10 flex-1">
        <NavigationBar />
        {showGuides && (
          <>
            {/* Show appropriate guide based on user role */}
            {user?.role === "contributor" && <ContributionDemo />}
            {user?.role === "poolmanager" && <PoolManagerWelcomeGuide />}
            {user?.role === "poolmanager" && <FundingDemo />}
          </>
        )}
        <Switch>
          {/* Root - Landing for guests, Dashboard for users */}
          <Route path="/">
            {user ? <Redirect to="/dashboard" /> : <LandingPage />}
          </Route>

          {/* Auth routes */}
          <Route path="/auth/signin" component={AuthPage} />
          <Route path="/auth" component={AuthPage} />

          {/* VSCode wallet */}
          <Route path="/vscode/wallet">
            <Suspense fallback={<div className="flex items-center justify-center h-full">Loading...</div>}>
              {React.createElement(lazy(() => import("./pages/vscode-wallet-page")))}
            </Suspense>
          </Route>

          {/* Main app routes */}
          <Route path="/dashboard" component={DashboardPage} />
          <Route path="/repos" component={ReposExplorerPage} />
          <Route path="/repos/:owner/:name" component={RepoDetailsPage} />
          <Route path="/wallet" component={WalletNewPage} />
          <Route path="/contributions" component={ContributionsPage} />
          <Route path="/membership" component={MembershipNewPage} />
          <Route path="/referrals" component={ReferralsPage} />
          <Route path="/profile" component={ProfilePage} />

          {/* Pool Manager routes */}
          <Route path="/my-repos">
            {() => {
              console.log('[Route /my-repos] Evaluating. User Role:', user?.role);
              if (!user) {
                return <Redirect to="/repos" />;
              }
              if (user.role === 'poolmanager') {
                return <MyRepositories />;
              }
              return <Redirect to="/repos" />;
            }}
          </Route>

          {/* Feature routes */}
          <Route path="/provider-hub" component={ProviderHubPage} />
          <Route path="/decentralized-chat" component={DecentralizedChatPage} />
          <Route path="/ai-scoping-agent" component={AiScopingAgentPage} />
          <Route path="/faq" component={FAQPage} />

          {/* Courses */}
          <Route path="/courses" component={CoursesPage} />
          <Route path="/courses/bolt-new" component={BoltNewCoursePage} />
          <Route path="/courses/v0-dev" component={V0DevCoursePage} />

          {/* Promotional Bounties */}
          <Route path="/promotional-bounties" component={PromotionalBountiesPage} />
          <Route path="/promotional-bounties/create" component={PromotionalBountiesCreatePage} />
          <Route path="/promotional-bounties/:id" component={PromotionalBountiesDetailPage} />
          <Route path="/promotional-bounties/review" component={PromotionalBountiesReviewPage} />

          {/* Dynamic repo route - must come AFTER specific routes */}
          <Route path="/:owner/:repo" component={RepoRoxonnPage} />

          {/* 404 */}
          <Route path="*" component={NotFound} />
        </Switch>
      </div>
    </div>
  );
}

function App() {
  const [location] = useLocation();
  const showChatWidget = location !== '/ai-scoping-agent';

  return (
    <ThemeProvider defaultTheme="dark" storageKey="github-identity-theme">
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <NotificationProvider>
            <Router />
            <Toaster />
            <ContributionDemo />
            {showChatWidget && <ChatWidget />}
          </NotificationProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;