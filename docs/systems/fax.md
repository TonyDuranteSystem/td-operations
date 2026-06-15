# Fax (Faxage integration)

_Last verified against code: 2026-06-15 — Claude (initial: Tools hub Fax tile + `/tools/fax` form + `POST /api/tools/fax/send` → Faxage httpsfax.php; `fax_irs` flow stage button.)_

## What it is
A staff tool to send a document by fax via **Faxage** (faxage.com HTTPS API). Reached from the **Tools hub** (`/tools` → "Fax" tile) at **`/tools/fax`**, and from the Tax Return **"Signed"** flow stage via the **"Send Fax to IRS"** button (`fax_irs` component).

## How it works
- **UI** `app/(dashboard)/tools/fax/page.tsx` + `fax-form.tsx` (client): recipient fax number, file upload (PDF/image, ≤10 MB), optional recipient name, optional cover message → reads the file as base64 → `POST /api/tools/fax/send`. Pre-fills `faxno` / `to` (recipient) / `message` from query params (used by the flow `fax_irs` button, which passes `to=IRS` + a cover note).
- **API** `app/api/tools/fax/send/route.ts` (staff-only via `isDashboardUser`): posts `application/x-www-form-urlencoded` to `https://www.faxage.com/httpsfax.php` with `operation=sendfax`, `username`/`password` from env, `recipname`, `faxno` (digits only), `faxfilenames`, `faxfiledata` (base64). Treats an `error`/`invalid`/`fail` token in the response (or non-2xx) as failure → 502 with the Faxage text surfaced.
- **Flow button** `components/flows/fax-irs.tsx` (`fax_irs` stage-layout component) — Tax Return "Signed" stage. Links to `/tools/fax?to=IRS&message=…`; the IRS fax number is NOT pre-filled (varies by form/office) — staff enters it and attaches the signed return downloaded from the stage's document viewer.

## Config
- **Env (server-only):** `FAXAGE_USERNAME`, `FAXAGE_PASSWORD` (in `.env.local`, gitignored; must also be set in the Vercel project env for deployed routes). Optional `FAXAGE_COMPANY` (Faxage account number) — sent as `company` only if set.
- Credentials are NEVER sent from the client or committed to git.

## Gotchas / unverified
- **The exact Faxage `sendfax` param set is UNVERIFIED** (no live API doc access at build time). Implemented per the provided spec + `recipname`/`faxfilenames`. If Faxage rejects with a missing-param error, Faxage's docs likely require `company` (account number) — set `FAXAGE_COMPANY` env and it's included automatically.
- E-Sign tile on the Tools hub is a **placeholder** ("Coming soon") — non-navigating.

## How to verify current state
- Open `/tools` → "Fax" tile present; `/tools/fax` renders the form.
- Open a Tax Return SD at "Signed" → the "Send Fax to IRS" card appears above File-with-IRS.
- A real send requires `FAXAGE_*` env set in the target environment; test deliberately (it sends a real fax).
