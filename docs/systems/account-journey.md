# Account journey (the card on the company page)
_Last verified against code: 2026-11-14 — Claude (dev job `b3b013cd`, SANDBOX — Antonio ships; in a pull request): the card now **starts closed** with a one-line header saying where the client is right now; the form boxes became slim rows; Partner Bank Applications left the card and is a closed card of its own._

## What it is
The first card under a company's header (`components/accounts/account-journey.tsx`, drawn by `account-detail.tsx`). Open, it shows the six steps a client goes through (Offer, Signed, Paid, Onboarding, Services, Active) with a hover note on each, and one slim row per client form (the "Client wizard submissions") with an Export button. Antonio (14 Nov 2026): for a client whose offer is done and whose forms are in, the open card told staff nothing and took a lot of room, so it starts closed like Offers, Signed contracts and Partner Bank Applications.

## Business rules
- **Closed by default, always.** No "open by itself when something is stuck": a stuck client says so in the header instead (same rule as the red "N applied" tag on Partner Bank Applications).
- **The header never reads the six steps.** About half of the active clients carry an expired offer, so their Offer and Signed steps are grey although the client is perfectly active. The header reads the client's real state instead (below).
- **The steps are not wrong when they look odd.** The "journey offer" is the NEWEST non-draft offer on the company (contact-filed offers included). A company with an old signed, paid, activated offer and a newer unsigned one shows "Viewed" / "Awaiting signature" next to green Paid / Onboarding / Active. That is real follow-up (the newer offer is unsigned), not a data error. The Offers card shows both offers.
- **Export** downloads the client's submitted form answers as a text file, in the browser (nothing is stored, no log of who used it).
- The Contact page has its OWN, separate journey strip (`contact-detail.tsx`); this card does not touch it.

## How it's built
- **Header line:** `journeyHeaderSummary()` in `lib/accounts/journey-summary.ts` (pure). First match wins:
  1. Account status Closed / Cancelled → that word, grey.
  2. A signed offer awaiting payment, with real dates → amber **Waiting for payment**, "N days since signing".
  3. Paid but no form started, with a real payment date, and the portal tier is NOT active → amber (over 3 days) or blue **Onboarding not started**, "N days since payment". Skipped for active-tier clients: 25 paid, activated clients have no form records, and "not started" would be a false alarm.
  4. A form an active service expects that the client has not started → amber **Form not started**; a form in progress → blue **Form in progress** (names cut to two, then "+N more"). Followed by "N forms submitted".
  5. Portal tier formation / onboarding → blue **Formation in progress** / **Onboarding in progress**.
  6. Portal tier active, account type Client, status Active (or none) → green **Active client**, "N forms submitted" (nothing extra when there are none).
  7. Anything else → the account status in grey ("Pending Formation", "Suspended", ...), or "Not active yet".
- **Flags on steps:** `deriveAccountJourneySteps()` sets `flag` (`awaiting_payment`, `onboarding_not_started`) and `days` on a step ONLY when it holds a real date (the signing date or the payment date). An old client with no timestamps never gets a flag. The same function drives the open card, so the closed line and the open card cannot disagree.
- **Forms list:** `buildWizardEntries()` (real submissions, then forms an active service still expects: Banking Fintech expects Payset EUR + Relay USD; ITIN, Tax Return, Company Formation, Company Closure expect their own). Used by the open card AND the header.
- **Partner Bank Applications** is `BankReferralsPanel` with `standalone`, rendered by `account-detail.tsx` under Signed contracts, closed by default (red "N applied" tag in its header). It used to sit inside this card, so closing the card would have hidden the tag.
- **Key files:** `components/accounts/account-journey.tsx`, `lib/accounts/journey-summary.ts`, `components/accounts/bank-referrals-panel.tsx`, `components/accounts/account-detail.tsx`. Tests: `tests/unit/journey-summary.test.ts`, `tests/unit/account-journey-closed.test.ts`, `tests/unit/bank-referrals-panel-closed.test.ts`.
- **Data:** nothing new. It reads what the account page already loads (offers, pending activations, payments, wizard progress, service deliveries).

## Gotchas, invariants & past bugs
- The first click on a freshly loaded company page can be ignored for a few seconds until the page finishes loading. That is the page, not this card.
- `deriveAccountJourneySteps` still has a dead `['active','full']` branch for the Active step (R102 retired `full`); harmless, left alone.
- Early-stage states (waiting for payment, onboarding not started) are rare on real accounts: only a handful of signed-but-unpaid offers exist at a time, and for a company that already paid anything the Paid step shows green.
- Counts quoted here (about half the active clients with a grey Offer/Signed step; 25 active clients with no form records) were read from production on 2026-11-14 and will drift.

## How to verify current state
- Open any company page: the Account Journey card is closed, with a chip and a short line. Click it: six steps and slim form rows. Partner Bank Applications is its own closed card under Signed contracts.
- `npx vitest run tests/unit/journey-summary.test.ts tests/unit/account-journey-closed.test.ts tests/unit/bank-referrals-panel-closed.test.ts`.
- Production read for the oddity above: a company whose latest offer is unsigned but which has an older completed, activated offer (e.g. the offers table joined to pending_activations by token).
