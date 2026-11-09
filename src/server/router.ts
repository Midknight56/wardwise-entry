import { logFailure } from './logging';
import type { CampaignEngine } from './campaign/engine';
import { ApiError, errorResponse, fields, requireRule } from './errors';
import { verifySignature, type PayPalEvent } from './paypal/webhooks';
import type { PayPalPort } from './paypal/client';
import type { Answer } from './ai/ask';
export interface RouterDependencies {
  campaign(): Pick<CampaignEngine, 'donate' | 'refreshDonation' | 'finishOrder' | 'approveRefund' | 'createWorklog' | 'pay' | 'refresh' | 'cancel' | 'state' | 'applyWebhook' | 'setFault' | 'payPayroll' | 'refreshPayroll' | 'payrollPreview'>;
  ask(input: unknown): Promise<Answer>; paypal: PayPalPort; webhookId: string;
  assets(request: Request): Promise<Response>; dev: boolean; build: string;
}
function publicJson(value: unknown): Response {
  return new Response(JSON.stringify(value, (key, item) => key === 'sid' ? undefined : item), { headers: { 'Content-Type': 'application/json' } });
}
export async function readBody(request: Request, limit = 16384): Promise<string> {
  const reader = request.body?.getReader(); if (!reader) return '';
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > limit) { await reader.cancel(); throw new ApiError(413, 'body_too_large', 'Request body is too large.'); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}
async function json(request: Request): Promise<unknown> {
  const raw = await readBody(request);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new ApiError(400, 'invalid_json', 'Send valid JSON.'); }
}
export async function route(request: Request, deps: RouterDependencies): Promise<Response> {
  const url = new URL(request.url);
  const existing = request.headers.get('cookie')?.match(/(?:^|;\s*)ww_sid=([a-f0-9]{32})(?:;|$)/)?.[1];
  const sid = existing ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  let response: Response;
  try {
    if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
      const origin = request.headers.get('origin'); requireRule(!origin || origin === url.origin, 'Use this site to send requests.', 403);
    }
    if (url.pathname === '/healthz' && request.method === 'GET') response = publicJson({ ok: true, build: deps.build });
    else if (url.pathname === '/webhooks/paypal' && request.method === 'POST') {
      const raw = await readBody(request, 1024 * 1024);
      let event: PayPalEvent;
      try { event = JSON.parse(raw); } catch { throw new ApiError(400, 'invalid_json', 'Invalid webhook JSON.'); }
      requireRule(event && typeof event.id === 'string' && typeof event.event_type === 'string' && event.resource && typeof event.resource === 'object', 'Invalid webhook event.');
      requireRule(await verifySignature(deps.paypal, request.headers, deps.webhookId, raw), 'Webhook signature was not verified.');
      response = publicJson(await deps.campaign().applyWebhook(event));
    } else if (request.method === 'GET' && ['/return/paypal', '/return/cancel'].includes(url.pathname)) {
      const token = url.searchParams.get('token'); requireRule(token && /^[A-Za-z0-9-]+$/.test(token), 'PayPal order token is required.');
      const record = await deps.campaign().finishOrder(sid, token, url.pathname === '/return/cancel');
      const target = new URL('/', url.origin); target.searchParams.set('ward', String(record.ward));
      target.searchParams.set('result', record.status.toLowerCase());
      if (record.message) target.searchParams.set('message', record.message);
      response = new Response(null, { status: 303, headers: { Location: target.href } });
    } else if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/state' && request.method === 'GET') {
        const raw = url.searchParams.get('ward');
        const ward = raw === null ? undefined : Number(raw);
        requireRule(ward === undefined || Number.isInteger(ward) && ward >= 1 && ward <= 50, 'Ward must be 1 to 50.');
        response = publicJson(await deps.campaign().state(sid, ward));
      }
      else if (url.pathname === '/api/payroll/preview' && request.method === 'GET') {
        response = publicJson(await deps.campaign().payrollPreview());
      }
      else if (request.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Use POST for this action.');
      else if (url.pathname === '/api/donations') response = publicJson(await deps.campaign().donate(sid, await json(request), { origin: url.origin, declineTest: deps.dev && url.searchParams.get('declineTest') === '1' }));
      else if (url.pathname === '/api/ask') response = publicJson(await deps.ask(await json(request)));
      else if (url.pathname === '/api/worklogs') response = publicJson(await deps.campaign().createWorklog(await json(request)));
      else if (url.pathname === '/api/payroll/pay') {
        const body = fields(await json(request), ['version']);
        response = publicJson(await deps.campaign().payPayroll(body));
      }
      else if (url.pathname === '/api/dev/fault') {
        requireRule(deps.dev, 'Route not found.', 404);
        const body = fields(await json(request), ['kind']); requireRule(body.kind === 'lose_next_response' || body.kind === 'pending_next_capture', 'Unknown fault kind.');
        response = publicJson(await deps.campaign().setFault(body.kind));
      } else {
        const body = await json(request);
        fields(body, []);
        const donation = url.pathname.match(/^\/api\/donations\/([\w-]+)\/refresh$/);
        const refund = url.pathname.match(/^\/api\/refunds\/([\w-]+)\/approve$/), worklog = url.pathname.match(/^\/api\/worklogs\/([\w-]+)\/(pay|refresh|cancel)$/);
        const payrollRefresh = url.pathname.match(/^\/api\/payroll\/([\w-]+)\/refresh$/);
        if (donation) response = publicJson(await deps.campaign().refreshDonation(sid, donation[1]));
        else if (refund) response = publicJson(await deps.campaign().approveRefund(sid, refund[1]));
        else if (payrollRefresh) response = publicJson(await deps.campaign().refreshPayroll(payrollRefresh[1]));
        else if (worklog) {
          const engine = deps.campaign(), action = worklog[2] as 'pay' | 'refresh' | 'cancel'; response = publicJson(await engine[action](worklog[1]));
        } else throw new ApiError(404, 'not_found', 'Route not found.');
      }
    } else if (url.pathname.startsWith('/webhooks/') || url.pathname.startsWith('/return/')) throw new ApiError(404, 'not_found', 'Route not found.');
    else response = await deps.assets(request);
  } catch (e) {
    if (!(e instanceof ApiError) || e.status >= 500) logFailure('request', url.pathname, e);
    response = errorResponse(e);
  }
  const headers = new Headers(response.headers);
  if (!existing && url.pathname !== '/webhooks/paypal') headers.append('Set-Cookie', `ww_sid=${sid}; Path=/; HttpOnly; SameSite=Lax${url.protocol === 'https:' ? '; Secure' : ''}; Max-Age=31536000`);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/return/')) headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
