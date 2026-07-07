# Offers & Contracts
_Last verified against code: 2026-07-07 — Claude ("Unknown error" incident fix. The Create Offer dialog (`components/offers/create-offer-dialog.tsx`) no longer collapses non-JSON API failures into a bare "Unknown error": both the Generate-with-AI and create-offer fetches now read the error body as TEXT first (`readErrorBody`), detect the middleware's new `401 code: SESSION_EXPIRED` contract (→ "Your session expired — refresh the page, log in again" toast), surface `error` or `HTTP <status>` otherwise, and fire-and-forget a capture to the error auto-audit system (`reportDialogError` → `/api/system-errors/report`). The two offer API routes also report server-side failures via `reportSystemError`. Root cause of the 2026-07-07 incident: expired admin session → middleware 307 → browser re-POSTs `/login` → 405 HTML → old `res.json().catch(() => ({error:'Unknown error'}))` swallowed it. Full system: `error-auto-audit.md`; middleware contract: `auth-oauth.md`. SANDBOX, branch `claude/festive-wiles-4d3c84`.)_
_Prior: 2026-06-30 — AI OFFER NARRATIVE reliability fix. "Generate with AI" was failing in production ("AI generation failed") because a rich ~4096-token Sonnet narrative ran past the shared provider's 30s timeout AND the GPT-4o-mini fallback also timed out. FIX: (1) `app/api/crm/admin-actions/generate-offer-narrative/route.ts` now sets `export const maxDuration = 300` and passes `timeoutMs: 90_000` to `callAI` so Sonnet has room to finish; (2) the route surfaces the REAL provider error to the admin-only toast instead of an opaque "AI generation failed" (R099). PROVIDER POLICY CHANGE (`lib/portal/ai-provider.ts`, affects ALL callers): Sonnet/Opus ONLY — no Haiku, no OpenAI/GPT. Failover is now Sonnet→Opus (Anthropic-internal); `temperature` is dropped for Opus (it 400s otherwise). Tests: `tests/unit/ai-provider.test.ts`. SANDBOX, branch `claude/offer-narrative-ai-fix`._
_Last verified against code: 2026-06-25 — Claude (Create Offer dialog `components/offers/create-offer-dialog.tsx` gained an optional **Partner deal** section: pick a managed partner + setup payout + renewal payout (USD). Threaded via `createOffer` + the `create-offer` route into `offers.partner_id` / `partner_payout_model='flat_fee'` / `partner_payout_rate` (setup) / `partner_renewal_payout` (renewal). Full design in `partners-team.md`. SANDBOX, branch `feat/partner-deal-config`.)_
_Last verified against code: 2026-06-20 — AI OFFER NARRATIVE now grounded in the full call transcript. The "Generate with AI" button in Create Offer calls `app/api/crm/admin-actions/generate-offer-narrative/route.ts` (Claude Sonnet via the shared `callAI`, OpenAI fallback) → produces the offer's intro + strategy/next_steps/future_developments/immediate_actions JSON (validated by `validateNarrative` in `lib/offer-narrative.ts`). The dialog now passes `lead_id`/`account_id`; the route fetches that client's most-recent `call_summaries` row and feeds its notes + FULL transcript (capped ~14k chars via the new pure `renderCallForOffer`) into the prompt, so the narrative reflects what the client actually said — not just the capped summary notes. System prompt loosened (intro 4-6 sentences, 2-3-sentence descriptions, 4-5 steps, reference call specifics) + `maxTokens` 2048→4096. PRESERVED: the single-language intro rule (only the client's language intro is filled, the other stays "") and the formation/onboarding/renewal contract-type rules. Best-effort: no call / fetch error → falls back to notes-only. Tests: `renderCallForOffer` cases in `tests/unit/generate-offer-narrative.test.ts`. Prior: 2026-05-29 — Claude (read publish.ts, offer-signed webhook, sync-offer-email.ts)_

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
- **AI narrative generator:** `app/api/crm/admin-actions/generate-offer-narrative/route.ts` (system/user prompt + call-transcript enrichment via `fetchCallContext`), `lib/offer-narrative.ts` (`validateNarrative` + the pure `renderCallForOffer` transcript formatter), `components/offers/create-offer-dialog.tsx` (the "Generate with AI" button; passes `lead_id`/`account_id`). Reads `call_summaries` (`notes`, `transcript`, `lead_id`, `account_id`).

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
