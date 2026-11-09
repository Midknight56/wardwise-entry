import type { Ward } from '../../src/model/types';

/** Entirely synthetic ward data, not estimates of actual Chicago wards. */
export const sixWards: Ward[] = [
  [1, 3.1, 22000, 19000, 8000, 20000, 8500],
  [2, 4.0, 25000, 23000, 10000, 24000, 10500],
  [3, 5.2, 26000, 24000, 12000, 25000, 13000],
  [4, 6.3, 27000, 25000, 13000, 26000, 14000],
  [5, 9.0, 28000, 27000, 15000, 28000, 16000],
  [6, 12.0, 29000, 28000, 17000, 29000, 18000],
].map(([id, areaSqKm, adults, registered19, ballots19, registered23, ballots23]) => ({
  id, path: '', label: [id * 10, 10], areaSqKm, adults, population: Math.round(adults / 0.78),
  y2019: { registered: registered19, ballots: ballots19, topShare: 0.40, secondShare: 0.25 },
  y2023: { registered: registered23, ballots: ballots23, topShare: 0.42, secondShare: 0.27 },
}));
