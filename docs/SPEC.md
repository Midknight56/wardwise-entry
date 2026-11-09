# WardWise build spec

The contract for every job. Where a job file and this file disagree, this file wins. Sources: `docs/SOURCES.md`.

## The product in one paragraph

A fictional citywide campaign ("Candidate A", no party, no office named beyond "citywide race") has a fixed field
budget for Chicago's Municipal General Election on Tuesday, February 23, 2027. WardWise spreads that budget over
Chicago's 50 wards to win the most new votes from people who are registered but did not vote last time. Code does
every number. An AI model only explains the numbers code gives it, and its answer is checked. Supporters give to one
ward's plan with PayPal (sandbox). Money over a labelled $100 demo cap is partly refunded after a person approves.
Crews and vendors are paid by PayPal Payouts only for work code has checked against the plan. A backtest runs the same
method on the 2019 election and checks it against what really happened in 2023, with the misses in red.

Labels that must appear on screen: "Fictional campaign", "Sandbox test money", "Demo cap", "Assumption" next to every
made up number, "Recorded answer" on any AI answer that did not come from a live call.

Never: real candidate names in the UI, party names or party colours (no red versus blue scheme), personal data, race
or ethnicity inputs, any claim of election law compliance.

## Stack

- Cloudflare Worker (TypeScript) with static assets from `public/`. Hackathon account, Worker name `wardwise`, URL
  `https://wardwise.midknight-labs.workers.dev`.
- One Durable Object class `CampaignDO` (SQLite storage), one instance named `"demo"`, holds every money record and
  serializes every money action with a promise queue (outgoing fetches let requests interleave; the input gate is not
  enough). A second class `GateDO` (one instance `"gate"`) holds the daily counters and the AI answer cache.
- Workers AI binding `AI`, model `@cf/ibm-granite/granite-4.0-h-micro` only.
- The shared D1 neuron ledger `hackathon-ledger` (binding `LEDGER`, remote) for the AI cap.
- Front end: TypeScript bundled by esbuild into `public/app.js`. Map is hand drawn SVG from bundled paths (no map
  tiles, no map library). Grid: `ag-grid-community` (MIT). Chart: `ag-charts-community` (MIT).
- Tests: vitest (unit, in memory, injected fetch and clock), Playwright (headless e2e against `wrangler dev` and,
  separately, the live URL).

Folders: `tools/` (Python data build), `src/model/` (pure scoring code, shared by Worker and browser), `src/server/`
(Worker, DOs, PayPal, AI), `src/web/` (browser), `public/` (static files and `public/data/chicago.json`), `tests/`,
`e2e/`, `dev/` (helper scripts), `docs/`.

## Data file: `public/data/chicago.json`

Built by `python tools/build_data.py` from `data/raw/`. Shape (TypeScript type `CityData` in `src/model/types.ts`):

```ts
interface CityData {
  city: "Chicago";
  election: { name: "Municipal General Election"; date: "2027-02-23"; source: string };
  viewBox: [number, number, number, number];        // SVG viewBox of all paths, e.g. [0, 0, 1000, 1300]
  totals: { y2023: Turnout; y2019: Turnout };        // city totals as printed in the official files
  wards: Ward[];                                     // exactly 50, id 1..50
  precincts: Precinct[];                             // 2023 precincts (about 1,290)
  backtestCrosswalk: { precincts2019: number; matched: number; unmatched: number; registeredMatchedShare: number };
  builtAt: string;                                   // ISO time of the build
}
interface Turnout { registered: number; ballots: number }
interface Ward {
  id: number;                                        // 1..50
  path: string;                                      // SVG path, simplified, in viewBox units
  label: [number, number];                           // a point inside the ward for its number
  areaSqKm: number;                                  // from the ward polygon (equal area projection)
  population: number;                                // ACS 2023 5 year, City ward table
  adults: number;                                    // ACS age bands 18 and over
  y2023: Turnout & { topShare: number; secondShare: number };  // mayor first round, shares 0..1 of valid votes
  y2019: Turnout & { topShare: number; secondShare: number };  // 2019 precincts moved onto 2023 wards (see below)
}
interface Precinct { ward: number; precinct: number; path: string; registered: number; ballots: number }
```

Rules for the build:

- Read the five Board spreadsheets with `xlrd` (`ignore_workbook_corruption=True`; the files need it). Each file:
  a city total block, then per ward a "Ward N" row, a header row, one row per precinct, a "Total" row. Check that the
  sum of precinct rows equals each ward's Total row and the city total; fail loudly if not.
- 2019 mayor: the Board splits 14 names over two files. Add the two files per precinct (the "Total Voters" column of
  each file counts only its own names, so total = sum of all 14 name columns). Keep only the top two shares per ward.
  Never write a candidate name into the output.
- 2019 onto 2023 wards: for each 2013-2022 precinct polygon take `representative_point()`, find the 2023 ward polygon
  that contains it, and add that precinct's 2019 counts to that ward. Record matched and unmatched counts and the
  share of 2019 registered voters matched. Fail if under 99%.
- Projection: equirectangular centred on Chicago (x = lon times cos(41.84 deg), y = minus lat), scaled to a viewBox
  1000 wide. Simplify wards to about 1 m on the ground tolerance equivalent of 0.0002 deg and precincts 0.0003 deg,
  keep topology good enough that wards do not show gaps at 1440 px. Round coordinates to 1 decimal. Target file size
  under 900 KB.
- ACS: only `total_population` and the age band columns. Drop every race and ethnicity column. A test asserts no key
  in the output contains "white", "black", "asian", "hispanic", "latino", "race".
- Print a short summary: per ward registered and ballots for both years, city sums, file size.

## The model (`src/model/`, pure functions, no I/O)

Tuning note (6 Nov 2026, on the real data): with a wide cost spread ($1.60 to $3.00) and a large easy pool (10%), votes
grew almost in step with contacts, so the cheapest (densest, downtown) wards took everything and the size of the non
voter pool hardly mattered. Dense high rises are not really cheaper to canvass, so the spread is now small and the easy
pool saturates. Result at these values: $5,000 funds wards 2, 9, 21, 27; $2,000 keeps 2 and 21; the 2019 backtest
funds 4 wards and 3 were still top 10 non voter pools in 2023.

All constants live in `src/model/assumptions.ts`, each with a one line label shown in the UI as "Assumption".

| Constant | Value | Label |
| --- | --- | --- |
| `SETUP_COST` | 300 | "Each funded ward needs a crew kit and a first print run before the first door: $300" |
| `COST_MIN`, `COST_MAX` | 2.30, 2.60 | "Cost per contact: $2.30 in the densest ward, $2.60 in the most spread out (more walking between doors)" |
| `EASY_SHARE` | 0.03 | "About 3 in 100 non voters are easy to reach (voted recently, missed this one). Returns fall after that." |
| `LIFT` | 0.05 | "5 in 100 reached non voters vote because of the contact" |
| `STEP` | 50 | "The allocator moves money in $50 steps" |
| `BUDGET_MIN`, `BUDGET_MAX`, `BUDGET_DEFAULT` | 1000, 25000, 5000 | Budget slider range |
| `MISS_POINTS` | 4 | "A ward is a miss when real turnout was more than 4 points from the forecast" |

Functions (names fixed, tests call them):

- `forecastTurnout(ward, base: "y2019" | "y2023") = ballots / registered` of that year (persistence: last time is the
  forecast). Returns 0..1.
- `nonVoters(ward, base) = registered - ballots` of that year.
- `densityScore(wards)`: adults per km2, min max scaled to 0..1 across the 50 wards (1 = densest).
- `costPerContact(ward, wards) = COST_MAX - (COST_MAX - COST_MIN) * densityScore`.
- `expectedVotes(ward, spend, base, wards)`: 0 when `spend < SETUP_COST`. Else
  `contacts = (spend - SETUP_COST) / costPerContact`, `pool = EASY_SHARE * nonVoters`,
  `votes = LIFT * pool * (1 - exp(-contacts / pool))`. Concave after setup.
- `allocate(budget, base, wards) -> { perWard: Record<id, dollars>, votes: Record<id, number>, total: number }`.
  Budget is rounded down to a multiple of `STEP`. Greedy in `STEP` units by marginal votes per dollar, where opening
  a new ward is valued as its best average return over any first chunk `SETUP_COST + k*STEP` that fits the budget
  left (so a fixed cost does not block a good ward). Ties break on the lower ward id. Every funded ward gets at least
  `SETUP_COST + STEP`. The sum of `perWard` equals the rounded budget exactly. Test: on random 6 ward cases with
  small budgets, the result is within 1% of the brute force best and never worse than the best single ward plan.
- `explainDrop(before, after)`: when a slider move removes a ward, returns the facts code needs for one line: the ward,
  its dollars before, the marginal votes per $100 of the last step it held versus the ward that kept money. Used for
  the instant line under the slider (no AI).
- `compareWards(a, b, plan, base, wards)`: the facts for "why A and not B": dollars, non voters, cost per contact,
  votes per $100 at the current plan, setup cost, turnout last time, top two share gap (context only, see below).
- `backtest(wards, budget)`: runs `allocate(budget, "y2019")` and compares with 2023 reality. Returns per ward
  `{ forecast, actual, errorPoints, miss: |errorPoints| > MISS_POINTS, funded2019, nonVoters2023Rank }` and a scorecard
  `{ meanAbsErrorPoints, misses, funded, fundedStillTop10, rankCorrelation }` where `fundedStillTop10` counts funded
  wards that were still among the 10 largest non voter pools in 2023 and `rankCorrelation` is Spearman between 2019
  and 2023 non voter counts. A funded ward that fell out of the top 10 is a plan miss (red too).

**Why past margin is shown but not used.** The race is citywide: a new vote in a close ward counts the same as one in
a lopsided ward. So the top two share gap is context on the ward card and in the agent's facts, never a weight. The
agent can say so when asked.

## Money (PayPal sandbox only, `https://api-m.sandbox.paypal.com`)

Every amount and every recipient comes from server code and the server allow list. The browser sends only ids and
choices from fixed lists. Each write is stored as an operation intent (op id, kind, body, PayPal-Request-Id, status)
before it is sent. A lost answer is reconciled by reading the resource (never a second order or payout).

### Donations

- `POST /api/donations` `{ ward: 1..50, amount: 10 | 25 | 50, method: "card" | "paypal" }`.
- `card`: create the order with `payment_source.card` = PayPal's published sandbox test Visa `4111111111111111`,
  expiry `2030-12`, security code `123`, name "Test Supporter", a US billing address (comment: published test number
  only). With `intent: CAPTURE` and a card source the create call itself captures: proven 6 Nov 2026, order
  `61479712H2699180S` answered 201 `COMPLETED` with capture `0A080060NS265914X` `COMPLETED` inside
  `purchase_units[0].payments.captures[0]`. If the create answer is not COMPLETED, read the order and, if it is
  `APPROVED`, capture it. Judges need no login. `paypal`: create the order with an approval link (return and
  cancel URLs on our site); the return page captures. The sandbox buyer login for that path is in the README.
- Order body: `intent: CAPTURE`, one purchase unit, USD, `custom_id: "ww-<donationId>"`, item
  `{ name: "Ward <n> field plan (fictional campaign)", category: "DONATION", quantity: "1" }`,
  description "Fictional campaign demo. Sandbox test money."
- After capture: `GET /v2/payments/captures/{id}` confirms. Only `COMPLETED` fills the ward bar. `PENDING` shows
  "Pending at PayPal" and does not count. Declined or cancelled: no record counts, the message says so.
- Each browser has an `ww_sid` cookie (random, http only). It is one "test supporter".

### The demo cap and the partial refund

- `DEMO_CAP = 100` dollars per supporter (labelled "Demo cap, made up for this demo, not a legal limit").
- Only real sandbox captures count toward the cap. Example: $50, $50 and $25 with the test card make $125, so the
  server proposes a $25 refund on the last capture.
- When a supporter's completed total passes the cap, the server proposes a refund of the
  excess, taken from the supporter's most recent completed capture, never more than that capture's unrefunded amount
  (split over two captures if needed). Status "Waiting for a person to approve".
- `POST /api/refunds/:id/approve` (the button "Approve refund") sends
  `POST /v2/payments/captures/{id}/refund` with `amount: { value, currency_code: "USD" }`, `custom_id`, and a
  `note_to_payer` "Over the demo cap of $100 (fictional campaign)". Then `GET /v2/payments/refunds/{id}`. `PENDING`
  and `FAILED` stay visible as open items.

### Work logs and Payouts

- Allow list (server only, `src/server/payees.ts`): three payees, each a label, a role and a sandbox email:
  `crew-north` "North Side door crew (sandbox)" -> the sandbox buyer account email from the secret
  `PAYOUT_EMAIL_CREW`; `print-shop` "Ward print shop (sandbox)" -> the same secret (PayPal sandbox has one personal
  account for us); `crew-unclaimed` "New crew, no PayPal account yet (sandbox)" -> `crew-unclaimed@example.com`
  (a payout to an address with no PayPal account stays UNCLAIMED; it shows the held path and can be cancelled).
- Rates (assumptions): door crew $0.25 per door, print shop $0.10 per flyer.
- `POST /api/worklogs` `{ ward, payee, units }`. Code checks: the ward is funded in the campaign plan, which is
  fixed at the default budget of $5,000 (else "Ward 9 is not in the campaign's $5,000 plan."); units are whole, 1..400; the payee's role fits the work kind; amount = units x rate is at most the
  ward's unpaid plan dollars and at most $60 per log. Rejections name the rule.
- `POST /api/worklogs/:id/pay` sends `POST /v1/payments/payouts` with `sender_batch_id: "ww-<worklogId>"`,
  `sender_item_id: "ww-<worklogId>-1"`, `recipient_type: EMAIL`, `amount: { value, currency: "USD" }`. Then reads
  `GET /v1/payments/payouts/{batch}` and `GET /v1/payments/payouts-item/{item}`. The log shows "Paid" only on item
  status `SUCCESS`. `UNCLAIMED`, `PENDING`, `ONHOLD`, `BLOCKED`, `FAILED`, `RETURNED`, `REFUNDED` show as they are.
  `POST /api/worklogs/:id/refresh` reads again. `POST /api/worklogs/:id/cancel` sends
  `POST /v1/payments/payouts-item/{id}/cancel` only when the item is `UNCLAIMED`.
- Payroll (what the screen uses): `POST /api/payroll/pay` (no body fields) takes every work log in status `READY`,
  oldest first, at most 10, consumes the daily payout gate once per item, saves the payroll and its
  PayPal-Request-Id, then sends ONE `POST /v1/payments/payouts` with `sender_batch_id: "ww-pr-<payrollId>"` and one
  item per work log (`sender_item_id: "ww-<worklogId>-1"`). It reads the batch and matches each item to its log by
  `sender_item_id`. The payroll's status comes from its items: `PAID` when all are `SUCCESS`, `PARTLY_PAID` when some
  are, `CHECKING` while none is final. A lost answer is replayed with the same request id within 3 hours, else
  `NEEDS_REVIEW`. A payroll that never reached PayPal frees its logs back to `READY`. `POST /api/payroll/:id/refresh`
  reads again. Pressing "Pay all ready" is the person's approval.
- The agent's payroll summary: `POST /api/ask` `{ kind: "payroll" }` builds facts from the READY logs (ward, payee,
  units, dollars, total) and the model summarises them for the person who approves; same checker and fallback.
- `POST /api/worklogs/:id/pay` (one payout per log) stays for older records; the screen no longer uses it.
- A duplicate `sender_batch_id` answer (400 `USER_BUSINESS_ERROR` with field `SENDER_BATCH_ID`) is reconciled by
  reading the original batch from the answer's link, never by a new id.

### Webhooks

- `POST /webhooks/paypal`: verify with `POST /v1/notifications/verify-webhook-signature` (raw body spliced in as
  is). Unverified: 400, no change. Ignore events whose resource `custom_id` (or payout `sender_item_id`) does not start
  with `ww-` (answer 200). Store event ids uniquely. Apply by reading the resource again, so duplicate and out of
  order events never move a record backwards. Events: PAYMENT.CAPTURE.COMPLETED, PAYMENT.CAPTURE.PENDING,
  PAYMENT.CAPTURE.DECLINED, PAYMENT.CAPTURE.REFUNDED, PAYMENT.REFUND.PENDING, PAYMENT.REFUND.FAILED,
  PAYMENT.PAYOUTS-ITEM.SUCCEEDED, PAYMENT.PAYOUTS-ITEM.UNCLAIMED, PAYMENT.PAYOUTS-ITEM.FAILED,
  PAYMENT.PAYOUTS-ITEM.CANCELED, PAYMENT.PAYOUTS-ITEM.HELD, PAYMENT.PAYOUTS-ITEM.BLOCKED,
  PAYMENT.PAYOUTS-ITEM.RETURNED.
- `dev/paypal_webhook.mjs` registers (or finds) the webhook for the live URL and prints only its id.

### Limits (a free visitor never costs money)

PayPal sandbox calls cost $0. Still, `GateDO` caps per UTC day: 6 donations per supporter, 120 donations total,
40 refunds total, 20 payouts total, 30 work logs total. Over a cap: 429 with a plain message. These protect the shared
sandbox balance and the other entries.

### Records shown to judges

`GET /api/state` returns, for the whole demo (not per supporter): per ward funded dollars (completed captures minus
completed refunds), paid dollars (SUCCESS payouts), the last 30 money records with their PayPal ids, statuses and a
"receipt" (method, path, HTTP status, debug_id, time) for each call, and the open items. Plus the caller's own
supporter total and refund proposals. Seeded records: the first live run's real sandbox ids are kept (no fake ids).

## AI (`src/server/ai/`)

- Model id constant `MODEL_ID = "@cf/ibm-granite/granite-4.0-h-micro"` in `src/server/ai/model.ts`. A test fails if
  the id is in `DEPRECATED_MODELS` (`@cf/meta/llama-3.2-3b-instruct`, `@cf/qwen/qwen3-30b-a3b-fp8`, both "Planned
  Deprecation 11/20/2026" on Cloudflare's pages, read 6 Nov 2026) or is not this exact id.
- Cost: granite-4.0-h-micro is 1,542 neurons per M input tokens and 10,158 per M output tokens (Cloudflare pricing
  page, 6 Nov 2026). Input capped at 2,500 tokens (prompt plus facts, counted as characters / 3.5 rounded up),
  `max_tokens: 220`. Worst case 2,500 x 1,542 / 1e6 + 220 x 10,158 / 1e6 = 3.86 + 2.23 = 6.09 neurons. Reserve
  `RESERVE = 8` before each call (retries reserve again).
- Daily cap: `APP_CAP = 900` neurons for app `wardwise`, `ACCOUNT_CAP = 9500` for all apps, in the shared ledger with
  one `INSERT ... SELECT ... WHERE app sum + reserve <= APP_CAP AND all apps sum + reserve <= ACCOUNT_CAP` (same
  table and columns as the other entries' `ai_calls`; read `A:/Projects/roomweft` or `A:/Projects/circlekeeper`
  `src/ai/ledger.ts`). $0 line beside the constants: "900 + the other apps' caps stay under the account cap of 9,500,
  under the free 10,000 neurons a day; 900 / 8 = 112 calls a day at most." Ledger unreachable or cap reached: no call.
- Endpoints: `POST /api/ask` `{ kind: "why", a, b, budget }` (why ward a and not ward b),
  `{ kind: "move", from, to, amount, budget }` (what happens if I move $amount), `{ kind: "more", ward, amount,
  budget }` (what $500 more buys in a ward), `{ kind: "plan", budget }` (the one line plan summary under the slider)
  and `{ kind: "payroll" }` (above). Budgets are $1,000 to $25,000 in $50 steps. Code computes the facts with
  `compareWards` / a re-run of the allocator with the move forced; the model gets only those facts and must answer in
  at most 3 short sentences. A checker extracts every number in the answer; each must appear in the facts (allowing
  rounding to whole numbers and "$" or "%"); ward numbers must be a or b (or from or to). The prompt lists the numbers the model may use. The checker also
  binds each dollar amount to its ward, checks every comparison ("larger non voter pool (A vs B)", "lower cost per
  contact"), rejects a higher cost per contact given as a reason to win, and rejects a wrong setup cost or rate. Code
  gives the model the main reason in words for "why". A rejected answer is logged (`ai_reject`) and asked once more;
  a second failure, a timeout
  (8 s), a cap, or an error -> the template answer built by code from the same facts, labelled "Explained by rules".
- Cache: answers keyed by `(kind, a, b, budget)` for 24 h in `GateDO`, so many judges share one call.
- Recorded answers: `public/data/recorded-answers.json` holds real model answers captured on the build day for the
  first screen's questions, labelled "Recorded answer, <date>"; shown when live AI is off (`LIVE_AI` var not "1").
- The slider's one line is always code (`explainDrop`), never AI.

## Screens

One page, full screen map. Its own look: warm paper background `#F3EFE6`, ink `#1E2A33`, heat from pale sand
`#EFE6D2` to deep teal `#0E5C61`, money gold `#B8862B`, misses vermilion `#D2462E` (used only for misses). Fonts:
"Fraunces" for headings, "IBM Plex Sans" for text, "IBM Plex Mono" for numbers (Google Fonts). No party colours.

1. **Top bar**: "WardWise", "Chicago, Municipal General, Feb 23, 2027", chips "Fictional campaign" and
   "Sandbox test money". An About button.
2. **Map** (most of the screen): the heading is the number from the data, "1,014,591 registered Chicagoans did not
   vote in 2023". The 1,291 precincts are filled by registered non voters (5 quantile buckets). Funded wards get a
   teal fill and outline on top. On first load the $5,000 plan pours in, ward by ward in the order the allocator
   funded them, while the counters run up (skipped with reduced motion). Funded wards show a thin gold bar for
   donations against plan. Three start buttons: "1 Drag the budget", "2 Ask why", "3 Give $25, test card, no login".
3. **Budget panel**: a chip "Campaign plan: $5,000" (the money always follows this plan) and a slider "Explore a
   budget" from $1,000 to $25,000, with "Back to the campaign plan" when it is moved. Total expected new votes, about
   $X per expected vote, the one line under the slider when a ward drops or joins, and the plan line (the agent's one
   line summary, tagged). Buttons "Ask why" and "What would $500 more buy".
4. **Mode toggle**: "Plan 2027" / "Last election". Last election shows the backtest: wards filled by forecast error,
   red outlines on misses, and the scorecard (mean error, misses, funded wards still top 10, rank correlation) with
   a one line honest summary written by code. The forecast is said plainly (2023 turnout equals 2019 turnout), and a
   panel lists the wards the 2019 plan would have picked with each ward's turnout change beside the city's.
5. **Ward card** (drawer on desktop, bottom sheet on phone): campaign plan dollars and expected votes (plus the
   explored budget's line while exploring), donations (list with PayPal ids and status), refund proposals, work logs
   ("Paid from Payroll"), then a closed "Ward facts" with non voters, cost per contact (Assumption), votes per $100,
   setup, turnout 2019 and 2023. Buttons: Give $10 / $25 / $50 (test card), Give with PayPal (sandbox login), Log
   work, Approve refund.
6. **Grid** (below the map on desktop, a tab on phone): AG Grid of the 50 wards: ward, plan $, expected votes,
   votes per $100 (the default sort), non voters, cost per contact, turnout change, funded $, paid $, backtest error,
   miss. Plan $ draws a small bar. "Download the plan (CSV)" saves the funded wards at the budget on screen. Sorting
   and a row click
   selects the ward on the map and the map click selects the row. An AG Charts bar chart of plan $ by ward.
7. **Money log**: the Payroll panel on top (ready, paid and unclaimed counts, the agent's summary, "Pay all ready",
   then each payroll with its status, batch id and one row per item), then "Your records" (this browser's), then
   "Everyone's records" (the last 30, closed by default), each with PayPal ids and receipts.
8. **About**: the method in 6 lines, every assumption with its value, the sources (link to SOURCES), the City's data
   disclaimer text (exact words from SOURCES.md), "No personal data. No race inputs. Fictional campaign. Not a
   statement of election law compliance."

Phone width (390 px): map on top (60% height), tabs below: Plan, Grid, Money, About. Every control 16 px inside the
screen, 12 px between neighbours, text inside buttons with 8 px padding.

## Failure paths (each has a unit test; the ones marked e2e also run headless)

| Failure | Expected result |
| --- | --- |
| Buyer cancels the PayPal approval (e2e) | No record counts, message "You cancelled. No money moved." |
| Card declined (`PayPal-Mock-Response` `INSTRUMENT_DECLINED` via `?declineTest=1` only when `DEV_ROUTES=1`) | "Declined by PayPal. No money moved." |
| Capture answer lost (dev fault `lose_next_response`) | "Checking payment", read the order, apply the real state, no second order |
| Capture PENDING | Bar does not fill, "Pending at PayPal" |
| Refund PENDING or FAILED | Open item stays, cap excess still owed |
| Payout item FAILED, UNCLAIMED, ONHOLD, BLOCKED | Log not marked paid; real status shown; cancel only on UNCLAIMED (e2e: unclaimed and cancel) |
| Duplicate webhook | Second event id ignored, no second change |
| Out of order webhook | Resource read again, state never moves back |
| Bad webhook signature | 400, no change |
| Browser changes amount, ward, payee or recipient (e2e) | 400 with the rule named; recipient is never accepted from the browser |
| Work log over plan or over $60 | 400 with the rule named |
| Two concurrent captures or payouts of the same record | One PayPal write |
| AI over cap, ledger down, timeout, bad numbers | Template answer, labelled |
| Daily gate caps | 429 with a plain message |

Dev fault route: `POST /api/dev/fault` `{ kind: "lose_next_response" | "pending_next_capture" }`, live only when
`DEV_ROUTES === "1"` (404 otherwise). `lose_next_response`: the next PayPal write is sent, its answer is thrown away.
`pending_next_capture`: the next capture read is treated as PENDING (sandbox cannot make one on demand).

## The 60 second judge path (no login)

Open the URL. The number appears and the $5,000 plan pours in. Drag the slider to $2,000: a ward drops, the line
says why; drag to $25,000: twenty wards. Ask why, tagged Live AI. Click "Last election": red outlines, the scorecard
and the wards 2019 would have picked. Click a funded ward and "Give $25 (test card)": a real sandbox capture appears
with its id. Open Money: the Payroll panel, one Payouts batch with an item per work log.

## Secrets (Worker secrets, never in git)

`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYOUT_EMAIL_CREW`. Vars: `PAYPAL_BASE`, `LIVE_AI`,
`DEV_ROUTES` ("0" live), `BUILD_TAG`.
