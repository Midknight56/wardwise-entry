import { CACHE_TTL_MS, DONATIONS_PER_DAY, DONATIONS_PER_SUPPORTER, PAYOUTS_PER_DAY, REFUNDS_PER_DAY, WORKLOGS_PER_DAY } from '../caps';
import { requireRule } from '../errors';
import type { Store } from '../campaign/store';
export type GateKind = 'donation' | 'refund' | 'payout' | 'worklog';
export interface GatePort {
  consume(kind: GateKind, sid?: string): Promise<void>;
  release(kind: GateKind, sid: string | undefined, attemptedAt: number): Promise<void>;
  cacheGet<T>(key: string): Promise<T | undefined>;
  cachePut(key: string, value: unknown): Promise<void>;
  remaining(kind: GateKind): Promise<number>;
}
export class GateEngine implements GatePort {
  constructor(private store: Store, private clock = Date.now) {}
  async remaining(kind: GateKind): Promise<number> {
    const day = new Date(this.clock()).toISOString().slice(0, 10);
    const key = `counter:${day}:${kind}`;
    const count = this.store.get<number>('records', key) ?? 0;
    const caps = { donation: DONATIONS_PER_DAY, refund: REFUNDS_PER_DAY, payout: PAYOUTS_PER_DAY, worklog: WORKLOGS_PER_DAY };
    return Math.max(0, caps[kind] - count);
  }
  async consume(kind: GateKind, sid = ''): Promise<void> {
    const day = new Date(this.clock()).toISOString().slice(0, 10);
    const key = `counter:${day}:${kind}`;
    const count = this.store.get<number>('records', key) ?? 0;
    const caps = { donation: DONATIONS_PER_DAY, refund: REFUNDS_PER_DAY, payout: PAYOUTS_PER_DAY, worklog: WORKLOGS_PER_DAY };
    requireRule(count < caps[kind], `Daily ${kind} limit reached. Please try tomorrow.`, 429);
    const supporterKey = `${key}:${sid}`;
    const own = this.store.get<number>('records', supporterKey) ?? 0;
    if (kind === 'donation') requireRule(own < DONATIONS_PER_SUPPORTER, 'Your daily donation limit is 6. Please try tomorrow.', 429);
    // Synchronous SQLite calls, with no await between reading and incrementing.
    this.store.put('records', key, count + 1);
    if (kind === 'donation') this.store.put('records', supporterKey, own + 1);
  }
  async release(kind: GateKind, sid: string | undefined, attemptedAt: number): Promise<void> {
    const key = `counter:${new Date(attemptedAt).toISOString().slice(0, 10)}:${kind}`;
    for (const counter of kind === 'donation' ? [key, `${key}:${sid ?? ''}`] : [key]) {
      this.store.put('records', counter, Math.max(0, (this.store.get<number>('records', counter) ?? 0) - 1));
    }
  }
  async cacheGet<T>(key: string): Promise<T | undefined> {
    const item = this.store.get<{ expires: number; value: T }>('records', 'cache:' + key);
    return item && item.expires > this.clock() ? item.value : undefined;
  }
  async cachePut(key: string, value: unknown): Promise<void> { this.store.put('records', 'cache:' + key, { expires: this.clock() + CACHE_TTL_MS, value }); }
}
