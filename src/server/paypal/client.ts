import { logFailure } from '../logging';

export class NotSentError extends Error {
  constructor() { super('PayPal could not be reached. No money moved.'); this.name = 'NotSentError'; }
}
export interface PayPalEnv { PAYPAL_CLIENT_ID: string; PAYPAL_CLIENT_SECRET: string; PAYPAL_BASE?: string }
export interface Receipt { method: string; path: string; status: number; debugId?: string; at: string }
// PayPal payloads have nested, endpoint-specific schemas. Narrow them at the money boundary.
export type Resource = Record<string, any>;
export interface PayPalResult { status: number; body: Resource; debugId?: string }
export interface PayPalPort {
  onCall?: (receipt: Receipt) => void;
  request(method: string, path: string, body?: unknown, options?: { requestId?: string; headers?: Record<string, string> }): Promise<PayPalResult>;
}
export class PayPal implements PayPalPort {
  onCall?: (receipt: Receipt) => void;
  private cached?: { value: string; expires: number };
  private minting?: Promise<string>;
  readonly base: string;
  constructor(private env: PayPalEnv, private fetchFn: typeof fetch = (input, init) => fetch(input, init), private clock = Date.now,
    private sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))) {
    this.base = env.PAYPAL_BASE ?? 'https://api-m.sandbox.paypal.com';
    if (this.base !== 'https://api-m.sandbox.paypal.com') throw new Error('Sandbox PayPal only.');
  }
  async token(): Promise<string> {
    if (this.cached && this.cached.expires > this.clock()) return this.cached.value;
    if (this.minting) return this.minting;
    this.minting = (async () => {
      const path = '/v1/oauth2/token';
      const res = await (0, this.fetchFn)(this.base + path, { method: 'POST', headers: {
        Authorization: 'Basic ' + btoa(`${this.env.PAYPAL_CLIENT_ID}:${this.env.PAYPAL_CLIENT_SECRET}`),
        'Content-Type': 'application/x-www-form-urlencoded', 'PayPal-Request-Id': crypto.randomUUID(),
      }, body: 'grant_type=client_credentials' });
      const body = await res.json() as Resource;
      this.onCall?.({ method: 'POST', path, status: res.status, debugId: body.debug_id ?? res.headers.get('paypal-debug-id') ?? undefined, at: new Date(this.clock()).toISOString() });
      if (!res.ok || !body.access_token) throw new Error('PayPal authentication unavailable.');
      this.cached = { value: body.access_token, expires: this.clock() + (body.expires_in - 60) * 1000 };
      return this.cached.value;
    })();
    try { return await this.minting; } catch (e) {
      logFailure('paypal', '/v1/oauth2/token', e, [this.env.PAYPAL_CLIENT_ID, this.env.PAYPAL_CLIENT_SECRET]); throw e;
    } finally { this.minting = undefined; }
  }
  async request(method: string, path: string, body?: unknown, options: { requestId?: string; headers?: Record<string, string> } = {}): Promise<PayPalResult> {
    let requestId: string;
    let serialized: string | undefined;
    try {
      if (!/^\/v[12]\//.test(path)) throw new Error('Invalid PayPal path.');
      requestId = options.requestId ?? crypto.randomUUID();
      serialized = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    } catch (e) { logFailure('paypal', path, e, [this.env.PAYPAL_CLIENT_ID, this.env.PAYPAL_CLIENT_SECRET, this.cached?.value ?? '']); throw new NotSentError(); }
    for (let attempt = 0; attempt < 3; attempt++) {
      let init: RequestInit;
      try {
        init = { method, headers: {
          Authorization: 'Bearer ' + await this.token(), 'Content-Type': 'application/json',
          ...(method === 'POST' ? { 'PayPal-Request-Id': requestId } : {}),
          ...(/orders|\/refund/.test(path) ? { Prefer: 'return=representation' } : {}), ...options.headers,
        }, body: serialized };
      } catch (e) { logFailure('paypal', path, e, [this.env.PAYPAL_CLIENT_ID, this.env.PAYPAL_CLIENT_SECRET, this.cached?.value ?? '']); throw new NotSentError(); }
      let res: Response;
      try {
        res = await (0, this.fetchFn)(this.base + path, init);
      } catch (e) {
        logFailure('paypal', path, e, [this.env.PAYPAL_CLIENT_ID, this.env.PAYPAL_CLIENT_SECRET, this.cached?.value ?? '']);
        this.onCall?.({ method, path, status: 0, at: new Date(this.clock()).toISOString() });
        if (method === 'POST' || attempt === 2) throw e;
        await this.sleep(100 * 2 ** attempt); continue;
      }
      let parsed: Resource;
      try {
        parsed = await res.json() as Resource;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('Unreadable PayPal resource.');
      }
      catch (e) {
        logFailure('paypal', path, e, [this.env.PAYPAL_CLIENT_ID, this.env.PAYPAL_CLIENT_SECRET, this.cached?.value ?? '']);
        this.onCall?.({ method, path, status: res.status, at: new Date(this.clock()).toISOString() });
        throw e;
      }
      if (res.status >= 400) logFailure('paypal', path, new Error(`HTTP ${res.status}`));
      const debugId = parsed.debug_id ?? res.headers.get('paypal-debug-id') ?? undefined;
      this.onCall?.({ method, path, status: res.status, debugId, at: new Date(this.clock()).toISOString() });
      if (res.status === 401 && attempt < 2) { this.cached = undefined; continue; }
      if (method === 'GET' && (res.status === 429 || res.status >= 500) && attempt < 2) { await this.sleep(100 * 2 ** attempt); continue; }
      return { status: res.status, body: parsed, debugId };
    }
    throw new Error('PayPal unavailable.');
  }
}
