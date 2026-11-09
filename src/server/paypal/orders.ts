import type { PayPalPort } from './client';
export const money = (cents: number) => (cents / 100).toFixed(2);
export function orderBody(p: { id: string; ward: number; cents: number; method: 'card' | 'paypal'; origin: string }) {
  const amount = { currency_code: 'USD', value: money(p.cents), breakdown: { item_total: { currency_code: 'USD', value: money(p.cents) } } };
  return { intent: 'CAPTURE', purchase_units: [{ custom_id: `ww-${p.id}`, description: 'Fictional campaign demo. Sandbox test money.', amount,
    items: [{ name: `Ward ${p.ward} field plan (fictional campaign)`, category: 'DONATION', quantity: '1', unit_amount: { currency_code: 'USD', value: money(p.cents) } }] }],
    payment_source: p.method === 'card' ? { card: {
      // Published sandbox test number only. Client enforces the sandbox hostname.
      number: '4111111111111111', expiry: '2030-12', security_code: '123', name: 'Test Supporter',
      billing_address: { address_line_1: '123 Main St', admin_area_2: 'Chicago', admin_area_1: 'IL', postal_code: '60601', country_code: 'US' },
    } } : { paypal: { experience_context: { return_url: `${p.origin}/return/paypal`, cancel_url: `${p.origin}/return/cancel`, user_action: 'PAY_NOW' } } } };
}
export const createOrder = (p: PayPalPort, body: unknown, requestId: string, headers?: Record<string, string>) => p.request('POST', '/v2/checkout/orders', body, { requestId, headers });
export const captureOrder = (p: PayPalPort, id: string, requestId: string) => p.request('POST', `/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {}, { requestId });
export const getOrder = (p: PayPalPort, id: string) => p.request('GET', `/v2/checkout/orders/${encodeURIComponent(id)}`);
export const getCapture = (p: PayPalPort, id: string) => p.request('GET', `/v2/payments/captures/${encodeURIComponent(id)}`);
