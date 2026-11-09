import { allocate } from '../model/allocate';
import { BUDGET_DEFAULT, BUDGET_MIN, BUDGET_MAX, SETUP_COST, STEP } from '../model/assumptions';
import { backtest, backtestPicks, summaryLine } from '../model/backtest';
import { compareWards, explainDrop } from '../model/explain';
import { costPerContact, forecastTurnout, nonVoters } from '../model/score';
import type { CityData, Plan } from '../model/types';
import { api, emptyState, type Answer, type MoneyRecord, type MoneyState } from './api';
import { aboutContent, BACKTEST_LIMIT, ESTIMATE_LIMIT } from './about';
import { defaultWardPickers, decimal, dollars, ERROR_HEAT, escapeHtml as e, foldKey, heatBucket, integer, nonVoterTotal, percent, planCsv, pourFrame, PRECINCT_HEAT, precinctBreaks, precinctBucket, returnMessage, summaryMatches } from './helpers';
import { renderMoneyLog, renderRecord } from './money';
import { WardTable } from './grid';

// Worker globals also declare Element. The cast keeps HTMLSelectElement's DOM
// remove(index) overload from conflicting with that unrelated server interface.
const $ = <T = HTMLElement>(selector: string) => document.querySelector(selector)! as unknown as T;
const button = (action: string, label: string, testid = action, extra = '') => `<button data-action="${action}" data-testid="${testid}" ${extra}>${label}</button>`;
const assumption = '<span class="chip assumption">Assumption</span>';
let city: CityData;
let budget = BUDGET_DEFAULT;
let plan: ReturnType<typeof allocate>;
let campaignPlan: ReturnType<typeof allocate>;
let history: ReturnType<typeof backtest>;
let oldPlan: Plan;
let mode: 'plan' | 'backtest' = 'plan';
let selected: number | undefined;
let lastDropped: number | undefined;
let lastPlanEvent = '';
let money: MoneyState = emptyState();
let stateReady = false;
let refreshInFlight: Promise<void> | undefined;
let lastStateJson: string | undefined;
let lastRenderedWard: number | undefined;
let askBusy = false;
let moneyBusy = false;
let grid: WardTable;
let askOpen = false;
let workPayee = '';
let historyWard: number | undefined;
let workUnits = '100';
let toastTimer: ReturnType<typeof setTimeout>;
let planTimer: ReturnType<typeof setTimeout>;
let planRequest = 0;
let nudgeTimer: ReturnType<typeof setTimeout>;
let rememberedFocus: Element | null = null;
let payrollSummary: Answer | undefined;
let lastPayrollReadyKey = '';
let pour: ReturnType<typeof pourFrame> | undefined;
let pourAnimation = 0;
let budgetAnimation = 0;
let detailAnimation = 0;
let pendingBudget = budget;
let historyBudget = budget;
let heatBreaks: number[];
const mobile = () => matchMedia('(max-width: 760px)').matches;

function toast(message: string, error = false) {
  const el = $('#toast'); el.textContent = message; el.classList.toggle('error', error); el.hidden = false;
  el.setAttribute('role', error ? 'alert' : 'status'); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 9000);
}
function setAskBusy(v: boolean) { askBusy = v; syncButtons(); }
function setMoneyBusy(v: boolean) { moneyBusy = v; syncButtons(); }
function syncButtons() {
  document.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach(el => {
    const action = el.dataset.action!;
    if (['give', 'give-paypal', 'approve-refund', 'log-work', 'pay', 'refresh', 'cancel', 'pay-all', 'payroll-refresh'].includes(action))
      el.disabled = moneyBusy || (el.dataset.needsState === 'true' && !stateReady) || (action === 'pay-all' && el.dataset.readyCount === '0');
    else if (['ask-submit', 'ask-move', 'ask-more'].includes(action))
      el.disabled = askBusy;
  });
  $('#app').setAttribute('aria-busy', String(askBusy || moneyBusy));
  $('#action-status').textContent = moneyBusy ? 'Checking the server…' : '';
}
function currentPlan() { return mode === 'plan' ? plan : oldPlan; }
async function refreshState() {
  if (refreshInFlight) return refreshInFlight;
  const requestedWard = selected;
  refreshInFlight = (async () => {
    try {
      const nextMoney = await api<MoneyState>('/api/state' + (requestedWard === undefined ? '' : `?ward=${requestedWard}`));
      const nextStateJson = JSON.stringify(nextMoney);
      const unchanged = nextStateJson === lastStateJson && requestedWard === lastRenderedWard;
      money = nextMoney; stateReady = true;
      historyWard = requestedWard;
      if (!money.payees.some(p => p.key === workPayee)) workPayee = money.payees[0]?.key ?? '';
      $('#state-status').textContent = 'Money synced ' + new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const currentReadyKey = money.payrollPreview?.version ?? '';
      if (currentReadyKey !== lastPayrollReadyKey) {
        lastPayrollReadyKey = currentReadyKey;
        payrollSummary = undefined;
        if ((money.payrollPreview?.count ?? 0) > 0) {
          const askedVersion = currentReadyKey;
          void (async () => {
            try {
              const answer = await api<Answer>('/api/ask', { kind: 'payroll' });
              // A late answer for an older batch, or for a batch the screen does not show yet, is dropped.
              if (!summaryMatches(answer.previewVersion, askedVersion, lastPayrollReadyKey)) return;
              payrollSummary = { ...answer, previewVersion: answer.previewVersion ?? askedVersion };
              const summaryEl = $('#payroll-summary');
              if (summaryEl) summaryEl.innerHTML = answerMarkup(answer);
            } catch (err) {
              if (askedVersion !== lastPayrollReadyKey) return;
              payrollSummary = undefined;
              const summaryEl = $('#payroll-summary');
              if (summaryEl) summaryEl.innerHTML = `<p class="muted">${e((err as Error).message)}</p>`;
            }
          })();
        }
      }
      if (unchanged) return;
      lastStateJson = nextStateJson;
      lastRenderedWard = requestedWard;
      const expanded = new Set([...$('#money-log').querySelectorAll<HTMLDetailsElement>('details[open]')].map(foldKey));
      const everyoneRecordsOpen = $('#money-log').querySelector<HTMLDetailsElement>('.everyone-records')?.open ?? false;
      const shownSummary = payrollSummary && summaryMatches(payrollSummary.previewVersion, '', money.payrollPreview?.version ?? '') ? payrollSummary : undefined;
      $('#money-log').innerHTML = renderMoneyLog(money, shownSummary ? answerMarkup(shownSummary) : '');
      for (const detail of $('#money-log').querySelectorAll<HTMLDetailsElement>('details'))
        if (expanded.has(foldKey(detail))) detail.open = true;
      const everyoneRecords = $('#money-log').querySelector<HTMLDetailsElement>('.everyone-records');
      if (everyoneRecords) everyoneRecords.open = everyoneRecordsOpen;
      renderCard(true); updateMap(); updateGrid(); syncButtons();
    } catch (error) {
      $('#state-status').textContent = 'Money sync unavailable'; toast((error as Error).message, true);
    }
  })().finally(() => {
    refreshInFlight = undefined;
    if (selected !== requestedWard) void refreshState();
  });
  return refreshInFlight;
}

function shell() {
  $('#app').innerHTML = `<header class="topbar"><div class="brand"><a class="wordmark" href="/" aria-label="WardWise home"><svg class="wordmark-ward" viewBox="0 0 32 32" width="18" height="18" aria-hidden="true"><path d="M7 5h13v5h6v12h-6v5H8V17H5V9h2Z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/></svg>WardWise</a>
    <span class="subtitle">Chicago · Municipal General · Feb 23, 2027</span></div><div class="top-chips"><span class="chip">Fictional campaign</span><span class="chip gold-chip">Sandbox test money</span></div>${button('about', 'About', 'about-open')}</header>
    <main class="workspace" data-tab="plan"><section class="map-column" aria-label="Chicago ward map and data">
      <div class="map-header"><div class="map-heading"><span class="eyebrow" id="map-kicker">50 WARDS · ONE CITYWIDE PLAN</span><h1 id="map-title">${integer(nonVoterTotal(city.wards))} registered Chicagoans did not vote in 2023</h1><p id="map-note">Start with a budget. See where it goes.</p></div>
      <div class="map-tools"><label class="ward-jump">Find ward <select data-testid="ward-picker" id="ward-jump"><option value="">Choose</option>${city.wards.map(w => `<option value="${w.id}">${w.id}</option>`).join('')}</select></label>${button('grid-toggle', 'Grid', 'grid-toggle', 'aria-controls="data-panel" aria-expanded="false"')}${button('plan-csv', 'Download the plan (CSV)', 'plan-csv')}</div>
      </div><div class="map-stage"><div class="map-canvas" id="map-canvas"></div><div id="map-tooltip" class="map-tooltip" role="tooltip" hidden></div>
      <div class="legend" id="legend"></div><span class="map-footnote">Chicago · 2023 ward boundaries</span></div>
      <section id="data-panel" class="data-panel panel" aria-label="Ward grid and plan chart" hidden><div class="data-toolbar"><h2>The ward ledger</h2><label class="search-label"><span class="sr-only">Filter wards</span><input id="grid-filter" data-testid="grid-filter" type="search" placeholder="Filter wards…"></label>${button('grid-toggle', 'Close grid', 'grid-close')}</div>
      <p class="grid-assumptions">${assumption} Plan $, expected votes, votes / $100 and cost / contact are model estimates.</p>
      <div class="data-body"><div id="grid" data-testid="grid" aria-label="50 ward comparison"></div><div class="chart-wrap"><h3>Plan dollars by ward</h3><div id="chart" data-testid="chart" aria-label="Plan dollars by funded ward"></div></div></div></section></section>
      <nav class="mobile-tabs" aria-label="Screens">${['plan', 'grid', 'money', 'about'].map(tab => button(`tab-${tab}`, tab[0].toUpperCase() + tab.slice(1), `tab-${tab}`, `aria-pressed="${tab === 'plan'}"`)).join('')}</nav>
      <aside class="sidebar"><div class="plan-controls"><section class="panel budget-panel"><div class="section-heading"><div><span class="eyebrow">THE FIELD BUDGET</span><h2>Put the plan to work.</h2></div><span class="chip assumption">Assumption</span></div>
      <p><span class="chip" data-testid="campaign-chip">Campaign plan: ${dollars(BUDGET_DEFAULT)}</span></p><label class="budget-label" for="budget">Explore a budget <output id="budget-value" class="mono" for="budget">${dollars(budget)}</output></label><input id="budget" data-testid="budget" type="range" min="${BUDGET_MIN}" max="${BUDGET_MAX}" step="${STEP}" value="${budget}">
      <div class="range-labels mono"><span>${dollars(BUDGET_MIN)}</span><span>${dollars(BUDGET_MAX)}</span></div>
      <div id="budget-reset"></div>
      <div class="plan-stats"><div>Expected new votes (simulated): <strong class="mono" id="expected-votes"></strong> ${assumption}<small id="cost-per-vote"></small></div><div>Funded wards: <strong class="mono" id="funded-wards"></strong></div></div><p class="estimate-limit" data-testid="estimate-limit">${ESTIMATE_LIMIT}</p>
      <div class="drop-note"><p id="drop-line" aria-live="polite">The best expected return after each ward’s setup cost.</p><span class="chip rules">Explained by rules</span></div>
      <div id="plan-line" data-testid="plan-line" aria-live="polite"></div>
      ${button('ask-why', 'Ask why', 'ask-why', 'aria-expanded="false" aria-controls="agent-box"')}<section id="agent-box" class="agent-box" hidden><h3>Question the allocation</h3><p class="muted">Uses the Plan 2027 numbers at this budget.</p><div class="picker-row"><label>Ward A<select id="ask-a" data-testid="ask-a"></select></label><label>Ward B<select id="ask-b" data-testid="ask-b"></select></label></div>
      <div class="button-stack">${button('ask-submit', 'Why A and not B?', 'ask-submit')}${button('ask-move', 'Move $500 from A to B', 'ask-move')}${button('ask-more', 'What would $500 more buy in A?', 'ask-more')}</div><p class="muted">A what if explanation. Your plan and money stay as shown.</p><div id="ask-answer" data-testid="ask-answer" aria-live="polite"></div></section></section>
      <section class="mode-section"><div class="mode-toggle" aria-label="Map mode">${button('mode-plan', 'Plan 2027', 'mode-plan', 'aria-pressed="true"')}${button('mode-backtest', 'Last election', 'mode-backtest', 'aria-pressed="false"')}</div>
      <div id="backtest-panel" class="panel backtest-panel" hidden><span class="eyebrow">A CHECK AGAINST REALITY</span><div id="scorecard" data-testid="scorecard"></div><p class="backtest-limit" data-testid="backtest-limit">${BACKTEST_LIMIT}</p><p>The forecast is simple: each ward's 2023 turnout equals its 2019 turnout.</p><p id="backtest-summary"></p><p class="muted">Same method, run on the 2019 results, checked against what happened in 2023.</p>
      <section data-testid="backtest-picks"><h3>The wards the 2019 plan would have picked</h3><p class="muted">At the default ${dollars(BUDGET_DEFAULT)} budget. Changes are percentage points.</p><div class="backtest-picks-scroll"><table><thead><tr><th scope="col">Ward</th><th scope="col">Turnout 2019</th><th scope="col">Turnout 2023</th><th scope="col">Ward change</th><th scope="col">City change</th></tr></thead><tbody>${backtestPicks(city.wards).map(row => `<tr><th scope="row">${row.ward}</th><td>${decimal(row.turnout2019)}%</td><td>${decimal(row.turnout2023)}%</td><td>${row.change > 0 ? '+' : ''}${decimal(row.change)} pt</td><td>${row.cityChange > 0 ? '+' : ''}${decimal(row.cityChange)} pt</td></tr>`).join('')}</tbody></table></div><p>We cannot know what the money would have done. We can show whether the ground moved under the plan.</p></section></div></section></div>
      <section class="panel ward-card" id="ward-card" data-testid="ward-card" aria-label="Selected ward" hidden></section>
      <section class="panel money-panel"><div id="money-log" data-testid="money-log"><h2>Money trail</h2><p>Loading sandbox records…</p></div><p id="state-status" class="muted" aria-live="polite">Connecting to the money ledger…</p></section></aside></main>
      <dialog id="about" data-testid="about" aria-labelledby="about-title">${aboutContent()}</dialog><div id="toast" data-testid="toast" class="toast" role="status" aria-live="polite" hidden></div><div id="action-status" class="sr-only" aria-live="polite"></div>`;
  // One stage owns the city and its story; CSS stacks them on phones.
  const stage = $('.map-stage'), story = document.createElement('div'), visual = document.createElement('div');
  story.className = 'stage-story'; visual.className = 'map-visual';
  for (const selector of ['#map-canvas', '#map-tooltip', '#legend', '.map-footnote', '.map-tools']) visual.appendChild($(selector));
  story.appendChild($('.map-heading')); story.appendChild($('.plan-controls'));
  $('.map-header').remove(); stage.appendChild(story); stage.appendChild(visual);
  $('.map-heading').insertAdjacentHTML('beforeend', `<div class="start-here" aria-label="Start here">${button('start-1', '1 Drag the budget')}${button('start-2', '2 Ask why')}${button('start-3', '3 Give $25, test card, no login')}</div>`);
}

function buildMap() {
  const labels = city.wards.map(w => `<g class="ward-label" data-label="${w.id}" transform="translate(${w.label.join(' ')})" pointer-events="none"><text text-anchor="middle" dy="3">${w.id}</text><rect class="fund-track" x="-10" y="6" width="20" height="3" rx="1.5"/><rect class="fund-bar" x="-10" y="6" width="0" height="3" rx="1.5"/></g>`).join('');
  $('#map-canvas').innerHTML = `<svg id="ward-map" viewBox="${city.viewBox.join(' ')}" aria-label="Chicago’s 50 wards. Tab to a ward and press Enter to select." xmlns="http://www.w3.org/2000/svg">
    <g class="precinct-heat" data-testid="precinct-layer" pointer-events="none">${city.precincts.map(p => `<path d="${p.path}" fill="${PRECINCT_HEAT[precinctBucket(p.registered - p.ballots, heatBreaks)]}"/>`).join('')}</g>
    <g class="ward-shapes">${city.wards.map(w => `<path d="${w.path}" data-ward="${w.id}" data-testid="ward-${w.id}" tabindex="0" role="button" aria-label="Ward ${w.id}" aria-pressed="false"/>`).join('')}</g>
    <path id="selection-outline" pointer-events="none" fill="none"/><g class="ward-labels">${labels}</g></svg>`;
}
function updateMap() {
  if (!city) return;
  const active = currentPlan();
  const canvas = $('#map-canvas');
  const mapScale = Math.min(canvas.clientWidth / city.viewBox[2], canvas.clientHeight / city.viewBox[3]);
  const max = mode === 'plan' ? Math.max(...Object.values(active.perWard)) : Math.max(...Object.values(history.perWard).map(r => Math.abs(r.errorPoints)));
  for (const ward of city.wards) {
    const path = $<SVGPathElement>(`[data-ward="${ward.id}"]`), row = history.perWard[ward.id];
    const bucket = heatBucket(mode === 'plan' ? active.perWard[ward.id] : Math.abs(row.errorPoints), max);
    const fraction = pour?.fractions[ward.id] ?? (pour ? 0 : 1);
    path.setAttribute('fill', mode === 'plan' ? (active.perWard[ward.id] ? '#0E5C61' : 'transparent') : ERROR_HEAT[bucket]);
    path.setAttribute('fill-opacity', String(mode === 'plan' ? .38 * fraction : .92));
    path.classList.toggle('funded', mode === 'plan' && active.perWard[ward.id] > 0 && fraction > 0);
    path.classList.toggle('miss', mode === 'backtest' && row.miss);
    path.classList.toggle('plan-miss', mode === 'backtest' && row.planMiss);
    path.setAttribute('aria-pressed', String(selected === ward.id));
    path.setAttribute('aria-label', `Ward ${ward.id}, plan ${dollars(active.perWard[ward.id])}, ${decimal(active.votes[ward.id])} expected votes${mode === 'backtest' ? `, error ${decimal(row.errorPoints)} points${row.miss ? ', miss' : ''}${row.planMiss ? ', plan miss' : ''}` : ''}`);
    const label = $<SVGGElement>(`[data-label="${ward.id}"]`);
    // Keep numbers and donation bars readable when the grid changes the map's height.
    if (mapScale > 0) label.setAttribute('transform', `translate(${ward.label.join(' ')}) scale(${1 / mapScale})`);
    label.classList.toggle('light-label', mode === 'backtest' && bucket >= 4);
    const funded = campaignPlan.perWard[ward.id] > 0;
    label.querySelectorAll('rect').forEach(el => el.setAttribute('visibility', funded ? 'visible' : 'hidden'));
    label.querySelector('.fund-bar')!.setAttribute('width', String(20 * Math.min(1, Math.max(0, (money.wards[ward.id]?.funded ?? 0) / (campaignPlan.perWard[ward.id] || 1)))));
  }
  const outline = $<SVGPathElement>('#selection-outline'); outline.setAttribute('d', city.wards.find(w => w.id === selected)?.path ?? '');
  $('#map-canvas').classList.toggle('backtest-map', mode === 'backtest');
  $('#map-canvas').dataset.budget = String(budget);
  const legend = mode === 'plan' ? `<span>Did not vote in 2023, per precinct</span><div class="precinct-key">${PRECINCT_HEAT.map((color, i) => `<div><i style="background:${color}"></i><span class="mono">${i === 0 ? '≤ ' + integer(heatBreaks[0]) : i === 4 ? '> ' + integer(heatBreaks[3]) : integer(heatBreaks[i - 1] + 1) + '–' + integer(heatBreaks[i])}</span></div>`).join('')}</div><small><i class="plan-key"></i> Planned dollars<br><i class="gold-key"></i> Donations / plan</small>`
    : `<span>Absolute forecast error</span><div class="legend-ramp">${ERROR_HEAT.map(color => `<i style="background:${color}"></i>`).join('')}</div><div class="legend-ends mono"><span>0 pt</span><span>${decimal(max)} pt</span></div><small><i class="miss-key"></i> Turnout miss<br><i class="miss-key dashed"></i> Funded in 2019, outside top 10</small>`;
  if ($('#legend').innerHTML !== legend) $('#legend').innerHTML = legend;
  $('#map-title').textContent = mode === 'plan' ? `${integer(nonVoterTotal(city.wards))} registered Chicagoans did not vote in 2023` : 'Look back. Show the misses.';
  $('#map-kicker').textContent = mode === 'plan' ? '50 WARDS · ONE CITYWIDE PLAN' : '2019 FORECAST · 2023 REALITY';
  $('#map-note').textContent = mode === 'plan' ? 'Start with a budget. See where it goes.' : 'Vermilion outlines mark the method’s misses.';
}
function renderBudget() {
  $('#budget-value').textContent = dollars(budget);
  $('#budget-reset').innerHTML = budget === BUDGET_DEFAULT ? '' : button('back-to-plan', 'Back to the campaign plan', 'back-to-plan');
  $('#expected-votes').textContent = decimal(pour?.votes ?? plan.total);
  $('#cost-per-vote').textContent = plan.total > 0 ? `about ${dollars((pour?.dollars ?? budget) / plan.total)} per expected vote` : '';
  $('#funded-wards').textContent = String(pour ? Object.values(pour.fractions).filter(v => v > 0).length : plan.order.length);
  const score = history.scorecard;
  $('#scorecard').innerHTML = [
    [decimal(score.meanAbsErrorPoints) + ' pt', 'Mean absolute error'], [String(score.misses), 'Turnout misses'],
    [`${score.fundedStillTop10} / ${score.funded}`, 'Funded still top 10'], [decimal(score.rankCorrelation, 2), 'Rank correlation'],
  ].map(([value, label]) => `<div><strong class="mono">${value}</strong><span>${label}</span></div>`).join('');
  $('#backtest-summary').textContent = summaryLine(score);
}
function updateGrid() {
  if (!grid || $('#data-panel').hidden) return;
  ensureHistory();
  const active = currentPlan(), base = mode === 'plan' ? 'y2023' : 'y2019';
  grid.update(city.wards.map(w => ({ ward: w.id, plan: active.perWard[w.id], votes: active.votes[w.id],
    return100: compareWards(w.id, city.wards.find(other => other.id !== w.id)!.id, active, base, city.wards).a.votesPer100,
    nonVoters: nonVoters(w, base), cost: costPerContact(w, city.wards), funded: money.wards[w.id]?.funded ?? 0,
    paid: money.wards[w.id]?.paid ?? 0, change: (forecastTurnout(w, 'y2023') - forecastTurnout(w, 'y2019')) * 100, error: history.perWard[w.id].errorPoints,
    miss: history.perWard[w.id].miss || history.perWard[w.id].planMiss })));
  if (selected) grid.select(selected, false);
}
function renderCard(preserveFocus = false) {
  const card = $('#ward-card');
  if (!selected) { card.hidden = true; return; }
  const focus = preserveFocus && card.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.testid : undefined;
  const factsOpen = preserveFocus && card.querySelector<HTMLDetailsElement>('#ward-facts')?.open;
  const historyOpen = preserveFocus && card.querySelector<HTMLDetailsElement>('.ward-history')?.open;
  const openedReceipts = new Set([...card.querySelectorAll<HTMLDetailsElement>('[data-record-id] details[open]')].map(foldKey));
  const ward = city.wards.find(w => w.id === selected)!, active = currentPlan();
  card.dataset.history = historyWard === selected ? 'ready' : 'loading';
  const records = historyWard === selected ? money.wardRecords ?? [] : [];
  const donations = records.filter(r => !r.payee && !r.donationId), work = records.filter(r => r.payee), refunds = records.filter(r => r.donationId);

  const openRefundIds = new Set((money.refundProposals ?? []).map(r => r.id));
  const openProposals = [...(money.refundProposals ?? []), ...records].filter((r, i, arr) =>
    r.ward === ward.id && r.donationId && r.status === 'PROPOSED' && openRefundIds.has(r.id) && arr.findIndex(x => x.id === r.id) === i
  );
  const openRefundsHtml = openProposals.map(r => renderRecord(r, money.refundProposals, money.payees)).join('');

  const myCandidateRecords = [
    ...(money.wardRecords ?? []),
    ...(money.records ?? []),
    ...(money.refundProposals ?? []),
    ...(money.openItems ?? []),
  ].filter((r, i, arr) => r.ward === ward.id && r.mine && arr.findIndex(x => x.id === r.id) === i);
  const myLatestRecords = myCandidateRecords.filter(r => !openProposals.some(p => p.id === r.id)).sort((a, b) => b.createdAt - a.createdAt);
  const latestMine = myLatestRecords[0];
  const latestMineHtml = latestMine ? `<section class="card-section"><h4>Your latest record</h4>${renderRecord(latestMine, money.refundProposals, money.payees)}</section>` : '';

  card.hidden = false;
  card.innerHTML = `<div class="section-heading"><div><span class="eyebrow">${mode === 'plan' ? 'PLAN 2027' : '2019 BACKTEST PLAN'}</span><h2 id="ward-title">Ward ${ward.id}</h2></div>${button('close-ward', 'Close', 'close-ward', 'aria-label="Close ward card"')}</div>
    <div class="ward-numbers"><div><strong class="mono">Campaign plan ${dollars(campaignPlan.perWard[ward.id])}</strong></div><div><strong class="mono" data-testid="campaign-ward-votes">${decimal(campaignPlan.votes[ward.id])}</strong><span>Expected votes ${assumption}</span></div></div>
    ${budget !== BUDGET_DEFAULT ? `<p class="muted explore-ward-plan">At ${dollars(budget)}: ${dollars(plan.perWard[ward.id])}, ${decimal(plan.votes[ward.id])} expected votes ${assumption}</p>` : ''}
    <section class="card-section"><h4>This browser</h4><p>This browser’s total: <strong class="mono" data-testid="supporter-total">${stateReady ? dollars(money.supporterTotal, true) : 'Loading…'}</strong></p><p><span class="chip gold-chip">Demo cap</span> <span class="mono">$100</span> ${assumption}<br><small>Made up for this demo, not a legal limit. Counted per browser, not per person.</small></p>
    ${openRefundsHtml}</section>
    <section class="card-section"><h3>Donations</h3><p class="muted">Test card, no login. Sandbox test money.</p><div class="give-buttons">${[10, 25, 50].map(amount => button('give', `Give $${amount}`, `give-${amount}`, `data-amount="${amount}" data-needs-state="true" aria-label="Give $${amount} (test card)"`)).join('')}</div>
    ${button('give-paypal', 'Give with PayPal', 'give-paypal', 'class="gold" data-needs-state="true"')}<p class="muted">Gives $25 in sandbox test money. Needs a PayPal sandbox buyer account. The test card buttons need no login.</p>
    <p class="funding-total mono">${dollars(money.wards[ward.id]?.funded ?? 0, true)} funded / ${dollars(campaignPlan.perWard[ward.id])} plan</p></section>
    <section class="card-section"><h3>Work</h3><p class="muted">Checked against the campaign's $5,000 plan. Door crew: $0.25 / door. Print shop: $0.10 / flyer. ${assumption} Maximum $60 per log.${budget !== BUDGET_DEFAULT ? ` Explore shows what ${dollars(budget)} would do.` : ''}</p>
    <form id="work-form"><label>Payee<select id="work-payee" data-testid="work-payee">${money.payees.map(({key, label}) => `<option value="${e(key)}" ${key === workPayee ? 'selected' : ''}>${e(label)}</option>`).join('')}</select></label>
    <div class="work-row"><label>Units<input id="work-units" data-testid="work-units" type="number" inputmode="numeric" min="1" max="400" step="1" value="${e(workUnits)}" required></label><button type="submit" data-action="log-work" data-testid="log-work" data-needs-state="true">Log work</button></div></form></section>
    ${latestMineHtml}
    <details class="ward-history card-section" data-testid="ward-history" ${historyOpen ? 'open' : ''}><summary>Ward history (${records.length} records)</summary>
    <div id="ward-donations">${donations.map(r => renderRecord(r, [], money.payees)).join('') || '<p class="muted">No donations in the available records.</p>'}</div>
    <div id="ward-refunds">${refunds.map(r => renderRecord(r, [], money.payees)).join('') || '<p class="muted">No refunds in the available records.</p>'}</div>
    <div id="ward-work">${work.map(r => renderRecord(r, [], money.payees)).join('') || '<p class="muted">No work logged in the available records.</p>'}</div></details>
    <details id="ward-facts" class="card-section" ${factsOpen ? 'open' : ''}><summary data-testid="ward-facts">Ward facts</summary>
    <dl class="facts"><div><dt>Non voters · ${mode === 'plan' ? '2023' : '2019'}</dt><dd class="mono">${integer(nonVoters(ward, mode === 'plan' ? 'y2023' : 'y2019'))}</dd></div>
    <div><dt>Cost / contact ${assumption}</dt><dd class="mono">${dollars(costPerContact(ward, city.wards), true)}</dd></div><div><dt>Votes per $100 ${assumption}</dt><dd class="mono">${decimal(compareWards(ward.id, city.wards.find(other => other.id !== ward.id)!.id, active, mode === 'plan' ? 'y2023' : 'y2019', city.wards).a.votesPer100, 2)}</dd></div><div><dt>Ward setup ${assumption}</dt><dd class="mono">${dollars(SETUP_COST)}</dd></div>
    <div><dt>Turnout 2019</dt><dd class="mono">${percent(forecastTurnout(ward, 'y2019'))}</dd></div><div><dt>Turnout 2023</dt><dd class="mono">${percent(forecastTurnout(ward, 'y2023'))}</dd></div></dl></details>
    <p class="muted">${records.length === 50 ? 'Last 50 records for this ward' : 'Records for this ward'}</p>`;
  for (const detail of card.querySelectorAll<HTMLDetailsElement>('[data-record-id] details')) if (openedReceipts.has(foldKey(detail))) detail.open = true;
  syncButtons();
  if (focus) card.querySelector<HTMLElement>(`[data-testid="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true });
}

function selectWard(id: number) {
  if (!city.wards.some(w => w.id === id)) return;
  rememberedFocus = document.activeElement; selected = id;
  if (grid.api.getRowNode(String(id))?.rowIndex === null) { $<HTMLInputElement>('#grid-filter').value = ''; grid.filter(''); }
  renderCard(); updateMap(); grid.select(id); $<HTMLSelectElement>('#ward-jump').value = String(id);
  syncWardSheet(); void refreshState();
  if (mobile()) $('#ward-card [data-action="close-ward"]').focus({ preventScroll: true });
  else $('#ward-card').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function closeWard() {
  selected = undefined; $('#ward-card').hidden = true; syncWardSheet(); updateMap(); grid.api.deselectAll();
  $<HTMLSelectElement>('#ward-jump').value = '';
  if (rememberedFocus instanceof HTMLElement || rememberedFocus instanceof SVGElement) rememberedFocus.focus({ preventScroll: true });
}
function syncWardSheet() {
  const open = mobile() && selected !== undefined;
  document.body.classList.toggle('ward-open', open);
  for (const selector of ['.topbar', '.map-column', '.mobile-tabs', '.plan-controls', '.money-panel']) $(selector).inert = open;
  const card = $('#ward-card');
  if (open) { card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-labelledby', 'ward-title'); }
  else { card.removeAttribute('role'); card.removeAttribute('aria-modal'); }
}
function showGrid(open: boolean) {
  $('#data-panel').hidden = !open; $('.map-column').classList.toggle('grid-open', open);
  $('[data-testid="grid-toggle"]').setAttribute('aria-expanded', String(open));
  updateMap();
  if (open) updateGrid();
  if (open) requestAnimationFrame(() => { grid.updateChart(); if (selected) grid.select(selected); });
}
function setTab(tab: string) {
  if (tab === 'about') { openAbout(); return; }
  $('.workspace').setAttribute('data-tab', tab);
  document.querySelectorAll('.mobile-tabs button').forEach(el => el.setAttribute('aria-pressed', String(el.getAttribute('data-testid') === `tab-${tab}`)));
  if (tab === 'grid') showGrid(true);
  if (mobile()) window.scrollTo({ top: 0, behavior: 'instant' });
}
function openAbout() { const dialog = $<HTMLDialogElement>('#about'); if (!dialog.open) dialog.showModal(); }
function setMode(next: typeof mode) {
  endPour();
  ensureHistory();
  mode = next; $('#backtest-panel').hidden = mode !== 'backtest';
  $('[data-testid="mode-plan"]').setAttribute('aria-pressed', String(mode === 'plan'));
  $('[data-testid="mode-backtest"]').setAttribute('aria-pressed', String(mode === 'backtest'));
  updateMap(); updateGrid(); renderCard(true); renderBudget();
}
function resetPickers() {
  const defaults = defaultWardPickers(plan, city.wards, lastDropped);
  for (const which of ['a', 'b'] as const) {
    const picker = $<HTMLSelectElement>(`#ask-${which}`);
    picker.innerHTML = city.wards.map(w => `<option value="${w.id}">Ward ${w.id} · ${dollars(plan.perWard[w.id])}</option>`).join('');
    picker.value = String(defaults[which]);
  }
}
function ensureHistory() {
  if (historyBudget === budget) return;
  history = backtest(city.wards, budget); oldPlan = allocate(budget, 'y2019', city.wards);
  historyBudget = budget;
}
function changeBudget(value: number) {
  endPour();
  const before = plan; budget = value; plan = allocate(budget, 'y2023', city.wards);
  if (mode === 'backtest') ensureHistory();
  const dropped = explainDrop(before, plan, 'y2023', city.wards);
  const joined = city.wards.find(w => !before.perWard[w.id] && plan.perWard[w.id]);
  if (dropped) {
    lastDropped = dropped.ward;
    lastPlanEvent = `Ward ${dropped.ward} dropped at ${dollars(budget)}: its last step returned ${dropped.votesPer100} votes per $100; Ward ${dropped.keptWard} kept money at ${dropped.keptVotesPer100} votes per $100.`;
  } else if (joined) lastPlanEvent = `Ward ${joined.id} joins at ${dollars(budget)}: its ${dollars(SETUP_COST)} setup is covered, with ${decimal(plan.votes[joined.id])} expected votes for ${dollars(plan.perWard[joined.id])}.`;
  $('#drop-line').textContent = lastPlanEvent || `At ${dollars(budget)}, ${Object.values(plan.perWard).filter(Boolean).length} wards share the plan. Each new ward must cover its ${dollars(SETUP_COST)} setup.`;
  $('#ask-answer').textContent = ''; renderBudget(); updateMap();
  // Paint the city first. Hidden ledger and backtest work need not block a drag.
  cancelAnimationFrame(detailAnimation);
  detailAnimation = requestAnimationFrame(() => { detailAnimation = 0; resetPickers(); updateGrid(); renderCard(true); });
  schedulePlanAnswer();
}

function queueBudget(value: number) {
  clearTimeout(nudgeTimer);
  endPour();
  pendingBudget = Math.max(BUDGET_MIN, Math.min(BUDGET_MAX, Math.floor(value / STEP) * STEP));
  clearTimeout(planTimer); planRequest++;
  cancelAnimationFrame(detailAnimation);
  if (!budgetAnimation) budgetAnimation = requestAnimationFrame(() => {
    budgetAnimation = 0; changeBudget(pendingBudget);
  });
}
function endPour() {
  cancelAnimationFrame(pourAnimation); pourAnimation = 0;
  if (!pour) return;
  pour = undefined;
  $('.map-stage').dataset.pouring = 'false';
  renderBudget(); updateMap();
}
function startPour() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    $('.map-stage').dataset.pouring = 'false'; return;
  }
  const start = performance.now(), fadeDuration = 450, pourDuration = 2000;
  pour = pourFrame(plan, 0); $('.map-stage').dataset.pouring = 'true';
  renderBudget(); updateMap();
  const tick = (now: number) => {
    const progress = Math.max(0, (now - start - fadeDuration) / pourDuration);
    if (progress >= 1) { endPour(); return; }
    pour = pourFrame(plan, progress); renderBudget(); updateMap();
    pourAnimation = requestAnimationFrame(tick);
  };
  pourAnimation = requestAnimationFrame(tick);
}
function openAsk() {
  askOpen = true; $('#agent-box').hidden = false;
  $('[data-testid="ask-why"]').setAttribute('aria-expanded', 'true');
  resetPickers(); $('#ask-a').focus();
}

function answerMarkup(answer: Answer): string {
  const source = { live: 'Live AI', cache: 'Cached AI answer', rules: 'Explained by rules', recorded: answer.reason?.startsWith('Recorded answer,') ? answer.reason : 'Recorded answer, date unavailable' }[answer.source];
  return `<span class="chip ${answer.source === 'live' ? 'live-ai' : ''}">${e(source)}</span><p>${e(answer.text)}</p>`;
}
function schedulePlanAnswer() {
  clearTimeout(planTimer);
  const request = ++planRequest, askedBudget = budget;
  $('#plan-line').textContent = '';
  planTimer = setTimeout(async () => {
    $('#plan-line').textContent = 'Explaining the plan…';
    try {
      const answer = await api<Answer>('/api/ask', { kind: 'plan', budget: askedBudget });
      if (request === planRequest) $('#plan-line').innerHTML = answerMarkup(answer);
    } catch (error) {
      if (request === planRequest) $('#plan-line').textContent = (error as Error).message;
    }
  }, 700);
}
async function askQuestion(kind: 'why' | 'move' | 'more') {
  if (askBusy) return;
  const a = Number($<HTMLSelectElement>('#ask-a').value), b = Number($<HTMLSelectElement>('#ask-b').value);
  if (kind !== 'more' && a === b) { toast('Choose two different city wards.', true); return; }
  setAskBusy(true); const askedBudget = budget;
  $('#ask-answer').textContent = 'Checking the plan’s facts…';
  try {
    const answer = await api<Answer>('/api/ask', kind === 'why' ? { kind, a, b, budget } : kind === 'more' ? { kind, ward: a, amount: 500, budget } : { kind, from: a, to: b, amount: 500, budget });
    $('#ask-answer').innerHTML = `${answerMarkup(answer)}<small>Plan 2027 · ${dollars(askedBudget)} · ${kind === 'more' ? `Ward ${a}` : `Wards ${a} and ${b}`}</small>${askedBudget !== budget ? '<p>The budget has changed since this question.</p>' : ''}`;
  } catch (error) { $('#ask-answer').textContent = ''; toast((error as Error).message, true); }
  finally { void refreshState(); setAskBusy(false); }
}
async function moneyAction(action: string, target: HTMLElement) {
  if (moneyBusy) return;
  if (!stateReady) { await refreshState(); if (!stateReady) return; }
  setMoneyBusy(true);
  let path: string, body: unknown = {};
  const id = encodeURIComponent(target.dataset.id ?? '');
  switch (action) {
    case 'give': case 'give-paypal':
      if (!selected) { setMoneyBusy(false); return; }
      path = '/api/donations' + (new URLSearchParams(location.search).get('declineTest') === '1' ? '?declineTest=1' : '');
      body = { ward: selected, amount: action === 'give' ? Number(target.dataset.amount) : 25, method: action === 'give' ? 'card' : 'paypal' }; break;
    case 'approve-refund': path = `/api/refunds/${id}/approve`; break;
    case 'pay-all': path = '/api/payroll/pay'; body = { version: target.dataset.version }; break;
    case 'payroll-refresh': path = `/api/payroll/${id}/refresh`; body = {}; break;
    case 'log-work':
      if (!$<HTMLFormElement>('#work-form').reportValidity()) { setMoneyBusy(false); return; }
      path = '/api/worklogs'; body = { ward: selected, payee: workPayee, units: Number(workUnits) }; break;
    default: path = `/api/worklogs/${id}/${action}`;
  }
  try {
    const result = await api<MoneyRecord & { message?: string }>(path, body);
    if (action === 'give-paypal' && result.approvalUrl) {
      const approval = new URL(result.approvalUrl);
      if (approval.protocol !== 'https:' || !(approval.hostname === 'sandbox.paypal.com' || approval.hostname.endsWith('.sandbox.paypal.com'))) throw new Error('PayPal did not return a sandbox approval link.');
      await refreshState(); location.assign(approval.href); return;
    }
    const message = result.message ?? (action === 'log-work' ? 'Work logged. Rules checked by code.'
      : action === 'give' || action === 'give-paypal' ? returnMessage(result.status) ?? `Donation saved. Status: ${result.status}.`
      : action === 'approve-refund' ? `Refund ${result.status}.`
      : action === 'pay-all' ? `Payroll batch sent. Status: ${result.status}.`
      : action === 'payroll-refresh' ? `Payroll status: ${result.status}.`
      : `Payout ${result.status === 'SUCCESS' ? 'paid · SUCCESS' : result.status}.`);
    toast(message, ['DECLINED', 'FAILED', 'BLOCKED'].includes(result.status));
  } catch (error) { toast((error as Error).message, true); }
  finally { await refreshState(); setMoneyBusy(false); }
}

function bind() {
  document.addEventListener('click', event => {
    const target = event.target as Element;
    const copy = target.closest<HTMLElement>('[data-copy]');
    if (copy) { void navigator.clipboard.writeText(copy.dataset.copy!).then(() => toast('PayPal id copied.'), () => toast('Could not copy. Select the PayPal id to copy it.', true)); return; }
    const ward = target.closest<SVGElement>('[data-ward]'); if (ward) { selectWard(Number(ward.dataset.ward)); return; }
    const control = target.closest<HTMLButtonElement>('button[data-action]'); if (!control || control.disabled) return;
    const action = control.dataset.action!;
    if (action.startsWith('tab-')) { setTab(action.slice(4)); return; }
    switch (action) {
      case 'about': openAbout(); break;
      case 'close-about': $<HTMLDialogElement>('#about').close(); break;
      case 'close-ward': closeWard(); break;
      case 'mode-plan': setMode('plan'); break;
      case 'mode-backtest': setMode('backtest'); break;
      case 'back-to-plan': cancelAnimationFrame(budgetAnimation); budgetAnimation = 0; $<HTMLInputElement>('#budget').value = String(BUDGET_DEFAULT); changeBudget(BUDGET_DEFAULT); break;
      case 'start-1': {
        endPour(); clearTimeout(nudgeTimer);
        const slider = $<HTMLInputElement>('#budget'); slider.focus();
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) break;
        slider.classList.remove('budget-nudge'); void slider.offsetWidth; slider.classList.add('budget-nudge');
        // Move the thumb one step and back without changing the explored plan.
        slider.value = String(Math.min(BUDGET_MAX, budget + STEP));
        nudgeTimer = setTimeout(() => { slider.value = String(budget); }, 180);
        break;
      }
      case 'start-2': openAsk(); break;
      case 'start-3': endPour(); if (plan.order[0]) selectWard(plan.order[0]); break;
      case 'grid-toggle': if (mobile()) setTab('grid'); else showGrid(Boolean($('#data-panel').hidden)); break;
      case 'plan-csv': {
        const url = URL.createObjectURL(new Blob([planCsv(currentPlan(), city.wards, mode === 'plan' ? 'y2023' : 'y2019')], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = `wardwise-plan-${budget}.csv`;
        document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        break;
      }
      case 'ask-why': if (!askOpen) openAsk(); else { askOpen = false; $('#agent-box').hidden = true; control.setAttribute('aria-expanded', 'false'); } break;
      case 'ask-submit': void askQuestion('why'); break;
      case 'ask-move': void askQuestion('move'); break;
      case 'ask-more': void askQuestion('more'); break;
      case 'pay-all': void moneyAction('pay-all', control); break;
      case 'payroll-refresh': void moneyAction('payroll-refresh', control); break;
      case 'log-work': break; // Form submit supplies native validation and keyboard support.
      default: void moneyAction(action, control);
    }
  });
  document.addEventListener('submit', event => { if ((event.target as HTMLElement).id === 'work-form') { event.preventDefault(); void moneyAction('log-work', $('[data-testid="log-work"]')); } });
  $('#budget').addEventListener('input', event => queueBudget(Number((event.target as HTMLInputElement).value)));
  $('#grid-filter').addEventListener('input', event => grid.filter((event.target as HTMLInputElement).value));
  $('#ward-jump').addEventListener('change', event => selectWard(Number((event.target as HTMLSelectElement).value)));
  document.addEventListener('input', event => { const target = event.target as HTMLInputElement; if (target.id === 'work-units') workUnits = target.value; });
  document.addEventListener('change', event => { const target = event.target as HTMLSelectElement; if (target.id === 'work-payee') workPayee = target.value; });
  document.addEventListener('keydown', event => {
    const ward = (event.target as Element).closest<SVGElement>('[data-ward]');
    if (ward && ['Enter', ' '].includes(event.key)) { event.preventDefault(); selectWard(Number(ward.dataset.ward)); }
    if (event.key === 'Escape' && !$<HTMLDialogElement>('#about').open && selected) closeWard();
    if (event.key === 'Tab' && mobile() && selected && !$<HTMLDialogElement>('#about').open) {
      const controls = [...$('#ward-card').querySelectorAll<HTMLElement>('button:not(:disabled), select, input, summary, a[href]')];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  const tooltip = $('#map-tooltip');
  $('#map-canvas').addEventListener('pointermove', event => {
    if ((event as PointerEvent).pointerType === 'touch') return;
    const ward = (event.target as Element).closest<SVGElement>('[data-ward]');
    if (!ward) { tooltip.hidden = true; return; }
    const id = Number(ward.dataset.ward), active = currentPlan();
    tooltip.textContent = `Ward ${id} · ${dollars(active.perWard[id])} plan · ${decimal(active.votes[id])} expected votes`;
    tooltip.hidden = false;
    const bounds = $('.map-visual').getBoundingClientRect();
    tooltip.style.left = Math.max(16, Math.min(event.clientX - bounds.left + 14, bounds.width - tooltip.offsetWidth - 16)) + 'px';
    tooltip.style.top = Math.max(16, Math.min(event.clientY - bounds.top + 14, bounds.height - tooltip.offsetHeight - 16)) + 'px';
  });
  $('#map-canvas').addEventListener('pointerleave', () => { tooltip.hidden = true; });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshState(); });
  window.addEventListener('resize', () => {
    syncWardSheet();
    requestAnimationFrame(() => { grid.updateChart(); updateMap(); });
  });
}

async function start() {
  try {
    const response = await fetch('/data/chicago.json'); if (!response.ok) throw new Error('The Chicago data could not be loaded. Please reload.');
    city = await response.json() as CityData;
    heatBreaks = precinctBreaks(city.precincts);
    plan = allocate(budget, 'y2023', city.wards); campaignPlan = allocate(BUDGET_DEFAULT, 'y2023', city.wards); history = backtest(city.wards, budget); oldPlan = allocate(budget, 'y2019', city.wards);
    shell(); buildMap(); grid = new WardTable($('#grid'), $('#chart'), selectWard); bind();
    renderBudget(); updateMap(); updateGrid(); syncButtons(); resetPickers();
    schedulePlanAnswer();
    showGrid(false); startPour();
    const params = new URLSearchParams(location.search), ward = Number(params.get('ward'));
    if (city.wards.some(w => w.id === ward)) selectWard(ward);
    if (location.pathname === '/sources') openAbout();
    await refreshState();
    const message = returnMessage(params.get('result'));
    if (message) {
      toast(message, params.get('result') === 'declined');
      params.delete('result'); params.delete('ward'); params.delete('message');
      window.history.replaceState(null, '', location.pathname + (params.size ? '?' + params.toString() : '') + location.hash);
    }
    const poll = setInterval(() => { if (!document.hidden && !moneyBusy) void refreshState(); }, 15000);
    window.addEventListener('pagehide', event => { if (!event.persisted) { clearInterval(poll); clearTimeout(toastTimer); clearTimeout(planTimer); clearTimeout(nudgeTimer); cancelAnimationFrame(pourAnimation); cancelAnimationFrame(budgetAnimation); cancelAnimationFrame(detailAnimation); planRequest++; grid.destroy(); } });
  } catch (error) {
    $('#app').innerHTML = `<main class="loading"><h1>WardWise</h1><p>${e(error instanceof Error ? error.message : 'The screen could not be loaded.')}</p><a href="/">Reload the plan</a></main>`;
  }
}
void start();
