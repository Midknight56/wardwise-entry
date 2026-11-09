import { beforeEach, describe, expect, it, vi } from 'vitest';
import { modelMocks } from './helpers/model';
import { wards } from './helpers/city';
import { world } from './helpers/world';
import { ask, answerKey, factsPrompt, safeAnswer, SYSTEM, type AskDependencies } from '../src/server/ai/ask';
import { explainPayroll, type PayrollFacts } from '../src/model/explain';
import { MODEL_ID, DEPRECATED_MODELS, MAX_NEURONS, estimateTokens, neurons } from '../src/server/ai/model';
import { NeuronLedger, RESERVE } from '../src/server/ai/ledger';
import { memoryLedger } from './helpers/ledger';
const question = { kind: 'why' as const, a: 1, b: 2, budget: 5000 };
function dependencies(): AskDependencies & { ledger: { reserve: ReturnType<typeof vi.fn>; settle: ReturnType<typeof vi.fn> }; ai: { run: ReturnType<typeof vi.fn> } } {
  return { wards, gate: world().gate, ledger: { reserve: vi.fn(async () => 1), settle: vi.fn(async () => {}) }, ai: { run: vi.fn(async () => ({ response: 'Ward 1 gets $100.' })) }, live: true, timeoutMs: 10 };
}
beforeEach(() => { vi.clearAllMocks(); modelMocks.checkAnswer.mockReturnValue({ ok: true, bad: [] }); });
describe('bounded AI explanations', () => {
  it('uses only the fixed current model and excludes deprecated models', () => {
    expect(MODEL_ID).toBe('@cf/ibm-granite/granite-4.0-h-micro'); expect(DEPRECATED_MODELS).not.toContain(MODEL_ID);
    expect(DEPRECATED_MODELS).toEqual(['@cf/meta/llama-3.2-3b-instruct', '@cf/qwen/qwen3-30b-a3b-fp8']);
    expect(MAX_NEURONS).toBeCloseTo(6.08976); expect(MAX_NEURONS).toBeLessThan(RESERVE); expect(estimateTokens('12345678')).toBe(3);
  });
  it('reserves before live call, uses bounded prompt, then caches a checked answer', async () => {
    const deps = dependencies(); const output = await ask(question, deps);
    expect(output.source).toBe('live'); expect(deps.ai.run).toHaveBeenCalledWith(MODEL_ID, { messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: expect.stringContaining('Question: Why does Ward') }], max_tokens: 220 });
    expect(deps.ledger.reserve.mock.invocationCallOrder[0]).toBeLessThan(deps.ai.run.mock.invocationCallOrder[0]);
    expect(modelMocks.checkAnswer).toHaveBeenCalledWith(output.text, modelMocks.compareWards.mock.results[0].value, [1, 2]);
    expect((await ask(question, deps)).source).toBe('cache'); expect(deps.ai.run).toHaveBeenCalledTimes(1);
    expect(deps.ledger.settle).not.toHaveBeenCalled();
  });
  it('settles only real usage', async () => {
    const deps = dependencies(); deps.ai.run.mockResolvedValue({ response: 'Ward 1 gets $100.', usage: { prompt_tokens: 100, completion_tokens: 20 } });
    await ask(question, deps); expect(deps.ledger.settle).toHaveBeenCalledWith(1, neurons(100, 20));
  });
  it.each(['cap', 'ledger_down'])('%s returns rules without any AI call', async reason => {
    const deps = dependencies(); if (reason === 'cap') deps.ledger.reserve.mockResolvedValue(null); else deps.ledger.reserve.mockRejectedValue(new Error('down'));
    expect((await ask(question, deps)).source).toBe('rules'); expect(deps.ai.run).not.toHaveBeenCalled();
  });
  it('uses a matching checked recording when the live cap is reached', async () => {
    const deps = dependencies(); deps.ledger.reserve.mockResolvedValue(null);
    deps.recorded = [{ key: answerKey(question), text: 'Ward 1 gets $100.', date: '2026-11-06' }];
    expect(await ask(question, deps)).toMatchObject({ source: 'recorded', reason: 'Recorded answer, 2026-11-06' });
    expect(deps.ai.run).not.toHaveBeenCalled();
  });
  it('keeps the cap fallback reason when there is no recording', async () => {
    const deps = dependencies(); deps.ledger.reserve.mockResolvedValue(null);
    expect(await ask(question, deps)).toMatchObject({ source: 'rules', reason: 'cap_or_ledger_unavailable' });
  });
  it('timeout returns rules and keeps reservation', async () => {
    const deps = dependencies(); deps.ai.run.mockImplementation(() => new Promise(() => {}));
    const output = await ask(question, deps); expect(output).toMatchObject({ source: 'rules', reason: 'timeout' }); expect(deps.ledger.settle).not.toHaveBeenCalled();
  });
  it('failed number or ward check returns template', async () => {
    const deps = dependencies(); deps.ai.run.mockResolvedValue({ response: 'Ward 99 gets $99999.' }); modelMocks.checkAnswer.mockReturnValue({ ok: false, bad: ['99', '99999'] });
    expect((await ask(question, deps)).reason).toBe('answer_check');
  });
  it.each(['One. Two. Three. Four.', 'Ward 1 — a funded ward.', 'Ward 1 - a funded ward.', ''])('rejects bad style or empty output %#', async response => {
    const deps = dependencies(); deps.ai.run.mockResolvedValue({ response }); expect((await ask(question, deps)).source).toBe('rules');
  });
  it('AI error returns rules', async () => {
    const deps = dependencies(); deps.ai.run.mockRejectedValue(new Error('unavailable')); expect((await ask(question, deps)).source).toBe('rules');
  });
  it('oversized facts stop before reserving', async () => {
    const deps = dependencies(); modelMocks.compareWards.mockReturnValueOnce({ ...modelMocks.compareWards(), a: { ...modelMocks.compareWards().a, nonVoters: 'x'.repeat(10000) as unknown as number } } as ReturnType<typeof modelMocks.compareWards>);
    expect((await ask(question, deps)).reason).toBe('input_limit'); expect(deps.ledger.reserve).not.toHaveBeenCalled();
  });
  it('live off uses a matching checked recorded answer with date', async () => {
    const deps = dependencies(); deps.live = false; deps.recorded = [{ key: answerKey(question), text: 'Ward 1 gets $100.', date: '2026-11-06' }];
    expect(await ask(question, deps)).toMatchObject({ source: 'recorded', reason: 'Recorded answer, 2026-11-06' }); expect(deps.ai.run).not.toHaveBeenCalled();
  });
  it('live off without matching recording uses rules', async () => {
    const deps = dependencies(); deps.live = false; expect((await ask(question, deps)).source).toBe('rules'); expect(deps.ledger.reserve).not.toHaveBeenCalled();
  });
  it('move uses forced allocation facts and a key including amount', async () => {
    const deps = dependencies(), move = { kind: 'move' as const, from: 1, to: 2, amount: 50, budget: 5000 };
    await ask(move, deps); expect(modelMocks.allocateWithMove).toHaveBeenCalledWith(5000, 'y2023', wards, 1, 2, 50);
    expect(modelMocks.checkAnswer.mock.calls.at(-1)?.[1]).toMatchObject({ kind: 'move', amount: 50 });
    expect(answerKey(move)).not.toBe(answerKey({ ...move, amount: 100 }));
  });
  it.each([{ ...question, extra: 1 }, { ...question, budget: 10001 }, { ...question, a: 99 }, { ...question, b: 1 }, { kind: 'move', from: 1, to: 2, amount: 1500, budget: 5000 }])('rejects invalid questions %# before ledger', async input => {
    const deps = dependencies(); await expect(ask(input, deps)).rejects.toMatchObject({ status: 400 }); expect(deps.ledger.reserve).not.toHaveBeenCalled();
  });
  it('for payroll facts from explainPayroll, safeAnswer rejects unsupported assurance words while a plain correct answer passes', () => {
    const facts = explainPayroll([{ ward: 1, payee: 'crew-north', units: 100, cents: 2500 }]);
    const ids = [1];
    expect(safeAnswer('All work has been independently verified.', facts, ids)).toBeUndefined();
    expect(safeAnswer('Ward 1 gets $100.', facts, ids)).toBe('Ward 1 gets $100.');
  });
  const twoCrews = (): PayrollFacts => ({ kind: 'payroll', count: 2, total: 40, checksPassed: 2, items: [
    { ward: 21, payee: 'North Side door crew', units: 120, unit: 'doors', dollars: 30 },
    { ward: 21, payee: 'New crew, no PayPal account yet', units: 40, unit: 'doors', dollars: 10 },
  ] });
  it('rejects a payroll summary that says money was paid before a person approves the batch', () => {
    const facts = twoCrews();
    const reviewerSaw = '$30 was paid to North Side door crew for 120 doors at Ward 21. $10 was paid to a new crew for 40 doors at Ward 21. Total payroll is $40.';
    expect(safeAnswer(reviewerSaw, facts, [21])).toBeUndefined();
    expect(safeAnswer('Ward 21 has $30 paid to North Side door crew and $10 to a new crew. Total $40.', facts, [21])).toBeUndefined();
    expect(safeAnswer('The batch sent $10 to a new crew in Ward 21. Total $40.', facts, [21])).toBeUndefined();
    expect(safeAnswer('North Side door crew received $30 in Ward 21. Total $40.', facts, [21])).toBeUndefined();
    expect(safeAnswer('PayPal transferred $30 in Ward 21. Total $40.', facts, [21])).toBeUndefined();
  });
  it('accepts a payroll summary that says the batch would pay', () => {
    const facts = twoCrews();
    const proposal = 'This batch would pay $30 to North Side door crew for 120 doors in Ward 21 and $10 to New crew, no PayPal account yet for 40 doors in Ward 21. Total $40.';
    expect(safeAnswer(proposal, facts, [21])).toBe(proposal);
  });
  it('rejects a payroll summary that gives a payee an amount that is not theirs', () => {
    const facts = twoCrews();
    // seen from the real model: $40 is the batch total, the North Side crew gets $30
    expect(safeAnswer('Batch proposes $40 for North Side door crew and $10 for New crew.', facts, [21])).toBeUndefined();
    expect(safeAnswer('This batch would pay $10 to North Side door crew and $30 to the new crew.', facts, [21])).toBeUndefined();
    // also seen from the real model: a list of amounts given to one payee
    expect(safeAnswer('The proposed payroll batch would pay $10, $30 to North Side door crew for 40, 120 doors.', facts, [21])).toBeUndefined();
    expect(safeAnswer('Batch proposes $40 total. Includes $30 for North Side doors and $10 for New crew.', facts, [21]))
      .toBe('Batch proposes $40 total. Includes $30 for North Side doors and $10 for New crew.');
    expect(safeAnswer('New crew\'s $10 is waiting for approval. Total $40.', facts, [21])).toBe('New crew\'s $10 is waiting for approval. Total $40.');
    expect(safeAnswer('The batch proposes $40 in all. It would pay $30 to the door crew and $10 to the new crew.', facts, [21]))
      .toBe('The batch proposes $40 in all. It would pay $30 to the door crew and $10 to the new crew.');
  });
  it('tells the model the payroll batch is only proposed', () => {
    const prompt = factsPrompt(twoCrews());
    expect(prompt).toContain('Nothing has been paid yet');
    // the checker pairs a ward with each amount, so the batch total must stand alone
    expect(prompt).toContain('Batch total for all wards together: $40');
    expect(prompt).toContain('Never name a ward in the same sentence as the batch total.');
    expect(prompt).toContain('Ward 21: would pay $30 to North Side door crew for 120 doors');
    expect(prompt).not.toMatch(/: \$30 to North Side/);
  });
  const previewDeps = () => {
    const deps = dependencies();
    deps.readyWorklogs = async () => ({ version: 'w1,w2:4000', items: [
      { id: 'w1', ward: 21, payee: 'crew-north', units: 120, cents: 3000 },
      { id: 'w2', ward: 21, payee: 'crew-unclaimed', units: 40, cents: 1000 },
    ] });
    return deps;
  };
  it('a live payroll answer carries the version of the preview it describes', async () => {
    const deps = previewDeps();
    deps.ai.run.mockResolvedValue({ response: 'This batch would pay $30 in Ward 21. Total $40.' });
    const answer = await ask({ kind: 'payroll' }, deps);
    expect(answer.source).toBe('live');
    expect(answer.previewVersion).toBe('w1,w2:4000');
    const again = await ask({ kind: 'payroll' }, deps);
    expect(again.source).toBe('cache');
    expect(again.previewVersion).toBe('w1,w2:4000');
  });
  it('a rules payroll answer carries the preview version too', async () => {
    const deps = previewDeps(); deps.live = false;
    const answer = await ask({ kind: 'payroll' }, deps);
    expect(answer.source).toBe('rules');
    expect(answer.previewVersion).toBe('w1,w2:4000');
  });
  it('the old array form of ready work logs still works, with no version', async () => {
    const deps = dependencies(); deps.live = false;
    deps.readyWorklogs = [{ id: 'w1', ward: 21, payee: 'crew-north', units: 120, cents: 3000 }];
    const answer = await ask({ kind: 'payroll' }, deps);
    expect(answer.source).toBe('rules');
    expect(answer.previewVersion).toBeUndefined();
  });
});
describe('shared atomic neuron ledger', () => {
  it('concurrent SQL reservations stop at 896 held neurons under the app cap', async () => {
    const { database, sql } = memoryLedger();
    try {
      const ledger = new NeuronLedger(database, () => Date.parse('2026-11-06T12:00Z'));
      const results = await Promise.all(Array.from({ length: 120 }, () => ledger.reserve()));
      expect(results.filter(id => id !== null)).toHaveLength(112);
      expect(sql.prepare('SELECT SUM(neurons) AS total FROM ai_calls').get()?.total).toBe(896);
    } finally { sql.close(); }
  });
  it('other apps share the account ceiling; actual usage settlement is durable', async () => {
    const { database, sql } = memoryLedger();
    try {
      sql.prepare('INSERT INTO ai_calls (app,day,neurons) VALUES (?,?,?)').run('other', '2026-11-06', 9490);
      const ledger = new NeuronLedger(database, () => Date.parse('2026-11-06T12:00Z'));
      const id = await ledger.reserve(); expect(id).not.toBeNull(); expect(await ledger.reserve()).toBeNull();
      await ledger.settle(id!, 1); expect(await ledger.reserve()).not.toBeNull(); expect(await ledger.reserve()).toBeNull();
      expect(sql.prepare('SELECT SUM(neurons) AS total FROM ai_calls').get()?.total).toBe(9499);
    } finally { sql.close(); }
  });
  function db(first: () => Promise<unknown>) {
    const statement = { bind: vi.fn(), first: vi.fn(first), run: vi.fn(async () => ({})) };
    statement.bind.mockReturnValue(statement);
    const database = { prepare: vi.fn((_sql: string) => statement) };
    return { database: database as unknown as D1Database, prepare: database.prepare, ...statement };
  }
  it('reserves with one conditional INSERT using the existing shared schema', async () => {
    const database = db(async () => ({ id: 7 })); const ledger = new NeuronLedger(database.database, () => Date.parse('2026-11-06T00:00Z'));
    expect(await ledger.reserve()).toBe(7); expect(database.prepare).toHaveBeenCalledTimes(1);
    expect(database.prepare.mock.calls[0][0]).toMatch(/INSERT INTO ai_calls \(app,day,neurons\) SELECT/);
    expect(database.prepare.mock.calls[0][0]).toContain('AND (SELECT COALESCE(SUM(neurons),0)');
    expect(database.bind).toHaveBeenCalledWith('wardwise', '2026-11-06', 8, 'wardwise', '2026-11-06', 8, 900, '2026-11-06', 8, 9500);
  });
  it.each(['full', 'down'])('fails closed when %s', async state => {
    const database = db(async () => { if (state === 'down') throw new Error('down'); return null; });
    expect(await new NeuronLedger(database.database).reserve()).toBeNull();
  });
  it('settles actual neurons, keeps uncertain usage and settlement errors held', async () => {
    const database = db(async () => null); const ledger = new NeuronLedger(database.database);
    await ledger.settle(7); await ledger.settle(7, NaN); await ledger.settle(7, -1); expect(database.prepare).not.toHaveBeenCalled();
    await ledger.settle(7, 1.2); expect(database.bind).toHaveBeenCalledWith(1.2, 7, 'wardwise');
    database.run.mockRejectedValueOnce(new Error('down')); await expect(ledger.settle(7, 1)).resolves.toBeUndefined();
  });
});

it('logs caught AI failures with the route and error name while returning rules', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {}), deps = dependencies();
  try {
    deps.ai.run.mockRejectedValue(new TypeError('Model unavailable'));
    expect((await ask(question, deps)).source).toBe('rules');
    expect(log).toHaveBeenCalledWith('ai', '/api/ask', 'TypeError', 'Model unavailable');
  } finally { log.mockRestore(); }
});
