import { COST_MAX, COST_MIN, EASY_SHARE, LIFT, SETUP_COST } from './assumptions';
import type { Base, Ward } from './types';

export function forecastTurnout(ward: Ward, base: Base): number {
  const { registered, ballots } = ward[base];
  return registered > 0 ? Math.max(0, Math.min(1, ballots / registered)) : 0;
}
export function nonVoters(ward: Ward, base: Base): number {
  return Math.max(0, ward[base].registered - ward[base].ballots);
}
export function densityScore(wards: readonly Ward[]): Record<number, number> {
  const densities = wards.map(w => w.areaSqKm > 0 ? w.adults / w.areaSqKm : 0);
  const min = Math.min(...densities), max = Math.max(...densities);
  return Object.fromEntries(wards.map((w, i) => [w.id, max > min ? (densities[i] - min) / (max - min) : 0]));
}
export function costPerContact(ward: Ward, wards: readonly Ward[]): number {
  return COST_MAX - (COST_MAX - COST_MIN) * (densityScore(wards)[ward.id] ?? 0);
}
export function expectedContacts(ward: Ward, spend: number, wards: readonly Ward[]): number {
  return Math.floor(Math.max(0, spend - SETUP_COST) / costPerContact(ward, wards));
}
/** Shared kernel lets the allocator calculate density once per call. */
export function votesAtCost(spend: number, pool: number, cost: number): number {
  return spend <= SETUP_COST || pool <= 0 ? 0 : LIFT * pool * -Math.expm1(-(spend - SETUP_COST) / cost / pool);
}
export function expectedVotes(ward: Ward, spend: number, base: Base, wards: readonly Ward[]): number {
  return votesAtCost(spend, EASY_SHARE * nonVoters(ward, base), costPerContact(ward, wards));
}
