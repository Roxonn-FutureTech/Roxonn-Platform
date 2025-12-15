import { Link } from "wouter";
import { motion } from "framer-motion";
import { ThemeToggle } from "@/components/theme-toggle";
import { useAuth } from "@/hooks/use-auth";
import { useWallet } from "@/hooks/use-wallet";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ethers } from "ethers";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Loader2, LogOut, User, HelpCircle, Code, BookOpen, AlertCircle, Menu, X, Wallet, Crown, Gift, Zap, Coins, Shield, Trophy } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTrigger, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { showContributionDemo } from "@/components/contribution-demo";
import { showReposWelcomeGuide } from "@/components/welcome-guide";
import { showPoolManagerGuide } from "@/components/pool-manager-guide";
import { showFundingDemo } from "@/components/funding-demo";
import { Badge } from "@/components/ui/badge";
import { useIsMobile } from "@/hooks/use-mobile";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { STAGING_API_URL } from '@/config';

export function NavigationBar() {
  const { user, signOut } = useAuth();
  const { data: walletInfo, isLoading: walletLoading } = useWallet();
  const { toast } = useToast();
  const isMobile = useIsMobile();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Fetch subscription status for premium badge
  const { data: subscriptionStatus } = useQuery({
    queryKey: ["/api/subscription/status"],
    queryFn: async () => {
      const response = await fetch(`${STAGING_API_URL}/api/subscription/status`, {
        credentials: 'include',
      });
      if (!response.ok) return { active: false };
      return response.json();
    },
    enabled: !!user,
  });

  // Determine the correct home link based on role
  const homeLink = user?.role === 'poolmanager' ? '/my-repos' : '/repos';

  // Format XDC balance with appropriate precision
  const formattedXdcBalance = walletInfo?.balance
    ? parseFloat(ethers.formatEther(walletInfo.balance)).toFixed(4)
    : "0.0000";

  // Format ROXN balance with appropriate precision
  const formattedRoxnBalance = walletInfo?.tokenBalance
    ? parseFloat(ethers.formatEther(walletInfo.tokenBalance)).toFixed(2)
    : "0.00";

  const handleSignOut = async () => {
    try {
      await signOut();
      toast({
        title: "Signed out successfully",
        description: "You have been signed out of your account",
      });
    } catch (error) {
      toast({
        title: "Error signing out",
        description: "There was a problem signing out. Please try again.",
        variant: "destructive",
      });
    }
  };

  return (
    <nav className="sticky top-0 z-40 w-full border-b border-border/40 bg-background/80 backdrop-blur-lg backdrop-saturate-150">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        {/* Logo and brand */}
        <div className="flex items-center gap-4">
          <Link href={homeLink} className="flex flex-col items-center relative group">
            <div className="relative">
              <span className="text-2xl font-bold">
                <span className="bg-gradient-to-r from-violet-600 via-red-500 to-violet-500 bg-clip-text text-transparent">
                  ROXONN
                </span>
                <motion.div
                  className="absolute inset-0 bg-gradient-to-r from-transparent via-foreground/30 to-transparent"
                  animate={{
                    x: ['100%', '-100%'],
                  }}
                  transition={{
                    duration: 3.5,
                    repeat: Infinity,
                    ease: 'linear',
                  }}
                  style={{
                    clipPath: 'polygon(0 0, 100% 0, 80% 100%, 20% 100%)',
                  }}
                />
              </span>
              <motion.div
                className="absolute -inset-2 bg-gradient-to-r from-[#8B5CF6] to-[#6D28D9] opacity-0 blur-xl"
                animate={{
                  opacity: [0, 0.2, 0],
                }}
                transition={{
                  duration: 4,
                  repeat: Infinity,
                  ease: 'easeInOut',
                }}
              />
            </div>
            <span className="text-[0.6rem] font-bold tracking-[0.3em] relative">
              <span className="bg-gradient-to-r from-violet-600 via-red-500 to-violet-500 bg-clip-text text-transparent">
                FUTURE TECH
              </span>
              <motion.div
                className="absolute inset-0 bg-gradient-to-r from-violet-600 via-red-500 to-violet-500"
                animate={{
                  opacity: [0, 0.3, 0],
                }}
                transition={{
                  duration: 3,
                  repeat: Infinity,
                  ease: 'easeInOut',
                }}
                style={{
                  mixBlendMode: 'overlay',
                }}
              />
            </span>
          </Link>
          <div className="flex items-center">
            <Badge variant="outline" className="ml-2 bg-violet-500/10 hover:bg-violet-500/20 text-violet-500 border-violet-500/30 text-xs uppercase font-bold tracking-wide">
              Beta
            </Badge>
          </div>
        </div>

        {/* Desktop Right side actions */}
        <div className="hidden md:flex items-center gap-4">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-cyan-400 hover:bg-cyan-500/10"
              >
                <HelpCircle className="h-5 w-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56 bg-background/95 backdrop-blur-xl border-border/50">
              <DropdownMenuLabel className="text-muted-foreground">Help & Guides</DropdownMenuLabel>
              <DropdownMenuSeparator className="bg-border/50" />
              {/* Show different demos based on user role */}
              {user?.role === 'contributor' && (
                <DropdownMenuItem onClick={() => showContributionDemo()} className="cursor-pointer hover:bg-cyan-500/10 hover:text-cyan-400 focus:bg-cyan-500/10 focus:text-cyan-400">
                  <BookOpen className="mr-2 h-4 w-4" />
                  Contribution Demo
                </DropdownMenuItem>
              )}

              {user?.role === 'poolmanager' && (
                <>
                  <DropdownMenuItem onClick={() => showPoolManagerGuide()} className="cursor-pointer hover:bg-cyan-500/10 hover:text-cyan-400 focus:bg-cyan-500/10 focus:text-cyan-400">
                    <BookOpen className="mr-2 h-4 w-4" />
                    Pool Manager Guide
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => showFundingDemo()} className="cursor-pointer hover:bg-cyan-500/10 hover:text-cyan-400 focus:bg-cyan-500/10 focus:text-cyan-400">
                    <BookOpen className="mr-2 h-4 w-4" />
                    Funding Demo
                  </DropdownMenuItem>
                </>
              )}

              <DropdownMenuItem asChild>
                <Link to="/faq" className="w-full cursor-pointer hover:bg-cyan-500/10 hover:text-cyan-400 focus:bg-cyan-500/10 focus:text-cyan-400">
                  <HelpCircle className="mr-2 h-4 w-4" />
                  FAQs
                </Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Link href="/decentralized-chat">
            <Button variant="ghost" className="text-muted-foreground hover:text-violet-400 hover:bg-violet-500/10">
              Chat
            </Button>
          </Link>
          <Link href="/courses">
            <Button variant="ghost" className="text-violet-400 font-semibold flex items-center hover:bg-violet-500/10">
              <BookOpen className="mr-2 h-5 w-5" />
              Courses
            </Button>
          </Link>
          {user && (
            <Link href="/referrals">
              <Button variant="ghost" className="text-violet-400 font-semibold flex items-center hover:bg-violet-500/10">
                <Gift className="mr-2 h-5 w-5" />
                Refer & Earn
              </Button>
            </Link>
          )}
          <Link href="/leaderboard">
            <Button variant="ghost" className="text-muted-foreground hover:text-cyan-400 hover:bg-cyan-500/10">
              <Trophy className="mr-2 h-5 w-5" />
              Leaderboard
            </Button>
          </Link>
          <Link href="/repos">
            <Button variant="ghost" className="text-muted-foreground hover:text-cyan-400 hover:bg-cyan-500/10">
              Explore
            </Button>
          </Link>

          <ThemeToggle />

          {user && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-3 border border-border/50 rounded-xl px-3 py-1.5 bg-muted/30 text-sm backdrop-blur-sm">
                    {walletLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <Zap className="h-3.5 w-3.5 text-cyan-400" />
                          <span className="font-mono text-cyan-400">{formattedXdcBalance}</span>
                          <span className="text-xs text-muted-foreground">XDC</span>
                        </div>
                        <div className="h-6 w-px bg-border/50" />
                        <div className="flex items-center gap-2">
                          <Coins className="h-3.5 w-3.5 text-violet-400" />
                          <span className="font-mono text-violet-400">{formattedRoxnBalance}</span>
                          <span className="text-xs text-muted-foreground">ROXN</span>
                        </div>
                      </>
                    )}
                  </div>
                </TooltipTrigger>
                <TooltipContent className="bg-background/95 backdrop-blur-xl border-border/50 max-w-xs">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-amber-400">
                      <Shield className="h-4 w-4" />
                      <span className="font-medium">XDC Mainnet</span>
                    </div>
                    <p className="text-xs text-muted-foreground">All transactions involve real tokens with actual value.</p>
                    {walletInfo?.address && (
                      <p className="font-mono text-xs text-muted-foreground pt-2 border-t border-border/50">
                        {walletInfo.address.slice(0, 10)}...{walletInfo.address.slice(-8)}
                      </p>
                    )}
                  </div>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {!user && (
            <Link href="/membership">
              <Button variant="ghost" size="sm" className="mr-2 hover:bg-violet-500/10">
                <Crown className="h-4 w-4 mr-1 text-violet-400" />
                <span className="text-violet-400 font-semibold">Premium $10/year</span>
              </Button>
            </Link>
          )}

          {user ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Avatar className="h-9 w-9 ring-2 ring-border/40 transition-all duration-200 hover:ring-cyan-500 hover:scale-105 cursor-pointer">
                  <AvatarImage src={user.avatarUrl || undefined} alt={user.username} />
                  <AvatarFallback className="bg-violet-500/10 text-violet-400">
                    {user.username.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 bg-background/95 backdrop-blur-xl border-border/50">
                <DropdownMenuLabel>
                  <div className="flex items-center justify-between">
                    <span className="text-foreground">{user.githubUsername}</span>
                    {subscriptionStatus?.active && (
                      <Badge className="bg-gradient-to-r from-amber-500/20 to-orange-500/20 text-amber-400 border-amber-500/30 px-2 py-0.5 flex items-center gap-1">
                        <Crown className="h-3 w-3" />
                        <span className="text-xs">Premium</span>
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground capitalize mt-0.5">{user.role}</p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator className="bg-border/50" />
                <Link href="/profile">
                  <DropdownMenuItem className="cursor-pointer hover:bg-cyan-500/10 hover:text-cyan-400 focus:bg-cyan-500/10 focus:text-cyan-400">
                    <User className="mr-2 h-4 w-4" />
                    <span>Profile</span>
                  </DropdownMenuItem>
                </Link>
                <Link href="/wallet">
                  <DropdownMenuItem className="cursor-pointer hover:bg-cyan-500/10 hover:text-cyan-400 focus:bg-cyan-500/10 focus:text-cyan-400">
                    <Wallet className="mr-2 h-4 w-4" />
                    <span>Wallet</span>
                  </DropdownMenuItem>
                </Link>
                <Link href="/provider-hub">
                  <DropdownMenuItem className="cursor-pointer hover:bg-violet-500/10 hover:text-violet-400 focus:bg-violet-500/10 focus:text-violet-400">
                    <Code className="mr-2 h-4 w-4" />
                    <span>Provider Hub</span>
                  </DropdownMenuItem>
                </Link>
                <DropdownMenuSeparator className="bg-border/50" />
                <DropdownMenuItem onClick={handleSignOut} className="cursor-pointer text-red-400 hover:bg-red-500/10 hover:text-red-400 focus:bg-red-500/10 focus:text-red-400">
                  <LogOut className="mr-2 h-4 w-4" />
                  <span>Sign out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Link href="/auth">
              <Button className="btn-primary">
                Sign In
              </Button>
            </Link>
          )}
        </div>

        {/* Mobile Navigation */}
        <div className="flex md:hidden items-center gap-2">
          <ThemeToggle />

          {user && (
            <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="h-10 w-10 hover:bg-cyan-500/10">
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-[300px] sm:w-[400px] bg-background/95 backdrop-blur-xl border-border/50">
                <SheetHeader>
                  <SheetTitle className="text-left">
                    <div className="flex items-center gap-3">
                      <Avatar className="h-10 w-10 ring-2 ring-cyan-500/30">
                        <AvatarImage src={user.avatarUrl || undefined} alt={user.username} />
                        <AvatarFallback className="bg-violet-500/10 text-violet-400">
                          {user.username.slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <p className="font-semibold">{user.username}</p>
                        <p className="text-sm text-muted-foreground capitalize">{user.role}</p>
                      </div>
                    </div>
                  </SheetTitle>
                </SheetHeader>

                <div className="mt-8 space-y-6">
                  {/* Wallet Info */}
                  <div className="p-4 border border-border/50 rounded-xl bg-muted/30">
                    <div className="flex items-center gap-2 mb-3">
                      <Wallet className="h-4 w-4 text-cyan-400" />
                      <span className="font-medium">Wallet</span>
                    </div>
                    {walletLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin text-cyan-400" />
                    ) : (
                      <div className="space-y-3">
                        <div className="flex justify-between items-center">
                          <span className="text-sm text-muted-foreground">XDC:</span>
                          <span className="font-mono text-cyan-400">{formattedXdcBalance}</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-sm text-muted-foreground">ROXN:</span>
                          <span className="font-mono text-violet-400">{formattedRoxnBalance}</span>
                        </div>
                        <div className="flex items-center gap-1.5 mt-2 p-2 bg-amber-500/10 rounded-lg border border-amber-500/20">
                          <Shield className="h-3.5 w-3.5 text-amber-400" />
                          <span className="text-xs text-amber-400">XDC Mainnet</span>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Navigation Links */}
                  <div className="space-y-2">
                    <Link href="/decentralized-chat" className="block">
                      <Button variant="ghost" className="w-full justify-start h-12 hover:bg-violet-500/10 hover:text-violet-400" onClick={() => setMobileMenuOpen(false)}>
                        Chat
                      </Button>
                    </Link>
                    <Link href="/courses" className="block">
                      <Button variant="ghost" className="w-full justify-start h-12 text-violet-400 font-semibold flex items-center hover:bg-violet-500/10" onClick={() => setMobileMenuOpen(false)}>
                        <BookOpen className="mr-2 h-5 w-5" />
                        Courses
                      </Button>
                    </Link>
                    {user && (
                      <Link href="/referrals" className="block">
                        <Button variant="ghost" className="w-full justify-start h-12 text-violet-400 font-semibold flex items-center hover:bg-violet-500/10" onClick={() => setMobileMenuOpen(false)}>
                          <Gift className="mr-2 h-5 w-5" />
                          Refer & Earn
                        </Button>
                      </Link>
                    )}
                    <Link href="/leaderboard" className="block">
                      <Button variant="ghost" className="w-full justify-start h-12 hover:bg-cyan-500/10 hover:text-cyan-400" onClick={() => setMobileMenuOpen(false)}>
                        <Trophy className="mr-2 h-5 w-5" />
                        Leaderboard
                      </Button>
                    </Link>
                    <Link href="/repos" className="block">
                      <Button variant="ghost" className="w-full justify-start h-12 hover:bg-cyan-500/10 hover:text-cyan-400" onClick={() => setMobileMenuOpen(false)}>
                        Explore
                      </Button>
                    </Link>
                    <Link href="/profile" className="block">
                      <Button variant="ghost" className="w-full justify-start h-12 hover:bg-cyan-500/10 hover:text-cyan-400" onClick={() => setMobileMenuOpen(false)}>
                        <User className="mr-2 h-4 w-4" />
                        Profile
                      </Button>
                    </Link>
                    <Link href="/wallet" className="block">
                      <Button variant="ghost" className="w-full justify-start h-12 hover:bg-cyan-500/10 hover:text-cyan-400" onClick={() => setMobileMenuOpen(false)}>
                        <Wallet className="mr-2 h-4 w-4" />
                        Wallet
                      </Button>
                    </Link>
                    <Link href="/provider-hub" className="block">
                      <Button variant="ghost" className="w-full justify-start h-12 hover:bg-violet-500/10 hover:text-violet-400" onClick={() => setMobileMenuOpen(false)}>
                        <Code className="mr-2 h-4 w-4" />
                        Provider Hub
                      </Button>
                    </Link>
                  </div>

                  {/* Help Section */}
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-muted-foreground">Help & Guides</p>
                    {user?.role === 'contributor' && (
                      <Button
                        variant="ghost"
                        className="w-full justify-start h-12 hover:bg-cyan-500/10 hover:text-cyan-400"
                        onClick={() => {
                          showContributionDemo();
                          setMobileMenuOpen(false);
                        }}
                      >
                        <BookOpen className="mr-2 h-4 w-4" />
                        Contribution Demo
                      </Button>
                    )}

                    {user?.role === 'poolmanager' && (
                      <>
                        <Button
                          variant="ghost"
                          className="w-full justify-start h-12 hover:bg-cyan-500/10 hover:text-cyan-400"
                          onClick={() => {
                            showPoolManagerGuide();
                            setMobileMenuOpen(false);
                          }}
                        >
                          <BookOpen className="mr-2 h-4 w-4" />
                          Pool Manager Guide
                        </Button>
                        <Button
                          variant="ghost"
                          className="w-full justify-start h-12 hover:bg-cyan-500/10 hover:text-cyan-400"
                          onClick={() => {
                            showFundingDemo();
                            setMobileMenuOpen(false);
                          }}
                        >
                          <BookOpen className="mr-2 h-4 w-4" />
                          Funding Demo
                        </Button>
                      </>
                    )}

                    <Link href="/faq" className="block">
                      <Button variant="ghost" className="w-full justify-start h-12 hover:bg-cyan-500/10 hover:text-cyan-400" onClick={() => setMobileMenuOpen(false)}>
                        <HelpCircle className="mr-2 h-4 w-4" />
                        FAQs
                      </Button>
                    </Link>
                  </div>

                  {/* Sign Out */}
                  <div className="pt-4 border-t border-border/50">
                    <Button
                      variant="ghost"
                      className="w-full justify-start h-12 text-red-400 hover:text-red-400 hover:bg-red-500/10"
                      onClick={() => {
                        handleSignOut();
                        setMobileMenuOpen(false);
                      }}
                    >
                      <LogOut className="mr-2 h-4 w-4" />
                      Sign out
                    </Button>
                  </div>
                </div>
              </SheetContent>
            </Sheet>
          )}

          {!user && (
            <Link href="/auth">
              <Button className="btn-primary" size="sm">
                Sign In
              </Button>
            </Link>
          )}
        </div>
      </div>
    </nav>
  );
}
