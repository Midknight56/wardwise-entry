import { allocate } from './allocate';
import { SETUP_COST, STEP } from './assumptions';
import { expectedVotes } from './score';
import type { Base, Plan, Ward } from './types';
import type { MoveFacts } from './explain';

export interface MoveResult { plan: Plan; change: number; facts: MoveFacts }
export function allocateWithMove(budget: number, base: Base, wards: readonly Ward[], from: number, to: number, amount: number): MoveResult {
  if (from === to || !wards.some(w => w.id === from) || !wards.some(w => w.id === to)) {
    throw new RangeError('Move needs two different known wards');
  }
  const before = allocate(budget, base, wards);
  if (!Number.isFinite(amount) || amount < 0 || amount % STEP || amount > before.perWard[from]) {
    throw new RangeError('Move must be whole steps within the source ward dollars');
  }
  const remainder = before.perWard[from] - amount;
  const moved = amount > 0 && remainder > 0 && remainder < SETUP_COST + STEP ? before.perWard[from] : amount;
  const perWard = { ...before.perWard, [from]: before.perWard[from] - moved, [to]: before.perWard[to] + moved };
  const votes = Object.fromEntries(wards.map(w => [w.id, expectedVotes(w, perWard[w.id], base, wards)]));
  const total = Object.values(votes).reduce((a, b) => a + b, 0);
  const change = total - before.total;
  return { plan: { perWard, votes, total }, change, facts: {
    kind: 'move', from, to, amount: moved, fromDollars: perWard[from], toDollars: perWard[to],
    setupCost: SETUP_COST, step: STEP, budget, returnDollars: 100,
    votesBefore: Number(before.total.toFixed(1)), votesAfter: Number(total.toFixed(1)), change: Number(change.toFixed(1)),
  } };
}
