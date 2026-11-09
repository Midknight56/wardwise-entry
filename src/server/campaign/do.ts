import { DurableObject } from 'cloudflare:workers';
import cityJson from '../../../public/data/chicago.json';
import type { CityData } from '../../model/types';
import { allocate } from '../../model/allocate';
import { DEFAULT_BUDGET } from '../caps';
import { CampaignEngine } from './engine';
import { SerialQueue, SqlStore } from './store';
import { PayPal } from '../paypal/client';
import { payees } from '../payees';
import type { Env } from '../env';
import type { PayPalEvent } from '../paypal/webhooks';
import { ApiError } from '../errors';
export class CampaignDO extends DurableObject<Env> {
  private engine: CampaignEngine;
  private queue = new SerialQueue();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.engine = new CampaignEngine({ store: new SqlStore(ctx.storage.sql), paypal: new PayPal(env), clock: Date.now,
      payees: payees(env), gate: {
        consume: async (kind, sid) => { const result = await env.GATE.getByName('gate').take(kind, sid); if (!result.ok) throw new ApiError(result.status, 'daily_cap', result.message); },
        release: (kind, sid, attemptedAt) => env.GATE.getByName('gate').release(kind, sid, attemptedAt),
        cacheGet: key => env.GATE.getByName('gate').cacheGet(key), cachePut: (key, value) => env.GATE.getByName('gate').cachePut(key, value),
        remaining: kind => env.GATE.getByName('gate').remaining(kind),
      }, plan: allocate(DEFAULT_BUDGET, 'y2023', city.wards).perWard, wards: city.wards.map(w => w.id) });
  }
  async dispatch(action: string, args: unknown[]) {
    try {
      let value: unknown;
      switch (action) {
        case 'donate': value = await this.donate(args[0] as string, args[1], args[2] as { origin?: string; declineTest?: boolean }); break;
        case 'refreshDonation': value = await this.refreshDonation(args[0] as string, args[1] as string); break;
        case 'finishOrder': value = await this.finishOrder(args[0] as string, args[1] as string, args[2] as boolean); break;
        case 'approveRefund': value = await this.approveRefund(args[0] as string, args[1] as string); break;
        case 'createWorklog': value = await this.createWorklog(args[0]); break;
        case 'pay': value = await this.pay(args[0] as string); break;
        case 'refresh': value = await this.refresh(args[0] as string); break;
        case 'cancel': value = await this.cancel(args[0] as string); break;
        case 'payPayroll': value = await this.payPayroll(args[0]); break;
        case 'refreshPayroll': value = await this.refreshPayroll(args[0] as string); break;
        case 'payrollPreview': value = await this.payrollPreview(); break;
        case 'getReadyWorklogs': value = await this.getReadyWorklogs(); break;
        case 'applyWebhook': value = await this.applyWebhook(args[0] as PayPalEvent); break;
        case 'state': value = await this.state(args[0] as string, args[1] as number | undefined); break;
        case 'setFault': value = await this.setFault(args[0] as 'lose_next_response' | 'pending_next_capture'); break;
        default: throw new ApiError(404, 'not_found', 'Unknown campaign action.');
      }
      return { ok: true as const, value };
    } catch (e) { return { ok: false as const, status: e instanceof ApiError ? e.status : 503, error: e instanceof ApiError ? e.error : 'unavailable', message: e instanceof Error ? e.message : 'Service unavailable.' }; }
  }
  donate(sid: string, body: unknown, options?: { origin?: string; declineTest?: boolean }) { return this.queue.run(() => this.engine.donate(sid, body, options)); }
  refreshDonation(sid: string, id: string) { return this.queue.run(() => this.engine.refreshDonation(sid, id)); }
  finishOrder(sid: string, id: string, cancel?: boolean) { return this.queue.run(() => this.engine.finishOrder(sid, id, cancel)); }
  approveRefund(sid: string, id: string) { return this.queue.run(() => this.engine.approveRefund(sid, id)); }
  createWorklog(body: unknown) { return this.queue.run(() => this.engine.createWorklog(body)); }
  pay(id: string) { return this.queue.run(() => this.engine.pay(id)); }
  payPayroll(input?: unknown) { return this.queue.run(() => this.engine.payPayroll(input)); }
  refreshPayroll(id: string) { return this.queue.run(() => this.engine.refreshPayroll(id)); }
  payrollPreview() { return this.queue.run(() => this.engine.payrollPreview()); }
  getReadyWorklogs() { return this.queue.run(async () => this.engine.getReadyWorklogs()); }
  refresh(id: string) { return this.queue.run(() => this.engine.refresh(id)); }
  cancel(id: string) { return this.queue.run(() => this.engine.cancel(id)); }
  applyWebhook(event: PayPalEvent) { return this.queue.run(() => this.engine.applyWebhook(event)); }
  state(sid: string, ward?: number) { return this.queue.run(() => this.engine.state(sid, ward)); }
  setFault(kind: 'lose_next_response' | 'pending_next_capture') { return this.queue.run(() => this.engine.setFault(kind)); }
}
const city = cityJson as unknown as CityData;
