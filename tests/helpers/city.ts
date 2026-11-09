import type { Ward } from '../../src/model/types';
// Deliberately tiny fixture. Never imported by production code.
export const wards: Ward[] = [1, 2, 3].map(id => ({ id, path: '', label: [id, id], areaSqKm: id, population: 10000, adults: 8000,
  y2023: { registered: 6000, ballots: 2000, topShare: 0.5, secondShare: 0.3 },
  y2019: { registered: 6000, ballots: 1800, topShare: 0.5, secondShare: 0.3 } }));
