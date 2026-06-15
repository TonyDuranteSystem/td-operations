# Fax (Faxage integration)

_Last verified against code: 2026-06-15 — Claude (Tools hub Fax tile + `/tools/fax` form with upload-or-recent-document + `POST /api/tools/fax/send` → Faxage httpsfax.php via testable `lib/fax/faxage.ts`; `fax_irs` flow stage button; action_log audit.)_

## What it is
A staff tool to send a document by fax via **Faxage** (faxage.com HTTPS API). Reached from the **Tools hub** (`/tools` → "Fax" tile) at **`/tools/fax`**, and from the Tax Return **"Signed"** flow stage via the **"Send Fax to IRS"** button (`fax_irs` component).

## How it works
- **UI** `app/(dashboard)/tools/fax/page.tsx` (server, fetches recent Drive-backed documents + the configured IRS number) + `fax-form.tsx` (client): recipient fax number, recipient name (optional), **document source toggle — upload a file (PDF/image, ≤10 MB) OR pick a recent document** from a dropdown, optional cover message. Upload path reads the file as base64 client-side; document path sends the `document_id`. Pre-fills from query params (`to`, `message`, `faxno`); `to=IRS` pre-fills the configured IRS fax number.
- **API** `app/api/tools/fax/send/route.ts` (staff-only via `isDashboardUser` → 403): accepts JSON with either `file_base64`+`file_name` (upload) or `document_id` (a `documents` row → downloaded from Drive via `downloadFileBinary`, base64-encoded server-side). Sends via `lib/fax/faxage.ts::sendFax` and writes an `action_log` row (`action_type='fax_sent'`, with `faxno`/`file_name`/`job_id`/`source` in `details`). `GET` returns the configured IRS number (no secrets) for the UI.
- **Library** `lib/fax/faxage.ts` (pure + unit-tested, `tests/unit/faxage.test.ts`): `normalizeFaxNo`/`isValidFaxNo` (digits-only, 10–15), `stripBase64Prefix`, `buildFaxageParams` (posts `operation=sendfax`, `username`, `company`, `password`, `faxno`, `recipname`, **indexed** `faxfilenames[0]`/`faxfiledata[0]`), `parseFaxageResponse` (best-effort: `error`/`invalid`/`fail`/`denied` token or non-2xx → failure; otherwise pulls a job id), `sendFax` (injectable fetch).
- **Flow button** `components/flows/fax-irs.tsx` (`fax_irs` stage-layout component) — Tax Return "Signed" stage. Links to `/tools/fax?to=IRS&message=…`; the fax form then pre-fills the IRS number from `FAXAGE_IRS_NUMBER`. Staff attaches the signed return (download from the stage's document viewer, or pick it from the Recent-document dropdown).

## Config
- **Env (server-only):** `FAXAGE_USERNAME`, `FAXAGE_PASSWORD`, `FAXAGE_COMPANY` (Faxage account "company"; defaults to username if unset), `FAXAGE_IRS_NUMBER` (default `8552151627` from `DEFAULT_IRS_FAX_NUMBER`). In `.env.local` (gitignored) for local/sandbox; must also be set in the Vercel project env for deployed routes.
- Credentials are NEVER sent from the client or committed to git.

## Gotchas / unverified
- **The exact Faxage `sendfax` response format is UNVERIFIED** (no live API doc access at build time). `parseFaxageResponse` is heuristic; adjust the job-id/error parsing once a real response is observed.
- **Cover message is recorded in `action_log` but NOT transmitted** — the documented Faxage fields have no cover-page param we can rely on. Wire it once confirmed from Faxage's docs.
- **Sandbox `downloadFileBinary` returns a placeholder PDF** (it short-circuits when `SANDBOX_MODE=1`), so faxing a *selected document* in sandbox sends a mock PDF, not the real file. Upload path uses the real uploaded bytes.
- **Faxage is a real external service with no sandbox** — any send goes out for real. Test deliberately with a safe number.
- E-Sign tile on the Tools hub is a **placeholder** ("Coming soon") — non-navigating.

## How to verify current state
- Open `/tools` → "Fax" tile present; `/tools/fax` renders the form with upload / recent-document toggle.
- Open a Tax Return SD at "Signed" → the "Send Fax to IRS" card appears next to File-with-IRS; clicking it opens `/tools/fax` with the IRS number pre-filled.
- `npm run test:unit` covers `lib/fax/faxage.ts`.
- A real send requires `FAXAGE_*` env set in the target environment.
