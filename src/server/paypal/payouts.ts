import { logFailure } from '../logging';
import type { PayPalPort, PayPalResult, Resource } from './client';
import { money } from './orders';
export function payoutBody(id: string, email: string, cents: number) { return {
  sender_batch_header: { sender_batch_id: `ww-${id}`, email_subject: 'WardWise sandbox work payment' },
  items: [{ recipient_type: 'EMAIL', receiver: email, amount: { value: money(cents), currency: 'USD' }, sender_item_id: `ww-${id}-1`, note: 'Fictional campaign. Sandbox test money.' }],
}; }
export function originalPayoutBatchId(res: PayPalResult): string | undefined {
  if (res.status !== 400 || res.body.name !== 'USER_BUSINESS_ERROR') return;
  const details: Resource[] = res.body.details ?? [];
  if (!details.some(d => d.field === 'SENDER_BATCH_ID')) return;
  for (const link of [...details.flatMap(d => Array.isArray(d.link) ? d.link : d.link ? [d.link] : []), ...(res.body.links ?? [])]) {
    try { const match = new URL(link.href).pathname.match(/^\/v1\/payments\/payouts\/([\w-]+)\/?$/); if (match) return match[1]; } catch (e) { logFailure('paypal-duplicate', '/v1/payments/payouts', e); }
  }
}
export async function createPayout(p: PayPalPort, body: unknown, requestId: string) {
  const res = await p.request('POST', '/v1/payments/payouts', body, { requestId });
  const original = originalPayoutBatchId(res);
  return original ? getBatch(p, original) : res;
}
export const getBatch = (p: PayPalPort, id: string) => p.request('GET', `/v1/payments/payouts/${encodeURIComponent(id)}`);
export const getItem = (p: PayPalPort, id: string) => p.request('GET', `/v1/payments/payouts-item/${encodeURIComponent(id)}`);
export const cancelItem = (p: PayPalPort, id: string, requestId: string) => p.request('POST', `/v1/payments/payouts-item/${encodeURIComponent(id)}/cancel`, {}, { requestId });
