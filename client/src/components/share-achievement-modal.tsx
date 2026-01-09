import { useState, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { useSocialShare } from '../hooks/use-social-share';
import { 
  Twitter, 
  Linkedin, 
  Copy, 
  Coins, 
  Award, 
  ExternalLink,
  Check,
  Sparkles
} from 'lucide-react';
import { motion } from 'framer-motion';

interface ShareAchievementModalProps {
  isOpen: boolean;
  onClose: () => void;
  achievementData: {
    amount: string;
    currency: 'XDC' | 'ROXN' | 'USDC';
    projectName?: string;
    issueTitle?: string;
    issueNumber?: number;
    transactionHash?: string;
  };
}

export function ShareAchievementModal({ 
  isOpen, 
  onClose, 
  achievementData 
}: ShareAchievementModalProps) {
  const [copied, setCopied] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const { shareOnTwitter, shareOnLinkedIn, copyToClipboard, viewOnExplorer } = useSocialShare();

  const { amount, currency, projectName, issueTitle, issueNumber, transactionHash } = achievementData;

  const handleShareTwitter = () => {
    shareOnTwitter(achievementData);
  };

  const handleShareLinkedIn = () => {
    shareOnLinkedIn(achievementData);
  };

  const handleCopy = async () => {
    const success = await copyToClipboard(achievementData);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleViewExplorer = () => {
    viewOnExplorer(transactionHash);
  };

  // Currency-specific styling
  const getCurrencyStyle = () => {
    switch (currency) {
      case 'ROXN':
        return {
          gradient: 'from-violet-500 via-purple-500 to-fuchsia-500',
          bgGradient: 'from-violet-500/20 via-purple-500/10 to-fuchsia-500/20',
          text: 'text-violet-400',
          border: 'border-violet-500/30'
        };
      case 'USDC':
        return {
          gradient: 'from-blue-500 via-cyan-500 to-teal-500',
          bgGradient: 'from-blue-500/20 via-cyan-500/10 to-teal-500/20',
          text: 'text-cyan-400',
          border: 'border-cyan-500/30'
        };
      case 'XDC':
      default:
        return {
          gradient: 'from-cyan-500 via-emerald-500 to-green-500',
          bgGradient: 'from-cyan-500/20 via-emerald-500/10 to-green-500/20',
          text: 'text-emerald-400',
          border: 'border-emerald-500/30'
        };
    }
  };

  const style = getCurrencyStyle();

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-yellow-500" />
            Share Your Achievement!
          </DialogTitle>
          <DialogDescription>
            Celebrate your contribution and inspire others to join Roxonn.
          </DialogDescription>
        </DialogHeader>

        {/* Achievement Card Preview */}
        <div 
          ref={cardRef}
          className="relative overflow-hidden rounded-xl p-6 bg-gradient-to-br from-background via-background to-muted border"
        >
          {/* Decorative background elements */}
          <div className={`absolute inset-0 bg-gradient-to-br ${style.bgGradient} opacity-50`} />
          <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-yellow-500/10 to-transparent rounded-full blur-2xl" />
          <div className="absolute bottom-0 left-0 w-24 h-24 bg-gradient-to-tr from-violet-500/10 to-transparent rounded-full blur-2xl" />
          
          <div className="relative z-10 space-y-4">
            {/* Header with Roxonn branding */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-violet-600 to-cyan-600 flex items-center justify-center">
                  <Award className="h-4 w-4 text-white" />
                </div>
                <span className="font-semibold text-sm text-muted-foreground">ROXONN</span>
              </div>
              <Badge variant="outline" className={`${style.border} ${style.text}`}>
                Achievement Unlocked
              </Badge>
            </div>

            {/* Main content */}
            <div className="text-center py-4">
              <motion.div
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: 0.5, ease: 'easeOut' }}
              >
                <p className="text-sm text-muted-foreground mb-2">I just earned</p>
                <div className={`text-4xl font-bold bg-gradient-to-r ${style.gradient} bg-clip-text text-transparent mb-2`}>
                  {amount} {currency}
                </div>
                <p className="text-sm text-muted-foreground">for contributing</p>
              </motion.div>
            </div>

            {/* Project info */}
            {(projectName || issueTitle) && (
              <div className={`rounded-lg bg-card/50 backdrop-blur-sm border ${style.border} p-3`}>
                {projectName && (
                  <p className="text-sm font-medium truncate">{projectName}</p>
                )}
                {issueTitle && (
                  <p className="text-xs text-muted-foreground truncate">
                    {issueNumber && `#${issueNumber} - `}{issueTitle}
                  </p>
                )}
              </div>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between pt-2 border-t border-border/50">
              <span className="text-xs text-muted-foreground">app.roxonn.com</span>
              <div className="flex items-center gap-1">
                <Coins className={`h-3 w-3 ${style.text}`} />
                <span className="text-xs text-muted-foreground">Blockchain Verified</span>
              </div>
            </div>
          </div>
        </div>

        {/* Share Buttons */}
        <div className="grid grid-cols-2 gap-3">
          <Button 
            onClick={handleShareTwitter} 
            variant="outline" 
            className="gap-2 hover:bg-[#1DA1F2]/10 hover:border-[#1DA1F2]/50 hover:text-[#1DA1F2]"
          >
            <Twitter className="h-4 w-4" />
            Share on X
          </Button>
          <Button 
            onClick={handleShareLinkedIn} 
            variant="outline"
            className="gap-2 hover:bg-[#0077B5]/10 hover:border-[#0077B5]/50 hover:text-[#0077B5]"
          >
            <Linkedin className="h-4 w-4" />
            LinkedIn
          </Button>
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button 
            variant="ghost" 
            size="sm" 
            onClick={handleCopy}
            className="gap-2"
          >
            {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
            {copied ? 'Copied!' : 'Copy Text'}
          </Button>
          {transactionHash && (
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={handleViewExplorer}
              className="gap-2"
            >
              <ExternalLink className="h-4 w-4" />
              View on Explorer
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Export a hook for easy usage
export function useShareAchievement() {
  const [isOpen, setIsOpen] = useState(false);
  const [achievementData, setAchievementData] = useState<ShareAchievementModalProps['achievementData']>({
    amount: '0',
    currency: 'ROXN'
  });

  const openShareModal = (data: ShareAchievementModalProps['achievementData']) => {
    setAchievementData(data);
    setIsOpen(true);
  };

  const closeShareModal = () => {
    setIsOpen(false);
  };

  return {
    isOpen,
    achievementData,
    openShareModal,
    closeShareModal
  };
}
