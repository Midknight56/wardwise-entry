import { SETUP_COST, STEP } from './assumptions';
import { costPerContact, expectedVotes, forecastTurnout, nonVoters } from './score';
import type { Base, Plan, Ward } from './types';

const round = (value: number, places = 0) => Number(value.toFixed(places));
const money = (value: number) => Math.round(value).toLocaleString('en-US');
export interface WardFacts {
  ward: number; dollars: number; votes: number; nonVoters: number; costPerContact: number;
  votesPer100: number; turnout: number; shareGap: number;
}
interface CommonFacts { setupCost: number; step: number; budget: number; returnDollars: number }
export interface WhyFacts extends CommonFacts { kind: 'why'; a: WardFacts; b: WardFacts; dollarsGap: number; votesGap: number; nonVotersGap: number; reason: string }
export interface DropFacts extends CommonFacts {
  kind: 'drop'; ward: number; dollarsBefore: number; votesPer100: number;
  keptWard: number; keptVotesPer100: number;
}
export interface MoveFacts extends CommonFacts {
  kind: 'move'; from: number; to: number; amount: number; fromDollars: number;
  toDollars: number; votesBefore: number; votesAfter: number; change: number;
}
export interface MoreFacts extends CommonFacts {
  kind: 'more'; ward: number; amount: number; dollarsNow: number; dollarsAfter: number;
  votesNow: number; votesAfter: number; gain: number; votesPer100: number;
  ratePer100ForThis: number;
}
export interface PlanFacts extends CommonFacts {
  kind: 'plan'; wardsFunded: number; fundedWards: number[]; votes: number; dollarsPerVote: number;
  wards: { ward: number; dollars: number; votes: number }[]; otherWards?: number; otherDollars?: number;
  topWard: number; topWardDollars: number; topWardNonVoters: number;
}
export interface PayrollItemFact {
  ward: number; payee: string; units: number; unit: string; dollars: number;
  ['payee label']?: string; payeeLabel?: string;
}
export interface PayrollFacts {
  kind: 'payroll'; count: number; total: number; items: PayrollItemFact[]; checksPassed: number;
}
export type Facts = WhyFacts | DropFacts | MoveFacts | MoreFacts | PlanFacts | PayrollFacts;

function planBudget(plan: Plan): number { return Object.values(plan.perWard).reduce((a, b) => a + b, 0); }

function marginal(ward: Ward, spend: number, base: Base, wards: readonly Ward[]): number {
  return (expectedVotes(ward, spend + STEP, base, wards) - expectedVotes(ward, spend, base, wards)) * 100 / STEP;
}
export function compareWards(a: number, b: number, plan: Plan, base: Base, wards: readonly Ward[]): WhyFacts {
  if (a === b) throw new RangeError('Ward comparison requires two different wards');
  const facts = (id: number): WardFacts => {
    const ward = wards.find(w => w.id === id);
    if (!ward) throw new RangeError(`Unknown ward ${id}`);
    const spend = plan.perWard[id] ?? 0;
    return { ward: id, dollars: round(spend), votes: round(expectedVotes(ward, spend, base, wards), 1),
      nonVoters: round(nonVoters(ward, base)), costPerContact: round(costPerContact(ward, wards), 2),
      // An unopened ward must cover its kit before it can produce any votes.
      votesPer100: round(spend ? marginal(ward, spend, base, wards)
        : expectedVotes(ward, SETUP_COST + STEP, base, wards) * 100 / (SETUP_COST + STEP), 2),
      turnout: round(100 * forecastTurnout(ward, base)),
      shareGap: round(100 * (ward[base].topShare - ward[base].secondShare)) };
  };
  const left = facts(a), right = facts(b);
  const [winner, other] = left.votesPer100 >= right.votesPer100 ? [left, right] : [right, left];
  let reason: string;
  if (winner.nonVoters > other.nonVoters && winner.costPerContact < other.costPerContact) {
    reason = `Ward ${winner.ward} wins on both: more non voters and a lower cost per contact.`;
  } else if (winner.nonVoters > other.nonVoters && winner.costPerContact >= other.costPerContact) {
    reason = winner.costPerContact === other.costPerContact
      ? `Ward ${winner.ward} wins because of its larger non voter pool; the cost per contact is the same.`
      : `Ward ${winner.ward} wins because its larger non voter pool outweighs its higher cost per contact.`;
  } else if (winner.nonVoters < other.nonVoters && winner.costPerContact < other.costPerContact) {
    reason = `Ward ${winner.ward} wins because its lower cost per contact outweighs its smaller non voter pool.`;
  } else if (winner.dollars > other.dollars && other.dollars === 0) {
    reason = `Ward ${winner.ward} wins because it starts with more money in the plan, so its next $100 lands after setup is paid.`;
  } else {
    reason = `Ward ${winner.ward} returns more votes per $100.`;
  }
  return { kind: 'why', a: left, b: right, setupCost: SETUP_COST, step: STEP, budget: planBudget(plan), returnDollars: 100,
    dollarsGap: Math.abs(left.dollars - right.dollars), votesGap: round(Math.abs(left.votes - right.votes), 1),
    nonVotersGap: Math.abs(left.nonVoters - right.nonVoters), reason };
}
export function explainDrop(before: Plan, after: Plan, base: Base, wards: readonly Ward[]): DropFacts | null {
  const dropped = [...wards].sort((a, b) => a.id - b.id)
    .find(w => before.perWard[w.id] > 0 && !(after.perWard[w.id] > 0));
  if (!dropped) return null;
  const kept = wards.filter(w => after.perWard[w.id] > 0).sort((a, b) =>
    marginal(b, after.perWard[b.id] - STEP, base, wards) - marginal(a, after.perWard[a.id] - STEP, base, wards) || a.id - b.id)[0];
  if (!kept) return null;
  return { kind: 'drop', ward: dropped.id, dollarsBefore: round(before.perWard[dropped.id]),
    votesPer100: round(marginal(dropped, before.perWard[dropped.id] - STEP, base, wards), 2),
    keptWard: kept.id, keptVotesPer100: round(marginal(kept, after.perWard[kept.id] - STEP, base, wards), 2),
    budget: round(planBudget(after)), setupCost: SETUP_COST, step: STEP, returnDollars: 100 };
}
export function explainMore(wardId: number, amount: number, plan: Plan, base: Base, wards: readonly Ward[]): MoreFacts {
  const ward = wards.find(w => w.id === wardId);
  if (!ward) throw new RangeError(`Unknown ward ${wardId}`);
  const spend = plan.perWard[wardId] ?? 0;
  const now = expectedVotes(ward, spend, base, wards), after = expectedVotes(ward, spend + amount, base, wards);
  const gain = round(after - now, 1);
  return { kind: 'more', ward: wardId, amount, dollarsNow: spend, dollarsAfter: spend + amount,
    votesNow: round(now, 1), votesAfter: round(after, 1), gain,
    ratePer100ForThis: round(gain / (amount / 100), 2),
    votesPer100: round(marginal(ward, spend, base, wards), 2), setupCost: SETUP_COST, step: STEP, budget: planBudget(plan), returnDollars: 100 };
}
export function templateMore(facts: MoreFacts): string {
  return `Adding $${money(facts.amount)} to Ward ${facts.ward} takes it from $${money(facts.dollarsNow)} to $${money(facts.dollarsAfter)} and adds ${facts.gain} expected votes.`;
}
export function explainPlan(plan: Plan, budget: number, base: Base, wards: readonly Ward[]): PlanFacts {
  const funded = wards.filter(w => plan.perWard[w.id] > 0).sort((a, b) => plan.perWard[b.id] - plan.perWard[a.id] || a.id - b.id);
  const top = funded[0];
  return { kind: 'plan', budget, wardsFunded: funded.length, fundedWards: funded.map(w => w.id), votes: round(plan.total, 1),
    wards: funded.slice(0, 10).map(w => ({ ward: w.id, dollars: plan.perWard[w.id], votes: round(plan.votes[w.id], 1) })),
    ...(funded.length > 10 ? { otherWards: funded.length - 10, otherDollars: funded.slice(10).reduce((sum, w) => sum + plan.perWard[w.id], 0) } : {}),
    dollarsPerVote: plan.total > 0 ? round(budget / plan.total) : 0, topWard: top?.id ?? 0,
    topWardDollars: top ? plan.perWard[top.id] : 0, topWardNonVoters: top ? nonVoters(top, base) : 0,
    setupCost: SETUP_COST, step: STEP, returnDollars: 100 };
}
export function templatePlan(facts: PlanFacts): string {
  return `At $${money(facts.budget)} the plan funds ${facts.wardsFunded} wards for ${facts.votes} expected new votes, about $${money(facts.dollarsPerVote)} per vote. ` +
    `Ward ${facts.topWard} gets the most, $${money(facts.topWardDollars)}, for its ${money(facts.topWardNonVoters)} non voters.`;
}
export function templateWhy(facts: WhyFacts): string {
  return `Ward ${facts.a.ward} gets $${money(facts.a.dollars)} and Ward ${facts.b.ward} gets $${money(facts.b.dollars)}. ` +
    `${facts.reason} ` +
    'The past vote gap is context and does not change the plan.';
}
export function templateMove(facts: MoveFacts): string {
  const direction = facts.change < 0 ? 'loses' : 'gains';
  return `Moving $${money(facts.amount)} from Ward ${facts.from} to Ward ${facts.to} ${direction} ${Math.abs(facts.change)} expected votes. ` +
    `Ward ${facts.from} then has $${money(facts.fromDollars)} and Ward ${facts.to} has $${money(facts.toDollars)}.`;
}
export function explainPayroll(items: any[]): PayrollFacts {
  const parsedItems: PayrollItemFact[] = items.map(it => {
    const ward = it.ward;
    const rawPayee = it.payee ?? it['payee label'] ?? '';
    let label = rawPayee;
    let unit = it.unit;
    if (rawPayee === 'crew-north' || rawPayee.startsWith('crew-north')) {
      label = 'North Side door crew';
      unit ??= 'doors';
    } else if (rawPayee === 'print-shop' || rawPayee.startsWith('print-shop')) {
      label = 'Ward print shop';
      unit ??= 'flyers';
    } else if (rawPayee === 'crew-unclaimed' || rawPayee.startsWith('crew-unclaimed')) {
      label = 'New crew, no PayPal account yet';
      unit ??= 'doors';
    } else {
      label = rawPayee.replace(/\s*\(sandbox\)$/, '');
      unit ??= (label.toLowerCase().includes('print') || it.role === 'flyers') ? 'flyers' : 'doors';
    }
    const units = it.units;
    const rate = unit === 'flyers' ? 0.10 : 0.25;
    const dollars = it.dollars ?? (it.cents !== undefined ? it.cents / 100 : Math.round(units * rate * 100) / 100);
    const itemFact: PayrollItemFact = { ward, payee: label, units, unit, dollars };
    Object.defineProperty(itemFact, 'payee label', { get() { return this.payee; }, enumerable: false });
    Object.defineProperty(itemFact, 'payeeLabel', { get() { return this.payee; }, enumerable: false });
    return itemFact;
  });
  const total = parsedItems.reduce((sum, it) => sum + it.dollars, 0);
  return {
    kind: 'payroll',
    count: parsedItems.length,
    total: Math.round(total * 100) / 100,
    items: parsedItems,
    checksPassed: parsedItems.length,
  };
}
export function templatePayroll(facts: PayrollFacts): string {
  const list = facts.items.map(it => `$${money(it.dollars)} to ${it.payee} for ${it.units} ${it.unit} in Ward ${it.ward}`).join(', ');
  const header = `${facts.count} checked work ${facts.count === 1 ? 'log is' : 'logs are'} ready:`;
  return `${header} ${list}. Total $${money(facts.total)}.`;
}
function numbers(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(numbers);
  return [];
}
export function factNumbers(facts: Facts): string[] {
  // Small rates must retain their precision; magnitude supports prose such as "loses 1.2".
  let values: number[];
  if (facts.kind === 'plan') {
    const { setupCost, step, returnDollars, ...planFacts } = facts;
    values = numbers(planFacts);
    values.push(...facts.wards.filter(w => w.votes !== 0).map(w => Math.round(w.dollars / w.votes)));
  } else {
    values = numbers(facts);
  }
  if (facts.kind === 'more' && facts.dollarsNow === 0) values.push(Math.max(0, facts.amount - facts.setupCost));
  return [...new Set(values.flatMap(n => [n, Math.abs(n), ...(Math.abs(n) >= 10 ? [Math.round(n), Math.round(Math.abs(n))] : [])]
    .flatMap(value => [String(value), Number.isInteger(value) ? value.toLocaleString('en-US') : String(value)])))];
}
function wardMoney(facts: Facts): Map<number, number[]> {
  if (facts.kind === 'why') return new Map([facts.a, facts.b].map(w => [w.ward, [w.dollars, w.costPerContact]]));
  if (facts.kind === 'plan') return new Map(facts.wards.map(w => [w.ward, [w.dollars]]));
  if (facts.kind === 'more') return new Map([[facts.ward, [facts.dollarsNow, facts.dollarsAfter]]]);
  if (facts.kind === 'move') return new Map([[facts.from, [facts.fromDollars]], [facts.to, [facts.toDollars]]]);
  if (facts.kind === 'payroll') return new Map(facts.items.map(w => [w.ward, [w.dollars]]));
  return new Map([[facts.ward, [facts.dollarsBefore]]]);
}
function claimErrors(answer: string, facts: Facts): string[] {
  const bad: string[] = [], money = wardMoney(facts);
  if (facts.kind === 'more') money.get(facts.ward)?.push(facts.amount);
  const allWardsInAnswer = [...answer.matchAll(/\bWard\s+(\d+)\b/gi)].map(m => Number(m[1]));
  const firstWardOfAnswer = allWardsInAnswer[0];
  let lastSentenceWards: number[] = [];

  for (const sentence of answer.split(/[.!?](?=\s|$)/)) {
    const wards = [...sentence.matchAll(/\bWard\s+(\d+)\b/gi)];
    const sentenceWards = wards.map(m => Number(m[1]));

    if (facts.kind === 'plan') {
      const voteMention = /\bvotes?\b/i.test(sentence);
      const wholePlan = /\b(?:plan|overall|average|whole|in total)\b/i.test(sentence);
      const oneWard = sentenceWards.length === 1 ? sentenceWards[0] : undefined;
      const perVoteClaims = [
        ...sentence.matchAll(/\$((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s+per\s+(?:(?:expected|new)\s+)*(?:new\s+)?votes?\b/gi),
        ...(voteMention ? [...sentence.matchAll(/\$((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s+each\b/gi)] : []),
        ...sentence.matchAll(/\bat\s+\$((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s+a\s+vote\b/gi),
      ].sort((a, b) => a.index! - b.index!);
      for (const claim of perVoteClaims) {
        const amount = Number(claim[1].replaceAll(',', ''));
        const ward = !wholePlan && oneWard !== undefined ? facts.wards.find(w => w.ward === oneWard) : undefined;
        const expected = ward ? Math.round(ward.dollars / ward.votes) : facts.dollarsPerVote;
        if (amount !== expected) {
          bad.push(ward
            ? `Ward ${ward.ward} costs $${expected} per vote, not $${claim[1]}.`
            : `The plan costs $${facts.dollarsPerVote} per vote, not $${claim[1]}.`);
        }
      }
    }

    for (const match of sentence.matchAll(/\$((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s+(?:for|to|in)\s+Ward\s+(\d+)(?:'s)?\b/gi)) {
      if (/votes per\s*$/i.test(sentence.slice(0, match.index))) continue;
      const targetWard = Number(match[2]);
      const amountVal = Number(match[1].replaceAll(',', ''));
      if (facts.kind === 'why' && /\b(?:additional|extra)\s*$/i.test(sentence.slice(0, match.index))) {
        const topWard = facts.a.dollars >= facts.b.dollars ? facts.a.ward : facts.b.ward;
        if (targetWard !== topWard || amountVal !== facts.dollarsGap) bad.push(`Ward ${targetWard} $${match[1]}`);
        continue;
      }
      const known = money.get(targetWard);
      if (known && !known.includes(amountVal)) bad.push(`Ward ${targetWard} $${match[1]}`);
    }

    for (const ward of wards) {
      const start = ward.index! + ward[0].length;
      const nextWard = wards.find(w => w.index! > ward.index!);
      const tail = sentence.slice(start, nextWard?.index);
      for (const amount of tail.matchAll(/\$((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)/g)) {
        if (amount.index! >= 30) break;
        // The denominator of a rate is not an allocation to the ward.
        if (/votes per\s*$/i.test(tail.slice(0, amount.index))) continue;
        const after = sentence.slice(start + amount.index! + amount[0].length);
        if (/^\s+(?:for|to|in)\s+Ward\s+\d+(?:'s)?\b/i.test(after)) continue;
        const known = money.get(Number(ward[1]));
        if (known && !known.includes(Number(amount[1].replaceAll(',', '')))) bad.push(`Ward ${ward[1]} $${amount[1]}`);
        break;
      }
    }

    if (facts.kind !== 'why') {
      if (sentenceWards.length > 0) lastSentenceWards = sentenceWards;
      continue;
    }

    const fallbackWard = lastSentenceWards[0] ?? firstWardOfAnswer;
    const firstWardIndex = sentenceWards.length > 0 ? wards[0].index! : Infinity;
    const hasItBeforeFirstWard = /\b(?:it|its)\b/i.test(sentence.slice(0, firstWardIndex));

    const winner = facts.a.votesPer100 >= facts.b.votesPer100 ? facts.a : facts.b;
    const other = winner === facts.a ? facts.b : facts.a;
    const causeRegex = /\b(because|due to|reasons?|thanks to|outweigh[a-z]*)\b/i;
    const costClaimRegex = /\b(?:(?:a|an|slightly)\s+)*(?:higher\s+cost\s+per\s+contact|costs?\s+more\s+per\s+contact)\b/gi;
    if (causeRegex.test(sentence)) {
      for (const claimMatch of sentence.matchAll(costClaimRegex)) {
        let claimSubjectWardId: number | undefined;
        const wardsBeforeClaim = wards.filter(w => w.index! < claimMatch.index!);
        if (wardsBeforeClaim.length > 0) {
          const prefix = sentence.slice(0, claimMatch.index);
          const pronoun = /\b(?:it|its)\s+(?:(?:has|a|an|slightly)\s+)*$/i.test(prefix);
          claimSubjectWardId = pronoun ? (hasItBeforeFirstWard ? fallbackWard : Number(wards[0][1])) : Number(wardsBeforeClaim.at(-1)![1]);
        } else {
          claimSubjectWardId = fallbackWard;
        }
        const isWinnerClaim = claimSubjectWardId === winner.ward ||
          (!claimSubjectWardId && winner.costPerContact > other.costPerContact) ||
          (claimSubjectWardId !== other.ward && winner.costPerContact > other.costPerContact);
        if (isWinnerClaim) {
          const textBefore = sentence.slice(0, claimMatch.index);
          const allowed = /\b(despite|although|even\s+though|even\s+with|but|while|outweigh(?:s|ed|ing)?\s+its)\b/i.test(textBefore);
          if (!allowed) {
            bad.push(`Ward ${winner.ward} higher cost per contact as reason`);
          }
        }
      }
    }

    const pattern = /\b(higher|lower|larger|smaller|bigger|more|fewer|cheaper|less|equal|same)\s+(cost per contact|non voter pool|non voters|votes per \$100)\b/gi;
    for (const claim of sentence.matchAll(pattern)) {
      const claimWord = claim[1].toLowerCase();
      const metricStr = claim[2].toLowerCase();
      const metric = metricStr === 'cost per contact' ? 'costPerContact' : metricStr.startsWith('non') ? 'nonVoters' : 'votesPer100';
      const greaterWords = ['higher', 'larger', 'bigger', 'more'];
      const lesserWords = ['lower', 'smaller', 'fewer', 'cheaper', 'less'];
      const equalWords = ['equal', 'same'];

      // Bracket pair check within 3 characters
      const detail = sentence.slice(claim.index! + claim[0].length);
      const pairMatch = detail.match(/^([^(]{0,3})\([a-zA-Z\s]{0,12}\$?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s+(?:vs\.?|versus)\s+\$?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*\)/i);

      // Subject resolution
      let subjectWardId: number | undefined;
      const wardsBefore = wards.filter(w => w.index! < claim.index!);
      if (wardsBefore.length > 0) {
        const prefix = sentence.slice(0, claim.index);
        const pronoun = /\b(?:it|its)\s+(?:(?:has|a|an|slightly)\s+)*$/i.test(prefix);
        if (pronoun) {
          subjectWardId = hasItBeforeFirstWard ? fallbackWard : Number(wards[0][1]);
        } else {
          subjectWardId = Number(wardsBefore.at(-1)![1]);
        }
      } else {
        subjectWardId = fallbackWard;
      }

      const subject = subjectWardId ? [facts.a, facts.b].find(w => w.ward === subjectWardId) : undefined;
      const other = subject ? (subject === facts.a ? facts.b : facts.a) : undefined;

      if (pairMatch) {
        const valA = Number(pairMatch[2].replaceAll(',', ''));
        const valB = Number(pairMatch[3].replaceAll(',', ''));

        const isGreater = valA > valB;
        const isLesser = valA < valB;
        const isEqual = Math.abs(valA - valB) < 1e-6;

        const pairWordOk = (greaterWords.includes(claimWord) && isGreater) ||
                           (lesserWords.includes(claimWord) && isLesser) ||
                           (equalWords.includes(claimWord) && isEqual);

        const w1 = facts.a[metric], w2 = facts.b[metric];
        const setOk = Math.abs(w1 - w2) < 1e-6
          ? Math.abs(valA - w1) < 1e-6 && Math.abs(valB - w1) < 1e-6
          : (Math.abs(valA - w1) < 1e-6 && Math.abs(valB - w2) < 1e-6) ||
            (Math.abs(valA - w2) < 1e-6 && Math.abs(valB - w1) < 1e-6);

        if (!pairWordOk || !setOk) {
          bad.push(subjectWardId ? `Ward ${subjectWardId} ${claim[0]} comparison` : `${claim[0]} comparison`);
        }

        if (subject && other) {
          const subjectGreater = greaterWords.includes(claimWord) && subject[metric] > other[metric];
          const subjectLesser = lesserWords.includes(claimWord) && subject[metric] < other[metric];
          const subjectEqual = equalWords.includes(claimWord) && Math.abs(subject[metric] - other[metric]) < 1e-6;
          if (!subjectGreater && !subjectLesser && !subjectEqual) {
            bad.push(`Ward ${subjectWardId} ${claim[0]}`);
          }
          if (Math.abs(valA - subject[metric]) >= 1e-6 || Math.abs(valB - other[metric]) >= 1e-6) {
            bad.push(`Ward ${subjectWardId} ${claim[2]} comparison`);
          }
        }
      } else {
        if (equalWords.includes(claimWord)) {
          if (Math.abs(facts.a[metric] - facts.b[metric]) >= 1e-6) {
            bad.push(subjectWardId ? `Ward ${subjectWardId} ${claim[0]}` : claim[0]);
          }
        } else if (subject && other) {
          const subjectGreater = greaterWords.includes(claimWord) && subject[metric] > other[metric];
          const subjectLesser = lesserWords.includes(claimWord) && subject[metric] < other[metric];
          if (!subjectGreater && !subjectLesser) {
            bad.push(`Ward ${subjectWardId} ${claim[0]}`);
          }
        }
      }

      if (greaterWords.includes(claimWord) && metric === 'costPerContact' && /\bmaking it more effective\b/i.test(detail)) {
        bad.push(`Ward ${subjectWardId ?? ''} higher cost makes it more effective`.trim());
      }
    }
    if (sentenceWards.length > 0) lastSentenceWards = sentenceWards;
  }
  return bad;
}
export function directionOk(text: string, facts: Facts): boolean {
  if (facts.kind !== 'move') return true;
  // A description of the allocator's general goal does not describe the move's result.
  text = text.replace(/\bThe plan (?:prioritizes|puts)\b[^.!?]*(?:[.!?]|$)/gi, '');
  if (facts.change < 0) return !/\b(gain|gains|gained|increase|increases|increased|adds|raises|more votes)\b/i.test(text);
  if (facts.change > 0) return !/\b(lose|loses|lost|loss|decrease|decreases|decreased|fewer|drops|reduces)\b/i.test(text);
  return true;
}
export function checkAnswer(answer: string, facts: Facts, allowedWards: readonly number[]): { ok: boolean; bad: string[] } {
  const allowed = new Set(factNumbers(facts).map(Number));
  const bad: string[] = claimErrors(answer, facts);
  const ratePer100Pattern = /\b((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s+(?:(?:expected|new)\s+)*votes per \$100\b/gi;
  for (const match of answer.matchAll(ratePer100Pattern)) {
    const val = Number(match[1].replaceAll(',', ''));
    let allowedRates: number[] = [];
    if (facts.kind === 'why') {
      allowedRates = [facts.a.votesPer100, facts.b.votesPer100];
    } else if (facts.kind === 'more') {
      if (facts.dollarsNow > 0) allowedRates = [facts.votesPer100, facts.ratePer100ForThis];
    } else if (facts.kind === 'drop') {
      allowedRates = [facts.votesPer100, facts.keptVotesPer100];
    }
    if (!allowedRates.some(r => Math.abs(r - val) < 1e-4)) {
      bad.push(match[0]);
    }
  }
  if ('setupCost' in facts) {
    const setupPattern = /(?:\$((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s+setup(?:\s+costs?)?|setup\s+costs?(?:\s+of)?\s+\$((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?))\b/gi;
    for (const match of answer.matchAll(setupPattern)) {
      const amountStr = match[1] ?? match[2];
      const val = Number(amountStr.replaceAll(',', ''));
      if (val !== facts.setupCost) bad.push(match[0]);
    }
  }
  if (facts.kind === 'why') {
    for (const match of answer.matchAll(/\b(?:these factors\s+outweigh the advantage(?:\s+in votes per \$100)?|outweigh the advantage in votes per \$100)\b/gi)) {
      bad.push(match[0]);
    }
  }
  if (facts.kind === 'more') {
    for (const match of answer.matchAll(/votes per \$100\s+(?:is|of|are)\s+(\d+(?:\.\d+)?)/gi)) {
      const val = Number(match[1]);
      if (facts.dollarsNow === 0 || (val !== facts.votesPer100 && val !== facts.ratePer100ForThis)) bad.push(`votes per $100 ${match[1]}`);
    }
  }
  if (facts.kind === 'why') {
    for (const match of answer.matchAll(/\$([\d,]+(?:\.\d+)?)\s+(?:more|less|higher|lower|additional|extra)\b/gi)) {
      if (Number(match[1].replaceAll(',', '')) !== facts.dollarsGap) bad.push(match[1]);
    }
  }
  const wardPattern = /\bwards?\s*#?\s*([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)(?:\s*(?:,|and|&|or|versus|vs\.?)\s*([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?))*/gi;
  for (const match of answer.matchAll(wardPattern)) {
    for (const token of match[0].match(/[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi) ?? []) {
      if (!allowedWards.includes(Number(token))) bad.push(`Ward ${token}`);
    }
  }
  for (const match of answer.matchAll(/[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:e[+-]?\d+)?/gi)) {
    if (!allowed.has(Number(match[0].replaceAll(',', '')))) bad.push(match[0]);
  }
  return { ok: bad.length === 0, bad: [...new Set(bad)] };
}
