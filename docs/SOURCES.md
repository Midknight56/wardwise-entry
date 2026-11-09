# Sources

Every real number in WardWise comes from one of the files below. The campaign is fictional. No file holds personal
data: all numbers are totals for a precinct or a ward.

Raw copies live in `data/raw/`. `python tools/build_data.py` turns them into `public/data/chicago.json`.

## The city and the race

**Chicago, Illinois. 50 wards. Municipal General Election, Tuesday, February 23, 2027.**

| What | Source | Exact words |
| --- | --- | --- |
| 2027 election date | Chicago Board of Election Commissioners, "2027 Election Information Pamphlet & Calendar", published June 9, 2026, revised July 28, 2026. https://cboeprod.blob.core.usgovcloudapi.net/prod/2026-08/2027%20Election%20Calendar-REV%2001-ADOPTED%2007-28-2026%20typo%20corrected.pdf (linked from https://chicagoelections.gov/getting-ballot/election-calendar). Copy: `data/raw/cboe-2027-election-calendar.pdf` | "Municipal General Election, Tuesday, February 23, 2027" and "Municipal Runoff and Supplementary Aldermanic Elections (if necessary), Tuesday, April 6, 2027" |
| Ward map used in 2027 | City of Chicago Data Portal, "Boundaries - Wards (2023-)", dataset `p293-wvbd`. https://data.cityofchicago.org/d/p293-wvbd | 50 ward polygons, the map in force since the 2023 election |

Read on 6 Nov 2026.

## Election results (precinct level, official)

Chicago Board of Election Commissioners, election results pages. Each page has a Download link that gives an Excel
file with one row per precinct, grouped by ward.

| Election | Page | Contest | File in `data/raw/` |
| --- | --- | --- | --- |
| Municipal General, Feb 28, 2023 (the last election) | https://chicagoelections.gov/elections/results/241 | Registered Voters/Ballots/Turnout | `cboe-2023-02-28-turnout-by-precinct.xls` |
| Municipal General, Feb 28, 2023 | same | Mayor (first round) | `cboe-2023-02-28-mayor-by-precinct.xls` |
| Municipal General, Feb 26, 2019 (the election before last) | https://chicagoelections.gov/elections/results/210 | Registered Voters/Ballots/Turnout | `cboe-2019-02-26-turnout-by-precinct.xls` |
| Municipal General, Feb 26, 2019 | same | Mayoral candidates 1-7 and 8-14 (the Board splits the 14 names over two contests) | `cboe-2019-02-26-mayor-1-7-by-precinct.xls`, `cboe-2019-02-26-mayor-8-14-by-precinct.xls` |

Download address pattern: `https://chicagoelections.gov/elections/results/<id>/download?contest=<contest>&ward=&precinct=`
(turnout is `contest=`, 2023 mayor is `contest=11`, 2019 mayor is `contest=9` and `contest=10`).

City totals in the files: 2023, 1,581,564 registered, 566,973 ballots, 35.85% turnout. 2019, 1,581,755 registered,
560,701 ballots, 35.45% turnout.

**Terms.** The results pages carry no licence text. The Board lists "Election Results (on the Board's website)" as
records that are "Immediately Available" under the Illinois Freedom of Information Act
(https://chicagoelections.gov/about-board/freedom-information-act-foia, 5 ILCS 140). They are public records. The same
page limits the use of individual voter registration information; WardWise uses none (only precinct totals).

WardWise keeps only totals and vote shares. It stores no candidate names: for each ward it keeps the top two vote shares
of the mayor's first round, to show how close the ward was.

## Ward and precinct shapes

City of Chicago Data Portal.

| Dataset | Id | Used for |
| --- | --- | --- |
| Boundaries - Wards (2023-) | `p293-wvbd` | The 50 wards on the map |
| Boundaries - Ward Precincts (2023-2024) | `6piy-vbxa` | Precinct heat inside each ward (2023 results) |
| Boundaries - Ward Precincts (2013-2022) | `nvke-umup` | Moving 2019 precinct results onto the 2023 wards for the backtest |

## Census

City of Chicago Data Portal, "ACS 5 Year Data by Ward", dataset `awnk-6fvc` (https://data.cityofchicago.org/d/awnk-6fvc).
The City builds it from the Census Bureau's American Community Survey 5 year estimates (2023 release) and splits each
census tract over the wards by area. Its own description says "these figures should be considered an estimate".

WardWise uses only `total_population` and the age bands (to count adults 18 and over). It drops every race and
ethnicity column at build time. The model has no race input.

## Terms of the City data

City of Chicago, Data Terms of Use (https://www.chicago.gov/city/en/narr/foia/data_disclaimer.html). It asks every
application that uses portal data to show this text, and WardWise shows it on its About panel:

> This site provides applications using data that has been modified for use from its original source,
> www.cityofchicago.org, the official website of the City of Chicago. The City of Chicago makes no claims as to the
> content, accuracy, timeliness, or completeness of any of the data provided at this site. The data provided at this
> site is subject to change at any time. It is understood that the data provided at this site is being used at one's
> own risk.

## What is made up

Labelled in the app as assumptions:

- The campaign, Candidate A and the budget.
- Cost per contact, ward setup cost, how many reached non voters vote, how fast returns fall.
- Crew and vendor rates, the $100 demo cap per supporter.
- All money moves are PayPal sandbox test money.

WardWise makes no claim about election law compliance.
