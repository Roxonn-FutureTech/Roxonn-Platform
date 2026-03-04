import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  CreditCard,
  Loader2,
  Receipt,
  AlertTriangle
} from 'lucide-react';
import api from '@/lib/api';
import { format } from 'date-fns';

interface PaymentVerificationModalProps {
  onSuccess?: () => void;
  trigger?: React.ReactNode;
}

export function PaymentVerificationModal({ onSuccess, trigger }: PaymentVerificationModalProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pendingPayments, setPendingPayments] = useState<any[]>([]);
  const [needsConfirmation, setNeedsConfirmation] = useState<any>(null);

  // Form state for Order ID verification (ONLY SECURE METHOD)
  const [orderId, setOrderId] = useState('');

  // Load pending payments when modal opens
  React.useEffect(() => {
    if (open) {
      loadPendingPayments();
    }
  }, [open]);

  const loadPendingPayments = async () => {
    try {
      const response = await api.get('/api/subscription/pending-payments');
      if (response.data?.payments) {
        setPendingPayments(response.data.payments);
      }
    } catch (err) {
      console.error('Failed to load pending payments:', err);
    }
  };

  const handleVerification = async () => {
    if (!orderId) return;

    setLoading(true);
    setError(null);
    setSuccess(false);
    setNeedsConfirmation(null);

    try {
      const payload = { orderId };

      const response = await api.post('/api/subscription/verify-payment', payload);

      if (response.data?.success) {
        setSuccess(true);
        setTimeout(() => {
          setOpen(false);
          if (onSuccess) onSuccess();
        }, 2000);
      } else if (response.data?.needsConfirmation) {
        setNeedsConfirmation(response.data);
      } else {
        setError(response.data?.message || 'Verification failed');
      }
    } catch (err: any) {
      const errorMessage = err.response?.data?.message ||
                          err.response?.data?.error ||
                          'An error occurred during verification';
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmation = async (confirmed: boolean) => {
    if (!confirmed || !needsConfirmation?.transaction) {
      setNeedsConfirmation(null);
      return;
    }

    setLoading(true);
    try {
      const response = await api.post('/api/subscription/confirm-verification', {
        transactionId: needsConfirmation.transaction.id,
        confirm: true,
        orderId: orderId || undefined
      });

      if (response.data?.success) {
        setSuccess(true);
        setNeedsConfirmation(null);
        setTimeout(() => {
          setOpen(false);
          if (onSuccess) onSuccess();
        }, 2000);
      } else {
        setError(response.data?.message || 'Confirmation failed');
        setNeedsConfirmation(null);
      }
    } catch (err: any) {
      setError('Failed to confirm payment');
      setNeedsConfirmation(null);
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setOrderId('');
    setError(null);
    setSuccess(false);
    setNeedsConfirmation(null);
  };

  return (
    <Dialog open={open} onOpenChange={(newOpen) => {
      setOpen(newOpen);
      if (!newOpen) resetForm();
    }}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" className="w-full">
            <Receipt className="h-4 w-4 mr-2" />
            Verify Payment
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Verify Your Payment</DialogTitle>
          <DialogDescription>
            Enter your Order ID from Onramp.money. Only you can see this in your Onramp account after logging in.
          </DialogDescription>
        </DialogHeader>

        {/* Success State */}
        {success && (
          <Alert className="bg-green-50 border-green-200 dark:bg-green-900/20">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            <AlertTitle>Payment Verified!</AlertTitle>
            <AlertDescription>
              Your subscription is now active. Refreshing...
            </AlertDescription>
          </Alert>
        )}

        {/* Error State */}
        {error && !success && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Verification Failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Confirmation Required */}
        {needsConfirmation && (
          <Card className="border-orange-200 dark:border-orange-800">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-orange-600" />
                Confirm Your Payment
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-4">We found a payment initiated at:</p>
              <div className="bg-muted p-3 rounded-md space-y-2 mb-4">
                <div>
                  <span className="font-medium">Time:</span>{' '}
                  {format(new Date(needsConfirmation.transaction.createdAt), 'PPpp')}
                </div>
                <div>
                  <span className="font-medium">Reference:</span>{' '}
                  <code className="text-xs">{needsConfirmation.transaction.merchantRecognitionId}</code>
                </div>
              </div>
              <p className="text-sm text-muted-foreground mb-4">
                To confirm this is your payment, please provide the Order ID or Transaction Hash.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => handleConfirmation(false)}
                  disabled={loading}
                >
                  This isn't my payment
                </Button>
                <Button
                  onClick={() => handleConfirmation(true)}
                  disabled={loading || !orderId}
                >
                  {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Confirm & Activate
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Pending Payments Info */}
        {pendingPayments.length > 0 && !success && !needsConfirmation && (
          <Alert>
            <Clock className="h-4 w-4" />
            <AlertTitle>Pending Payments Detected</AlertTitle>
            <AlertDescription>
              You have {pendingPayments.length} payment(s) awaiting verification.
              {pendingPayments[0] && (
                <div className="mt-2 text-xs">
                  Last initiated: {format(new Date(pendingPayments[0].createdAt), 'PP p')}
                </div>
              )}
            </AlertDescription>
          </Alert>
        )}

        {/* Verification Method - ONLY ORDER ID IS SECURE */}
        {!success && !needsConfirmation && (
          <div className="w-full space-y-4">
              <div className="space-y-2">
                <Label htmlFor="orderId">Order ID</Label>
                <Input
                  id="orderId"
                  placeholder="e.g., 1480242"
                  value={orderId}
                  onChange={(e) => setOrderId(e.target.value)}
                  disabled={loading}
                />
                <p className="text-sm text-muted-foreground">
                  Find this in your Onramp.money receipt or confirmation email
                </p>
              </div>

              {/* Security Info */}
              <Card className="bg-muted/50">
                <CardContent className="pt-4">
                  <p className="text-sm mb-2 font-medium">Why Order ID is secure:</p>
                  <div className="bg-background p-2 rounded border">
                    <div className="text-xs space-y-1">
                      <div>✓ Only visible after logging into YOUR Onramp account</div>
                      <div>✓ Tied to your Onramp login credentials</div>
                      <div>✓ Cannot be seen on blockchain (private)</div>
                      <div>✓ Unique to your payment</div>
                    </div>
                  </div>
                  <p className="text-xs mt-2 text-muted-foreground">
                    Find it in: Onramp receipt page, Email confirmation, or Transaction details
                  </p>
                </CardContent>
              </Card>

              <Button
                className="w-full"
                onClick={handleVerification}
                disabled={loading || !orderId}
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Verifying...
                  </>
                ) : (
                  <>
                    <CreditCard className="h-4 w-4 mr-2" />
                    Verify Payment
                  </>
                )}
              </Button>
          </div>
        )}


        {/* Help Text */}
        {!success && !needsConfirmation && (
          <div className="mt-4 pt-4 border-t">
            <p className="text-sm text-muted-foreground">
              <strong>Note:</strong> Verification typically works immediately if your payment was successful.
              If you continue to have issues, please contact support with your payment details.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}