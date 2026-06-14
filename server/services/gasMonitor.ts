import { ethers } from 'ethers';
import { log } from '../vite';
import { config } from '../config';

interface GasThresholds {
  critical: string; // XDC amount as string
  warning: string;
  checkInterval: number; // milliseconds
}

interface AlertState {
  lastCriticalAlert: number; // Unix timestamp
  lastWarningAlert: number;
  alertCooldown: number; // milliseconds
}

export interface GasStatus {
  balance: string; // Balance in XDC
  status: 'healthy' | 'warning' | 'critical';
  timestamp: string;
}

export class GasMonitor {
  private provider: ethers.JsonRpcProvider;
  private relayerAddress: string;
  private thresholds: GasThresholds = {
    critical: '5.0',      // 5 XDC
    warning: '10.0',      // 10 XDC
    checkInterval: 300000 // 5 minutes
  };
  private alertState: AlertState = {
    lastCriticalAlert: 0,
    lastWarningAlert: 0,
    alertCooldown: 3600000 // 1 hour
  };
  private monitoringInterval: NodeJS.Timeout | null = null;

  constructor(rpcUrl: string, relayerPrivateKey: string) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);

    // Derive relayer address from private key
    const wallet = new ethers.Wallet(relayerPrivateKey);
    this.relayerAddress = wallet.address;

    log(`Gas monitor initialized for relayer: ${this.relayerAddress}`, 'blockchain');
  }

  /**
   * Check current gas balance and return status
   */
  async checkBalance(): Promise<GasStatus> {
    try {
      // Get balance from blockchain
      const balanceWei = await this.provider.getBalance(this.relayerAddress);
      const balance = ethers.formatEther(balanceWei);

      // Determine status based on thresholds
      const criticalThreshold = ethers.parseEther(this.thresholds.critical);
      const warningThreshold = ethers.parseEther(this.thresholds.warning);

      let status: 'healthy' | 'warning' | 'critical' = 'healthy';

      if (balanceWei <= criticalThreshold) {
        status = 'critical';
        await this.sendAlertIfNeeded('critical', balance);
      } else if (balanceWei <= warningThreshold) {
        status = 'warning';
        await this.sendAlertIfNeeded('warning', balance);
      }

      // Log current status
      log(
        `Relayer gas balance: ${balance} XDC (${status})`,
        'blockchain'
      );

      return {
        balance,
        status,
        timestamp: new Date().toISOString()
      };

    } catch (error: any) {
      log(
        `Error checking gas balance: ${error.message}`,
        'blockchain'
      );
      throw error;
    }
  }

  /**
   * Send email alert if cooldown period has passed
   */
  private async sendAlertIfNeeded(
    level: 'warning' | 'critical',
    balance: string
  ): Promise<void> {
    const now = Date.now();
    const lastAlert =
      level === 'critical'
        ? this.alertState.lastCriticalAlert
        : this.alertState.lastWarningAlert;

    // Check if enough time has passed since last alert
    if (now - lastAlert < this.alertState.alertCooldown) {
      return; // Don't spam alerts
    }

    try {
      // Import email service dynamically to avoid circular dependencies
      const { sendGasAlertEmail } = await import('../email');

      await sendGasAlertEmail(level, balance, this.relayerAddress);

      // Update last alert timestamp
      if (level === 'critical') {
        this.alertState.lastCriticalAlert = now;
      } else {
        this.alertState.lastWarningAlert = now;
      }

      log(
        `Gas alert email sent: ${level.toUpperCase()} - Balance: ${balance} XDC`,
        'email'
      );

    } catch (error: any) {
      log(
        `Failed to send gas alert email: ${error.message}`,
        'email'
      );
      // Don't throw - email failure shouldn't break gas monitoring
    }
  }

  /**
   * Start background monitoring service
   */
  startMonitoring(): void {
    if (this.monitoringInterval) {
      log('Gas monitor already running', 'blockchain');
      return;
    }

    log(
      `Starting gas monitor service (interval: ${this.thresholds.checkInterval / 1000}s)`,
      'blockchain'
    );

    // Initial check
    this.checkBalance().catch((err) => {
      log(
        `Gas monitor initial check failed: ${err.message}`,
        'blockchain'
      );
    });

    // Periodic checks
    this.monitoringInterval = setInterval(() => {
      this.checkBalance().catch((err) => {
        log(
          `Gas monitor periodic check failed: ${err.message}`,
          'blockchain'
        );
      });
    }, this.thresholds.checkInterval);
  }

  /**
   * Stop background monitoring service
   */
  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
      log('Gas monitor service stopped', 'blockchain');
    }
  }

  /**
   * Ensure sufficient gas before executing a transaction
   * @param requiredGas Minimum XDC required (default: 0.1)
   * @throws Error if insufficient gas
   */
  async ensureSufficientGas(requiredGas: string = '0.1'): Promise<void> {
    const { balance, status } = await this.checkBalance();

    const balanceWei = ethers.parseEther(balance);
    const requiredWei = ethers.parseEther(requiredGas);

    // Check if balance is below required amount
    if (balanceWei < requiredWei) {
      throw new Error(
        `Insufficient relayer gas: ${balance} XDC (need ${requiredGas} XDC)`
      );
    }

    // Check if balance is critically low
    if (status === 'critical') {
      throw new Error(
        `Relayer gas critically low: ${balance} XDC - operations paused`
      );
    }

    // Log warning if approaching threshold
    if (status === 'warning') {
      log(
        `WARNING: Relayer gas balance is low (${balance} XDC)`,
        'blockchain'
      );
    }
  }

  /**
   * Get current monitoring interval
   */
  getCheckInterval(): number {
    return this.thresholds.checkInterval;
  }

  /**
   * Get configured thresholds
   */
  getThresholds(): { critical: string; warning: string } {
    return {
      critical: this.thresholds.critical,
      warning: this.thresholds.warning
    };
  }

  /**
   * Update thresholds (useful for testing)
   */
  setThresholds(critical: string, warning: string): void {
    this.thresholds.critical = critical;
    this.thresholds.warning = warning;

    log(
      `Gas thresholds updated - Critical: ${critical} XDC, Warning: ${warning} XDC`,
      'blockchain'
    );
  }

  /**
   * Reset alert cooldown (useful for testing)
   */
  resetAlertCooldown(): void {
    this.alertState.lastCriticalAlert = 0;
    this.alertState.lastWarningAlert = 0;
  }
}

// Singleton instance - initialized with config
export const gasMonitor = new GasMonitor(
  config.xdcRpcUrl,
  config.relayerPrivateKey
);
