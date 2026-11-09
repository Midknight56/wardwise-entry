import { vi } from 'vitest';
const modelMocks = vi.hoisted(() => {
  const ward = (id: number, dollars: number) => ({ ward: id, dollars, votes: 2, nonVoters: 4000, costPerContact: 2, votesPer100: 1, turnout: 33, shareGap: 20 });
  const facts = { kind: 'why' as const, a: ward(1, 100), b: ward(2, 0), setupCost: 300, step: 50, budget: 5000, returnDollars: 100, dollarsGap: 100, votesGap: 0, nonVotersGap: 0 };
  return {
    allocate: vi.fn(() => ({ perWard: { 1: 1000, 2: 0, 3: 0 }, votes: {}, total: 2 })),
    compareWards: vi.fn(() => facts),
    templateWhy: vi.fn(() => 'Ward 1 gets $100. Explained by rules.'),
    templateMove: vi.fn(() => 'Moving $50 changes the plan. Explained by rules.'),
    explainPayroll: vi.fn((items: any[] = []) => ({ kind: 'payroll' as const, count: items.length, total: 70, items: [], checksPassed: items.length })),
    templatePayroll: vi.fn(() => '3 checked work logs are ready. Total $70. Explained by rules.'),
    factNumbers: vi.fn(() => ['1', '2', '100', '0']),
    directionOk: vi.fn((text: string, facts: { kind?: string; change?: number }) => facts.kind !== 'move' || !(facts.change! < 0 ? /\b(gain|gains|gained|increase|increases|increased|adds|raises|more votes)\b/i.test(text) : facts.change! > 0 && /\b(lose|loses|lost|loss|decrease|decreases|decreased|fewer|drops|reduces)\b/i.test(text))),
    checkAnswer: vi.fn((_answer: string, _facts: unknown, _wards: readonly number[]) => ({ ok: true, bad: [] as string[] })),
    allocateWithMove: vi.fn((_budget: number, _base: string, _wards: unknown, from: number, to: number, amount: number) => ({ plan: { perWard: {}, votes: {}, total: 1 }, change: -1, facts: { kind: 'move' as const, from, to, amount, fromDollars: 950, toDollars: 50, votesBefore: 2, votesAfter: 1, change: -1 } })),
  };
});
vi.mock('../../src/model/allocate', () => ({ allocate: modelMocks.allocate }));
vi.mock('../../src/model/explain', () => ({ compareWards: modelMocks.compareWards, templateWhy: modelMocks.templateWhy, templateMove: modelMocks.templateMove, explainPayroll: modelMocks.explainPayroll, templatePayroll: modelMocks.templatePayroll, factNumbers: modelMocks.factNumbers, directionOk: modelMocks.directionOk, checkAnswer: modelMocks.checkAnswer }));
vi.mock('../../src/model/forceMove', () => ({ allocateWithMove: modelMocks.allocateWithMove }));
export { modelMocks };
