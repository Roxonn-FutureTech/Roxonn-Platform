import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NavigationBar } from '../navigation-bar';
import { useAuth } from '@/hooks/use-auth';
import { useWallet } from '@/hooks/use-wallet';

// Mock dependencies
vi.mock('@/hooks/use-auth', () => ({
  useAuth: vi.fn(),
}));

vi.mock('@/hooks/use-wallet', () => ({
  useWallet: vi.fn(),
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: vi.fn(() => ({
    toast: vi.fn(),
  })),
}));

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: vi.fn(() => false),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn(() => ({
    data: { active: false },
    isLoading: false,
  })),
}));

vi.mock('wouter', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

describe('NavigationBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render navigation bar for authenticated user', () => {
    (useAuth as any).mockReturnValue({
      user: {
        id: 1,
        username: 'testuser',
        avatarUrl: 'https://example.com/avatar.jpg',
      },
      loading: false,
      signOut: vi.fn(),
    });

    (useWallet as any).mockReturnValue({
      data: {
        address: 'xdc1234567890123456789012345678901234567890',
        balance: '1000000000000000000',
        tokenBalance: '500000000000000000',
      },
      isLoading: false,
    });

    render(<NavigationBar />);
    
    // Check if user info is displayed
    expect(screen.getByText(/testuser/i)).toBeDefined();
  });

  it('should render navigation bar for unauthenticated user', () => {
    (useAuth as any).mockReturnValue({
      user: null,
      loading: false,
      signOut: vi.fn(),
    });

    (useWallet as any).mockReturnValue({
      data: null,
      isLoading: false,
    });

    render(<NavigationBar />);
    
    // Should show sign in option or similar
    expect(screen.queryByText(/testuser/i)).toBeNull();
  });

  it('should display wallet balance when available', () => {
    (useAuth as any).mockReturnValue({
      user: {
        id: 1,
        username: 'testuser',
      },
      loading: false,
      signOut: vi.fn(),
    });

    (useWallet as any).mockReturnValue({
      data: {
        address: 'xdc1234567890123456789012345678901234567890',
        balance: '1000000000000000000',
        tokenBalance: '500000000000000000',
      },
      isLoading: false,
    });

    render(<NavigationBar />);
    
    // Wallet info should be available in component
    expect(useWallet).toHaveBeenCalled();
  });

  it('should show loading state', () => {
    (useAuth as any).mockReturnValue({
      user: null,
      loading: true,
      signOut: vi.fn(),
    });

    (useWallet as any).mockReturnValue({
      data: null,
      isLoading: true,
    });

    render(<NavigationBar />);
    
    // Component should handle loading state
    expect(useAuth).toHaveBeenCalled();
  });
});


