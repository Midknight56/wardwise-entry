import type { MoneyRecord, MoneyState, PayrollRecord } from './api';
import { dollars, escapeHtml as e } from './helpers';

export function recordKind(record: MoneyRecord): string {
  return record.payee ? 'Work' : record.donationId ? 'Refund' : 'Donation';
}
export function statusChip(status: string): string {
  const label = status === 'SUCCESS' ? 'Paid · SUCCESS' : status === 'PROPOSED' ? 'Waiting for a person to approve'
    : status === 'PENDING' ? 'Pending at PayPal' : status;
  const error = ['FAILED', 'DECLINED', 'BLOCKED'].includes(status);
  return `<span class="chip status ${error ? 'error' : ''}">${e(label)}</span>`;
}
export function paypalIds(record: MoneyRecord): string {
  return (['orderId', 'captureId', 'refundId', 'batchId', 'itemId'] as const).filter(key => record[key]).map(key =>
    `<div class="id-line"><span>${{ orderId: 'Order', captureId: 'Capture', refundId: 'Refund', batchId: 'Batch', itemId: 'Item' }[key]}</span><button class="copy mono" data-copy="${e(record[key])}" title="Copy ${key}" aria-label="Copy ${key} ${e(record[key])}">${e(record[key])}</button></div>`).join('');
}
const money$ = (cents: number) => dollars(cents / 100, true);
const localTime = (at: number) => new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function evidenceReceipts(title: string, receipts: MoneyRecord['receipts']): string {
  if (!receipts.length) return `<div class="evidence-receipts"><strong>${e(title)}</strong><p class="muted">No PayPal call recorded yet.</p></div>`;
  return `<div class="evidence-receipts"><strong>${e(title)}</strong><ul>${receipts.map(r =>
    `<li><span class="mono">${e(r.method)} ${e(r.path)}</span> · HTTP <span class="mono">${e(r.status)}</span> · <time>${e(r.at)}</time></li>`).join('')}</ul></div>`;
}
function refundEvidence(record: MoneyRecord): string {
  const ev = record.evidence;
  const approval = record.approvedAt ? `Approved by a person at ${localTime(record.approvedAt)}` : 'Waiting for a person to approve';
  const refundLine = record.refundId ? `Refund ${record.refundId} · ${record.status}` : `Refund not sent yet · ${record.status}`;
  const lines = [
    ...(ev ? [`Captured from this browser ${money$(ev.capturedCents)}`, `Refunded before ${money$(ev.refundedBeforeCents)}`,
      `Demo cap ${money$(ev.capCents)}`, `Over the cap ${money$(ev.excessCents)}`, `Proposed refund ${money$(record.cents)}`, approval] : []),
    refundLine,
    ...(record.captureId ? [`Capture refunded: ${record.captureId}`] : []),
    ...(ev && record.status === 'COMPLETED' ? [`Stays donated ${money$(ev.capturedCents - ev.refundedBeforeCents - record.cents)}`] : []),
  ];
  return `<details class="evidence" data-testid="refund-evidence"><summary>Evidence</summary>
    <ul class="evidence-lines">${lines.map(line => `<li>${e(line)}</li>`).join('')}</ul>
    ${evidenceReceipts('Receipts', record.receipts)}</details>`;
}
export function recordActions(record: MoneyRecord, mine: MoneyRecord[] = []): string {
  if (record.payee) return `<div class="button-row">
    <span class="note muted">Paid from Payroll</span>
    ${record.status === 'UNCLAIMED' ? `<button data-action="cancel" data-id="${e(record.id)}" data-testid="cancel-${e(record.id)}">Cancel</button>` : ''}</div>`;
  if (record.donationId && record.status === 'PROPOSED' && mine.some(r => r.id === record.id))
    return `<button class="gold" data-action="approve-refund" data-id="${e(record.id)}" data-testid="approve-refund">Approve refund ${dollars(record.cents / 100, true)}</button>`;
  return '';
}
export function renderRecord(record: MoneyRecord, mine: MoneyRecord[] = [], payees: MoneyState['payees'] = []): string {
  const receipts = record.receipts.map(r => `<li><span class="mono">${e(r.method)} ${e(r.path)}</span><br>
    HTTP <span class="mono">${e(r.status)}</span> · debug_id <span class="mono">${e(r.debugId ?? 'Not returned')}</span><br><time>${e(r.at)}</time></li>`).join('');
  return `<article class="money-record" data-record-id="${e(record.id)}">
    <div class="record-heading"><strong>${recordKind(record)} · Ward ${record.ward}</strong><span class="mono">${dollars(record.cents / 100, true)}</span></div>
    <div class="record-meta"><time datetime="${new Date(record.createdAt).toISOString()}">${e(new Date(record.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</time>${statusChip(record.status)}</div>
    ${record.payee ? `<p>${e(payees.find(p => p.key === record.payee)?.label ?? record.payee)} · <span class="mono">${record.units}</span> units<br><span class="rule-result">Rule check: accepted by server against the $5,000 plan.</span></p>` : ''}
    ${record.message ? `<p>${e(record.message)}</p>` : ''}${recordActions(record, mine)}
    ${record.donationId && !record.payee ? refundEvidence(record) : ''}
    <details><summary>PayPal ids and receipts (${record.receipts.length})</summary>${paypalIds(record)}<ol class="receipts">${receipts || '<li>No PayPal call recorded yet.</li>'}</ol></details></article>`;
}
export function payrollStatusText(status: string): string {
  switch (status) {
    case 'PAID': return 'Paid';
    case 'PARTLY_PAID': return 'Partly paid';
    case 'CHECKING': return 'Checking';
    case 'NEEDS_REVIEW': return 'Needs review';
    case 'FAILED': return 'Failed';
    default: return status;
  }
}
export function payrollStatusChip(status: string): string {
  const error = ['FAILED', 'DECLINED', 'BLOCKED'].includes(status);
  return `<span class="chip status ${error ? 'error' : ''}">${e(payrollStatusText(status))}</span>`;
}
type ShownPayroll = MoneyState['payrolls'][number];
type PayrollLine = Pick<MoneyRecord, 'id' | 'ward' | 'payee' | 'units' | 'cents' | 'status' | 'itemId' | 'receipts' | 'message'>;
/** The server sends each payroll's own work logs. An older answer without them falls back to the loaded records. */
function payrollLines(p: ShownPayroll, records: MoneyRecord[]): PayrollLine[] {
  return p.items ?? p.worklogIds.map(id => records.find(r => r.id === id)).filter((r): r is MoneyRecord => !!r);
}
function payrollEvidence(p: ShownPayroll, records: MoneyRecord[], payees: MoneyState['payees']): string {
  const approval = p.approvedAt ? `Approved by a person at ${localTime(p.approvedAt)}` : 'Approval time not recorded';
  const items = payrollLines(p, records);
  const rows = items.map(item => {
    const payee = payees.find(py => py.key === item.payee);
    const rate = payee ? payee.rateDollars : item.units ? item.cents / item.units / 100 : 0;
    return `<li class="evidence-item"><div><strong>Work log <span class="mono">${e(item.id.slice(0, 8))}</span></strong> · Ward ${item.ward}</div>
      <div>${e(payee?.label ?? item.payee ?? '')}</div>
      <div><span class="mono">${e(item.units ?? '')}</span> ${payee?.role === 'doors' ? 'doors' : payee?.role === 'flyers' ? 'flyers' : 'units'} × <span class="mono">${dollars(rate, true)}</span> = <span class="mono" data-testid="evidence-amount">${money$(item.cents)}</span></div>
      <div>Rule check: accepted by the server, inside the ward's $5,000 plan, at most $60</div>
      <div>PayPal item <span class="mono">${e(item.itemId ?? 'Not assigned yet')}</span> · ${e(item.status)}</div></li>`;
  }).join('');
  const rowSum = items.reduce((s, r) => s + r.cents, 0);
  const itemReceipts = items.filter(r => r.receipts.length).map(r => evidenceReceipts(`Item ${r.itemId ?? r.id.slice(0, 8)}`, r.receipts)).join('');
  return `<details class="evidence" data-testid="payroll-evidence"><summary>Evidence</summary>
    <p>${approval}</p>
    <ol class="evidence-items">${rows || '<li class="evidence-item">No work logs in this batch are loaded here.</li>'}</ol>
    <p>Batch ${e(p.batchId ?? 'Processing…')}</p>
    <p>Batch total ${money$(p.cents)}</p>
    ${items.length < p.worklogIds.length ? `<p class="muted">The rows shown add up to ${money$(rowSum)}. ${p.worklogIds.length - items.length} work logs are not loaded in this view.</p>` : ''}
    ${evidenceReceipts('Payroll receipts', p.receipts)}${itemReceipts}
    <p class="muted">PayPal's own status is the source of truth. UNCLAIMED means the payee has no PayPal account yet.</p></details>`;
}
function renderPayrollBatch(p: ShownPayroll, records: MoneyRecord[], payees: MoneyState['payees'] = []): string {
  const batchIdHtml = p.batchId
    ? `<div class="id-line"><span>Batch</span><button class="copy mono" data-copy="${e(p.batchId)}" title="Copy batch">${e(p.batchId)}</button></div>`
    : `<div class="id-line"><span>Batch</span><span class="mono">Processing…</span></div>`;
  const rows = payrollLines(p, records).map(item => {
    const payee = payees.find(py => py.key === item.payee);
    const payeeLabel = payee?.label ?? item.payee ?? '';
    const itemIdHtml = item.itemId
      ? `<button class="copy mono" data-copy="${e(item.itemId)}" title="Copy item">Item ${e(item.itemId)}</button>`
      : `<span class="mono muted">Item Processing…</span>`;
    const honestMessage = item.message && item.message !== item.status && item.message !== 'UNCLAIMED' && item.message !== 'Paid';
    return `<div class="payroll-item-row" data-record-id="${e(item.id)}">
      <div class="payroll-item-line1">
        <span class="payroll-item-title">Ward ${item.ward} · ${e(payeeLabel)}</span>
        <span class="mono">${dollars(item.cents / 100, true)}</span>
      </div>
      <div class="payroll-item-line2">
        <div class="payroll-item-status-col">
          ${statusChip(item.status)}
          ${item.status === 'UNCLAIMED' ? `<button data-action="cancel" data-id="${e(item.id)}" data-testid="cancel-${e(item.id)}">Cancel</button>` : ''}
        </div>
        ${itemIdHtml}
      </div>
      ${honestMessage ? `<p class="muted">${e(item.message)}</p>` : ''}
    </div>`;
  }).join('');
  return `<div class="payroll-batch" data-payroll-id="${e(p.id)}">
    <div class="payroll-header">
      <span class="payroll-title">Payroll · <time datetime="${new Date(p.createdAt).toISOString()}">${e(new Date(p.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</time></span>
      ${payrollStatusChip(p.status)}
    </div>
    ${batchIdHtml}
    ${p.message ? `<p class="muted">${e(p.message)}</p>` : ''}
    <div class="payroll-items">${rows}</div>
    ${payrollEvidence(p, records, payees)}
  </div>`;
}
function renderPayrollBatches(payrolls: ShownPayroll[] = [], records: MoneyRecord[], payees: MoneyState['payees'] = []): string {
  if (payrolls.length === 0) return '';
  const newest = renderPayrollBatch(payrolls[0], records, payees);
  if (payrolls.length === 1) return newest;
  const older = payrolls.slice(1).map(p => renderPayrollBatch(p, records, payees)).join('');
  return `${newest}<details class="older-payrolls" data-testid="older-payrolls"><summary>Older payrolls (${payrolls.length - 1})</summary>${older}</details>`;
}
export function renderMoneyLog(state: MoneyState, payrollSummaryHtml = ''): string {
  const allRecords = new Map<string, MoneyRecord>();
  for (const r of [...state.records, ...(state.openItems ?? []), ...(state.wardRecords ?? [])])
    allRecords.set(r.id, r);
  const recordsList = [...allRecords.values()];
  const preview = state.payrollPreview ?? { version: '', items: [], cents: 0, count: 0, readyCount: 0, excluded: 0, limit: null };
  const unitWord = (payee: string) => { const role = state.payees.find(p => p.key === payee)?.role; return role === 'doors' ? 'doors' : role === 'flyers' ? 'flyers' : 'units'; };
  const previewRows = preview.items.map(item =>
    `<li>Ward ${item.ward} · ${e(item.payeeLabel)} · ${item.units} ${unitWord(item.payee)} × ${money$(item.rateCents)} = ${money$(item.cents)}</li>`).join('');
  const previewHtml = `<div class="payroll-preview-box"><h4>Next payroll batch</h4>
        ${preview.count > 0 ? `<ul data-testid="payroll-preview">${previewRows}</ul>
        <p class="mono" data-testid="payroll-preview-total">Batch total ${money$(preview.cents)}</p>` : '<p class="muted">No checked work logs are ready to pay.</p>'}
        ${preview.excluded > 0 ? `<p class="muted">${preview.excluded} more ready logs wait for the next batch (${preview.limit === 'daily' ? 'daily payout limit' : 'at most 10 per batch'}).</p>` : ''}
      </div>`;
  // The server counts every work log. The loaded records hold only the newest 30.
  const paidCount = state.payoutCounts?.paid ?? recordsList.filter(r => r.payee && r.status === 'SUCCESS').length;
  const unclaimedCount = state.payoutCounts?.unclaimed ?? recordsList.filter(r => r.payee && r.status === 'UNCLAIMED').length;
  const latestPayroll = state.payrolls?.[0];

  const summaryContent = payrollSummaryHtml || (preview.count > 0 ? '<p class="muted">Checking ready work logs…</p>' : '<p class="muted">No checked work logs are ready to pay.</p>');

  return `<div class="section-heading"><h2>Money trail</h2><span class="eyebrow">USD · SANDBOX</span></div>
    <p class="muted">Completed captures fill the gold bars. Only SUCCESS payouts count as paid.</p>
    <section class="payroll-panel" data-testid="payroll">
      <div class="section-heading"><h3>Payroll</h3></div>
      ${previewHtml}
      <div class="payroll-counts">
        <div>Paid <span class="mono">${paidCount}</span></div>
        <div>Unclaimed <span class="mono">${unclaimedCount}</span> <small class="muted">No PayPal account yet. PayPal says it returns unclaimed money after 30 days.</small></div>
      </div>
      <small class="muted payroll-summary-label">AI explanation of this batch</small>
      <div id="payroll-summary" data-testid="payroll-summary">
        ${summaryContent}
      </div>
      <div class="button-row">
        <button data-action="pay-all" data-testid="pay-all" data-version="${e(preview.version)}" data-ready-count="${preview.count}" ${preview.count === 0 ? 'disabled' : ''}>Approve and pay ${preview.count} ${preview.count === 1 ? 'log' : 'logs'} (${money$(preview.cents)})</button>
        <button data-action="payroll-refresh" data-testid="payroll-refresh" ${latestPayroll ? `data-id="${e(latestPayroll.id)}"` : 'disabled'}>Refresh</button>
      </div>
      <div class="payroll-batches">
        ${renderPayrollBatches(state.payrolls ?? [], recordsList, state.payees)}
      </div>
    </section>
    <section class="money-record-groups" aria-label="Money records">
      <div class="your-records" data-testid="your-records">
        <h3>Your records</h3>
        ${[...state.records].filter(r => r.mine).sort((a, b) => b.createdAt - a.createdAt).map(r => renderRecord(r, state.refundProposals, state.payees)).join('') || '<p class="muted">No records from this browser yet. Give $10 on a ward card to make one.</p>'}
      </div>
      <details class="everyone-records">
        <summary>Everyone's records (${state.records.length})</summary>
        ${state.records.map(r => renderRecord(r, state.refundProposals, state.payees)).join('') || '<p class="muted">No money records yet. Select a ward to give test money or log work.</p>'}
      </details>
    </section>`;
}
