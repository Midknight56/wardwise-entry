export interface Turnout { registered: number; ballots: number }
export interface Ward {
  id: number;
  path: string;
  label: [number, number];
  areaSqKm: number;
  population: number;
  adults: number;
  y2023: Turnout & { topShare: number; secondShare: number };
  y2019: Turnout & { topShare: number; secondShare: number };
}
export interface Precinct { ward: number; precinct: number; path: string; registered: number; ballots: number }
export interface CityData {
  city: "Chicago";
  election: { name: "Municipal General Election"; date: "2027-02-23"; source: string };
  viewBox: [number, number, number, number];
  totals: { y2023: Turnout; y2019: Turnout };
  wards: Ward[];
  precincts: Precinct[];
  backtestCrosswalk: { precincts2019: number; matched: number; unmatched: number; registeredMatchedShare: number };
  builtAt: string;
}
export type Base = "y2019" | "y2023";
export interface Plan { perWard: Record<number, number>; votes: Record<number, number>; total: number }
export interface Scorecard {
  wardCount?: number;
  meanAbsErrorPoints: number;
  misses: number;
  funded: number;
  fundedStillTop10: number;
  rankCorrelation: number;
}
export interface BacktestResult {
  perWard: Record<number, { forecast: number; actual: number; errorPoints: number; miss: boolean;
    funded2019: boolean; nonVoters2023Rank: number; planMiss: boolean }>;
  scorecard: Scorecard;
}
