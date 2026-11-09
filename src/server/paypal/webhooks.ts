import { logFailure } from '../logging';
import type { PayPalPort, Resource } from './client';
export const EVENT_TYPES = ['PAYMENT.CAPTURE.COMPLETED','PAYMENT.CAPTURE.PENDING','PAYMENT.CAPTURE.DECLINED','PAYMENT.CAPTURE.REFUNDED','PAYMENT.REFUND.PENDING','PAYMENT.REFUND.FAILED','PAYMENT.PAYOUTS-ITEM.SUCCEEDED','PAYMENT.PAYOUTS-ITEM.UNCLAIMED','PAYMENT.PAYOUTS-ITEM.FAILED','PAYMENT.PAYOUTS-ITEM.CANCELED','PAYMENT.PAYOUTS-ITEM.HELD','PAYMENT.PAYOUTS-ITEM.BLOCKED','PAYMENT.PAYOUTS-ITEM.RETURNED'] as const;
export interface PayPalEvent { id: string; event_type: string; resource: Resource }
export function buildVerifyBody(headers: Headers, webhookId: string, raw: string): string | null {
  const data: Record<string, string> = { webhook_id: webhookId };
  for (const [key, name] of Object.entries({ auth_algo: 'paypal-auth-algo', cert_url: 'paypal-cert-url', transmission_id: 'paypal-transmission-id', transmission_sig: 'paypal-transmission-sig', transmission_time: 'paypal-transmission-time' })) {
    const value = headers.get(name); if (!value || !webhookId) return null; data[key] = value;
  }
  return JSON.stringify(data).slice(0, -1) + ',"webhook_event":' + raw + '}';
}
export async function verifySignature(p: PayPalPort, headers: Headers, webhookId: string, raw: string): Promise<boolean> {
  const body = buildVerifyBody(headers, webhookId, raw); if (!body) return false;
  try { const res = await p.request('POST', '/v1/notifications/verify-webhook-signature', body); return res.status === 200 && res.body.verification_status === 'SUCCESS'; } catch (e) { logFailure('paypal-webhook', '/v1/notifications/verify-webhook-signature', e); return false; }
}
