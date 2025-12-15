import { useQuery } from '@tanstack/react-query';
import { useAuth } from './use-auth';
import { STAGING_API_URL } from '../config';
import csrfService from '../lib/csrf';

export interface Transaction {
  hash: string;
  blockNumber: number;
  from: string;
  to: string;
  value: string;
  timestamp: string;
  confirmations: number;
  isIncoming: boolean;
  status: 'confirmed' | 'pending';
  tokenSymbol?: string;  // 'XDC', 'ROXN', 'USDC'
  tokenAmount?: string;  // Formatted token amount
}

export function useTransactions(limit: number = 10) {
  const { user } = useAuth();
  
  return useQuery({
    queryKey: ['transactions', limit],
    queryFn: async (): Promise<Transaction[]> => {
      if (!user) return [];
      
      const csrfToken = await csrfService.getToken();
      const response = await fetch(`${STAGING_API_URL}/api/wallet/transactions?limit=${limit}`, {
        credentials: 'include',
        headers: { 
          'Accept': 'application/json',
          'X-CSRF-Token': csrfToken
        }
      });
      
      if (!response.ok) {
        throw new Error('Failed to fetch transactions');
      }
      
      const data = await response.json();
      return data.transactions;
    },
    enabled: !!user,
    staleTime: 60000, // Consider data fresh for 1 minute
    refetchOnWindowFocus: false, // Don't refetch on window focus
  });
}
