import { DEFAULT_BUDGET, DEMO_CAP, DONATION_CHOICES, WORKLOG_DOLLARS_MAX, WORKLOG_UNITS_MAX } from '../caps';
import { ApiError, fields, requireRule } from '../errors';
import type { GatePort } from '../gate/engine';
import type { Payee } from '../payees';
import { NotSentError } from '../paypal/client';
import { logFailure } from '../logging';
import type { PayPalPort, PayPalResult, Receipt, Resource } from '../paypal/client';
import { getCapture, getOrder, orderBody, money } from '../paypal/orders';
import { getRefund, refundBody } from '../paypal/refunds';
import { getBatch, getItem, originalPayoutBatchId, payoutBody } from '../paypal/payouts';
import { EVENT_TYPES, type PayPalEvent } from '../paypal/webhooks';
import { SerialQueue, type Store, type Table } from './store';

export interface MoneyRecord {
  id: string; ward: number; sid?: string; mine?: boolean; cents: number; status: string; createdAt: number;
  lastRecoveryAt?: number;
  capturedAt?: number; captureSequence?: number;
  receipts: Receipt[]; message?: string; orderId?: string; captureId?: string; refundId?: string;
  donationId?: string; batchId?: string; itemId?: string; payee?: string; units?: number; approvalUrl?: string;
  payrollId?: string;
  evidence?: { capturedCents: number; refundedBeforeCents: number; capCents: number; excessCents: number };
  approvedAt?: number;
}
export interface PayrollRecord {
  id: string; worklogIds: string[]; cents: number; status: string;
  batchId?: string; requestId: string; receipts: Receipt[]; createdAt: number;
  message?: string; lastRecoveryAt?: number;
  previewVersion?: string; approvedAt?: number;
}
export interface PayrollPreviewItem {
  id: string; ward: number; payee: string; payeeLabel: string; units: number; rateCents: number; cents: number;
}
export interface PayrollPreview {
  version: string; items: PayrollPreviewItem[]; cents: number; count: number; readyCount: number; excluded: number;
  limit: 'batch' | 'daily' | null;
}
export type PublicMoneyRecord = Omit<MoneyRecord, 'sid' | 'approvalUrl'> & { mine: boolean };
/** One work log of a shown payroll, with only the fields the evidence needs. */
export type PayrollItem = Pick<MoneyRecord, 'id' | 'ward' | 'payee' | 'units' | 'cents' | 'status' | 'itemId' | 'receipts' | 'message' | 'createdAt'>;
export interface CampaignState {
  wards: Record<number, { funded: number; paid: number }>;
  payees: { key: string; label: string; role: string; rateDollars: number }[];
  payrolls: (PayrollRecord & { items?: PayrollItem[] })[];
  payoutCounts?: { paid: number; unclaimed: number };
  payrollPreview?: PayrollPreview;
  wardRecords?: PublicMoneyRecord[];
  records: PublicMoneyRecord[];
  openItems: PublicMoneyRecord[];
  supporterTotal: number;
  refundProposals: PublicMoneyRecord[];
}
export interface Operation { id: string; kind: string; body: unknown; requestId: string; firstAttemptAt?: number; path?: string; headers?: Record<string, string>; status: 'intent' | 'done' | 'uncertain' | 'failed'; result?: PayPalResult }
export interface EngineOptions {
  store: Store; paypal: PayPalPort; clock: () => number; payees: Record<string, Payee>; gate: GatePort;
  plan: Record<number, number>; wards?: number[]; origin?: string;
}
export class CampaignEngine {
  private queue = new SerialQueue();
  private fault?: 'lose_next_response' | 'pending_next_capture';
  constructor(private options: EngineOptions) {}
  private get store() { return this.options.store; }
  private get pp() { return this.options.paypal; }
  private save(table: Table, record: MoneyRecord) { this.store.put(table, record.id, record); return record; }
  private record(table: Table, id: string, sid?: string): MoneyRecord {
    const value = this.store.get<MoneyRecord>(table, id);
    requireRule(value && (!sid || value.sid === sid), 'Record not found.', 404); return value;
  }
  private recoverIds(table: 'donations' | 'refunds' | 'worklogs' | 'payrolls', record: MoneyRecord | PayrollRecord): void {
    const kind = table === 'donations' ? 'create' : table === 'refunds' ? 'refund' : 'payout';
    const result = this.store.get<Operation>('ops', `${record.id}:${kind}`)?.result;
    if (!result) return;
    if (table === 'donations') (record as MoneyRecord).orderId ??= result.body.id;
    else if (table === 'refunds') (record as MoneyRecord).refundId ??= result.body.id;
    else record.batchId ??= result.body.batch_header?.payout_batch_id ?? originalPayoutBatchId(result);
    this.save(table, record as any);
  }
  private ward(ward: unknown): asserts ward is number { requireRule(Number.isInteger(ward) && (this.options.wards ?? Array.from({ length: 50 }, (_, i) => i + 1)).includes(ward as number), 'Ward must be a city ward from 1 to 50.'); }
  private newRecord(ward: number, cents: number, status: string, sid?: string): MoneyRecord { return { id: crypto.randomUUID(), ward, cents, status, sid, createdAt: this.options.clock(), receipts: [] }; }
  private async withReceipt<T>(table: Table, record: MoneyRecord | PayrollRecord, fn: () => Promise<T>): Promise<T> {
    this.pp.onCall = receipt => { record.receipts.push(receipt); this.save(table, record as any); };
    try { return await fn(); } finally { this.pp.onCall = undefined; }
  }
  private async read(table: Table, record: MoneyRecord | PayrollRecord, call: () => Promise<PayPalResult>): Promise<Resource> {
    const res = await this.withReceipt(table, record, call);
    if (res.status < 200 || res.status >= 300) throw new ApiError(503, 'paypal_read', 'Checking payment. PayPal could not confirm its state.');
    return res.body;
  }
  private async write(table: Table, record: MoneyRecord | PayrollRecord, kind: string, path: string, body: unknown, headers?: Record<string, string>, replay = false): Promise<Resource | undefined> {
    const id = `${record.id}:${kind}`;
    const previous = this.store.get<Operation>('ops', id);
    if (previous && !replay && previous.status !== 'failed') return previous.result?.body;
    const requestId = (record as PayrollRecord).requestId ?? crypto.randomUUID();
    const op: Operation = previous ?? { id, kind, body, path, headers, firstAttemptAt: this.options.clock(), requestId, status: 'intent' };
    this.store.put('ops', id, op);
    try {
      const result = await this.withReceipt(table, record, () => this.pp.request('POST', op.path ?? path, op.body, { requestId: op.requestId, headers: op.headers ?? headers }));
      op.result = result;
      op.status = result.status >= 200 && result.status < 300 ? 'done' : 'failed';
      this.store.put('ops', id, op);
      if (this.fault === 'lose_next_response') {
        this.fault = undefined; op.status = 'uncertain'; this.store.put('ops', id, op);
        record.message = 'Checking payment';
        // Retain only the resource identity for a GET, then discard the write representation.
        return result.body.id ? { id: result.body.id } : result.body.batch_header ? { batch_header: { payout_batch_id: result.body.batch_header.payout_batch_id } } : undefined;
      }
      const duplicate = originalPayoutBatchId(result);
      if (duplicate) return { batch_header: { payout_batch_id: duplicate } };
      if (result.status < 200 || result.status >= 300) {
        if (JSON.stringify(result.body).includes('INSTRUMENT_DECLINED')) { record.status = 'DECLINED'; record.message = 'Declined by PayPal. No money moved.'; this.save(table, record as any); return undefined; }
        if (!['cancel', 'payout', 'refund'].includes(kind)) {
          record.status = 'FAILED'; record.message = 'PayPal refused this operation. No money counted.';
          this.save(table, record as any);
          throw new ApiError(503, 'paypal_write', record.message);
        }
        // A rejection does not prove that the resource stayed unchanged. Keep
        // the operation replayable and let the caller reconcile with PayPal.
        record.status = 'CHECKING'; record.message = 'Checking payment'; this.save(table, record as any);
        throw new ApiError(503, 'paypal_write', `PayPal returned HTTP ${result.status}.`);
      }
      return result.body;
    } catch (e) {
      logFailure('paypal-write', path, e);
      if (e instanceof NotSentError && !replay) {
        op.status = 'failed'; this.store.put('ops', id, op);
        record.status = 'FAILED'; record.message = 'PayPal could not be reached. No money moved.';
        this.save(table, record as any);
        if (kind !== 'cancel') {
          if (table === 'payrolls') {
            for (const _ of (record as PayrollRecord).worklogIds)
              await this.options.gate.release('payout', undefined, op.firstAttemptAt ?? record.createdAt);
            for (const wid of (record as PayrollRecord).worklogIds) {
              const w = this.store.get<MoneyRecord>('worklogs', wid);
              if (w) {
                w.status = 'READY';
                delete w.payrollId;
                w.message = 'PayPal could not be reached. Ready to pay again.';
                this.save('worklogs', w);
              }
            }
          } else {
            await this.options.gate.release(table === 'donations' ? 'donation' : table === 'refunds' ? 'refund' : 'payout', (record as MoneyRecord).sid,
              table === 'donations' ? record.createdAt : op.firstAttemptAt ?? record.createdAt);
          }
        }
        throw e;
      }
      if (op.status === 'intent') { op.status = 'uncertain'; this.store.put('ops', id, op); }
      if (record.status !== 'FAILED') { record.status = 'CHECKING'; record.message = 'Checking payment'; }
      this.save(table, record as any); throw e;
    }
  }
  private async recoverMissing(table: 'donations' | 'refunds' | 'worklogs' | 'payrolls', record: MoneyRecord | PayrollRecord, manual = false) {
    this.recoverIds(table, record);
    if (record.status !== 'CHECKING' || (table === 'donations' ? (record as MoneyRecord).orderId : table === 'refunds' ? (record as MoneyRecord).refundId : record.batchId)) return;
    const kind = table === 'donations' ? 'create' : table === 'refunds' ? 'refund' : 'payout';
    const op = this.store.get<Operation>('ops', `${record.id}:${kind}`);
    const path = table === 'donations' ? '/v2/checkout/orders' : table === 'refunds' ? `/v2/payments/captures/${encodeURIComponent((record as MoneyRecord).captureId!)}/refund` : '/v1/payments/payouts';
    const first = op?.firstAttemptAt ?? Date.parse(record.receipts.find(r => r.method === 'POST' && r.path === path)?.at ?? '');
    const firstAttempt = Number.isFinite(first) ? first : record.createdAt;
    if (!op || this.options.clock() - firstAttempt >= 3 * 60 * 60 * 1000) {
      record.status = 'NEEDS_REVIEW'; record.message = 'Could not confirm with PayPal. Not counted.'; this.save(table, record as any);
      if (table === 'payrolls') {
        const finalStatuses = ['SUCCESS', 'UNCLAIMED', 'FAILED', 'BLOCKED', 'RETURNED', 'CANCELED', 'CANCELLED', 'REFUNDED'];
        for (const wid of (record as PayrollRecord).worklogIds) {
          const w = this.store.get<MoneyRecord>('worklogs', wid);
          if (w && !finalStatuses.includes(w.status)) {
            w.status = 'NEEDS_REVIEW';
            w.message = record.message;
            this.save('worklogs', w);
          }
        }
      }
      return;
    }
    if (!manual && record.lastRecoveryAt !== undefined && this.options.clock() - record.lastRecoveryAt < 60_000) return;
    record.lastRecoveryAt = this.options.clock(); this.save(table, record as any);
    // Persist legacy intent timing too; never reset the replay window after eviction.
    op.firstAttemptAt ??= firstAttempt; this.store.put('ops', op.id, op);
    const result = await this.write(table, record, kind, path, op.body, op.headers, true);
    if (table === 'donations') {
      (record as MoneyRecord).orderId = result?.id;
      (record as MoneyRecord).approvalUrl = result?.links?.find((l: Resource) => l.rel === 'approve' || l.rel === 'payer-action')?.href;
    } else if (table === 'refunds') (record as MoneyRecord).refundId = result?.id;
    else record.batchId = result?.batch_header?.payout_batch_id;
    this.save(table, record as any);
  }
  refreshDonation(sid: string, id: string) { return this.queue.run(async () => {
    const record = this.record('donations', id, sid);
    try { await this.recoverMissing('donations', record, true); await this.syncDonation(record, true); }
    catch (e) { logFailure('paypal-refresh', '/api/donations/:id/refresh', e); }
    return this.save('donations', record);
  }); }
  setFault(kind: 'lose_next_response' | 'pending_next_capture') { return this.queue.run(async () => { this.fault = kind; return { ok: true }; }); }
  donate(sid: string, input: unknown, options: { origin?: string; declineTest?: boolean } = {}) { return this.queue.run(async () => {
    const body = fields(input, ['ward', 'amount', 'method']); this.ward(body.ward);
    requireRule(DONATION_CHOICES.includes(body.amount as 10), 'Donation amount must be $10, $25 or $50.');
    requireRule(body.method === 'card' || body.method === 'paypal', 'Choose card or paypal.');
    await this.options.gate.consume('donation', sid);
    const record = this.newRecord(body.ward, Number(body.amount) * 100, 'CREATED', sid); this.save('donations', record);
    const request = orderBody({ id: record.id, ward: record.ward, cents: record.cents, method: body.method, origin: options.origin ?? this.options.origin ?? 'https://wardwise.midknight-labs.workers.dev' });
    let result: Resource | undefined;
    try { result = await this.write('donations', record, 'create', '/v2/checkout/orders', request, options.declineTest ? { 'PayPal-Mock-Response': '{"mock_application_codes":"INSTRUMENT_DECLINED"}' } : undefined); }
    catch { return this.save('donations', record); }
    if (!result) return this.save('donations', record);
    if (typeof result.id !== 'string') { record.status = 'CHECKING'; record.message = 'Checking payment'; return this.save('donations', record); }
    record.orderId = result.id;
    record.approvalUrl = (result.links ?? []).find((l: Resource) => l.rel === 'approve' || l.rel === 'payer-action')?.href;
    this.save('donations', record);
    if (body.method === 'card') {
      try { await this.syncDonation(record, true); }
      catch (e) { logFailure('paypal-sync', `/v2/checkout/orders/${record.orderId}`, e); if (record.status !== 'FAILED') { record.status = 'CHECKING'; record.message = 'Checking payment'; } }
    }
    return this.save('donations', record);
  }); }
  private async syncDonation(record: MoneyRecord, capture = false): Promise<void> {
    this.recoverIds('donations', record);
    if (!record.orderId) return;
    const order = await this.read('donations', record, () => getOrder(this.pp, record.orderId!));
    const unit = order.purchase_units?.[0];
    requireRule(!unit?.custom_id || unit.custom_id === `ww-${record.id}`, 'PayPal order does not match this donation.');
    let cap = unit?.payments?.captures?.[0];
    if (!cap && order.status === 'APPROVED' && capture && record.status !== 'CANCELLED') {
      try { await this.write('donations', record, 'capture', `/v2/checkout/orders/${encodeURIComponent(record.orderId)}/capture`, {}); }
      catch (e) { if (e instanceof NotSentError) return; }
      const refreshed = await this.read('donations', record, () => getOrder(this.pp, record.orderId!));
      cap = refreshed.purchase_units?.[0]?.payments?.captures?.[0];
    }
    if (!cap) { if (!['CANCELLED', 'FAILED'].includes(record.status)) record.status = order.status ?? 'CHECKING'; this.save('donations', record); return; }
    record.captureId = cap.id;
    const current = await this.read('donations', record, () => getCapture(this.pp, cap.id));
    requireRule(current.amount?.currency_code === 'USD' && Math.round(Number(current.amount.value) * 100) === record.cents, 'Capture amount must match the server donation.');
    let status = current.status;
    if (this.fault === 'pending_next_capture') { this.fault = undefined; status = 'PENDING'; }
    const completedRank: Record<string, number> = { COMPLETED: 1, PARTIALLY_REFUNDED: 2, REFUNDED: 3 };
    if (!(completedRank[record.status] > 0) || (completedRank[status] ?? 0) >= completedRank[record.status]) record.status = status;
    if (['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(record.status) && record.captureSequence === undefined) {
      const parsedTime = Date.parse(current.create_time ?? '');
      record.capturedAt = Number.isFinite(parsedTime) ? parsedTime : this.options.clock();
      record.captureSequence = (this.store.get<number>('records', 'captureSequence') ?? 0) + 1;
      this.store.put('records', 'captureSequence', record.captureSequence);
    }
    record.message = record.status === 'PENDING' ? 'Pending at PayPal' : record.status === 'DECLINED' ? 'Declined by PayPal. No money moved.' : undefined;
    this.save('donations', record); this.propose(record.sid!);
  }
  finishOrder(sid: string, orderId: string, cancel = false) { return this.queue.run(async () => {
    const record = this.store.list<MoneyRecord>('donations').find(d => d.orderId === orderId && d.sid === sid);
    requireRule(record, 'Order not found for this supporter.', 404);
    if (cancel) {
      await this.syncDonation(record);
      if (!['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'PENDING'].includes(record.status)) { record.status = 'CANCELLED'; record.message = 'You cancelled. No money moved.'; }
    } else await this.syncDonation(record, true);
    return this.save('donations', record);
  }); }
  private completed(sid: string) { return this.store.list<MoneyRecord>('donations').filter(d => d.sid === sid && ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(d.status)); }
  private supporterTotal(sid: string) {
    return this.completed(sid).reduce((s, d) => s + d.cents, 0)
      - this.store.list<MoneyRecord>('refunds').filter(r => r.sid === sid && r.status === 'COMPLETED').reduce((s, r) => s + r.cents, 0);
  }
  private propose(sid: string) {
    const refunds = this.store.list<MoneyRecord>('refunds').filter(r => r.sid === sid);
    // Existing proposals, pending and failed refunds all reserve their capture slice.
    let excess = this.supporterTotal(sid) - DEMO_CAP * 100 - refunds.filter(r => r.status !== 'COMPLETED').reduce((s, r) => s + r.cents, 0);
    const donations = this.completed(sid).reverse().sort((a, b) => (b.capturedAt ?? b.createdAt) - (a.capturedAt ?? a.createdAt) || (b.captureSequence ?? 0) - (a.captureSequence ?? 0));
    const capturedCents = this.completed(sid).reduce((s, d) => s + d.cents, 0);
    const refundedBeforeCents = refunds.filter(r => r.status === 'COMPLETED').reduce((s, r) => s + r.cents, 0);
    const capCents = DEMO_CAP * 100;
    for (const donation of donations) {
      if (excess <= 0) break;
      const available = donation.cents - refunds.filter(r => r.donationId === donation.id).reduce((s, r) => s + r.cents, 0);
      const cents = Math.min(excess, available); if (cents <= 0) continue;
      const evidence = { capturedCents, refundedBeforeCents, capCents, excessCents: cents };
      const record = { ...this.newRecord(donation.ward, cents, 'PROPOSED', sid), donationId: donation.id, captureId: donation.captureId, message: 'Waiting for a person to approve', evidence };
      this.save('refunds', record); excess -= cents;
    }
  }
  approveRefund(sid: string, id: string) { return this.queue.run(async () => {
    const record = this.record('refunds', id, sid);
    this.recoverIds('refunds', record);
    if (record.status === 'PROPOSED' || record.status === 'CHECKING') {
      if (record.status === 'PROPOSED') record.approvedAt ??= this.options.clock();
      if (!this.store.get<Operation>('ops', `${record.id}:refund`)) await this.options.gate.consume('refund');
      record.status = 'CHECKING'; this.save('refunds', record);
      try {
        const result = await this.write('refunds', record, 'refund', `/v2/payments/captures/${encodeURIComponent(record.captureId!)}/refund`, refundBody(record.id, record.cents));
        if (result?.id) record.refundId = result.id;
        this.save('refunds', record);
      } catch (e) {
        // No refund ID means there is nothing to GET yet. Keep the proposal
        // open; the next approval retries this exact operation and request ID.
        const op = this.store.get<Operation>('ops', `${record.id}:refund`);
        const notSent = e instanceof NotSentError;
        if (!notSent && op?.result && (op.result.status < 200 || op.result.status >= 300)) record.status = 'PROPOSED';
        return this.save('refunds', record);
      }
    }
    if (record.refundId) await this.syncRefund(record);
    return this.save('refunds', record);
  }); }
  private async syncRefund(record: MoneyRecord) {
    const result = await this.read('refunds', record, () => getRefund(this.pp, record.refundId!));
    requireRule(result.amount?.currency_code === 'USD' && Math.round(Number(result.amount.value) * 100) === record.cents, 'Refund amount must match the approved amount.');
    if (record.status !== 'COMPLETED') record.status = result.status;
    record.message = record.status === 'COMPLETED' ? undefined : `Refund ${record.status}. Cap excess still owed.`;
    this.save('refunds', record);
  }
  createWorklog(input: unknown) { return this.queue.run(async () => {
    const body = fields(input, ['ward', 'payee', 'units']); this.ward(body.ward);
    requireRule(typeof body.payee === 'string' && Object.hasOwn(this.options.payees, body.payee), 'Unknown payee key.');
    const payee = this.options.payees[body.payee];
    // A key fixes the work kind and rate. No browser-selected role or price is accepted.
    requireRule((body.payee.startsWith('crew-') && payee.role === 'doors') || (body.payee === 'print-shop' && payee.role === 'flyers'), 'Payee role must fit the work kind.');
    requireRule(Number.isInteger(body.units) && Number(body.units) >= 1 && Number(body.units) <= WORKLOG_UNITS_MAX, 'Units must be whole numbers from 1 to 400.');
    const plan = this.options.plan[body.ward] ?? 0;
    requireRule(plan > 0, `Ward ${body.ward} is not in the campaign's $${DEFAULT_BUDGET.toLocaleString('en-US')} plan.`);
    const cents = Number(body.units) * payee.rateCents;
    requireRule(cents <= WORKLOG_DOLLARS_MAX * 100, 'Work log amount must be at most $60.');
    const reserved = this.store.list<MoneyRecord>('worklogs').filter(w => w.ward === body.ward && !['CANCELED', 'CANCELLED', 'FAILED', 'RETURNED', 'REFUNDED'].includes(w.status)).reduce((s, w) => s + w.cents, 0);
    requireRule(cents <= Math.round(plan * 100) - reserved, 'Work log exceeds the ward unpaid plan dollars.');
    await this.options.gate.consume('worklog');
    return this.save('worklogs', { ...this.newRecord(body.ward, cents, 'READY'), payee: body.payee, units: Number(body.units) });
  }); }
  pay(id: string) { return this.queue.run(async () => {
    const record = this.record('worklogs', id);
    this.recoverIds('worklogs', record);
    if (record.status === 'READY') {
      const payee = this.options.payees[record.payee!];
      requireRule(payee?.email, 'Sandbox payee is not configured.');
      await this.options.gate.consume('payout'); record.status = 'CHECKING'; this.save('worklogs', record);
      try {
        const result = await this.write('worklogs', record, 'payout', '/v1/payments/payouts', payoutBody(record.id, payee.email, record.cents));
        record.batchId = result?.batch_header?.payout_batch_id; this.save('worklogs', record);
      } catch { return record; }
    }
    if (record.batchId) await this.syncWorklog(record);
    return this.save('worklogs', record);
  }); }
  private async computePreview(): Promise<PayrollPreview> {
    const ready = this.store.list<MoneyRecord>('worklogs')
      .filter(w => w.status === 'READY')
      .sort((a, b) => a.createdAt - b.createdAt);
    const remaining = await this.options.gate.remaining('payout');
    const selected = ready.slice(0, 10).slice(0, remaining);
    const items: PayrollPreviewItem[] = selected.map(w => {
      const payee = this.options.payees[w.payee!];
      return {
        id: w.id,
        ward: w.ward,
        payee: w.payee!,
        payeeLabel: payee?.label ?? '',
        units: w.units!,
        rateCents: payee?.rateCents ?? 0,
        cents: w.cents,
      };
    });
    const cents = items.reduce((sum, it) => sum + it.cents, 0);
    const count = items.length;
    const readyCount = ready.length;
    const excluded = readyCount - count;
    const batchCapped = ready.length > 10;
    const dailyCapped = remaining < Math.min(10, ready.length);
    const limit: 'batch' | 'daily' | null = dailyCapped ? 'daily' : (batchCapped ? 'batch' : null);
    const version = count === 0 ? '' : `${items.map(i => i.id).join(',')}:${cents}`;
    return { version, items, cents, count, readyCount, excluded, limit };
  }
  payrollPreview(): Promise<PayrollPreview> {
    return this.queue.run(() => this.computePreview());
  }
  payPayroll(input?: unknown) { return this.queue.run(async () => {
    const { version } = fields(input ?? {}, ['version']);
    requireRule(typeof version === 'string' && version, 'Open the payroll preview first.');
    const preview = await this.computePreview();
    requireRule(preview.readyCount > 0, 'No checked work logs are ready to pay.');
    requireRule(preview.count > 0, 'Daily payout limit reached. Please try tomorrow.', 429);
    if (version !== preview.version) {
      throw new ApiError(409, 'preview_changed', 'The ready work changed. Check the new payroll preview, then approve again.');
    }
    const fitting: MoneyRecord[] = [];
    let consumedCount = 0;
    try {
      for (const item of preview.items) {
        await this.options.gate.consume('payout');
        consumedCount++;
        const log = this.store.get<MoneyRecord>('worklogs', item.id);
        requireRule(log && log.status === 'READY', 'Worklog is no longer ready.');
        fitting.push(log);
      }
    } catch (e) {
      for (let i = 0; i < consumedCount; i++) {
        await this.options.gate.release('payout', undefined, this.options.clock());
      }
      if (e instanceof ApiError && e.status === 429) {
        throw new ApiError(409, 'preview_changed', 'The ready work changed. Check the new payroll preview, then approve again.');
      }
      throw e;
    }
    const message = preview.limit === 'daily'
      ? `Daily payout limit reached. Paid ${fitting.length} of ${preview.readyCount} ready work logs that fit today's cap.`
      : undefined;
    const payroll: PayrollRecord = {
      id: crypto.randomUUID(),
      worklogIds: fitting.map(w => w.id),
      cents: fitting.reduce((sum, w) => sum + w.cents, 0),
      status: 'CHECKING',
      requestId: crypto.randomUUID(),
      receipts: [],
      createdAt: this.options.clock(),
      lastRecoveryAt: this.options.clock(),
      approvedAt: this.options.clock(),
      previewVersion: version,
      message,
    };
    this.store.put('payrolls', payroll.id, payroll);
    for (const w of fitting) {
      w.payrollId = payroll.id;
      w.status = 'CHECKING';
      w.message = 'Checking payment';
      this.save('worklogs', w);
    }
    const body = {
      sender_batch_header: { sender_batch_id: `ww-pr-${payroll.id}`, email_subject: 'WardWise sandbox work payment' },
      items: fitting.map(w => {
        const payee = this.options.payees[w.payee!];
        requireRule(payee?.email, 'Sandbox payee is not configured.');
        return {
          recipient_type: 'EMAIL',
          receiver: payee.email,
          amount: { value: money(w.cents), currency: 'USD' },
          sender_item_id: `ww-${w.id}-1`,
          note: 'Fictional campaign. Sandbox test money.',
        };
      }),
    };
    let result: Resource | undefined;
    try {
      result = await this.write('payrolls', payroll, 'payout', '/v1/payments/payouts', body);
      payroll.batchId = result?.batch_header?.payout_batch_id;
      this.store.put('payrolls', payroll.id, payroll);
      for (const w of fitting) {
        w.batchId = payroll.batchId;
        this.save('worklogs', w);
      }
    } catch {
      return payroll;
    }
    if (payroll.batchId) {
      await this.syncPayroll(payroll);
    }
    return payroll;
  }); }
  refreshPayroll(id: string) { return this.queue.run(async () => {
    const payroll = this.store.get<PayrollRecord>('payrolls', id);
    requireRule(payroll, 'Payroll not found.', 404);
    await this.recoverMissing('payrolls', payroll, true);
    if (payroll.batchId) {
      await this.syncPayroll(payroll, true);
    }
    return payroll;
  }); }
  private async syncPayroll(payroll: PayrollRecord, refreshItems = false) {
    this.recoverIds('payrolls', payroll);
    if (payroll.batchId) {
      const batch = await this.read('payrolls', payroll, () => getBatch(this.pp, payroll.batchId!));
      const items = batch.items ?? [];
      for (const item of items) {
        const senderItemId = item.payout_item?.sender_item_id ?? item.sender_item_id;
        const worklog = this.store.list<MoneyRecord>('worklogs').find(w => `ww-${w.id}-1` === senderItemId);
        if (worklog) {
          if (item.payout_item_id) worklog.itemId = item.payout_item_id;
          worklog.batchId = payroll.batchId;
          if (typeof item.transaction_status === 'string') {
            worklog.status = item.transaction_status;
            worklog.message = worklog.status === 'SUCCESS' ? 'Paid' : worklog.status;
          }
          this.save('worklogs', worklog);
        }
      }
    }
    const worklogs = payroll.worklogIds.map(wid => this.store.get<MoneyRecord>('worklogs', wid)).filter(Boolean) as MoneyRecord[];
    if (refreshItems) {
      for (const w of worklogs) {
        if (w.itemId && !['SUCCESS', 'CANCELED', 'CANCELLED', 'RETURNED', 'FAILED', 'BLOCKED', 'REFUNDED'].includes(w.status)) {
          try {
            const item = await this.read('worklogs', w, () => getItem(this.pp, w.itemId!));
            if (typeof item.transaction_status === 'string') {
              w.status = item.transaction_status;
              w.message = w.status === 'SUCCESS' ? 'Paid' : w.status;
              this.save('worklogs', w);
            }
          } catch (e) {
            logFailure('paypal-sync-item', `/v1/payments/payouts-item/${w.itemId}`, e);
          }
        }
      }
    }
    const allSuccess = worklogs.length > 0 && worklogs.every(w => w.status === 'SUCCESS');
    const someSuccess = worklogs.some(w => w.status === 'SUCCESS');
    const anyFinal = worklogs.some(w => ['SUCCESS', 'UNCLAIMED', 'FAILED', 'BLOCKED', 'RETURNED', 'CANCELED', 'REFUNDED'].includes(w.status));
    if (allSuccess) {
      payroll.status = 'PAID';
    } else if (someSuccess) {
      payroll.status = 'PARTLY_PAID';
    } else if (!anyFinal) {
      payroll.status = 'CHECKING';
    } else {
      const first = worklogs[0]?.status ?? 'CHECKING';
      payroll.status = worklogs.every(w => w.status === first) ? first : 'PARTLY_PAID';
    }
    this.store.put('payrolls', payroll.id, payroll);
    return payroll;
  }
  getReadyWorklogs(): MoneyRecord[] {
    return this.store.list<MoneyRecord>('worklogs')
      .filter(w => w.status === 'READY')
      .sort((a, b) => a.createdAt - b.createdAt);
  }
  private async syncWorklog(record: MoneyRecord) {
    this.recoverIds('worklogs', record);
    if (record.batchId) {
      const batch = await this.read('worklogs', record, () => getBatch(this.pp, record.batchId!));
      const item = (batch.items ?? []).find((i: Resource) => i.payout_item?.sender_item_id === `ww-${record.id}-1` || i.sender_item_id === `ww-${record.id}-1`);
      if (item) record.itemId = item.payout_item_id;
    }
    if (record.itemId) {
      const item = await this.read('worklogs', record, () => getItem(this.pp, record.itemId!));
      if (item.payout_item?.sender_item_id && item.payout_item.sender_item_id !== `ww-${record.id}-1`) throw new ApiError(503, 'paypal_mismatch', 'Payout item does not match this work log.');
      // PayPal's item read is the source of truth, including after a cancel
      // response. A cancel request can succeed while the item is RETURNED (or
      // another terminal state), so the local pre-request status is not enough.
      if (typeof item.transaction_status === 'string') record.status = item.transaction_status;
      record.message = record.status === 'SUCCESS' ? 'Paid' : record.status;
    }
    this.save('worklogs', record);
  }
  refresh(id: string) { return this.queue.run(async () => { const record = this.record('worklogs', id); await this.recoverMissing('worklogs', record, true); await this.syncWorklog(record); return record; }); }
  cancel(id: string) { return this.queue.run(async () => {
    const record = this.record('worklogs', id); await this.syncWorklog(record);
    requireRule(record.status === 'UNCLAIMED', 'Only an UNCLAIMED payout can be cancelled.');
    const path = `/v1/payments/payouts-item/${encodeURIComponent(record.itemId!)}/cancel`;
    try { await this.write('worklogs', record, 'cancel', path, {}); }
    catch (e) {
      // The cancel may have reached PayPal despite an error answer. The item
      // status is authoritative, so a successful read makes this a normal 200.
      await this.syncWorklog(record);
      if (record.status === 'UNCLAIMED') {
        const op = this.store.get<Operation>('ops', `${record.id}:cancel`);
        const receipt = [...record.receipts].reverse().find(r => r.method === 'POST' && r.path === path);
        const status = receipt?.status ?? op?.result?.status ?? 0;
        const debugId = op?.result?.debugId ?? receipt?.debugId ?? 'unknown';
        record.message = `PayPal could not cancel this payout (HTTP ${status}, debug id ${debugId}). It stays unclaimed. PayPal returns unclaimed money after 30 days.`;
        this.save('worklogs', record);
      }
      return record;
    }
    await this.syncWorklog(record); return record;
  }); }
  applyWebhook(event: PayPalEvent) { return this.queue.run(async () => {
    if (this.store.get('events', event.id)) return { duplicate: true };
    if (!(EVENT_TYPES as readonly string[]).includes(event.event_type)) return { ignored: true };
    const r = event.resource;
    const custom = r.custom_id ?? r.payout_item?.sender_item_id ?? r.sender_item_id;
    if (typeof custom !== 'string' || !custom.startsWith('ww-')) return { ignored: true };
    const matched = this.store.list<MoneyRecord>('donations').some(d => custom === `ww-${d.id}`)
      || this.store.list<MoneyRecord>('refunds').some(r => custom === `ww-${r.id}`)
      || this.store.list<MoneyRecord>('worklogs').some(w => custom === `ww-${w.id}-1`);
    if (!matched) return { ignored: true };
    if (event.event_type.startsWith('PAYMENT.PAYOUTS-ITEM.')) {
      const record = this.store.list<MoneyRecord>('worklogs').find(w => custom === `ww-${w.id}-1`);
      if (record) { record.itemId ??= r.payout_item_id; await this.syncWorklog(record); }
    } else if (event.event_type.startsWith('PAYMENT.REFUND.') || (event.event_type === 'PAYMENT.CAPTURE.REFUNDED' && this.store.get('refunds', custom.slice(3)))) {
      const record = this.store.get<MoneyRecord>('refunds', custom.slice(3));
      if (record) { record.refundId ??= r.id; await this.syncRefund(record); }
    } else {
      const record = this.store.get<MoneyRecord>('donations', custom.slice(3));
      if (record) {
        record.orderId ??= r.supplementary_data?.related_ids?.order_id;
        if (record.orderId) await this.syncDonation(record);
        for (const refund of this.store.list<MoneyRecord>('refunds').filter(x => x.donationId === record.id && x.refundId)) await this.syncRefund(refund);
      }
    }
    this.store.put('events', event.id, { id: event.id }); return { ok: true };
  }); }
  state(sid: string, ward?: number): Promise<CampaignState> { return this.queue.run(async () => {
    requireRule(ward === undefined || Number.isInteger(ward) && ward >= 1 && ward <= 50, 'Ward must be 1 to 50.');
    for (const d of this.store.list<MoneyRecord>('donations').filter(d => ['PENDING', 'CHECKING', 'APPROVED'].includes(d.status))) {
      try { await this.recoverMissing('donations', d); await this.syncDonation(d, true); }
      catch (e) { logFailure('paypal-state', '/v2/checkout/orders', e); }
    }
    for (const r of this.store.list<MoneyRecord>('refunds').filter(r => r.status !== 'COMPLETED')) {
      try { await this.recoverMissing('refunds', r); this.recoverIds('refunds', r); if (r.refundId) await this.syncRefund(r); }
      catch (e) { logFailure('paypal-state', '/v2/payments/refunds', e); }
    }
    for (const w of this.store.list<MoneyRecord>('worklogs').filter(w => w.status === 'CHECKING' && !w.payrollId)) {
      try { await this.recoverMissing('worklogs', w); await this.syncWorklog(w); }
      catch (e) { logFailure('paypal-state', '/v1/payments/payouts', e); }
    }
    for (const p of this.store.list<PayrollRecord>('payrolls').filter(p => p.status === 'CHECKING')) {
      try {
        await this.recoverMissing('payrolls', p);
        if (p.batchId) await this.syncPayroll(p);
      } catch (e) { logFailure('paypal-state', '/v1/payments/payouts', e); }
    }
    for (const p of this.store.list<PayrollRecord>('payrolls').filter(p => p.batchId && p.status !== 'PAID')) {
      const items = p.worklogIds.map(wid => this.store.get<MoneyRecord>('worklogs', wid)).filter(Boolean) as MoneyRecord[];
      const allSuccess = items.length > 0 && items.every(w => w.status === 'SUCCESS');
      const someSuccess = items.some(w => w.status === 'SUCCESS');
      const anyFinal = items.some(w => ['SUCCESS', 'UNCLAIMED', 'FAILED', 'BLOCKED', 'RETURNED', 'CANCELED', 'REFUNDED'].includes(w.status));
      if (allSuccess) p.status = 'PAID';
      else if (someSuccess) p.status = 'PARTLY_PAID';
      else if (!anyFinal) p.status = 'CHECKING';
      else {
        const first = items[0]?.status ?? 'CHECKING';
        p.status = items.every(w => w.status === first) ? first : 'PARTLY_PAID';
      }
      this.store.put('payrolls', p.id, p);
    }
    const donations = this.store.list<MoneyRecord>('donations'), refunds = this.store.list<MoneyRecord>('refunds'), worklogs = this.store.list<MoneyRecord>('worklogs');
    // Each shown payroll carries its own work logs, so its evidence does not depend on the 30 newest records.
    const payrollItem = (w: MoneyRecord): PayrollItem => ({ id: w.id, ward: w.ward, payee: w.payee, units: w.units, cents: w.cents, status: w.status,
      itemId: w.itemId, receipts: w.receipts, message: w.message, createdAt: w.createdAt });
    const payrolls = this.store.list<PayrollRecord>('payrolls').sort((a, b) => b.createdAt - a.createdAt).slice(0, 10)
      .map(p => ({ ...p, items: p.worklogIds.map(wid => this.store.get<MoneyRecord>('worklogs', wid)).filter((w): w is MoneyRecord => !!w).map(payrollItem) }));
    const payoutCounts = { paid: worklogs.filter(w => w.status === 'SUCCESS').length, unclaimed: worklogs.filter(w => w.status === 'UNCLAIMED').length };
    const wards: Record<number, { funded: number; paid: number }> = {};
    for (const ward of this.options.wards ?? Array.from({ length: 50 }, (_, i) => i + 1)) {
      wards[ward] = { funded: (donations.filter(d => d.ward === ward && ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(d.status)).reduce((s, d) => s + d.cents, 0) - refunds.filter(r => r.ward === ward && r.status === 'COMPLETED').reduce((s, r) => s + r.cents, 0)) / 100,
        paid: worklogs.filter(w => w.ward === ward && w.status === 'SUCCESS').reduce((s, w) => s + w.cents, 0) / 100 };
    }
    const records = [...donations, ...refunds, ...worklogs].sort((a, b) => b.createdAt - a.createdAt);
    const publicRecord = (record: MoneyRecord) => {
      const { sid: ownerSid, approvalUrl: _approval, ...r } = record;
      return { ...r, mine: ownerSid === sid };
    };
    const payees = Object.entries(this.options.payees).map(([key, { label, role, rateCents }]) => ({ key, label, role, rateDollars: rateCents / 100 }));
    const payrollPreview = await this.computePreview();
    return { wards, payees, payrolls, payoutCounts, payrollPreview, ...(ward === undefined ? {} : { wardRecords: records.filter(r => r.ward === ward).slice(0, 50).map(publicRecord) }), records: records.slice(0, 30).map(publicRecord), openItems: records.filter(r => !['COMPLETED', 'SUCCESS', 'CANCELLED', 'CANCELED', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(r.status)).map(publicRecord), supporterTotal: this.supporterTotal(sid) / 100, refundProposals: refunds.filter(r => r.sid === sid).map(publicRecord) };
  }); }
}
