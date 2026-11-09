import { SETUP_COST, STEP } from '../model/assumptions';
import { expectedContacts, expectedVotes } from '../model/score';
import type { Base, Plan, Precinct, Ward } from '../model/types';

/** Numeric CSV fields need no quoting; use the same marginal return as the grid. */
export function planCsv(plan: Plan, wards: readonly Ward[], base: Base): string {
  const rows = wards.filter(w => plan.perWard[w.id] > 0).sort((a, b) => a.id - b.id).map(w => {
    const spend = plan.perWard[w.id];
    const votes = expectedVotes(w, spend, base, wards);
    const return100 = (expectedVotes(w, spend + STEP, base, wards) - votes) * 100 / STEP;
    return [w.id, spend, expectedContacts(w, spend, wards), votes.toFixed(1), return100.toFixed(2)].join(',');
  });
  return ['ward,dollars,expected_contacts,expected_votes,votes_per_100', ...rows].join('\r\n') + '\r\n';
}

export const PRECINCT_HEAT = ['#F3EFE6', '#EADFD2', '#DDC5B3', '#CCA991', '#BA8D73'];
export const nonVoterTotal = (wards: readonly Ward[]) => wards.reduce((sum, ward) => sum + ward.y2023.registered - ward.y2023.ballots, 0);
/** Nearest-rank quantiles: four inclusive upper bounds for five buckets. */
export function precinctBreaks(precincts: readonly Precinct[]): number[] {
  const values = precincts.map(p => p.registered - p.ballots).sort((a, b) => a - b);
  return [1, 2, 3, 4].map(q => values[Math.max(0, Math.ceil(values.length * q / 5) - 1)] ?? 0);
}
export function precinctBucket(value: number, breaks: readonly number[]): number {
  const bucket = breaks.findIndex(upper => value <= upper);
  return bucket < 0 ? breaks.length : bucket;
}
/** Fill each ward completely before starting the next; counters follow that fill. */
export function pourFrame(plan: Plan & { order: number[] }, progress: number) {
  const position = Math.max(0, Math.min(1, progress)) * plan.order.length;
  const fractions = Object.fromEntries(plan.order.map((id, i) => [id, Math.max(0, Math.min(1, position - i))]));
  return { fractions, dollars: plan.order.reduce((sum, id) => sum + plan.perWard[id] * fractions[id], 0),
    votes: plan.order.reduce((sum, id) => sum + plan.votes[id] * fractions[id], 0) };
}

export const HEAT = ['#EFE6D2', '#CBD6BF', '#9CBDB0', '#6C9D96', '#397D7B', '#0E5C61'];
export const ERROR_HEAT = ['#F3EFE6', '#CDD0C9', '#A5B1AF', '#7B9195', '#4C646F', '#1E2A33'];
/** Zero has its own bucket; positive values use five equal intervals. */
export function heatBucket(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || value <= 0 || max <= 0) return 0;
  return Math.min(5, Math.max(1, Math.ceil(value / max * 5)));
}
const numeric = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
export const integer = (value: number) => numeric.format(value);
export const decimal = (value: number, digits = 1) => value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const dollars = (value: number, cents = false) => '$' + (cents ? decimal(value, 2) : integer(value));
export const percent = (fraction: number) => decimal(fraction * 100) + '%';
export const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** Top funded means most plan dollars, then expected votes, then lower ward id. */
export function defaultWardPickers(plan: Plan, wards: readonly Ward[], lastDropped?: number): { a: number; b: number } {
  if (wards.length < 2) throw new RangeError('Two wards are needed for a comparison.');
  const sorted = [...wards].sort((a, b) => (plan.perWard[b.id] ?? 0) - (plan.perWard[a.id] ?? 0)
    || (plan.votes[b.id] ?? 0) - (plan.votes[a.id] ?? 0) || a.id - b.id);
  const a = sorted[0].id;
  if (lastDropped !== a && wards.some(w => w.id === lastDropped) && !plan.perWard[lastDropped!]) return { a, b: lastDropped! };
  const budget = Object.values(plan.perWard).reduce((sum, n) => sum + n, 0);
  const firstReturn = (ward: Ward) => {
    let best = 0;
    for (let spend = SETUP_COST + STEP; spend <= budget; spend += STEP)
      best = Math.max(best, expectedVotes(ward, spend, 'y2023', wards) / spend);
    return best;
  };
  const unfunded = wards.filter(w => w.id !== a && !plan.perWard[w.id])
    .map(w => ({ id: w.id, score: firstReturn(w) })).sort((x, y) => y.score - x.score || x.id - y.id);
  return { a, b: unfunded[0]?.id ?? sorted.find(w => w.id !== a)!.id };
}

export function returnMessage(result: string | null): string | undefined {
  switch (result?.toLowerCase()) {
    case 'captured': case 'completed': return 'Payment completed. Sandbox test money.';
    case 'cancelled': case 'canceled': return 'You cancelled. No money moved.';
    case 'declined': return 'Declined by PayPal. No money moved.';
    case 'pending': return 'Pending at PayPal';
    case 'checking': case 'approved': case 'created': return 'Checking payment';
    default: return undefined;
  }
}

export function foldKey(d: Element): string {
  if (d.matches('.older-payrolls')) return 'older-payrolls';
  if (d.matches('.everyone-records')) return 'everyone-records';
  const owner = d.closest<HTMLElement>('[data-record-id]')?.dataset.recordId ?? d.closest<HTMLElement>('[data-payroll-id]')?.dataset.payrollId ?? 'none';
  return `${owner}:${d.matches('.evidence') ? 'evidence' : 'ids'}`;
}

/** An AI payroll summary stays on screen only while it describes the batch the screen shows. */
export function summaryMatches(answerVersion: string | undefined, askedVersion: string, currentVersion: string): boolean {
  return currentVersion !== '' && (answerVersion ?? askedVersion) === currentVersion;
}
