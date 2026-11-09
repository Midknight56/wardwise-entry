# Usability check: can a person read the money trail?

Status: **not run yet.** No results exist. Nothing in the submission claims a result from this check.

This check measures one narrow thing: whether WardWise makes campaign money easier to read than a plain list of
transactions. It does not measure turnout, votes or campaign adoption. Testers are internal testers, not campaign
customers, and are reported as internal testers.

## Setup

- Two testers who have not used WardWise before.
- Version A: the live app, on a ward with one refund and one mixed payroll (one item SUCCESS, one UNCLAIMED).
- Version B: the same records as a plain table (time, kind, amount, status, PayPal id), printed from `/api/state`.
- Each tester does the three tasks on one version, then on the other. Tester 1 starts with A, tester 2 with B.
- No help unless the tester is stuck for 60 seconds. Every help counts as an assist.

## Tasks

1. A supporter gave $25, $50 and $50 and got a refund. How much stays donated? (Answer: $100.)
2. Which crew was paid in the last payroll, and which was not? (Answer: the North Side door crew was paid; the crew
   with no PayPal account is unclaimed. The payroll is partly paid, not fully paid.)
3. Find the PayPal receipt that proves your answer to task 2. (Answer: the payout item id and its status.)

## What to record per tester, per version, per task

| Field | Meaning |
| --- | --- |
| Time | Seconds from reading the task to the answer |
| Correct | Yes or no, against the answers above |
| Errors | Wrong answers given before the final one |
| Assists | Times help was given |
| Note | What the tester said or where they got stuck |

Write results in `docs/usability-results.csv` with exact denominators (for example "2 of 2 testers"). Report what
happened, including no benefit. Fix any friction the testers show, then say what changed.
