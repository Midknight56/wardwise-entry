// Run only when explicitly registering the sandbox webhook. No credential values are printed.
const base = 'https://api-m.sandbox.paypal.com';
const url = 'https://wardwise.midknight-labs.workers.dev/webhooks/paypal';
const types = ['PAYMENT.CAPTURE.COMPLETED','PAYMENT.CAPTURE.PENDING','PAYMENT.CAPTURE.DECLINED','PAYMENT.CAPTURE.REFUNDED','PAYMENT.REFUND.PENDING','PAYMENT.REFUND.FAILED','PAYMENT.PAYOUTS-ITEM.SUCCEEDED','PAYMENT.PAYOUTS-ITEM.UNCLAIMED','PAYMENT.PAYOUTS-ITEM.FAILED','PAYMENT.PAYOUTS-ITEM.CANCELED','PAYMENT.PAYOUTS-ITEM.HELD','PAYMENT.PAYOUTS-ITEM.BLOCKED','PAYMENT.PAYOUTS-ITEM.RETURNED'];
async function main() {
  const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) throw new Error('PayPal environment keys are missing.');
  const token = await fetch(base + '/v1/oauth2/token', { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded', 'PayPal-Request-Id': crypto.randomUUID() }, body: 'grant_type=client_credentials' });
  if (!token.ok) throw new Error(`PayPal authentication HTTP ${token.status}`);
  const { access_token } = await token.json();
  const call = async (path, method = 'GET', body) => {
    const res = await fetch(base + path, { method, headers: { Authorization: 'Bearer ' + access_token, 'Content-Type': 'application/json', 'PayPal-Request-Id': crypto.randomUUID() }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw new Error(`PayPal webhook HTTP ${res.status}`);
    return res.json();
  };
  const existing = (await call('/v1/notifications/webhooks')).webhooks?.find(hook => hook.url === url);
  if (existing) {
    const present = new Set(existing.event_types.map(e => e.name));
    if (!types.every(type => present.has(type))) await call(`/v1/notifications/webhooks/${existing.id}`, 'PATCH', [{ op: 'replace', path: '/event_types', value: types.map(name => ({ name })) }]);
    console.log(existing.id);
  } else console.log((await call('/v1/notifications/webhooks', 'POST', { url, event_types: types.map(name => ({ name })) })).id);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
