# J2 Worker handoff, 2026-11-06

Uncommitted implementation on `server`. No deployment, live PayPal writes, live AI calls, secret uploads, or webhook registration were performed.

## Integration

- Replace the four fail-closed J2 stubs in `src/model/{allocate,explain,forceMove,types}.ts` with the model job's files. The signatures were checked against the completed model in `A:/Projects/wardwise/src/model/`.
- Supply `public/data/chicago.json` from the data job. The Worker imports that exact path; it never uses fixture city data. `src/server/city.d.ts` only permits isolated typechecking before data integration.
- Keep the existing `wrangler.jsonc` bindings: `CAMPAIGN`, `GATE`, `AI`, `LEDGER`, `ASSETS`, with SQLite migrations for both exported DO classes. Instances are `demo` and `gate`.
- The four secrets are `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYOUT_EMAIL_CREW`. Keep live `DEV_ROUTES=0`; local `.dev.vars` sets it to `1`. `LIVE_AI=1` enables ledger-reserved inference.
- No seeded sandbox transactions or real recorded AI answers were generated. The production store starts empty; fake PayPal ids occur only in test fixtures. Recorded assets, if supplied, are a JSON array of `{ key, text, date }` or `{ answers: [...] }`; compute the key with `answerKey` in `ai/ask.ts`. Missing recordings fall back to rules.

## Request and response contract

All money amounts in stored records are integer `cents`. `GET /api/state` has `wards[ward] = { funded, paid }` in dollars, `records` (last 30), `openItems`, caller-only `supporterTotal` in dollars, and `refundProposals`. It omits session ids and approval links from global records. Work log status `SUCCESS` has message `Paid`; pending and failed money stays visible. The donation response includes its own `approvalUrl` for the PayPal path.

POST bodies follow `docs/SPEC.md`; extra fields are rejected, including on pay/refund/cancel actions whose bodies must be empty. A payee key fixes the work kind and rate. The browser cannot select a recipient, role, work amount, or refund amount. Donation amounts are the fixed $10/$25/$50 choices. Move explanations accept only positive $50 steps within the source ward allocation.

The browser needs to render `answer.source`: `rules` as “Explained by rules”, `recorded` with the returned recording date, and `live`/`cache` as model explanations. Return pages finish or cancel then issue 303 redirects with `ward`, `result`, and an optional plain `message`.

## Recovery and caps

The DO wrapper and plain engine each serialize their actions with a promise queue. A write's operation id, exact body, request id, and status are persisted before its PayPal call. Known resource ids are recovered from saved operations after restart. Uncertain writes are never replayed; known resources are read. If an order-create response is lost before any resource id can be saved, its capture webhook supplies the order id. An unknown refund or payout id similarly waits visibly for a verified resource webhook; do not issue a new write to make it disappear.

Refund proposals reserve slices of the latest completed captures. Pending and failed refunds remain open and do not lower supporter totals. Work logs reserve plan dollars before payment, preventing multiple unpaid logs from overspending. The daily gate charges a slot before each new action; uncertain calls keep that slot. Sandbox requests cost $0. AI always reserves against the shared `ai_calls(app,day,neurons)` schema before calling the one permitted model, retains the full hold when usage is unknown, and falls back to rules on ledger failures.

RPC failures use plain result envelopes to preserve HTTP status across Cloudflare's error serialization. Webhooks are signature checked against the raw body, deduplicated only after successful resource reads, and cannot regress terminal state based on an old event body.

## Validation

119 tests pass across five server test files. `npm.cmd run typecheck` passes. The ordinary `npm.cmd test` is blocked in this restricted worktree by `EPERM` when Vite writes through the shared `node_modules` junction. The test-only alternative keeps its cache and API token in ignored `tests/helpers/.runtime`:

```powershell
npm.cmd test -- --config tests/helpers/sandbox.vitest.ts --configLoader runner
node tests/helpers/check-integration.mjs A:/Projects/wardwise
```

The integration helper reads the other checkout's completed model and real city JSON without copying or modifying them. It bundles the Worker in memory, checks real why/move templates and numeric rejection, and exercises a payout against the actual default plan using fake PayPal. The unit suite uses injected fetch/clock and in-memory stores; ledger concurrency tests execute the exact reservation SQL with in-memory SQLite. No external services are called.

`node --check dev/paypal_webhook.mjs` and Python source compilation validate helper syntax. Run browser and deployed binding checks after the remaining jobs are integrated; they were not part of the in-memory server run.
