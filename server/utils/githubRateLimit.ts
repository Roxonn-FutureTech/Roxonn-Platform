import { log } from '../vite';

interface RateLimitState {
  remaining: number;
  reset: number; // Unix timestamp
  limit: number;
  resource: string;
}

interface RetryConfig {
  maxRetries: number;
  baseDelay: number; // milliseconds
  maxDelay: number;
}

export interface GitHubAPIResponse<T> {
  data: T;
  headers: {
    'x-ratelimit-remaining'?: string;
    'x-ratelimit-reset'?: string;
    'x-ratelimit-limit'?: string;
    'x-ratelimit-resource'?: string;
  };
}

export class GitHubRateLimiter {
  private state: RateLimitState | null = null;
  private readonly config: RetryConfig = {
    maxRetries: 5,
    baseDelay: 1000,   // 1 second
    maxDelay: 60000    // 60 seconds
  };

  /**
   * Execute a GitHub API call with automatic retry and exponential backoff
   * @param fn Function that makes the GitHub API call
   * @param operation Description of the operation for logging
   * @returns The data from the API call
   */
  async executeWithRetry<T>(
    fn: () => Promise<GitHubAPIResponse<T>>,
    operation: string
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        // Check rate limit before making the call
        await this.checkRateLimit();

        // Execute the API call
        const response = await fn();

        // Update rate limit state from response headers
        this.updateRateLimitState(response.headers);

        // Log successful call
        if (this.state) {
          log(
            `GitHub API call successful [${operation}] - Rate limit: ${this.state.remaining}/${this.state.limit} remaining`,
            'github'
          );
        }

        return response.data;

      } catch (error: any) {
        lastError = error;

        // Check if this is a rate limit error (429)
        const isRateLimitError = error.status === 429 || error.response?.status === 429;

        // Check if this is a server error (5xx) that we should retry
        const isServerError = error.status >= 500 || error.response?.status >= 500;

        if (!isRateLimitError && !isServerError) {
          // Not a retryable error, throw immediately
          throw error;
        }

        // Update rate limit state if available in error response
        if (error.response?.headers) {
          this.updateRateLimitState(error.response.headers);
        }

        // Check if this is the last attempt
        if (attempt === this.config.maxRetries - 1) {
          log(
            `GitHub API call failed after ${this.config.maxRetries} attempts [${operation}]: ${error.message}`,
            'github'
          );
          throw new Error(
            `GitHub API rate limit exceeded or server error after ${this.config.maxRetries} retries: ${error.message}`
          );
        }

        // Calculate backoff delay
        const delay = this.calculateBackoff(attempt);

        log(
          `GitHub API ${isRateLimitError ? 'rate limit' : 'server error'} [${operation}] - Retry ${attempt + 1}/${this.config.maxRetries} in ${delay}ms`,
          'github'
        );

        // Wait before retrying
        await this.sleep(delay);
      }
    }

    // Should never reach here, but TypeScript needs this
    throw lastError || new Error('GitHub API call failed');
  }

  /**
   * Check if we're approaching rate limit and wait if needed
   */
  private async checkRateLimit(): Promise<void> {
    if (!this.state) {
      return; // No rate limit info yet
    }

    // If we have very few requests left, wait until reset
    if (this.state.remaining < 10) {
      const now = Math.floor(Date.now() / 1000);
      const waitTime = (this.state.reset - now) * 1000;

      if (waitTime > 0 && waitTime < 300000) { // Wait max 5 minutes
        log(
          `GitHub API rate limit low (${this.state.remaining} remaining) - Waiting ${Math.floor(waitTime / 1000)}s until reset`,
          'github'
        );
        await this.sleep(waitTime + 1000); // Add 1 second buffer
      }
    }
  }

  /**
   * Update rate limit state from API response headers
   */
  private updateRateLimitState(headers: any): void {
    const remaining = headers['x-ratelimit-remaining'];
    const reset = headers['x-ratelimit-reset'];
    const limit = headers['x-ratelimit-limit'];
    const resource = headers['x-ratelimit-resource'];

    if (remaining !== undefined && reset !== undefined && limit !== undefined) {
      this.state = {
        remaining: parseInt(remaining, 10),
        reset: parseInt(reset, 10),
        limit: parseInt(limit, 10),
        resource: resource || 'core'
      };
    }
  }

  /**
   * Calculate exponential backoff with jitter
   * Formula: min(baseDelay * 2^attempt, maxDelay) + random jitter
   */
  private calculateBackoff(attempt: number): number {
    const exponential = Math.min(
      this.config.baseDelay * Math.pow(2, attempt),
      this.config.maxDelay
    );

    // Add random jitter (0-25% of the delay)
    const jitter = Math.random() * exponential * 0.25;

    return Math.floor(exponential + jitter);
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get current rate limit status
   */
  getRateLimitStatus(): RateLimitState | null {
    return this.state;
  }

  /**
   * Check if we're close to rate limit
   */
  isApproachingLimit(): boolean {
    if (!this.state) {
      return false;
    }

    // Consider "approaching" when less than 20% remaining
    const threshold = this.state.limit * 0.2;
    return this.state.remaining < threshold;
  }
}

// Singleton instance
export const githubRateLimiter = new GitHubRateLimiter();
