import { describe, expect, it } from 'vitest';
import { world } from './helpers/world';
import type { GateKind } from '../src/server/gate/engine';
describe('UTC daily gate and cache', () => {
  it('allows 6 donations per supporter then refuses the seventh', async () => {
    const w = world(); for (let i = 0; i < 6; i++) await w.gate.consume('donation', 's');
    await expect(w.gate.consume('donation', 's')).rejects.toMatchObject({ status: 429 });
    await expect(w.gate.consume('donation', 'other')).resolves.toBeUndefined();
  });
  it.each<[GateKind, number]>([['donation', 120], ['refund', 40], ['payout', 20], ['worklog', 30]])('%s total stops at %s', async (kind, cap) => {
    const w = world(); for (let i = 0; i < cap; i++) await w.gate.consume(kind, String(i));
    await expect(w.gate.consume(kind, 'new')).rejects.toMatchObject({ status: 429 });
  });
  it('concurrent requests cannot both take the last daily slot', async () => {
    const w = world(); for (let i = 0; i < 19; i++) await w.gate.consume('payout');
    const results = await Promise.allSettled([w.gate.consume('payout'), w.gate.consume('payout')]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('resets at UTC midnight', async () => {
    const w = world(); for (let i = 0; i < 6; i++) await w.gate.consume('donation', 's');
    w.advance(12 * 60 * 60 * 1000); await expect(w.gate.consume('donation', 's')).resolves.toBeUndefined();
  });
  it('cache expires at 24 hours and separates keys', async () => {
    const w = world(); await w.gate.cachePut('a', { text: 'answer' });
    expect(await w.gate.cacheGet('a')).toEqual({ text: 'answer' }); expect(await w.gate.cacheGet('b')).toBeUndefined();
    w.advance(24 * 60 * 60 * 1000); expect(await w.gate.cacheGet('a')).toBeUndefined();
  });
  it('remaining(\'payout\') is 20 at start, 19 after one consume, and does not change the count', async () => {
    const w = world();
    expect(await w.gate.remaining('payout')).toBe(20);
    await w.gate.consume('payout');
    expect(await w.gate.remaining('payout')).toBe(19);
    expect(await w.gate.remaining('payout')).toBe(19);
  });
});
