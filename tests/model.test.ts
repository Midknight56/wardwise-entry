import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { allocate } from '../src/model/allocate';
import * as assumptions from '../src/model/assumptions';
import { backtest, backtestPicks, spearman, summaryLine } from '../src/model/backtest';
import { checkAnswer, compareWards, explainDrop, explainMore, explainPlan, factNumbers, templateMore, templatePlan, templateMove, templateWhy } from '../src/model/explain';
import { allocateWithMove } from '../src/model/forceMove';
import { costPerContact, densityScore, expectedContacts, expectedVotes, forecastTurnout, nonVoters } from '../src/model/score';
import { COST_MAX, COST_MIN } from '../src/model/assumptions';
import type { CityData, Plan, Ward } from '../src/model/types';
import { sixWards } from './fixtures/six-wards';

const sum = (plan: Plan) => Object.values(plan.perWard).reduce((a, b) => a + b, 0);
const count = (plan: Plan) => Object.values(plan.perWard).filter(Boolean).length;
const copy = () => structuredClone(sixWards);
const { SETUP_COST, STEP } = assumptions;

/** Exhaustive discrete search by dynamic programming, independent of greedy choices. */
function bruteForce(wards: Ward[], budget: number): number {
  const n = budget / STEP;
  let best = Array<number>(n + 1).fill(-Infinity);
  best[0] = 0;
  for (const ward of wards) {
    const curve = Array.from({ length: n + 1 }, (_, k) => expectedVotes(ward, k * STEP, 'y2023', wards));
    const next = [...best];
    for (let used = 0; used <= n; used++) {
      for (let k = (SETUP_COST + STEP) / STEP; used + k <= n; k++) {
        next[used + k] = Math.max(next[used + k], best[used] + curve[k]);
      }
    }
    best = next;
  }
  return best[n];
}
function rng(seed: number) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}

describe('scoring', () => {
  it('exports all labelled model constants', () => {
    expect(assumptions.ASSUMPTIONS).toHaveLength(10);
    for (const row of assumptions.ASSUMPTIONS) {
      expect(row.value).toBe(assumptions[row.key as keyof typeof assumptions]);
      expect(row.label.length).toBeGreaterThan(0);
    }
  });
  it('uses persistence and the registered non voter pool for both years', () => {
    expect(forecastTurnout(sixWards[0], 'y2019')).toBe(8000 / 19000);
    expect(nonVoters(sixWards[0], 'y2023')).toBe(11500);
  });
  it('scales adults per area and contact costs', () => {
    const scores = Object.values(densityScore(sixWards));
    expect(Math.min(...scores)).toBe(0);
    expect(Math.max(...scores)).toBe(1);
    expect(costPerContact(sixWards[0], sixWards)).toBeCloseTo(COST_MIN);
    expect(costPerContact(sixWards[5], sixWards)).toBe(COST_MAX);
  });
  it('handles uniform density, empty pools and zero registrations without NaN', () => {
    const wards = copy().map(w => ({ ...w, adults: 100, areaSqKm: 1, y2023: { ...w.y2023, registered: 0, ballots: 0 } }));
    expect(Object.values(densityScore(wards))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(forecastTurnout(wards[0], 'y2023')).toBe(0);
    expect(expectedVotes(wards[0], 5000, 'y2023', wards)).toBe(0);
  });
  it('charges setup and follows the specified exponential response', () => {
    expect(expectedVotes(sixWards[0], 299, 'y2023', sixWards)).toBe(0);
    expect(expectedVotes(sixWards[0], 300, 'y2023', sixWards)).toBe(0);
    expect(expectedVotes(sixWards[0], 1000, 'y2023', sixWards)).toBeCloseTo(assumptions.LIFT * assumptions.EASY_SHARE * 11500 * (1 - Math.exp(-700 / 2.3 / (assumptions.EASY_SHARE * 11500))));
  });
  it('has decreasing marginal returns after setup', () => {
    for (const ward of sixWards) {
      let prior = Infinity;
      for (let dollars = SETUP_COST; dollars < 10000; dollars += STEP) {
        const delta = expectedVotes(ward, dollars + STEP, 'y2023', sixWards) - expectedVotes(ward, dollars, 'y2023', sixWards);
        expect(delta).toBeGreaterThanOrEqual(0);
        expect(delta).toBeLessThanOrEqual(prior + 1e-12);
        prior = delta;
      }
    }
  });
  it('does not use the top share gap as a weight', () => {
    const wards = copy();
    wards[0].y2023.topShare = 0.99;
    expect(allocate(5000, 'y2023', wards)).toEqual(allocate(5000, 'y2023', sixWards));
  });
});

describe('allocation', () => {
  it.each([0, 350, 999, 1000, 2029, 5000, 10000])('spends rounded budget %i exactly with valid openings', budget => {
    const plan = allocate(budget, 'y2023', sixWards);
    expect(sum(plan)).toBe(Math.floor(budget / STEP) * STEP);
    expect(Object.values(plan.perWard).every(x => x === 0 || x >= SETUP_COST + STEP && x % STEP === 0)).toBe(true);
    expect(plan.total).toBeCloseTo(Object.values(plan.votes).reduce((a, b) => a + b, 0));
  });
  it('rejects infeasible or invalid budgets explicitly', () => {
    for (const budget of [-50, NaN, Infinity, 50, 300]) expect(() => allocate(budget, 'y2023', sixWards)).toThrow(RangeError);
    expect(() => allocate(1000, 'y2023', [])).toThrow(RangeError);
    expect(allocate(0, 'y2023', []).total).toBe(0);
  });
  it('breaks ties on lower id regardless of input order', () => {
    const wards = [3, 2, 1].map(id => ({ ...sixWards[0], id }));
    expect(allocate(1000, 'y2023', wards).perWard).toEqual({ 1: 1000, 2: 0, 3: 0 });
    expect(allocate(5000, 'y2023', wards)).toEqual(allocate(5000, 'y2023', [...wards].reverse()));
  });
  it('fills the remainder even when all pools are empty', () => {
    const wards = copy().map(w => ({ ...w, y2023: { ...w.y2023, ballots: w.y2023.registered } }));
    expect(sum(allocate(1000, 'y2023', wards))).toBe(1000);
  });
  it('is pure and deterministic', () => {
    const wards = copy(), before = copy();
    expect(allocate(5000, 'y2023', wards)).toEqual(allocate(5000, 'y2023', wards));
    expect(wards).toEqual(before);
  });
  it.each(Array.from({ length: 200 }, (_, i) => i + 1))('matches exhaustive optimum within 1 percent, random case %i', seed => {
    const random = rng(seed);
    const wards = copy().map(w => {
      const registered = Math.round(10000 + random() * 40000);
      return { ...w, adults: Math.round(15000 + random() * 40000), areaSqKm: 2 + random() * 18,
        y2023: { ...w.y2023, registered, ballots: Math.round(registered * (0.2 + random() * 0.5)) } };
    });
    const budget = (20 + Math.floor(random() * 41)) * STEP;
    const plan = allocate(budget, 'y2023', wards);
    expect(plan.total).toBeGreaterThanOrEqual(bruteForce(wards, budget) * 0.99 - 1e-10);
    expect(plan.total + 1e-10).toBeGreaterThanOrEqual(Math.max(...wards.map(w => expectedVotes(w, budget, 'y2023', wards))));
    expect(sum(plan)).toBe(budget);
  });
  it('runs 50 wards at $10,000 in under 30 ms', () => {
    const wards = Array.from({ length: 50 }, (_, i) => ({ ...sixWards[i % 6], id: i + 1 }));
    allocate(10000, 'y2023', wards); // Warm the runtime before timing the model itself.
    const start = performance.now();
    const plan = allocate(10000, 'y2023', wards);
    expect(performance.now() - start).toBeLessThan(30);
    expect(sum(plan)).toBe(10000);
  });
});

describe('facts and written answers', () => {
  it('names a ward removed when the fixture budget falls', () => {
    const before = allocate(5000, 'y2023', sixWards), after = allocate(2000, 'y2023', sixWards);
    const facts = explainDrop(before, after, 'y2023', sixWards)!;
    expect(count(before)).toBeGreaterThan(count(after));
    expect(before.perWard[facts.ward]).toBeGreaterThan(0);
    expect(after.perWard[facts.ward]).toBe(0);
    expect(facts.dollarsBefore).toBe(before.perWard[facts.ward]);
    expect(after.perWard[facts.keptWard]).toBeGreaterThan(0);
    expect(explainDrop(before, before, 'y2023', sixWards)).toBeNull();
  });
  const facts = compareWards(1, 6, allocate(5000, 'y2023', sixWards), 'y2023', sixWards);
  it('rounds facts to display precision', () => {
    expect(facts.a.turnout).toBe(Math.round(8500 / 20000 * 100));
    expect(facts.a.costPerContact).toBe(2.3);
    expect(facts.a.shareGap).toBe(15);
    expect(facts.a.votesPer100).toBe(Number(facts.a.votesPer100.toFixed(2)));
  });
  it('checks code templates against their own facts', () => {
    const answer = templateWhy(facts);
    expect(checkAnswer(answer, facts, [1, 6])).toEqual({ ok: true, bad: [] });
    expect(answer.split(/[.!?](?:\s|$)/).filter(Boolean).length).toBeLessThanOrEqual(3);
    expect(answer).not.toMatch(/[\u2013\u2014-]/);
  });
  it('formats large money with commas and accepts comma or plain fact numbers', () => {
    const large = { ...facts, a: { ...facts.a, dollars: 2600 } };
    const answer = templateWhy(large);
    expect(answer).toContain('$2,600');
    expect(checkAnswer('Ward 1 gets $2,600.', large, [1, 6]).ok).toBe(true);
    expect(checkAnswer('Ward 1 gets $2600.', large, [1, 6]).ok).toBe(true);
    expect(factNumbers(large)).toContain('2,600');
  });
  it('rejects invented numbers and wards even when a ward id is another fact number', () => {
    expect(checkAnswer('Ward 1 gains 999.9 votes.', facts, [1, 6]).ok).toBe(false);
    expect(checkAnswer('Ward 300 gets money.', facts, [1, 6]).bad).toContain('Ward 300');
    expect(checkAnswer('Wards 1, 300 and 6 get money.', facts, [1, 6]).ok).toBe(false);
    expect(checkAnswer('Ward #300 gets money.', facts, [1, 6]).ok).toBe(false);
    expect(checkAnswer('Ward 1e3 gets money.', facts, [1, 6]).ok).toBe(false);
    expect(checkAnswer('Ward 1 gains 1e3 votes.', facts, [1, 6]).ok).toBe(false);
  });
  it('accepts currency, commas, percentages, whole rounding and trailing zeroes', () => {
    expect(checkAnswer(`Ward 1.0 has ${facts.a.nonVoters.toLocaleString('en-US')}. Turnout was ${facts.a.turnout}.0%.`, facts, [1, 6]).ok).toBe(true);
    expect(factNumbers(facts)).toContain(String(facts.a.votes));
  });
  it('rejects unknown wards in comparisons', () => {
    expect(() => compareWards(99, 1, allocate(5000, 'y2023', sixWards), 'y2023', sixWards)).toThrow(RangeError);
    expect(() => compareWards(1, 1, allocate(5000, 'y2023', sixWards), 'y2023', sixWards)).toThrow(RangeError);
  });
});

describe('forced moves', () => {
  it('moves whole steps, preserves the budget and recomputes votes', () => {
    const before = allocate(5000, 'y2023', sixWards);
    const ids = sixWards.filter(w => before.perWard[w.id] > 0).map(w => w.id);
    const result = allocateWithMove(5000, 'y2023', sixWards, ids[0], ids[1], STEP);
    expect(sum(result.plan)).toBe(5000);
    expect(result.plan.perWard[ids[0]]).toBe(before.perWard[ids[0]] - STEP);
    expect(result.change).toBeCloseTo(result.plan.total - before.total);
    expect(checkAnswer(templateMove(result.facts), result.facts, ids).ok).toBe(true);
    expect(allocate(5000, 'y2023', sixWards)).toEqual(before);
  });
  it('moves the whole source when the remainder cannot cover setup', () => {
    const before = allocate(5000, 'y2023', sixWards);
    const ids = sixWards.filter(w => before.perWard[w.id] > 0).map(w => w.id);
    const result = allocateWithMove(5000, 'y2023', sixWards, ids[0], ids[1], before.perWard[ids[0]] - 300);
    expect(result.plan.perWard[ids[0]]).toBe(0);
    expect(result.facts.amount).toBe(before.perWard[ids[0]]);
  });
  it('validates steps, available dollars and ward ids', () => {
    for (const amount of [-50, 1, Infinity, 10000]) expect(() => allocateWithMove(5000, 'y2023', sixWards, 1, 6, amount)).toThrow(RangeError);
    expect(() => allocateWithMove(5000, 'y2023', sixWards, 1, 1, 50)).toThrow(RangeError);
    expect(() => allocateWithMove(5000, 'y2023', sixWards, 1, 99, 50)).toThrow(RangeError);
    const smallMove = allocateWithMove(5000, 'y2023', sixWards, 1, 6, 50);
    expect(smallMove.plan.perWard[6]).toBe(50);
    expect(smallMove.plan.votes[6]).toBe(0); // Forced dollars below setup cannot produce votes.
    expect(allocateWithMove(5000, 'y2023', sixWards, 1, 6, 0).change).toBeCloseTo(0);
  });
});

describe('backtest', () => {
  it('backtestPicks returns four real-data wards with turnout changes at the default budget', () => {
    const city = JSON.parse(readFileSync('public/data/chicago.json', 'utf8')) as CityData;
    const picks = backtestPicks(city.wards);
    const plan = allocate(assumptions.BUDGET_DEFAULT, 'y2019', city.wards);
    expect(picks).toHaveLength(4);
    expect(picks.map(row => row.ward)).toEqual(city.wards.filter(w => plan.perWard[w.id] > 0).map(w => w.id));
    const turnout = (base: 'y2019' | 'y2023') => 100 * city.wards.reduce((sum, w) => sum + w[base].ballots, 0) / city.wards.reduce((sum, w) => sum + w[base].registered, 0);
    for (const row of picks) {
      const ward = city.wards.find(w => w.id === row.ward)!;
      expect(row.turnout2019).toBe(Number((100 * forecastTurnout(ward, 'y2019')).toFixed(1)));
      expect(row.turnout2023).toBe(Number((100 * forecastTurnout(ward, 'y2023')).toFixed(1)));
      expect(row.change).toBeCloseTo(row.turnout2023 - row.turnout2019, 10);
      expect(row.cityChange).toBe(Number((turnout('y2023') - turnout('y2019')).toFixed(1)));
    }
    expect(backtestPicks([])).toEqual([]);
  });
  it('counts whole expected contacts after setup with no negative contacts', () => {
    for (const spend of [0, 299, 300, 350, 1000]) {
      expect(expectedContacts(sixWards[0], spend, sixWards)).toBe(Math.floor(Math.max(0, spend - SETUP_COST) / COST_MIN));
    }
  });
  it('counts errors strictly beyond four points, without rounding before comparison', () => {
    const wards = copy();
    for (const [i, ballots] of [4400, 4401, 3600, 3599].entries()) {
      wards[i].y2019 = { ...wards[i].y2019, registered: 10000, ballots: 4000 };
      wards[i].y2023 = { ...wards[i].y2023, registered: 10000, ballots };
    }
    const result = backtest(wards, 5000);
    expect([1, 2, 3, 4].map(id => result.perWard[id].miss)).toEqual([false, true, false, true]);
    expect(result.perWard[2].errorPoints).toBeCloseTo(4.01);
    expect(summaryLine(result.scorecard)).toContain('more than 4 points');
  });
  it('computes Spearman on known ascending, reversed and tied cases', () => {
    expect(spearman([1, 2, 3, 4], [1, 2, 3, 4])).toBe(1);
    expect(spearman([1, 2, 3], [3, 2, 1])).toBe(-1);
    expect(spearman([1, 2, 3, 4, 5], [1, 3, 2, 5, 4])).toBeCloseTo(0.8);
    expect(spearman([1, 1, 2], [1, 2, 3])).toBeCloseTo(Math.sqrt(3) / 2);
    expect(spearman([1, 1], [2, 3])).toBe(0);
    expect(spearman([], [])).toBe(0);
    expect(() => spearman([1], [])).toThrow(RangeError);
  });
  it('flags funded wards outside the later top ten separately from turnout misses', () => {
    const wards = Array.from({ length: 12 }, (_, i) => ({ ...sixWards[0], id: i + 1,
      y2023: { ...sixWards[0].y2023, registered: 20000, ballots: i === 0 ? 19999 : 1000 + i } }));
    const result = backtest(wards, 1000);
    expect(result.perWard[1].funded2019).toBe(true);
    expect(result.perWard[1].nonVoters2023Rank).toBe(12);
    expect(result.perWard[1].planMiss).toBe(true);
    expect(result.scorecard.fundedStillTop10).toBe(0);
  });
});

const cityPath = new URL('../public/data/chicago.json', import.meta.url);
const cityExists = existsSync(cityPath);
if (!cityExists) console.info('Skipping Chicago model check: public/data/chicago.json is absent.');
it.skipIf(!cityExists)('Chicago tuned plans fund the specified wards at $5,000 and $2,000', () => {
  const city = JSON.parse(readFileSync(cityPath, 'utf8')) as CityData;
  const high = allocate(5000, 'y2023', city.wards);
  const low = allocate(2000, 'y2023', city.wards);
  expect(Object.entries(high.perWard).filter(([, dollars]) => dollars > 0).map(([id]) => Number(id))).toEqual([2, 9, 21, 27]);
  expect(Object.entries(low.perWard).filter(([, dollars]) => dollars > 0).map(([id]) => Number(id))).toEqual([2, 21]);
});

it('explains $500 more in a real ward using the response curve', () => {
  const city = JSON.parse(readFileSync(cityPath, 'utf8')) as CityData;
  const plan = allocate(5000, 'y2023', city.wards), ward = city.wards.find(w => w.id === 21)!;
  const facts = explainMore(21, 500, plan, 'y2023', city.wards);
  const now = expectedVotes(ward, 1350, 'y2023', city.wards), after = expectedVotes(ward, 1850, 'y2023', city.wards);
  expect(facts).toMatchObject({ kind: 'more', ward: 21, amount: 500, dollarsNow: 1350, dollarsAfter: 1850, votesNow: Number(now.toFixed(1)), votesAfter: Number(after.toFixed(1)), gain: Number((after - now).toFixed(1)), budget: 5000, step: 50, setupCost: 300 });
  expect(templateMore(facts)).toBe(`Adding $500 to Ward 21 takes it from $1,350 to $1,850 and adds ${facts.gain} expected votes.`);
  expect(checkAnswer(templateMore(facts), facts, [21]).ok).toBe(true);
  expect(() => explainMore(99, 500, plan, 'y2023', city.wards)).toThrow(RangeError);
});

it('explains the real first screen plan with rounded totals', () => {
  const city = JSON.parse(readFileSync(cityPath, 'utf8')) as CityData;
  const plan = allocate(5000, 'y2023', city.wards), facts = explainPlan(plan, 5000, 'y2023', city.wards);
  expect(facts).toMatchObject({ kind: 'plan', budget: 5000, wardsFunded: 4, votes: Number(plan.total.toFixed(1)), dollarsPerVote: Math.round(5000 / plan.total), topWard: 21, topWardDollars: 1350, topWardNonVoters: 29263, step: 50, setupCost: 300 });
  expect(templatePlan(facts)).toBe(`At $5,000 the plan funds 4 wards for ${facts.votes} expected new votes, about $${facts.dollarsPerVote} per vote. Ward 21 gets the most, $1,350, for its 29,263 non voters.`);
  expect(checkAnswer(templatePlan(facts), facts, [2, 9, 21, 27]).ok).toBe(true);
});


it('limits plan ward facts to ten and totals the remaining wards', () => {
  const wards = Array.from({ length: 12 }, (_, i) => ({ ...sixWards[0], id: i + 1 }));
  const plan: Plan = { perWard: {}, votes: {}, total: 0 };
  for (const ward of wards) { plan.perWard[ward.id] = 350 + ward.id * 50; plan.votes[ward.id] = ward.id + 0.25; plan.total += plan.votes[ward.id]; }
  const facts = explainPlan(plan, sum(plan), 'y2023', wards);
  expect(facts.wards).toEqual([...wards].reverse().slice(0, 10).map(w => ({ ward: w.id, dollars: plan.perWard[w.id], votes: Number(plan.votes[w.id].toFixed(1)) })));
  expect(facts.otherWards).toBe(2);
  expect(facts.otherDollars).toBe(plan.perWard[1] + plan.perWard[2]);
  const small = explainPlan(allocate(5000, 'y2023', sixWards), 5000, 'y2023', sixWards);
  expect(small.otherWards).toBeUndefined(); expect(small.otherDollars).toBeUndefined();
});

it('only adds whole rounded fact copies for magnitudes of at least ten', () => {
  const facts = { ...compareWards(1, 6, allocate(5000, 'y2023', sixWards), 'y2023', sixWards), a: { ward: 21, dollars: 1350, votes: 16.3, nonVoters: 29263.4, costPerContact: 2.58, votesPer100: 0.3, turnout: 33, shareGap: 20 },
    b: { ward: 27, dollars: 350, votes: 4.2, nonVoters: 27056, costPerContact: 2.3, votesPer100: 1.38, turnout: 40, shareGap: 15 } };
  expect(factNumbers(facts)).toContain('29,263');
  expect(factNumbers(facts)).toContain('16');
  expect(factNumbers(facts)).toContain('0.3');
  expect(factNumbers(facts)).toContain('1.38');
  expect(factNumbers(facts)).not.toContain('0');
  expect(factNumbers(facts)).not.toContain('1');
  expect(checkAnswer('The votes per $100 is 0.', facts, [21, 27]).ok).toBe(false);
  expect(checkAnswer('The votes per $100 is 1.', facts, [21, 27]).ok).toBe(false);
});
