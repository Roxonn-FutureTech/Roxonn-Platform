import { useToast } from './use-toast';

interface ShareOptions {
  amount: string;
  currency: 'XDC' | 'ROXN' | 'USDC';
  projectName?: string;
  issueTitle?: string;
  issueNumber?: number;
  transactionHash?: string;
  customMessage?: string;
}

/**
 * Hook for sharing ROXN achievements on social media
 * Provides methods for Twitter, LinkedIn, and clipboard sharing
 */
export function useSocialShare() {
  const { toast } = useToast();

  /**
   * Generate a share message based on platform and achievement data
   */
  const generateShareMessage = (
    options: ShareOptions,
    platform: 'twitter' | 'linkedin' | 'generic'
  ): string => {
    if (options.customMessage) {
      return options.customMessage;
    }

    const { amount, currency, projectName, issueNumber } = options;
    const projectText = projectName ? ` on ${projectName}` : '';
    const issueText = issueNumber ? ` (#${issueNumber})` : '';

    const baseMessage = `🎉 I just earned ${amount} ${currency} for contributing${projectText}${issueText}!`;

    const hashtags = '#Roxonn #XDC #OpenSource #Web3 #Bounty';
    const link = 'https://app.roxonn.com';

    if (platform === 'twitter') {
      return `${baseMessage}\n\n${hashtags}\n\n🚀 Start earning with @RoxonnPlatform:\n${link}`;
    } else if (platform === 'linkedin') {
      return `${baseMessage}\n\nRoxonn is revolutionizing open-source contributions with blockchain-powered rewards. Join the future of collaborative development!\n\n${link}\n\n${hashtags}`;
    }
    return `${baseMessage}\n\n${hashtags}\n\n${link}`;
  };

  /**
   * Share on Twitter/X
   */
  const shareOnTwitter = (options: ShareOptions) => {
    const text = encodeURIComponent(generateShareMessage(options, 'twitter'));
    window.open(
      `https://twitter.com/intent/tweet?text=${text}`,
      '_blank',
      'noopener,noreferrer,width=550,height=420'
    );
    toast({
      title: 'Opening Twitter',
      description: 'Share your achievement with the world!',
    });
  };

  /**
   * Share on LinkedIn
   */
  const shareOnLinkedIn = (options: ShareOptions) => {
    const url = encodeURIComponent('https://app.roxonn.com');
    window.open(
      `https://www.linkedin.com/sharing/share-offsite/?url=${url}`,
      '_blank',
      'noopener,noreferrer,width=550,height=520'
    );
    toast({
      title: 'Opening LinkedIn',
      description: 'Share your professional achievement!',
    });
  };

  /**
   * Copy share text to clipboard
   */
  const copyToClipboard = async (options: ShareOptions): Promise<boolean> => {
    try {
      const message = generateShareMessage(options, 'generic');
      await navigator.clipboard.writeText(message);
      toast({
        title: 'Copied to clipboard!',
        description: 'Share message copied successfully.',
      });
      return true;
    } catch (error) {
      toast({
        title: 'Failed to copy',
        description: 'Could not copy to clipboard.',
        variant: 'destructive',
      });
      return false;
    }
  };

  /**
   * View transaction on XDC explorer
   */
  const viewOnExplorer = (transactionHash?: string) => {
    if (transactionHash) {
      const normalizedHash = transactionHash.startsWith('xdc') 
        ? '0x' + transactionHash.slice(3) 
        : transactionHash;
      const explorerUrl = `https://xdcscan.io/tx/${normalizedHash}`;
      window.open(explorerUrl, '_blank', 'noopener,noreferrer');
    }
  };

  /**
   * Use native share API if available (mobile friendly)
   */
  const nativeShare = async (options: ShareOptions): Promise<boolean> => {
    if (!navigator.share) {
      return false;
    }

    try {
      await navigator.share({
        title: `I earned ${options.amount} ${options.currency} on Roxonn!`,
        text: generateShareMessage(options, 'generic'),
        url: 'https://app.roxonn.com',
      });
      return true;
    } catch (error) {
      // User cancelled or share failed
      console.debug('Native share failed:', error);
      return false;
    }
  };

  return {
    shareOnTwitter,
    shareOnLinkedIn,
    copyToClipboard,
    viewOnExplorer,
    nativeShare,
    generateShareMessage,
  };
}
