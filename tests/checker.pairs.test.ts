import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { allocate } from '../src/model/allocate';
import { compareWards, explainPlan, explainMore, checkAnswer } from '../src/model/explain';
import type { CityData } from '../src/model/types';

const city = JSON.parse(readFileSync(new URL('../public/data/chicago.json', import.meta.url), 'utf8')) as CityData;
const wards = city.wards;

describe('J12 checker pairs and dollar binding tests', () => {
  it('rejects Reason answer with no subject when false of the previous sentence subject', () => {
    const facts = compareWards(21, 2, allocate(12000, 'y2023', wards), 'y2023', wards);
    const text = 'Ward 21 returns more votes per $100. Reason: higher votes per $100 (1.13 vs 1.11), larger non voter pool (29,263 vs 19,888), and lower cost per contact (wors 2.58 vs 2.30).';
    const result = checkAnswer(text, facts, [21, 2]);
    expect(result.ok).toBe(false);
  });

  it('rejects Ward 27 pronoun before ward mention only for the false cost claim', () => {
    const facts = compareWards(27, 2, allocate(8000, 'y2023', wards), 'y2023', wards);
    const text = 'Ward 27 returns more votes per $100. It has more non voters and a lower cost per contact than Ward 2.';
    const result = checkAnswer(text, facts, [27, 2]);
    expect(result.ok).toBe(false);
    expect(result.bad).toContain('Ward 27 lower cost per contact');
    expect(result.bad).not.toContain('Ward 2 more non voters');
    expect(result.bad).toEqual(['Ward 27 lower cost per contact']);
  });

  it('rejects false comparison when sentence names no ward but refers to previous ward via pronoun', () => {
    const facts = compareWards(27, 2, allocate(8000, 'y2023', wards), 'y2023', wards);
    const text = 'Ward 27 returns more votes per $100. It has a larger non voter pool (27,056 vs 19,888) and a lower cost per contact ($2.55 vs $2.30).';
    const result = checkAnswer(text, facts, [27, 2]);
    expect(result.ok).toBe(false);
  });

  it('rejects comparison claim followed by bracket pair when claim is false of A against B', () => {
    const facts = compareWards(2, 21, allocate(12000, 'y2023', wards), 'y2023', wards);
    const text = 'lower cost per contact ($2.58 vs $2.3)';
    const result = checkAnswer(text, facts, [2, 21]);
    expect(result.ok).toBe(false);
    expect(result.bad).toContain('lower cost per contact comparison');
  });

  it('rejects equal claim with no pair when the two wards values differ', () => {
    const facts = compareWards(27, 2, allocate(8000, 'y2023', wards), 'y2023', wards);
    const text = 'equal cost per contact';
    const result = checkAnswer(text, facts, [27, 2]);
    expect(result.ok).toBe(false);
    expect(result.bad).toContain('equal cost per contact');
  });

  it('accepts amounts directly followed by for Ward M', () => {
    const facts = explainPlan(allocate(3550, 'y2023', wards), 3550, 'y2023', wards);
    const text = '$1,300 for Ward 21, $1,200 for Ward 27, and $1,050 for Ward 2.';
    const result = checkAnswer(text, facts, facts.fundedWards);
    expect(result.ok).toBe(true);
    expect(result.bad).toEqual([]);
  });

  it('accepts amounts followed by for Ward M with possessive', () => {
    const facts = explainPlan(allocate(2000, 'y2023', wards), 2000, 'y2023', wards);
    const text = "$1,050 for Ward 21's 12.4 new votes and $950 for Ward 2's 11.3 votes.";
    const result = checkAnswer(text, facts, facts.fundedWards);
    expect(result.ok).toBe(true);
    expect(result.bad).toEqual([]);
  });

  it('only checks the first amount after a ward in the same tail', () => {
    const facts = explainMore(9, 500, allocate(3550, 'y2023', wards), 'y2023', wards);
    const text = 'In Ward 9, $500 buys $200 of contacts after the initial $300 setup.';
    const result = checkAnswer(text, facts, [9]);
    expect(result.ok).toBe(true);
    expect(result.bad).toEqual([]);
  });

  it('still rejects amount when it does not match known dollars for the ward', () => {
    const facts = explainPlan(allocate(3550, 'y2023', wards), 3550, 'y2023', wards);
    const text = 'Ward 2 gains $100, Ward 42 has $500.';
    const result = checkAnswer(text, facts, facts.fundedWards);
    expect(result.ok).toBe(false);
    expect(result.bad).toContain('Ward 2 $100');
  });

  it('still rejects parenthesized wrong amounts bound to wards', () => {
    const facts = explainPlan(allocate(3550, 'y2023', wards), 3550, 'y2023', wards);
    const text = 'Ward 21 ($300), Ward 2 ($50)';
    const result = checkAnswer(text, facts, facts.fundedWards);
    expect(result.ok).toBe(false);
    expect(result.bad).toContain('Ward 21 $300');
    expect(result.bad).toContain('Ward 2 $50');
  });
});
