import { COST_MAX, COST_MIN, EASY_SHARE, SETUP_COST, STEP } from './assumptions';
import { densityScore, nonVoters, votesAtCost } from './score';
import type { Base, Plan, Ward } from './types';

export function roundedBudget(budget: number): number {
  if (!Number.isFinite(budget) || budget < 0) throw new RangeError('Budget must be finite and nonnegative');
  return Math.floor(budget / STEP) * STEP;
}
export function allocate(budget: number, base: Base, wards: readonly Ward[]): Plan & { order: number[] } {
  const total = roundedBudget(budget);
  const ordered = [...wards].sort((a, b) => a.id - b.id);
  if (total > 0 && (total < SETUP_COST + STEP || !ordered.length)) {
    throw new RangeError('Budget needs at least one ward and its setup plus one step');
  }
  const densities = densityScore(ordered);
  const curves = ordered.map(w => {
    const cost = COST_MAX - (COST_MAX - COST_MIN) * densities[w.id];
    const pool = EASY_SHARE * nonVoters(w, base);
    return Array.from({ length: total / STEP + 1 }, (_, k) => votesAtCost(k * STEP, pool, cost));
  });
  const units = ordered.map(() => 0);
  let order: number[] = [];
  const opening = (SETUP_COST + STEP) / STEP;
  let left = total / STEP;
  while (left > 0) {
    let best = -1, chunk = 0, gain = -Infinity;
    for (let i = 0; i < ordered.length; i++) {
      if (units[i]) {
        const marginal = curves[i][units[i] + 1] - curves[i][units[i]];
        if (marginal > gain + 1e-12) { best = i; chunk = 1; gain = marginal; }
      } else {
        for (let k = opening; k <= left; k++) {
          const average = curves[i][k] / k;
          if (average > gain + 1e-12) { best = i; chunk = k; gain = average; }
        }
      }
    }
    // If all curves have saturated, existing wards still absorb the remainder.
    if (best < 0) throw new RangeError('No feasible allocation');
    if (!units[best]) order.push(ordered[best].id);
    units[best] += chunk;
    left -= chunk;
  }
  // Fixed setup costs make strict greedy violate the contract's 1% and best-single
  // requirements (even on realistic six-ward inputs). Keep its prescribed opening
  // rule, then certify the result with a discrete knapsack safeguard. At 50 wards
  // and 200 budget units this needs fewer than a million candidate comparisons.
  // Equal scores preserve the greedy result and its lower-id tie rule.
  const limit = total / STEP;
  let best = new Float64Array(limit + 1).fill(-Infinity);
  best[0] = 0;
  const choices: Uint32Array[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const next = best.slice();
    const choice = new Uint32Array(limit + 1);
    for (let used = 0; used <= limit; used++) {
      if (!Number.isFinite(best[used])) continue;
      for (let k = opening; used + k <= limit; k++) {
        const score = best[used] + curves[i][k];
        if (score > next[used + k] + 1e-12) {
          next[used + k] = score;
          choice[used + k] = k;
        }
      }
    }
    choices.push(choice);
    best = next;
  }
  const greedyVotes = units.reduce((sum, k, i) => sum + curves[i][k], 0);
  if (best[limit] > greedyVotes + 1e-12) {
    let remaining = limit;
    for (let i = ordered.length - 1; i >= 0; i--) {
      units[i] = choices[i][remaining];
      remaining -= units[i];
    }
    // The exact solution has no step history. Pour its funded wards by their
    // final votes per $100, with the same lower-id tie break as greedy.
    order = ordered.map((w, i) => ({ id: w.id, units: units[i], votes: curves[i][units[i]] }))
      .filter(w => w.units > 0).sort((a, b) => b.votes / b.units - a.votes / a.units || a.id - b.id)
      .map(w => w.id);
  }
  const perWard = Object.fromEntries(ordered.map((w, i) => [w.id, units[i] * STEP]));
  const votes = Object.fromEntries(ordered.map((w, i) => [w.id, curves[i][units[i]]]));
  return { perWard, votes, total: Object.values(votes).reduce((a, b) => a + b, 0), order };
}
