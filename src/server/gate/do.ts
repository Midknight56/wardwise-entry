import { DurableObject } from 'cloudflare:workers';
import { SqlStore, SerialQueue } from '../campaign/store';
import { GateEngine, type GateKind } from './engine';
import type { Env } from '../env';
import { ApiError } from '../errors';
export class GateDO extends DurableObject<Env> {
  private gate: GateEngine;
  private queue = new SerialQueue();
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); this.gate = new GateEngine(new SqlStore(ctx.storage.sql)); }
  consume(kind: GateKind, sid?: string) { return this.queue.run(() => this.gate.consume(kind, sid)); }
  release(kind: GateKind, sid: string | undefined, attemptedAt: number) { return this.queue.run(() => this.gate.release(kind, sid, attemptedAt)); }
  remaining(kind: GateKind) { return this.queue.run(() => this.gate.remaining(kind)); }
  async take(kind: GateKind, sid?: string) {
    try { await this.consume(kind, sid); return { ok: true as const }; }
    catch (e) { return { ok: false as const, status: e instanceof ApiError ? e.status : 503, message: e instanceof Error ? e.message : 'Gate unavailable.' }; }
  }
  cacheGet<T>(key: string): Promise<T | undefined> { return this.queue.run(() => this.gate.cacheGet<T>(key)); }
  cachePut(key: string, value: unknown) { return this.queue.run(() => this.gate.cachePut(key, value)); }
}
