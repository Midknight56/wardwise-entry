import type { PayPalPort } from './client';
import { money } from './orders';
export function refundBody(id: string, cents: number) { return { amount: { value: money(cents), currency_code: 'USD' }, custom_id: `ww-${id}`, note_to_payer: 'Over the demo cap of $100 (fictional campaign)' }; }
export const refundCapture = (p: PayPalPort, capture: string, body: unknown, requestId: string) => p.request('POST', `/v2/payments/captures/${encodeURIComponent(capture)}/refund`, body, { requestId });
export const getRefund = (p: PayPalPort, id: string) => p.request('GET', `/v2/payments/refunds/${encodeURIComponent(id)}`);
