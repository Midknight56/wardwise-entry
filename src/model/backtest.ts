import { allocate } from './allocate';
import { BUDGET_DEFAULT, MISS_POINTS } from './assumptions';
import { forecastTurnout, nonVoters } from './score';
import type { BacktestResult, Scorecard, Ward } from './types';

/** Turnout percentages and point changes for the default 2019 plan. */
export function backtestPicks(wards: readonly Ward[]): {
  ward: number; turnout2019: number; turnout2023: number; change: number; cityChange: number;
}[] {
  if (!wards.length) return [];
  const plan = allocate(BUDGET_DEFAULT, 'y2019', wards);
  const round = (value: number) => Number(value.toFixed(1));
  const cityTurnout = (base: 'y2019' | 'y2023') => {
    const registered = wards.reduce((sum, w) => sum + w[base].registered, 0);
    return registered > 0 ? 100 * wards.reduce((sum, w) => sum + w[base].ballots, 0) / registered : 0;
  };
  const cityChange = round(cityTurnout('y2023') - cityTurnout('y2019'));
  return wards.filter(w => plan.perWard[w.id] > 0).sort((a, b) => a.id - b.id).map(w => {
    const turnout2019 = round(100 * forecastTurnout(w, 'y2019'));
    const turnout2023 = round(100 * forecastTurnout(w, 'y2023'));
    return { ward: w.id, turnout2019, turnout2023, change: round(turnout2023 - turnout2019), cityChange };
  });
}

/** Average ranks for ties, so tied pool counts do not imply an invented order. */
function ranks(values: readonly number[]): number[] {
  const sorted = values.map((value, i) => ({ value, i })).sort((a, b) => b.value - a.value);
  const result: number[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].value === sorted[i].value) j++;
    for (let k = i; k < j; k++) result[sorted[k].i] = (i + 1 + j) / 2;
    i = j;
  }
  return result;
}
export function spearman(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new RangeError('Rank series must have the same length');
  if (a.length < 2) return 0;
  const x = ranks(a), y = ranks(b), mean = (a.length + 1) / 2;
  let xy = 0, xx = 0, yy = 0;
  for (let i = 0; i < x.length; i++) {
    xy += (x[i] - mean) * (y[i] - mean);
    xx += (x[i] - mean) ** 2;
    yy += (y[i] - mean) ** 2;
  }
  return xx && yy ? xy / Math.sqrt(xx * yy) : 0;
}
export function backtest(wards: readonly Ward[], budget: number): BacktestResult {
  const plan = allocate(budget, 'y2019', wards);
  const oldPools = wards.map(w => nonVoters(w, 'y2019'));
  const pools = wards.map(w => nonVoters(w, 'y2023'));
  const poolRanks = ranks(pools);
  const perWard: BacktestResult['perWard'] = {};
  for (let i = 0; i < wards.length; i++) {
    const ward = wards[i], forecast = forecastTurnout(ward, 'y2019'), actual = forecastTurnout(ward, 'y2023');
    // Integer count arithmetic preserves the strict four point boundary without an epsilon.
    const denominator = ward.y2023.registered * ward.y2019.registered;
    const errorPoints = denominator > 0
      ? 100 * (ward.y2023.ballots * ward.y2019.registered - ward.y2019.ballots * ward.y2023.registered) / denominator
      : actual * 100 - forecast * 100;
    const funded2019 = plan.perWard[ward.id] > 0;
    perWard[ward.id] = { forecast, actual, errorPoints,
      miss: Math.abs(errorPoints) > MISS_POINTS, funded2019,
      nonVoters2023Rank: poolRanks[i], planMiss: funded2019 && poolRanks[i] > 10 };
  }
  const rows = Object.values(perWard);
  return { perWard, scorecard: {
    wardCount: rows.length,
    meanAbsErrorPoints: rows.length ? rows.reduce((sum, row) => sum + Math.abs(row.errorPoints), 0) / rows.length : 0,
    misses: rows.filter(row => row.miss).length, funded: rows.filter(row => row.funded2019).length,
    fundedStillTop10: rows.filter(row => row.funded2019 && row.nonVoters2023Rank <= 10).length,
    rankCorrelation: spearman(oldPools, pools),
  } };
}
export function summaryLine(scorecard: Scorecard): string {
  const population = scorecard.wardCount === undefined ? '' : ` of ${scorecard.wardCount}`;
  return `The 2019 method missed ${scorecard.misses}${population} wards by more than ${MISS_POINTS} points. ` +
    `${scorecard.fundedStillTop10} of its ${scorecard.funded} funded wards were still among the 10 biggest non voter pools in 2023.`;
}
