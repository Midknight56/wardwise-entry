import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { allocate } from '../src/model/allocate';
import { compareWards, explainPlan, explainMore, checkAnswer, templateWhy, type PlanFacts, type WhyFacts } from '../src/model/explain';
import { factsPrompt } from '../src/server/ai/ask';
import type { CityData, Plan } from '../src/model/types';

const city = JSON.parse(readFileSync(new URL('../public/data/chicago.json', import.meta.url), 'utf8')) as CityData;
const wards = city.wards;

describe('J12c reasons and checker rules', () => {
  it('rejects wrong answer 1: votes used instead of votes per $100', () => {
    const facts = compareWards(9, 34, allocate(5000, 'y2023', wards), 'y2023', wards);
    const text = 'Ward 9 gets $1,250 because it has 14.8 expected new votes per $100, while Ward 34 has 0.29.';
    const result = checkAnswer(text, facts, [9, 34]);
    expect(result.ok).toBe(false);
    expect(result.bad).toContain('14.8 expected new votes per $100');
  });

  it('rejects wrong answer 2: higher cost given as reason to win and wrong setup cost', () => {
    const facts = compareWards(21, 42, allocate(3000, 'y2023', wards), 'y2023', wards);
    const text = 'Ward 21 gets $1,550 and Ward 42 gets $0. This is due to its larger non voter pool (29,263 vs 20,112) and higher cost per contact ($2.58 vs $2.37), despite the $50 setup cost.';
    const result = checkAnswer(text, facts, [21, 42]);
    expect(result.ok).toBe(false);
    expect(result.bad).toContain('$50 setup cost');
    expect(result.bad).toContain('Ward 21 higher cost per contact as reason');
  });

  it('rejects wrong answer 3: higher cost given as reason to win with outweighing', () => {
    const facts = compareWards(27, 4, allocate(5000, 'y2023', wards), 'y2023', wards);
    const text = "Ward 27 has a larger non voter pool (27,056 vs 18,777) and a slightly higher cost per contact ($2.55 vs $2.54), both outweighing Ward 4's lower votes per $100.";
    const result = checkAnswer(text, facts, [27, 4]);
    expect(result.ok).toBe(false);
    expect(result.bad).toContain('Ward 27 higher cost per contact as reason');
  });

  it('rejects wrong answer 4: muddled outweigh the advantage claim', () => {
    const facts = compareWards(21, 2, allocate(12000, 'y2023', wards), 'y2023', wards);
    const text = 'Ward 21 returns more votes per $100. It has a larger non voter pool (29,263 vs 19,888) and a slightly higher cost per contact ($2.58 vs $2.30), but these factors outweigh the advantage in votes per $100 (1.13 vs 1.11).';
    const result = checkAnswer(text, facts, [21, 2]);
    expect(result.ok).toBe(false);
    expect(result.bad).toContain('these factors outweigh the advantage in votes per $100');
  });

  it('rejects wrong answer 5: plan $2,000 made-up setup and step numbers', () => {
    const facts = explainPlan(allocate(2000, 'y2023', wards), 2000, 'y2023', wards);
    const text = 'Setup costs $300, with $50 and $100 allocated for additional resources.';
    const result = checkAnswer(text, facts, facts.fundedWards);
    expect(result.ok).toBe(false);
    expect(result.bad).toContain('50');
    expect(result.bad).toContain('100');
    expect(result.bad).toContain('300');
  });

  it('rejects wrong answer 6: plan $3,550 made-up $50 remaining', () => {
    const facts = explainPlan(allocate(3550, 'y2023', wards), 3550, 'y2023', wards);
    const text = 'After setup costs, the top ward has $50 remaining.';
    const result = checkAnswer(text, facts, facts.fundedWards);
    expect(result.ok).toBe(false);
    expect(result.bad).toContain('50');
  });

  it('accepts passing why answer where larger non voter pool outweighs higher cost', () => {
    const facts = compareWards(21, 42, allocate(3000, 'y2023', wards), 'y2023', wards);
    const text = 'Ward 21 returns more votes per $100 (1.1) than Ward 42 (0.3). Its larger non voter pool (29,263 vs 20,112) outweighs its higher cost per contact ($2.58 vs $2.37).';
    const result = checkAnswer(text, facts, [21, 42]);
    expect(result.ok).toBe(true);
    expect(result.bad).toEqual([]);
  });

  it('accepts passing more answer with initial setup dollars', () => {
    const facts = explainMore(9, 500, allocate(3550, 'y2023', wards), 'y2023', wards);
    const text = 'In Ward 9, $500 buys $200 of contacts after the initial $300 setup.';
    const result = checkAnswer(text, facts, [9]);
    expect(result.ok).toBe(true);
    expect(result.bad).toEqual([]);
  });

  it('why prompt for 21 vs 42 at $3,000 holds main reason and instruction', () => {
    const facts = compareWards(21, 42, allocate(3000, 'y2023', wards), 'y2023', wards);
    const prompt = factsPrompt(facts);
    expect(prompt).toContain('Main reason: Ward 21 wins because its larger non voter pool outweighs its higher cost per contact.');
    expect(prompt).toContain('Give the main reason in your own words. Never give a higher cost per contact as a reason to win.');
  });

  it('plan prompt for $2,000 holds neither $300 nor $50 and has no-explanation instruction', () => {
    const facts = explainPlan(allocate(2000, 'y2023', wards), 2000, 'y2023', wards);
    const prompt = factsPrompt(facts);
    expect(prompt).not.toContain('$300');
    expect(prompt).not.toContain('$50');
    expect(prompt).toContain('Do not explain setup costs or steps.');
  });

  it('checks plan dollars per vote against the ward or whole plan context', () => {
    const facts: PlanFacts = {
      kind: 'plan', setupCost: 300, step: 50, budget: 2000, returnDollars: 100,
      wardsFunded: 2, fundedWards: [21, 2], votes: 23.7, dollarsPerVote: 85,
      wards: [{ ward: 21, dollars: 1050, votes: 12.4 }, { ward: 2, dollars: 950, votes: 11.3 }],
      topWard: 21, topWardDollars: 1050, topWardNonVoters: 0,
    };
    const liveAnswer = '$1,050 goes to Ward 21, which has 12.4 expected new votes at $85 each. $950 is allocated to Ward 2 with 11.3 expected new votes at $85 per vote.';
    expect(checkAnswer(liveAnswer, facts, facts.fundedWards).ok).toBe(false);
    expect(checkAnswer('The $2,000 plan funds 2 wards for 23.7 expected new votes, about $85 per vote.', facts, facts.fundedWards).ok).toBe(true);
    expect(checkAnswer('Ward 2 gets $950 for 11.3 expected new votes, about $84 per vote.', facts, facts.fundedWards).ok).toBe(true);
    expect(checkAnswer('Ward 2 gets $950 at $85 per vote overall for the plan.', facts, facts.fundedWards).ok).toBe(true);
    expect(checkAnswer('The $2,000 plan funds 2 wards for 23.7 expected new votes.', facts, facts.fundedWards).ok).toBe(true);
  });

  it('plan prompt labels dollars per vote as whole-plan and bars a ward rate', () => {
    const facts = explainPlan(allocate(2000, 'y2023', wards), 2000, 'y2023', wards);
    const prompt = factsPrompt(facts);
    expect(prompt).toContain('Dollars per vote for the whole plan:');
    expect(prompt).toContain('Do not give a dollars per vote for one ward.');
  });

  it('constructs correct reason sentence variants in compareWards', () => {
    // 1. More non voters and lower cost
    const both = compareWards(1, 6, allocate(5000, 'y2023', wards), 'y2023', wards);
    expect(both.reason).toMatch(/wins on both: more non voters and a lower cost per contact\.$/);

    // 2. Fewer non voters, lower cost
    // Ward 2 (nonVoters 19,888, cost 2.30) vs Ward 27 (nonVoters 27,056, cost 2.55)
    // Ward 2 has fewer non voters and lower cost per contact.
    // At budget 1000, let's check
    const plan1000 = allocate(1000, 'y2023', wards);
    const costWins = compareWards(2, 27, plan1000, 'y2023', wards);
    if (costWins.a.votesPer100 > costWins.b.votesPer100) {
      expect(costWins.reason).toBe('Ward 2 wins because its lower cost per contact outweighs its smaller non voter pool.');
    }

    // 3. TemplateWhy uses the reason sentence as its second sentence
    const template = templateWhy(both);
    const sentences = template.split(/[.!?](?:\s|$)/).filter(Boolean);
    expect(sentences[1]).toBe(both.reason.replace(/\.$/, ''));
  });

  it('constructs reason when cost is equal', () => {
    // Synthetic facts test for equal cost
    const syntheticPlan: Plan = { perWard: { 1: 500, 2: 0 }, votes: { 1: 5, 2: 0 }, total: 5 };
    const fakeWards = [
      { ...wards[0], id: 1, adults: 10000, areaSqKm: 10, y2023: { ...wards[0].y2023, registered: 30000, ballots: 5000 } },
      { ...wards[1], id: 2, adults: 10000, areaSqKm: 10, y2023: { ...wards[1].y2023, registered: 20000, ballots: 5000 } },
    ];
    const facts = compareWards(1, 2, syntheticPlan, 'y2023', fakeWards);
    expect(facts.a.costPerContact).toBe(facts.b.costPerContact);
    expect(facts.reason).toBe('Ward 1 wins because of its larger non voter pool; the cost per contact is the same.');
  });

  it('constructs funding history reason when winner has more money in plan without demographic advantage', () => {
    // Winner has fewer non-voters and equal or higher cost, but starts with money in plan while other has 0
    const fakeWards = [
      { ...wards[0], id: 1, adults: 10000, areaSqKm: 10, y2023: { ...wards[0].y2023, registered: 15000, ballots: 5000 } },
      { ...wards[1], id: 2, adults: 10000, areaSqKm: 10, y2023: { ...wards[1].y2023, registered: 20000, ballots: 5000 } },
    ];
    // Ward 1 has 10,000 nonVoters, Ward 2 has 15,000. Both equal density.
    // Ward 1 spend $350 (setup paid, marginal spend 50), Ward 2 spend 0 (setup not paid, 350 for 50 of contacts).
    const plan: Plan = { perWard: { 1: 350, 2: 0 }, votes: { 1: 3, 2: 0 }, total: 3 };
    const facts = compareWards(1, 2, plan, 'y2023', fakeWards);
    expect(facts.reason).toBe('Ward 1 wins because it starts with more money in the plan, so its next $100 lands after setup is paid.');
  });
});
