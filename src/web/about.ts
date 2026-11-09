import { ASSUMPTIONS } from '../model/assumptions';
import { escapeHtml as e } from './helpers';

// Verbatim City disclaimer from docs/SOURCES.md. Sources are bundled here so About works offline.
export const CITY_DISCLAIMER = "This site provides applications using data that has been modified for use from its original source, www.cityofchicago.org, the official website of the City of Chicago. The City of Chicago makes no claims as to the content, accuracy, timeliness, or completeness of any of the data provided at this site. The data provided at this site is subject to change at any time. It is understood that the data provided at this site is being used at one's own risk.";
export const ESTIMATE_LIMIT = 'Simulated estimate from assumed costs and lift. No extra votes have been measured.';
export const BACKTEST_LIMIT = 'This compares turnout in two past elections. It does not test what spending does.';

export function aboutContent(): string {
  const extras = [
    ['Campaign', 'Fictional campaign', 'The campaign and its budget are made up.'],
    ['Door crew rate', '$0.25 per door', 'Sandbox work rate.'],
    ['Print shop rate', '$0.10 per flyer', 'Sandbox work rate.'],
    ['Demo cap', '$100 per browser', 'Made up for this demo, not a legal limit. Counted per browser, not per person.'],
  ];
  return `<div class="section-heading"><div><span class="eyebrow">THE METHOD</span><h2 id="about-title">A plan you can question.</h2></div><button data-action="close-about" data-testid="close-about" aria-label="Close About">Close</button></div>
    <ol class="method"><li>Count registered people who did not vote last time.</li><li>Use adults per square kilometre to estimate the cost of a contact.</li><li>Pay a setup cost before opening a ward. Returns fall as its easy pool runs out.</li><li>Allocate the budget in $50 steps to the best expected return.</li><li>Run the same method on 2019, then check it against 2023. Show the misses.</li><li>Code computes every number and checks each AI answer. AI writes the explanation only.</li><li>${ESTIMATE_LIMIT}</li></ol>
    <h3>What we assume</h3><div class="table-scroll"><table><thead><tr><th>Assumption</th><th>Value</th><th>Meaning</th></tr></thead><tbody>
    ${ASSUMPTIONS.map(a => `<tr><th><span class="chip">Assumption</span> ${e(a.key)}</th><td class="mono">${a.value}</td><td>${e(a.label)}</td></tr>`).join('')}
    ${extras.map(([key, value, label]) => `<tr><th><span class="chip">Assumption</span> ${key}</th><td class="mono">${value}</td><td>${label}</td></tr>`).join('')}</tbody></table></div>
    <h3 id="sources">Sources</h3><p>Ward and precinct totals only. The 2019 precinct results are moved onto the 2023 ward boundaries. ACS population figures are estimates.</p>
    <ul class="sources"><li><a href="https://chicagoelections.gov/getting-ballot/election-calendar">Chicago Board of Election Commissioners: 2027 election calendar</a></li>
    <li><a href="https://chicagoelections.gov/elections/results/241">Official 2023 turnout and mayor first round results</a></li><li><a href="https://chicagoelections.gov/elections/results/210">Official 2019 turnout and mayor first round results</a></li>
    <li><a href="https://data.cityofchicago.org/d/p293-wvbd">City of Chicago: ward boundaries (2023 onwards)</a></li><li><a href="https://data.cityofchicago.org/d/6piy-vbxa">City of Chicago: precinct boundaries (2023 to 2024)</a></li>
    <li><a href="https://data.cityofchicago.org/d/nvke-umup">City of Chicago: precinct boundaries (2013 to 2022)</a></li><li><a href="https://data.cityofchicago.org/d/awnk-6fvc">ACS 2023 five year ward estimates</a></li></ul>
    <h3>City data disclaimer</h3><blockquote>${CITY_DISCLAIMER}</blockquote><p><a href="https://www.chicago.gov/city/en/narr/foia/data_disclaimer.html">City of Chicago Data Terms of Use</a></p>
    <p class="closing-note">No voter level data and no race inputs. The app keeps a random browser id and sandbox payment records. Fictional campaign. Not a statement of election law compliance.</p>`;
}
