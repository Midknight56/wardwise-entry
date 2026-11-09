import { logFailure } from '../logging';
import { allocate } from '../../model/allocate';
import { compareWards, explainMore, explainPlan, explainPayroll, templateWhy, templateMove, templateMore, templatePlan, templatePayroll, checkAnswer, factNumbers, directionOk, type Facts, type WhyFacts, type PayrollFacts } from '../../model/explain';
import { BUDGET_MIN, BUDGET_MAX, STEP } from '../../model/assumptions';
import { allocateWithMove } from '../../model/forceMove';
import type { Ward } from '../../model/types';
import { AI_TIMEOUT_MS, INPUT_TOKEN_CAP, OUTPUT_TOKEN_CAP } from '../caps';
import { fields, requireRule } from '../errors';
import type { GatePort } from '../gate/engine';
import { MODEL_ID, estimateTokens, neurons } from './model';

export interface Answer { text: string; source: 'live' | 'cache' | 'rules' | 'recorded'; reason?: string; previewVersion?: string }
export type ReadyWorklogs = unknown[] | { version: string; items: unknown[] };
export type AskInput = { kind: 'why'; a: number; b: number; budget: number } | { kind: 'move'; from: number; to: number; amount: number; budget: number }
  | { kind: 'more'; ward: number; amount: 500; budget: number } | { kind: 'plan'; budget: number } | { kind: 'payroll' };
export interface RecordedAnswer { key: string; text: string; date: string }
export interface AskDependencies {
  wards: Ward[]; gate: GatePort; ledger: { reserve(): Promise<number | null>; settle(id: number, actual?: number): Promise<void> };
  ai: { run(model: string, input: { messages: { role: string; content: string }[]; max_tokens: number }): Promise<unknown> };
  live: boolean; recorded?: RecordedAnswer[]; timeoutMs?: number;
  readyWorklogs?: (() => Promise<ReadyWorklogs | undefined> | ReadyWorklogs | undefined) | ReadyWorklogs;
}
export const SYSTEM = 'You explain a budget plan for a fictional citywide campaign. Use only the numbers in FACTS. At most 3 short sentences. Plain words. No dashes. Never invent a number, a ward, a person or an amount.';
export function parseAsk(input: unknown, wards: Ward[]): AskInput {
  const raw = fields(input, ['kind', 'a', 'b', 'budget', 'from', 'to', 'amount', 'ward']);
  requireRule(raw.kind === 'why' || raw.kind === 'move' || raw.kind === 'more' || raw.kind === 'plan' || raw.kind === 'payroll', 'Ask kind must be why, move, more, plan or payroll.');
  if (raw.kind === 'payroll') {
    fields(input, ['kind']);
    return { kind: 'payroll' };
  }
  const keys = { why: ['a', 'b'], move: ['from', 'to', 'amount'], more: ['ward', 'amount'], plan: [], payroll: [] };
  const b = fields(input, ['kind', 'budget', ...keys[raw.kind as AskInput['kind']]]);
  requireRule(Number.isInteger(b.budget) && Number(b.budget) >= BUDGET_MIN && Number(b.budget) <= BUDGET_MAX && Number(b.budget) % STEP === 0, 'Budget must be $1,000 to $25,000 in $50 steps.');
  const ids = raw.kind === 'why' ? [b.a, b.b] : raw.kind === 'move' ? [b.from, b.to] : raw.kind === 'more' ? [b.ward] : [];
  requireRule(ids.every(id => Number.isInteger(id) && wards.some(w => w.id === id)) && (ids.length < 2 || ids[0] !== ids[1]), 'Choose valid city wards, different for a comparison or move.');
  if (raw.kind === 'move') requireRule(Number.isInteger(b.amount) && Number(b.amount) > 0 && Number(b.amount) % STEP === 0 && Number(b.amount) <= Number(b.budget), 'Move amount must be positive $50 steps within the budget.');
  if (raw.kind === 'more') requireRule(b.amount === 500, 'Additional amount must be $500.');
  return b as AskInput;
}
export function answerKey(input: AskInput, worklogIds: string[] = []) {
  switch (input.kind) {
    case 'why': return JSON.stringify(['why', input.a, input.b, input.budget]);
    case 'move': return JSON.stringify(['move', input.from, input.to, input.amount, input.budget]);
    case 'more': return JSON.stringify(['more', input.ward, input.amount, input.budget]);
    case 'plan': return JSON.stringify(['plan', input.budget]);
    case 'payroll': return JSON.stringify(['payroll', [...worklogIds].sort().join(',')]);
  }
}
function allowedNumbers(facts: Facts): string {
  const values = new Map<number, string>();
  const visit = (object: object) => {
    for (const [key, value] of Object.entries(object)) {
      if (facts.kind === 'plan' && /^(setupCost|step|returnDollars)$/.test(key)) continue;
      if (typeof value === 'number') {
        const monetary = /dollars|amount|budget|setupCost|step|returnDollars|costPerContact|total/i.test(key);
        if (!values.has(value) || monetary) values.set(value, `${monetary ? '$' : ''}${value.toLocaleString('en-US', { maximumFractionDigits: 20 })}`);
        if (value < 0 && !values.has(Math.abs(value))) values.set(Math.abs(value), String(Math.abs(value)));
      } else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(facts);
  if (facts.kind === 'more' && facts.dollarsNow === 0) {
    const contacts = Math.max(0, facts.amount - facts.setupCost);
    values.set(contacts, `$${contacts.toLocaleString('en-US')}`);
  }
  const spellings = [...values.values()];
  if (facts.kind === 'why') spellings.push(...[facts.a, facts.b].map(w => `$${w.costPerContact.toFixed(2)}`));
  return `Numbers you may use: ${[...new Set(spellings)].join(', ')}`;
}
export function factsPrompt(facts: Exclude<Facts, { kind: 'drop' }>): string {
  return `${questionPrompt(facts)}\n${allowedNumbers(facts)}`;
}
function questionPrompt(facts: Exclude<Facts, { kind: 'drop' }>): string {
  const money = (value: number) => '$' + value.toLocaleString('en-US', { maximumFractionDigits: 20 });
  if (facts.kind === 'payroll') {
    return `Question: Summarize this proposed payroll batch for the person who approves it, in 2 or 3 sentences.\nFacts:\nStatus: waiting for a person to approve. Nothing has been paid yet. PayPal decides each item after approval.\nChecked work logs ready: ${facts.count}\nChecks passed: ${facts.checksPassed}\nBatch total for all wards together: ${money(facts.total)}\nItems:\n${facts.items.map(it => `Ward ${it.ward}: would pay ${money(it.dollars)} to ${it.payee} for ${it.units} ${it.unit}`).join('\n')}\nAnswer in 2 or 3 sentences. Plain words. Use only the numbers above, written the same way.\nSay the batch would pay or proposes. Never say paid, sent, received or transferred.\nNever name a ward in the same sentence as the batch total.`;
  }
  if (facts.kind === 'more') {
    const rateLine = facts.dollarsNow === 0
      ? `Ward ${facts.ward} has no money in the plan yet. The first ${money(facts.setupCost)} covers its setup, so ${money(facts.amount)} buys ${money(Math.max(0, facts.amount - facts.setupCost))} of contacts.`
      : `Votes per $100 for this ${money(facts.amount)}: ${facts.ratePer100ForThis} (lower than the ward's average because returns fall)`;
    return `Question: What would ${money(facts.amount)} more buy in Ward ${facts.ward}?\nFacts:\nWard ${facts.ward}\nCurrent dollars: ${money(facts.dollarsNow)}\nDollars after: ${money(facts.dollarsAfter)}\nExpected new votes now: ${facts.votesNow}\nExpected new votes after: ${facts.votesAfter}\nExpected new votes added: ${facts.gain}\n${rateLine}\nDo not multiply any rate yourself; the votes added are given above.\nSetup cost: ${money(facts.setupCost)}\nBudget: ${money(facts.budget)}\nStep: ${money(facts.step)}\nAnswer in 2 or 3 short sentences. Say how many expected new votes it adds and why returns fall as a ward's easy voters run out.`;
  }
  if (facts.kind === 'plan') return `Question: Where does a ${money(facts.budget)} field budget go, in one or two sentences?\nFacts:\nBudget: ${money(facts.budget)}\nWards funded: ${facts.wardsFunded}\nFunded wards: \n${facts.wards.map(w => `Ward ${w.ward}: ${money(w.dollars)} for ${w.votes} expected new votes`).join('\n')}${facts.otherWards ? `\nOther wards: ${facts.otherWards} with ${money(facts.otherDollars!)}` : ''}\nDo not give a dollars per vote for one ward.\nExpected new votes: ${facts.votes}\nDollars per vote for the whole plan: ${money(facts.dollarsPerVote)}\nTop ward: Ward ${facts.topWard}\nTop ward dollars: ${money(facts.topWardDollars)}\nDo not explain setup costs or steps. Do not say how the other wards share their money.`;
  if (facts.kind === 'why') {
    const { a, b } = facts;
    const plan = (dollars: number) => dollars ? `${money(dollars)} in the plan` : 'no money in the plan';
    const ward = (w: WhyFacts['a']) => `Ward ${w.ward}: plan ${money(w.dollars)}; expected new votes ${w.votes}; non voters ${w.nonVoters}; cost per contact $${w.costPerContact.toFixed(2)}; votes per $100 ${w.votesPer100}.`;
    const comparison = (label: string, key: 'votesPer100' | 'nonVoters') => {
      const [winner, other] = a[key] > b[key] ? [a, b] : [b, a];
      const format = (w: WhyFacts['a']) => w[key].toLocaleString('en-US', { maximumFractionDigits: 20 });
      return a[key] === b[key] ? `Equal ${label.toLowerCase()}: Ward ${a.ward} and Ward ${b.ward} (${format(a)}).` : `${label}: Ward ${winner.ward} (${format(winner)} vs ${format(other)}).`;
    };
    const [winner, other] = a.votesPer100 >= b.votesPer100 ? [a, b] : [b, a];
    const costLine = a.costPerContact === b.costPerContact
      ? `Equal cost per contact: Ward ${a.ward} and Ward ${b.ward} ($${a.costPerContact.toFixed(2)}).`
      : winner.costPerContact < other.costPerContact
        ? `Cost per contact: Ward ${winner.ward} $${winner.costPerContact.toFixed(2)}, Ward ${other.ward} $${other.costPerContact.toFixed(2)}. Ward ${winner.ward} is cheaper per contact.`
        : `Cost per contact: Ward ${winner.ward} $${winner.costPerContact.toFixed(2)}, Ward ${other.ward} $${other.costPerContact.toFixed(2)}. Ward ${winner.ward} costs more per contact; its other facts outweigh that.`;
    return `Question: Why does Ward ${a.ward} get ${plan(a.dollars)} while Ward ${b.ward} gets ${plan(b.dollars)}?\nFacts:\n${ward(a)}\n${ward(b)}\nMain reason: ${facts.reason}\nDollar difference: ${money(facts.dollarsGap)}\nVote difference: ${facts.votesGap}\nNon voter difference: ${facts.nonVotersGap}\nEvery ward needs ${money(facts.setupCost)} of setup before its first door. For a ward with no money, votes per $100 already counts that setup.\nThe plan puts each $50 where it buys the most expected new votes.\n${comparison('More votes per $100', 'votesPer100')}\n${comparison('Larger non voter pool', 'nonVoters')}\n${costLine}\nAnswer in 2 or 3 short sentences. Say which ward returns more votes per $100, with both numbers, then the main reason in one sentence. Use only the numbers above, written the same way.\nGive the main reason in your own words. Never give a higher cost per contact as a reason to win.`;
  }
  const outcome = facts.change < 0 ? `, so the move loses ${Math.abs(facts.change)} expected new votes` : facts.change > 0 ? `, so the move gains ${Math.abs(facts.change)} expected new votes` : '';
  return `Question: What happens if ${money(facts.amount)} moves from Ward ${facts.from} to Ward ${facts.to}?\nFacts:\nThe whole citywide plan expects ${facts.votesBefore} new votes before the move and ${facts.votesAfter} after. Change: ${facts.change}${outcome}.\nThese vote totals are for the whole plan, not for one ward.\nAfter the move Ward ${facts.from} has ${money(facts.fromDollars)} and Ward ${facts.to} has ${money(facts.toDollars)}.\nThe plan puts each $50 where it buys the most expected new votes.\nAnswer in 2 or 3 short sentences. Say whether the move gains or loses votes. Use only the numbers above, written the same way.`;
}
const ASSURANCE_WORDS = [
  'independent', 'independently', 'verified', 'verify',
  'guarantee', 'guaranteed', 'guarantees',
  'audited', 'audit', 'certified',
  'compliant', 'compliance', 'legal', 'legally', 'approved',
] as const;

function hasUnsupportedAssurance(text: string, facts: Facts): boolean {
  const prompt = facts.kind !== 'drop' ? factsPrompt(facts) : '';
  for (const word of ASSURANCE_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, 'i');
    if (re.test(text) && !re.test(prompt)) return true;
  }
  return false;
}

// A payroll summary is written before a person approves the batch, so it must never say money moved.
const PAYMENT_DONE = /\b(?:(?:was|were|been|got|is|are)\s+paid|paid\s+(?:out|to)|sent|transferred|received|deposited)\b/i;
/**
 * In a payroll summary each dollar amount belongs to the payee named next after it in the same sentence (or, with
 * none after it, the last one named before it). That amount must be one of the payee's own items or their sum.
 */
function payeeAmountsMatch(text: string, facts: PayrollFacts): boolean {
  const amounts = new Map<string, Set<number>>();
  for (const it of facts.items) {
    const name = it.payee.split(',')[0].trim().toLowerCase();
    const set = amounts.get(name) ?? new Set<number>();
    set.add(it.dollars);
    amounts.set(name, set);
  }
  for (const set of amounts.values()) set.add(Math.round([...set].reduce((s, d) => s + d, 0) * 100) / 100);
  // Each payee is also known by its last two words ("door crew") and, unless it starts with "ward", its first two.
  const aliases = [...amounts.keys()].flatMap(name => {
    const words = name.split(/\s+/);
    const names = new Set([name, words.slice(-2).join(' ')]);
    if (words.length > 2 && words[0] !== 'ward') names.add(words.slice(0, 2).join(' '));
    return [...names].map(alias => ({ alias, name }));
  });
  for (const sentence of text.toLowerCase().split(/[.;!?](?:\s|$)/)) {
    const mentions = aliases.flatMap(({ alias, name }) => [...sentence.matchAll(new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'))]
      .map(m => ({ at: m.index!, name }))).sort((a, b) => a.at - b.at);
    if (!mentions.length) continue;
    for (const m of sentence.matchAll(/\$(\d[\d,]*(?:\.\d+)?)/g)) {
      const owner = mentions.find(x => x.at > m.index!) ?? [...mentions].reverse().find(x => x.at < m.index!);
      if (owner && !amounts.get(owner.name)!.has(Number(m[1].replace(/,/g, '')))) return false;
    }
  }
  return true;
}
export function safeAnswer(raw: string, facts: Facts, ids: number[]): string | undefined {
  const text = raw.replace(/(?<=[A-Za-z])-(?=[A-Za-z])/g, ' ');
  if (hasUnsupportedAssurance(text, facts)) return undefined;
  if (facts.kind === 'payroll' && (PAYMENT_DONE.test(text) || !payeeAmountsMatch(text, facts))) return undefined;
  return text.trim() && text.length <= 1500 && !/-(?!\d)|[\u2010-\u2015]/u.test(text) && (text.match(/[.!?](?:\s|$)/g)?.length ?? 1) <= 3 && factNumbers(facts).length > 0 && directionOk(text, facts) && checkAnswer(text, facts, ids).ok ? text : undefined;
}
export async function ask(input: unknown, deps: AskDependencies): Promise<Answer> {
  const tag: { previewVersion?: string } = {};
  const answer = await askChecked(input, deps, tag);
  // Every payroll answer names the preview it describes, so the screen can drop an answer for an older batch.
  return tag.previewVersion === undefined ? answer : { ...answer, previewVersion: tag.previewVersion };
}
async function askChecked(input: unknown, deps: AskDependencies, tag: { previewVersion?: string }): Promise<Answer> {
  const body = parseAsk(input, deps.wards);
  let facts: Facts;
  let ids: number[];
  let key: string;
  if (body.kind === 'payroll') {
    const readySource = typeof deps.readyWorklogs === 'function' ? await deps.readyWorklogs() : deps.readyWorklogs;
    const readyList = Array.isArray(readySource) ? readySource : readySource?.items;
    if (readySource && !Array.isArray(readySource) && typeof readySource.version === 'string') tag.previewVersion = readySource.version;
    const ready = Array.isArray(readyList) ? readyList as Array<{ id: string; ward: number; payee: string; units: number; cents?: number; dollars?: number }> : [];
    requireRule(ready.length > 0, 'No checked work logs are ready to pay.');
    const sortedIds = ready.map(w => w.id).sort();
    key = answerKey(body, sortedIds);
    facts = explainPayroll(ready);
    ids = [...new Set(ready.map(w => w.ward))];
  } else {
    key = answerKey(body);
    const plan = allocate(body.budget, 'y2023', deps.wards);
    if (body.kind === 'move') requireRule(body.amount <= (plan.perWard[body.from] ?? 0), 'Move amount exceeds the source ward plan dollars.');
    facts = body.kind === 'why' ? compareWards(body.a, body.b, plan, 'y2023', deps.wards)
      : body.kind === 'more' ? explainMore(body.ward, body.amount, plan, 'y2023', deps.wards)
      : body.kind === 'plan' ? explainPlan(plan, body.budget, 'y2023', deps.wards)
      : allocateWithMove(body.budget, 'y2023', deps.wards, body.from, body.to, body.amount).facts;
    ids = body.kind === 'why' ? [body.a, body.b] : body.kind === 'move' ? [body.from, body.to]
      : body.kind === 'more' ? [body.ward] : deps.wards.filter(w => plan.perWard[w.id] > 0).map(w => w.id);
  }
  const fallback = (reason: string): Answer => ({
    text: facts.kind === 'why' ? templateWhy(facts)
      : facts.kind === 'more' ? templateMore(facts)
      : facts.kind === 'plan' ? templatePlan(facts)
      : facts.kind === 'payroll' ? templatePayroll(facts)
      : templateMove(facts),
    source: 'rules',
    reason,
  });
  const recordedFallback = (reason: string): Answer => {
    const recorded = deps.recorded?.find(r => r.key === key);
    const text = recorded && safeAnswer(recorded.text, facts, ids);
    return text ? { text, source: 'recorded', reason: `Recorded answer, ${recorded!.date}` } : fallback(reason);
  };
  if (!deps.live) {
    return recordedFallback('live_off');
  }
  try {
    const cached = await deps.gate.cacheGet<Answer>(key);
    const text = cached && safeAnswer(cached.text, facts, ids);
    if (text) return { text, source: 'cache' };
  } catch (e) { logFailure('ai-gate', '/api/ask', e); return recordedFallback('gate_unavailable'); }
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: factsPrompt(facts) }];
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (estimateTokens(messages.map(m => m.content).join('\n')) > INPUT_TOKEN_CAP) return recordedFallback('input_limit');
    let reservation: number | null;
    try { reservation = await deps.ledger.reserve(); } catch (e) { logFailure('ai-ledger', '/api/ask', e); return recordedFallback('ledger_unavailable'); }
    if (reservation === null) return recordedFallback('cap_or_ledger_unavailable');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const output = await Promise.race([
        deps.ai.run(MODEL_ID, { messages: [...messages], max_tokens: OUTPUT_TOKEN_CAP }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), deps.timeoutMs ?? AI_TIMEOUT_MS); }),
      ]) as { response?: unknown; choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number } };
      const i = output.usage?.prompt_tokens ?? output.usage?.input_tokens, o = output.usage?.completion_tokens ?? output.usage?.output_tokens;
      if (typeof i === 'number' && typeof o === 'number' && Number.isFinite(i) && Number.isFinite(o) && i >= 0 && o >= 0) await deps.ledger.settle(reservation, neurons(i, o));
      const raw = typeof output.response === 'string' ? output.response : output.choices?.[0]?.message?.content;
      const text = typeof raw === 'string' ? safeAnswer(raw, facts, ids) : undefined;
      if (!text) {
        const rejected = typeof raw === 'string' ? raw : '';
        const bad = checkAnswer(rejected, facts, ids).bad;
        console.log(JSON.stringify({ event: 'ai_reject', key, attempt, bad, text: rejected }));
        const retry = bad.length ? `Your answer used numbers that are not in the facts: ${bad.join(', ')}. Answer again using only the numbers listed.`
          : facts.kind === 'payroll' && PAYMENT_DONE.test(rejected) ? 'Nothing has been paid yet. Answer again and say the batch would pay.'
          : facts.kind === 'payroll' ? 'Give each payee only its own amount from the items, and keep the batch total in its own sentence.'
          : 'Answer again using only the facts.';
        messages.push({ role: 'user', content: retry });
        continue;
      }
      const answer: Answer = { text, source: 'live' };
      // Losing the cache does not invalidate the answer or release its paid reservation.
      try { await deps.gate.cachePut(key, answer); } catch (e) { logFailure('ai-cache', '/api/ask', e); }
      return answer;
    } catch (e) { logFailure('ai', '/api/ask', e); return recordedFallback(e instanceof Error && e.message === 'timeout' ? 'timeout' : 'ai_error'); }
    finally { if (timer) clearTimeout(timer); }
  }
  return recordedFallback('answer_check');
}
