// Sandbox PayPal costs $0. These daily ceilings protect its shared test balance.
export const DEMO_CAP = 100;
export const DONATION_CHOICES = [10, 25, 50] as const;
export const DONATIONS_PER_SUPPORTER = 6;
export const DONATIONS_PER_DAY = 120;
export const REFUNDS_PER_DAY = 40;
export const PAYOUTS_PER_DAY = 20;
export const WORKLOGS_PER_DAY = 30;
export const WORKLOG_UNITS_MAX = 400;
export const WORKLOG_DOLLARS_MAX = 60;
export const DOOR_RATE_CENTS = 25;
export const FLYER_RATE_CENTS = 10;
export const DEFAULT_BUDGET = 5000;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const APP = 'wardwise';
export const APP_CAP = 900;
export const ACCOUNT_CAP = 9500;
export const RESERVE = 8;
// $0: 900 + the other apps' caps stay under the account cap of 9,500,
// under the free 10,000 neurons a day; floor(900 / 8) = 112 calls at most.
export const INPUT_TOKEN_CAP = 2500;
export const OUTPUT_TOKEN_CAP = 220;
export const AI_TIMEOUT_MS = 8000;
