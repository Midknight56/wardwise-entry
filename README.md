# WardWise

A small campaign's field budget, spread across Chicago's 50 wards by code you can check, funded and paid out with
PayPal.

WardWise plans door knocking and flyer money for a **fictional** citywide campaign in Chicago's Municipal General
Election on Tuesday, February 23, 2027. It uses real public numbers: official precinct results from the Chicago Board
of Election Commissioners (2019 and 2023) and Census estimates by ward from the City of Chicago Data Portal. Every
source is listed in [docs/SOURCES.md](docs/SOURCES.md).

All money in the app is PayPal sandbox test money.

## For judges

Live demo: **https://wardwise.midknight-labs.workers.dev** (no login, desktop or phone browser).

In about two minutes:

1. The page opens on the number: 1,014,591 registered Chicagoans did not vote in 2023. Each precinct is shaded by its
   non voters, and the campaign's $5,000 plan pours into the wards with the best estimated return per dollar. The
   vote figures are simulated estimates from assumed costs and lift; no extra votes have been measured.
2. Drag the budget slider to $2,000. A ward drops out and one line under the slider says why, with the numbers.
   Drag it to $25,000 and twenty wards light up in order. The campaign plan itself stays at $5,000.
3. Click **Ask why**, pick two wards, and read the answer. The tag says where it came from: Live AI, Cached AI answer,
   Recorded answer, or Explained by rules. Code computes the facts and checks every number in the answer before you
   see it; the AI only writes the explanation.
4. Click **Last election**. The same method, run on the 2019 results, is checked against what happened in 2023.
   Misses are outlined in red. The scorecard counts them. This shows how steady turnout is; it does not test what
   spending does.
5. Click a funded ward, then **Give $25**. This pays with PayPal's published sandbox test card, so it needs no login.
   A real sandbox capture appears with its id within a few seconds. Give $25, $50 and $50 from one browser and the
   app proposes a $25 refund over the $100 demo cap; a person approves it, and $100 stays donated. The cap is counted
   per browser, not per person.
6. Log work on that ward, then open the money trail. The payroll preview lists the exact batch code picked (up to 10
   checked logs, oldest first, inside the daily limit) and its total. Approve it and one PayPal Payouts batch pays
   exactly those items. Open **Evidence** on the payroll or a refund to trace each amount to PayPal's receipt.

**Give with PayPal** sends you to PayPal's sandbox to approve with your own sandbox buyer account (make one free in
the PayPal Developer dashboard). No judge login is needed for anything else: the test card buttons do the same job.

Daily limits protect the shared sandbox balance: 120 gifts (6 per browser), 40 refunds, 20 payouts and 30 work logs a
day across all visitors, reset at 00:00 UTC. When one is reached the app says so; the map, plan, questions and records
keep working.

What is made up, and labelled on screen: the campaign, its budget, the cost per contact, how many reached people vote,
the crew rates and the $100 demo cap. What is real: the wards, the results, the Census estimates, the election date
and every PayPal API call (sandbox).

WardWise uses only ward and precinct totals, with no voter level data and no race or ethnicity input. It keeps a
random browser id in a cookie and the sandbox records PayPal returns on the server; payee emails and PayPal response
bodies never reach the browser. It makes no claim about election law compliance.

## How it works

| Part | What it does |
| --- | --- |
| `tools/build_data.py` | Reads the official files in `data/raw/` and writes `public/data/chicago.json`: 50 ward shapes, 2023 precincts, turnout for 2019 (moved onto today's wards by precinct) and 2023, population and adults by ward |
| `src/model/` | Pure TypeScript. Scores each ward, splits the budget in $50 steps for the most expected new votes, runs the backtest, and builds the facts the agent may use |
| `src/server/` | Cloudflare Worker and Durable Objects. PayPal Orders v2, Payments v2 refunds, Payouts, webhooks, daily limits, and the AI cap |
| `src/web/` | The map (plain SVG), the budget slider, AG Grid and AG Charts |

The AI model is IBM Granite 4.0 H Micro on Cloudflare Workers AI. It only explains numbers that code gives it, and a
checker drops any answer with a number or ward that is not in those facts.

## Run it yourself

Needs Node 22 or later and Python 3.12 or later (only to rebuild the data).

```bash
npm install
npm test
npm run build:web
```

To run the Worker locally you need your own PayPal sandbox REST app and a Cloudflare account (both free).

1. Copy `.dev.vars.example` to `.dev.vars` and fill in your sandbox keys.
2. In `wrangler.jsonc`, add your `account_id`.
3. Make your own D1 database for the AI usage cap and create its table. In `wrangler.jsonc`, under `LEDGER`, set
   `database_name` to `wardwise-ledger` and `database_id` to the id the first command prints, in place of ours:

```bash
npx wrangler d1 create wardwise-ledger
```

```bash
npx wrangler d1 execute wardwise-ledger --remote --file=docs/ledger.sql
```

4. Start the Worker:

```bash
npx wrangler dev
```

Set `LIVE_AI` to `0` in both `wrangler.jsonc` and `.dev.vars` to run with no AI calls at all (a local run reads
`.dev.vars` first); the app then uses recorded answers and the code's own sentences.

The local site then opens on http://127.0.0.1:18823. With the local site running, the end to end tests use the
real PayPal sandbox (test money):

```bash
npx playwright test
```

To rebuild the data from the official files:

```bash
pip install xlrd shapely
python tools/build_data.py
```

## Licence

MIT, see [LICENSE](LICENSE). AG Grid Community and AG Charts Community are MIT. Data terms are in
[docs/SOURCES.md](docs/SOURCES.md), including the City of Chicago's data disclaimer, which the app shows on its About
panel.
