export const SETUP_COST = 300;
export const COST_MIN = 2.30;
export const COST_MAX = 2.60;
export const EASY_SHARE = 0.03;
export const LIFT = 0.05;
export const STEP = 50;
export const BUDGET_MIN = 1000;
export const BUDGET_MAX = 25000;
export const BUDGET_DEFAULT = 5000;
export const MISS_POINTS = 4;
export const ASSUMPTIONS: { key: string; value: number; label: string }[] = [
  { key: "SETUP_COST", value: SETUP_COST, label: "Each funded ward needs a crew kit and a first print run before the first door: $300" },
  ...([['COST_MIN', COST_MIN], ['COST_MAX', COST_MAX]] as const).map(([key, value]) => ({ key, value, label: "Cost per contact: $2.30 in the densest ward, $2.60 in the most spread out" })),
  { key: "EASY_SHARE", value: EASY_SHARE, label: "About 3 in 100 non voters are easy to reach (moved, missed one election). Returns fall after that." },
  { key: "LIFT", value: LIFT, label: "5 in 100 reached non voters vote because of the contact" },
  { key: "STEP", value: STEP, label: "The allocator moves money in $50 steps" },
  ...([['BUDGET_MIN', BUDGET_MIN], ['BUDGET_MAX', BUDGET_MAX], ['BUDGET_DEFAULT', BUDGET_DEFAULT]] as const).map(([key, value]) => ({ key, value, label: "Budget slider range" })),
  { key: "MISS_POINTS", value: MISS_POINTS, label: "A ward is a miss when real turnout was more than 4 points from the forecast" },
];
