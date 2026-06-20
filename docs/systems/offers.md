# Offers & Contracts
_Last verified against code: 2026-06-19 — Claude (added AI narrative + call_summary; read generate-offer-narrative, offer-narrative.ts, create-offer-dialog, offer render pages)_

## What it is
The sales artifact a prospect signs to become a client: an offer/contract published to a client-facing link, signed online, then paid. It's the money entry point. The single most important thing to understand: **signing, paying, and activating are three separate states** — confusing them causes wrong actions on real leads (this is exactly what R094 exists to prevent).

## The three independent states (do not conflate)
1. **`offers.status`** — the document: `draft` → `published` → `signed` → `completed` (and `superseded` when re-issued). Final statuses = `signed`/`completed`/`superseded`.
2. **`pending_activations.status`** — the payment wait: `awaiting_payment` → `payment_confirmed` → `activated`.
3. **`leads.status`** — the sales funnel: stays at its pre-payment value (e.g. "Offer Sent") through signing and only flips to **`Converted`** when payment is confirmed.

## Lifecycle (happy path)
1. **Create** (`offer_create`) → `draft`.
2. **Publish** (`publishOffer`, `lib/offers/publish.ts`) → strict gate: only `draft` can publish → status `published`; sends the client email via **safeSend** (R037); client-facing link on `app.tonydurante.us` (R012). Access code generated.
3. **Client signs** on the contract page → `offers.status='signed'` → the page calls the **offer-signed webhook**.
4. **offer-signed webhook** (`app/api/webhooks/offer-signed/route.ts`): verifies the offer is signed; **idempotent** (no-op if a `pending_activation` already exists); creates `pending_activations` (`status='awaiting_payment'`, `signed_at`); auto-saves the signed document; may create a TD invoice per `decideInvoiceAtSigning` (`lib/portal/offer-invoice-policy.ts`); **links lead→contact** (`leads.converted_to_contact_id`) but **does NOT flip `leads.status`**.
5. **Payment confirmed** (`confirm-payment` admin action / `stripe` webhook / `whop` webhook / wire-match cron) → flips `leads.status='Converted'` and runs `activateService()` to spin up the client (see formation doc).

## Business rules
- **R094** — `leads.status='Converted'` means **PAYMENT confirmed, not offer signed.** Since commit `4d5f403` (2026-04-17) the offer-signed webhook only links `converted_to_contact_id`; the `Converted` flip happens after payment in `confirm-payment`/`stripe`/`whop`. Before acting on a `Converted` lead, check `pending_activations.status` (`activated` vs stuck at `payment_confirmed`). Signed-but-unpaid leads stay at their pre-sign status.
- **R037** — Offer send/publish go through `safeSend()` (idempotency → send → status update after).
- **R012 / R005** — Client-facing offer links use `APP_BASE_URL` (`app.tonydurante.us`); never the internal `td-operations.vercel.app`.
- **R035** — Never send an offer to a client without testing it first via `?preview=td`.

## How it's built
### Key files
- `lib/offers/publish.ts` → `publishOffer()`, `resendOfferEmail()`, `buildPortalNotificationEmail()`.
- `lib/offers/sync-offer-email.ts` → `syncLeadEmailToOfferArtifacts()` (propagates a lead email change to non-final offers).
- `lib/mcp/tools/offers.ts` → `offer_create`, `offer_get`, `offer_list`, `offer_update`, `offer_send`, `offer_resend`, `offer_token`.
- `app/api/webhooks/offer-signed/route.ts` — the sign event.
- `lib/portal/offer-invoice-policy.ts` → `decideInvoiceAtSigning()` (whether/what to invoice at sign time).
- Payment confirmation: `app/api/crm/admin-actions/confirm-payment/route.ts`, `app/api/webhooks/stripe/route.ts`, `app/api/webhooks/whop/*`, `app/api/cron/*wire*`.
- `app/offer` (the contract/sign page). Activation: `lib/operations/activation.ts`.

### AI narrative content (client-facing offer body)
- The "Generate with AI" button in the Create Offer dialog (`components/offers/create-offer-dialog.tsx`) calls `app/api/crm/admin-actions/generate-offer-narrative/route.ts`, which uses the shared AI provider (`lib/portal/ai-provider.ts` — Sonnet, with Anthropic→OpenAI failover; the old hardcoded model that 404'd was removed 2026-06-15).
- Output shape + validation: `lib/offer-narrative.ts` (`NarrativeResponse`, `validateNarrative`). Fields: `intro_en`/`intro_it` (single-language: only the client's language is populated), `call_summary`, `strategy[]`, `next_steps[]`, `future_developments[]`, `immediate_actions[]`. All are stored as columns on `offers` and rendered on the client offer pages (`app/offer/[token]/page.tsx`, `app/offer/[token]/[code]/page.tsx`).
- **`call_summary`** (added 2026-06-19, migration `20260619-2330-offers-call-summary.sql`): a detailed, client-facing recap of the consultation call ("Summary of Our Call" / "Riepilogo della Nostra Call"). It is the ONE field exempt from the prompt's "under 2 sentences" rule. **Client-safety:** the prompt restricts it to what the client themselves shared and explicitly excludes internal staff notes/assessments — because the notes bundle fed to the generator mixes client-facing call notes with internal staff/lead notes. It is OPTIONAL: empty string when no call notes were available, and the render hides the section when empty (back-compat with pre-existing offers whose column is null). Staff can edit it before creating the draft.

### Tables
`offers` (`token`, `status`, `access_code`, `payment_links`, `bank_details`, `lead_id`, `account_id`, `client_name/email`, `language`, version fields), `pending_activations` (`status`, `offer_token`, `signed_at`), `leads` (`status`, `converted_to_contact_id`), `payments`.

## Gotchas, invariants & past bugs
- **Signing ≠ payment ≠ activation.** A signed offer with no payment is NOT a converted lead. Always check all three states before acting.
- **The offer-signed webhook is idempotent** — re-firing is safe (it checks for an existing `pending_activation`).
- **Only `draft` can be published**; re-publish is guarded by the offer's own current status inside `safeSend`, not by an inherited flag.
- **Email-change sync skips final offers** — `syncLeadEmailToOfferArtifacts` only updates offers NOT in `signed`/`completed`/`superseded`, so a signed record's identity is never mutated.
- **Don't reintroduce a `leads.status` flip at sign time** — that regression is precisely what R094 forbids (it caused actions to fire on unpaid leads).

## How to verify current state
- Read `app/api/webhooks/offer-signed/route.ts` (confirm it links contact but does NOT set `leads.status`), `lib/offers/publish.ts` (publish gate + safeSend), `lib/portal/offer-invoice-policy.ts`.
- For one offer: `SELECT status, lead_id, account_id FROM offers WHERE token='<t>';` then `SELECT status FROM pending_activations WHERE offer_token='<t>';` and `SELECT status, converted_to_contact_id FROM leads WHERE id='<lead_id>';` — the three states should tell a consistent story.
- Note (R096): sandbox via sandbox MCP / `psql`; production `execute_sql` hits production.
