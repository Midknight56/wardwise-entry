# J3 screen handoff

Implemented 2026-11-06 on `web`. No commit. No server, model, data, package, or build configuration edits.

## Files

- `main.ts`: screen shell, SVG ward and precinct map, local allocation on slider input, backtest, ward sheet, AI questions, action routing, visible-tab money polling every 15 seconds, return toasts and keyboard handling.
- `grid.ts`: AG Grid 34 Community with Quartz palette and sorting/filtering/selection; AG Charts 12 Community plan bars.
- `money.ts`: donation, refund and work records, truthful status chips, own-refund approval, payout actions, copyable PayPal ids and expandable receipts.
- `api.ts`: JSON requests and exact server-derived TypeScript response types. Public payee keys and labels mirrored from the server allow list.
- `helpers.ts`: heat buckets, formatters, default comparison wards and PayPal return messages.
- `about.ts`: six-step method, model assumptions, additional campaign/work/cap assumptions, linked sources, verbatim City disclaimer.
- `../../public/index.html`, `styles.css`, `favicon.svg`: entry document, three Google Fonts, responsive paper/ink/teal UI and ward outline favicon.
- `../../tests/web.test.ts`: Node-only helper, API boundary, money presentation and disclaimer tests.

## Verified

- `npm.cmd run build:web`: passes. Uses the existing esbuild command and generates ignored `public/app.js` and its source map.
- `npm.cmd run typecheck`: passes.
- All 366 tests in 7 files pass with `npm.cmd test -- --configLoader native --maxWorkers=2 --no-cache`. Standard config bundling cannot write into the shared `node_modules` junction in this sandbox. For the passing run, `LOCALAPPDATA` was set for that command only to `src/web/.validation/`, so Vitest could create its API token.
- Temporary headless Chrome check against a local static server and mocked API: 50 SVG wards; budget $5,000 to $2,000 and drop explanation; backtest outlines and scorecard; map/grid selection; $25 donation; own refund approval; unclaimed work payout and cancellation; rules answer; About; all phone tabs; cancelled PayPal return. No application console warnings or errors.
- No horizontal page overflow at widths 360, 390, 760, 761, 1024, 1440 and 1920. Desktop and phone screenshots were inspected. The map uses 60% of phone height as required by SPEC, which takes precedence over the job's 55% figure.
- Google Fonts requests are denied by this sandbox. Visual review used system fallbacks; all three requested families are loaded by the entry HTML when the network allows them.
- Live PayPal and live AI were not exercised. No outward money actions or deployment occurred. The temporary browser and local server were closed.
- The tool policy rejected both recursive cleanup and explicit file removal with `blocked by policy`. Review screenshots, the temporary browser script, and Vitest/npm state remain in `src/web/.validation/`, excluded by `src/web/.gitignore`. This local validation directory must not be committed.

## Existing server shape limits

- `/api/state` does not return a payee catalog. `api.ts` mirrors the three existing public keys and labels; it contains no recipient addresses and sends no rates or amounts for work. A catalog added later should replace this mirror.
- Completed history is limited to the last 30 records globally. The ward card merges that window with all open items, the caller's refund proposals, and actions returned during this page session. Older completed ward records cannot be recovered with the existing routes; the card labels the available history.
- Records have no kind field. Presentation derives Work from `payee`, Refund from `donationId`, and Donation otherwise. Amounts use `cents / 100`; receipt `debugId` is displayed as `debug_id`.
- PayPal returns use `completed` in the current router, rather than the job's `captured`; the browser accepts both. Payout cancellation uses its own status toast instead of the donation cancellation message.
