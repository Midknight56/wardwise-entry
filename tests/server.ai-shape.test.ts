import { afterEach, describe, expect, it, vi } from 'vitest';
import { ask, answerKey, factsPrompt, parseAsk, safeAnswer, type AskDependencies } from '../src/server/ai/ask';
import { allocate } from '../src/model/allocate';
import * as moves from '../src/model/forceMove';
import { compareWards, explainMore, explainPlan, explainPayroll, templateMore, templatePlan, templatePayroll, checkAnswer, directionOk, type MoveFacts, type WhyFacts } from '../src/model/explain';
import { readFileSync } from 'node:fs';
import type { CityData } from '../src/model/types';
import { neurons } from '../src/server/ai/model';
import { wards } from './helpers/city';
import { world } from './helpers/world';
const city = JSON.parse(readFileSync(new URL('../public/data/chicago.json', import.meta.url), 'utf8')) as CityData;

const why: WhyFacts = { kind: 'why', a: { ward: 21, dollars: 1350, votes: 12.3, nonVoters: 12345, costPerContact: 1.25, votesPer100: 2.4, turnout: 33, shareGap: 20 },
  b: { ward: 1, dollars: 0, votes: 0, nonVoters: 6789, costPerContact: 2, votesPer100: 1.1, turnout: 40, shareGap: 10 }, setupCost: 300, step: 50, budget: 5000, returnDollars: 100,
  dollarsGap: 1350, votesGap: 12.3, nonVotersGap: 5556, reason: 'Ward 21 wins on both: more non voters and a lower cost per contact.' };
const move: MoveFacts = { kind: 'move', from: 1, to: 2, amount: 500, fromDollars: 1350, toDollars: 500, votesBefore: 20, votesAfter: 18.8, change: -1.2, setupCost: 300, step: 50, budget: 5000, returnDollars: 100 };
afterEach(() => vi.restoreAllMocks());

describe('plain text facts prompts', () => {
  it('snapshots the exact why question and facts', () => {
    expect(factsPrompt(why)).toMatchInlineSnapshot(`
      "Question: Why does Ward 21 get $1,350 in the plan while Ward 1 gets no money in the plan?
      Facts:
      Ward 21: plan $1,350; expected new votes 12.3; non voters 12345; cost per contact $1.25; votes per $100 2.4.
      Ward 1: plan $0; expected new votes 0; non voters 6789; cost per contact $2.00; votes per $100 1.1.
      Main reason: Ward 21 wins on both: more non voters and a lower cost per contact.
      Dollar difference: $1,350
      Vote difference: 12.3
      Non voter difference: 5556
      Every ward needs $300 of setup before its first door. For a ward with no money, votes per $100 already counts that setup.
      The plan puts each $50 where it buys the most expected new votes.
      More votes per $100: Ward 21 (2.4 vs 1.1).
      Larger non voter pool: Ward 21 (12,345 vs 6,789).
      Cost per contact: Ward 21 $1.25, Ward 1 $2.00. Ward 21 is cheaper per contact.
      Answer in 2 or 3 short sentences. Say which ward returns more votes per $100, with both numbers, then the main reason in one sentence. Use only the numbers above, written the same way.
      Give the main reason in your own words. Never give a higher cost per contact as a reason to win.
      Numbers you may use: 21, $1,350, 12.3, 12,345, $1.25, 2.4, 33, 20, 1, $0, 6,789, $2, 1.1, 40, 10, $300, $50, $5,000, $100, 5,556, $2.00"
    `);
  });
  it('snapshots the exact move question including a negative change', () => {
    expect(factsPrompt(move)).toMatchInlineSnapshot(`
      "Question: What happens if $500 moves from Ward 1 to Ward 2?
      Facts:
      The whole citywide plan expects 20 new votes before the move and 18.8 after. Change: -1.2, so the move loses 1.2 expected new votes.
      These vote totals are for the whole plan, not for one ward.
      After the move Ward 1 has $1,350 and Ward 2 has $500.
      The plan puts each $50 where it buys the most expected new votes.
      Answer in 2 or 3 short sentences. Say whether the move gains or loses votes. Use only the numbers above, written the same way.
      Numbers you may use: 1, 2, $500, $1,350, 20, 18.8, -1.2, 1.2, $300, $50, $5,000, $100"
    `);
  });
});

function deps(output: unknown): AskDependencies & { ledger: { reserve: ReturnType<typeof vi.fn>; settle: ReturnType<typeof vi.fn> } } {
  return { wards, gate: world().gate, ledger: { reserve: vi.fn(async () => 1), settle: vi.fn(async () => {}) },
    ai: { run: async () => output }, live: true };
}
const question = { kind: 'why', a: 1, b: 2, budget: 5000 };
describe('AI shapes and checked answer normalization with the real number checker', () => {
  it('accepts chat completions and settles our formula rather than usage.neurons', async () => {
    const d = deps({ choices: [{ message: { content: 'Ward 1 and Ward 2 have non voters.' } }], usage: { prompt_tokens: 179, completion_tokens: 24, neurons: 9999 } });
    expect(await ask(question, d)).toMatchObject({ source: 'live' });
    expect(d.ledger.settle).toHaveBeenCalledWith(1, neurons(179, 24));
  });
  it('still accepts the response shape and alternate token usage names', async () => {
    const d = deps({ response: 'Ward 1 and Ward 2 have non voters.', usage: { input_tokens: 100, output_tokens: 20 } });
    expect((await ask(question, d)).source).toBe('live');
    expect(d.ledger.settle).toHaveBeenCalledWith(1, neurons(100, 20));
  });
  it('prefers a string response over chat content', async () => {
    expect((await ask(question, deps({ response: 'Ward 1 has non voters.', choices: [{ message: { content: 'Ward 99 gets $999999.' } }] }))).source).toBe('live');
  });
  it('falls back on missing chat content', async () => {
    expect(await ask(question, deps({ choices: [{ message: { role: 'assistant' } }] }))).toMatchObject({ source: 'rules', reason: 'answer_check' });
  });
  it('shows and caches non-voters as non voters', async () => {
    const d = deps({ response: 'Ward 1 has non-voters.' });
    expect(await ask(question, d)).toEqual({ text: 'Ward 1 has non voters.', source: 'live' });
    expect(await ask(question, d)).toEqual({ text: 'Ward 1 has non voters.', source: 'cache' });
  });
  it.each(['Ward 21 — Ward 1', 'Ward 1 - Ward 2'])('rejects a dash between words: %s', async response => {
    expect((await ask(question, deps({ response }))).reason).toBe('answer_check');
  });
  it('allows -1.2 when it is the change, and rejects a number outside the facts', async () => {
    vi.spyOn(moves, 'allocateWithMove').mockReturnValue({ plan: allocate(5000, 'y2023', wards), change: -1.2, facts: move });
    const input = { kind: 'move', from: 1, to: 2, amount: 50, budget: 5000 };
    expect(await ask(input, deps({ response: 'The change is -1.2 votes.' }))).toMatchObject({ source: 'live', text: 'The change is -1.2 votes.' });
    expect((await ask(input, deps({ response: 'The change is -9.7 votes.' }))).reason).toBe('answer_check');
    vi.mocked(moves.allocateWithMove).mockReturnValue({ plan: allocate(5000, 'y2023', wards), change: 1.2, facts: { ...move, change: 1.2 } });
    expect((await ask(input, deps({ response: 'The change is -1.2 votes.' }))).reason).toBe('answer_check');
  });
  it('checks move direction for both signs and rejects the reported wrong-direction answer', async () => {
    expect(directionOk('The move loses 4.1 votes.', { ...move, change: -4.1 })).toBe(true);
    expect(directionOk('The move gains 4.1 votes.', { ...move, change: -4.1 })).toBe(false);
    expect(directionOk('The move gains 4.1 votes.', { ...move, change: 4.1 })).toBe(true);
    expect(directionOk('The move loses 4.1 votes.', { ...move, change: 4.1 })).toBe(false);
    const liveFacts = { ...move, from: 1, to: 2, amount: 500, fromDollars: 550, toDollars: 500, votesBefore: 20, votesAfter: 15.9, change: -4.1 };
    vi.spyOn(moves, 'allocateWithMove').mockReturnValue({ plan: allocate(2000, 'y2023', wards), change: -4.1, facts: liveFacts });
    const input = { kind: 'move', from: 1, to: 2, amount: 500, budget: 2000 };
    expect((await ask(input, deps({ response: 'The move gains 4.1 votes. Ward 21 has $550. Ward 9 has $500.' }))).reason).toBe('answer_check');
  });
});

describe('Chicago answer regressions', () => {
  const realWards = city.wards;
  const plan = allocate(8000, 'y2023', realWards);
  const comparison = compareWards(27, 2, plan, 'y2023', realWards);
  it.each([
    [27, 21, 'The move loses 1.4 expected new votes. After the move, Ward 27 has $800 and Ward 21 has $1,850. The plan prioritizes spending each $50 for the most expected new votes.'],
    [2, 42, 'The move from Ward 2 to Ward 42 loses 3.4 expected new votes. The plan prioritizes spending $50 where it gains the most votes.'],
  ] as const)('accepts the reported move answer for Ward %i to %i', (from, to, text) => {
    const facts = moves.allocateWithMove(5000, 'y2023', realWards, from, to, 500).facts;
    expect(safeAnswer(text, facts, [from, to])).toBe(text);
  });
  it('accepts the reported why answer and its computed budget gap', () => {
    const text = "Ward 27 has higher votes per $100 (1.14) than Ward 2 (1.11). The additional $200 in Ward 27's budget allows for more contacts and higher expected new votes (16.7 vs. 14.3).";
    expect(comparison.dollarsGap).toBe(200);
    expect(safeAnswer(text, comparison, [27, 2])).toBe(text);
  });
  it('rejects $60 and a false $300 difference even though setup costs $300', () => {
    expect(safeAnswer('The plan spends each $60.', comparison, [27, 2])).toBeUndefined();
    expect(safeAnswer('Ward 27 gets $300 more than Ward 2.', comparison, [27, 2])).toBeUndefined();
    expect(safeAnswer('The dollar difference is $200.', comparison, [27, 2])).toBeDefined();
  });
  it('lists exact fact values with money formatting and no rounded copies', () => {
    const line = factsPrompt(comparison).split('\n').at(-1)!;
    expect(line).toContain('Numbers you may use: ');
    expect(line).toContain('$8,000'); expect(line).toContain('$50'); expect(line).toContain('$300'); expect(line).toContain('$100');
    expect(line).toContain('$200'); expect(line).toContain('1.14');
    const tokens = line.slice('Numbers you may use: '.length).split(', ');
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(tokens).not.toContain('17');
  });
});

describe('one checked retry', () => {
  it('reserves twice, logs only rejection fields, and returns the valid retry live', async () => {
    const d = deps({});
    const run = vi.fn().mockResolvedValueOnce({ response: 'Ward 1 gets $999999.' }).mockResolvedValueOnce({ response: 'Ward 1 has non voters.' });
    d.ai.run = run;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await ask(question, d)).toEqual({ source: 'live', text: 'Ward 1 has non voters.' });
    expect(d.ledger.reserve).toHaveBeenCalledTimes(2); expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][1].messages.at(-1).content).toBe('Your answer used numbers that are not in the facts: Ward 1 $999999, 999999. Answer again using only the numbers listed.');
    const receipt = JSON.parse(log.mock.calls[0][0]);
    expect(receipt).toEqual({ event: 'ai_reject', key: '["why",1,2,5000]', attempt: 1, bad: ['Ward 1 $999999', '999999'], text: 'Ward 1 gets $999999.' });
    expect(receipt).not.toHaveProperty('sid');
    expect((await ask(question, d)).source).toBe('cache');
    expect(d.ledger.reserve).toHaveBeenCalledTimes(2);
  });
  it.each(['recorded', 'rules'])('returns %s after exactly two rejected calls', async source => {
    const d = deps({ response: 'Ward 1 gets $999999.' });
    if (source === 'recorded') d.recorded = [{ key: '["why",1,2,5000]', text: 'Ward 1 has non voters.', date: '2026-11-08' }];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await ask(question, d)).source).toBe(source);
    expect(d.ledger.reserve).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.map(call => JSON.parse(call[0]).attempt)).toEqual([1, 2]);
  });
  it('stops when the retry reservation is denied', async () => {
    const d = deps({ response: 'Ward 1 gets $999999.' });
    d.ledger.reserve.mockResolvedValueOnce(1).mockResolvedValueOnce(null);
    d.ai.run = vi.fn(d.ai.run);
    expect((await ask(question, d)).reason).toBe('cap_or_ledger_unavailable');
    expect(d.ai.run).toHaveBeenCalledTimes(1);
  });
});

describe('more and plan asks', () => {
  const realWards = city.wards;
  it.each(['more', 'plan'] as const)('validates, answers and caches %s with the real model facts', async kind => {
    const input = kind === 'more' ? { kind, ward: 21, amount: 500 as const, budget: 5000 } : { kind, budget: 5000 };
    const plan = allocate(5000, 'y2023', realWards);
    const facts = kind === 'more' ? explainMore(21, 500, plan, 'y2023', realWards) : explainPlan(plan, 5000, 'y2023', realWards);
    const text = facts.kind === 'more' ? templateMore(facts) : templatePlan(facts);
    const d = deps({ response: text }); d.wards = realWards; d.ai.run = vi.fn(d.ai.run);
    expect(parseAsk(input, realWards)).toEqual(input);
    expect(answerKey(input)).toBe(kind === 'more' ? '["more",21,500,5000]' : '["plan",5000]');
    expect(await ask(input, d)).toEqual({ source: 'live', text });
    expect(await ask(input, d)).toEqual({ source: 'cache', text });
    expect(d.ai.run).toHaveBeenCalledTimes(1);
    expect(factsPrompt(facts)).toContain(kind === 'more' ? 'Question: What would $500 more buy in Ward 21?' : 'Question: Where does a $5,000 field budget go, in one or two sentences?');
  });
  it('allows every funded ward in a plan answer and rejects unfunded wards', async () => {
    const d = deps({ response: 'Wards 2, 9, 21 and 27 get money.' }); d.wards = realWards;
    expect((await ask({ kind: 'plan', budget: 5000 }, d)).source).toBe('live');
    const other = deps({ response: 'Ward 42 gets money.' }); other.wards = realWards;
    expect((await ask({ kind: 'plan', budget: 5000 }, other)).source).toBe('rules');
  });
  it('uses rules for both new kinds when live AI is off', async () => {
    const d = deps({}); d.wards = realWards; d.live = false;
    expect((await ask({ kind: 'more', ward: 21, amount: 500, budget: 5000 }, d)).text).toContain('Adding $500 to Ward 21');
    expect((await ask({ kind: 'plan', budget: 5000 }, d)).text).toContain('At $5,000 the plan funds 4 wards');
    expect(d.ledger.reserve).not.toHaveBeenCalled();
  });
  it('accepts the full budget range and rejects invalid new asks', () => {
    for (const budget of [1000, 5000, 10050, 25000]) expect(parseAsk({ kind: 'plan', budget }, realWards)).toEqual({ kind: 'plan', budget });
    for (const budget of [950, 25050, 1001]) expect(() => parseAsk({ kind: 'plan', budget }, realWards)).toThrow('Budget must be $1,000 to $25,000 in $50 steps.');
    for (const input of [{ kind: 'more', ward: 99, amount: 500, budget: 5000 }, { kind: 'more', ward: 21, amount: 50, budget: 5000 }, { kind: 'plan', ward: 21, budget: 5000 }]) expect(() => parseAsk(input, realWards)).toThrow();
  });
});


describe('J7b semantic answer checks', () => {
  const wards = city.wards;
  it('rejects setup and step dollars paired with funded wards in the reported plan answer', async () => {
    const facts = explainPlan(allocate(3550, 'y2023', wards), 3550, 'y2023', wards);
    const wrong = 'The $3,550 field budget is divided among 3 wards: Ward 21 ($1,300), Ward 27 ($300), and Ward 2 ($50).';
    expect(safeAnswer(wrong, facts, facts.fundedWards)).toBeUndefined();
    expect(checkAnswer(wrong, facts, facts.fundedWards).bad).toEqual(['Ward 27 $300', 'Ward 2 $50', '300', '50']);
    const d = deps({ response: wrong }); d.wards = wards;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await ask({ kind: 'plan', budget: 3550 }, d)).source).toBe('rules');
    expect(JSON.parse(log.mock.calls[0][0]).bad).toEqual(['Ward 27 $300', 'Ward 2 $50', '300', '50']);
  });
  it('accepts a funded ward allocation and the source ward dollars after a move', () => {
    const facts = explainPlan(allocate(5000, 'y2023', wards), 5000, 'y2023', wards);
    expect(safeAnswer('Ward 21 ($1,350).', facts, facts.fundedWards)).toBeDefined();
    const moved = moves.allocateWithMove(5000, 'y2023', wards, 21, 27, 500).facts;
    expect(moved.fromDollars).toBe(850);
    expect(safeAnswer('Ward 21 has $850.', moved, [21, 27])).toBeDefined();
  });
  it.each([
    [2, 21, 12000, 'Ward 2 has a slightly lower cost per contact ($2.58 vs $2.3).'],
    [27, 2, 8000, 'Ward 27 has a higher cost per contact ($2.55 vs $2.3), making it more effective.'],
  ] as const)('rejects the reported false cost comparison for Ward %i versus %i', (a, b, budget, text) => {
    expect(safeAnswer(text, compareWards(a, b, allocate(budget, 'y2023', wards), 'y2023', wards), [a, b])).toBeUndefined();
  });
  it('checks comparison direction separately from valid numbers and money pairings', () => {
    const facts = compareWards(27, 2, allocate(8000, 'y2023', wards), 'y2023', wards);
    expect(safeAnswer('Ward 27 has a higher cost per contact.', facts, [27, 2])).toBeDefined();
    expect(safeAnswer('Ward 21 has a slightly lower cost per contact.', compareWards(2, 21, allocate(12000, 'y2023', wards), 'y2023', wards), [2, 21])).toBeUndefined();
    expect(safeAnswer('Ward 27 has a larger non voter pool (27,056 vs 19,888).', facts, [27, 2])).toBeDefined();
    expect(safeAnswer('Ward 2 has a lower cost per contact ($2.30).', facts, [27, 2])).toBeDefined();
    expect(safeAnswer('Ward 2 has more non voters.', facts, [27, 2])).toBeUndefined();
    expect(safeAnswer('Ward 2 has fewer non voters.', facts, [27, 2])).toBeDefined();
    expect(safeAnswer('Ward 27 has lower votes per $100.', facts, [27, 2])).toBeUndefined();
    expect(safeAnswer('Ward 27 has more votes per $100.', facts, [27, 2])).toBeDefined();
    expect(safeAnswer('Ward 27 is funded because its smaller non voter pool helps.', facts, [27, 2])).toBeUndefined();
    expect(safeAnswer('Ward 27 gets money alongside Ward 2 because its smaller non voter pool helps.', facts, [27, 2])).toBeUndefined();
    expect(safeAnswer('Ward 27 gets money alongside Ward 2 because its larger non voter pool helps.', facts, [27, 2])).toBeDefined();
    expect(safeAnswer('Ward 27 gets money alongside Ward 2 with fewer non voters.', facts, [27, 2])).toBeDefined();
    expect(safeAnswer('A lower cost per contact helps.', facts, [27, 2])).toBeDefined();
  });
  it('states the computed comparisons and two decimal contact costs in the why prompt', () => {
    const facts = compareWards(2, 21, allocate(12000, 'y2023', wards), 'y2023', wards);
    const prompt = factsPrompt(facts);
    expect(prompt).toContain('Larger non voter pool: Ward 21 (29,263 vs 19,888).');
    expect(prompt).toContain('Cost per contact: Ward 21 $2.58, Ward 2 $2.30. Ward 21 costs more per contact; its other facts outweigh that.');
    expect(prompt).toContain('costs more per contact');
    expect(prompt).toContain(`More votes per $100: Ward ${facts.a.votesPer100 > facts.b.votesPer100 ? 2 : 21}`);
    expect(prompt.split('Numbers you may use: ')[1]).toContain('$2.30');
    expect(prompt.indexOf('Cost per contact:')).toBeLessThan(prompt.indexOf('Answer in'));
  });
  it('lists each funded ward allocation and votes in plan order without a step line', () => {
    const facts = explainPlan(allocate(5000, 'y2023', wards), 5000, 'y2023', wards);
    const prompt = factsPrompt(facts);
    expect(prompt).toContain('Ward 21: $1,350 for 16.3 expected new votes');
    let previous = -1;
    for (const ward of facts.wards) {
      const index = prompt.indexOf(`Ward ${ward.ward}:`);
      expect(index).toBeGreaterThan(previous); previous = index;
    }
    expect(prompt).not.toContain('Step:');
    expect(prompt.split('Numbers you may use: ')[1]).not.toContain('$50');
  });
  it('explains setup and contact dollars for an unfunded ward without a votes per $100 line', () => {
    const facts = explainMore(42, 500, allocate(5000, 'y2023', wards), 'y2023', wards);
    const prompt = factsPrompt(facts);
    expect(prompt).toContain('Ward 42 has no money in the plan yet. The first $300 covers its setup, so $500 buys $200 of contacts.');
    expect(prompt).not.toContain('Votes per $100:');
    expect(safeAnswer('This is because the votes per $100 is 0, meaning the initial budget of $0 does not convert to votes.', facts, [42])).toBeUndefined();
    expect(prompt.split('Numbers you may use: ')[1]).toContain('$200');
    expect(safeAnswer('The first $300 covers setup, so $500 buys $200 of contacts.', facts, [42])).toBeDefined();
    expect(factsPrompt(explainMore(21, 500, allocate(5000, 'y2023', wards), 'y2023', wards))).toContain('for this $500');
  });
  it('more prompt for Ward 21 at $5,000 holds for this $500 and not the average rate, and answer passes', () => {
    const facts = explainMore(21, 500, allocate(5000, 'y2023', wards), 'y2023', wards);
    const prompt = factsPrompt(facts);
    expect(prompt).toContain('for this $500');
    expect(prompt).not.toContain(`Votes per $100: ${facts.votesPer100}`);
    const answer = '$500 in Ward 21 adds 5.5 expected new votes, about 1.1 per $100.';
    expect(checkAnswer(answer, facts, [21]).ok).toBe(true);
  });
  it('why prompt for 21 vs 2 at $12,000 holds costs more per contact', () => {
    const facts = compareWards(21, 2, allocate(12000, 'y2023', wards), 'y2023', wards);
    const prompt = factsPrompt(facts);
    expect(prompt).toContain('costs more per contact');
  });
  it('rejects rounding a 0.3 return to zero when zero is not another fact', () => {
    const facts = { ...why, a: { ...why.a, votesPer100: 0.3 }, b: { ...why.b, dollars: 350, votes: 4.2 } };
    expect(safeAnswer('The votes per $100 is 0.', facts, [21, 1])).toBeUndefined();
    expect(safeAnswer('The votes per $100 is 0.3.', facts, [21, 1])).toBeDefined();
  });
});

describe('payroll summary AI ask', () => {
  it('payroll facts and template on a fixture', () => {
    const fixture = [
      { id: 'log-1', ward: 21, payee: 'crew-north', units: 120, cents: 3000 },
      { id: 'log-2', ward: 2, payee: 'print-shop', units: 100, cents: 1000 },
      { id: 'log-3', ward: 9, payee: 'crew-unclaimed', units: 120, cents: 3000 },
    ];
    const facts = explainPayroll(fixture);
    expect(facts).toEqual({
      kind: 'payroll',
      count: 3,
      total: 70,
      checksPassed: 3,
      items: [
        { ward: 21, payee: 'North Side door crew', units: 120, unit: 'doors', dollars: 30 },
        { ward: 2, payee: 'Ward print shop', units: 100, unit: 'flyers', dollars: 10 },
        { ward: 9, payee: 'New crew, no PayPal account yet', units: 120, unit: 'doors', dollars: 30 },
      ],
    });
    const text = templatePayroll(facts);
    expect(text).toBe(
      '3 checked work logs are ready: $30 to North Side door crew for 120 doors in Ward 21, $10 to Ward print shop for 100 flyers in Ward 2, $30 to New crew, no PayPal account yet for 120 doors in Ward 9. Total $70.'
    );
  });

  it('parseAsk({kind:"payroll", x:1}) is refused', () => {
    expect(() => parseAsk({ kind: 'payroll', x: 1 }, city.wards)).toThrow('Unexpected field. Amounts and recipients are set by server rules.');
    expect(parseAsk({ kind: 'payroll' }, city.wards)).toEqual({ kind: 'payroll' });
  });
});
